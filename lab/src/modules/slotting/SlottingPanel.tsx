/**
 * 库位优化面板（模块 id `slotting`）。
 *
 * 数据流（单向，没有第二条数据来源）：
 *   内置/导入问题 → 引擎 `wh_solve`（Worker）→ 信封（metrics/result/timeline/verification）
 *   → 3D 图层 + 指标卡 + 核验面板 + 运行历史；
 *   "重新核验"按钮 → `wh_verify`（独立验证器，和求解器物理隔离）。
 *
 * 本模块同时支持**联合优化**（kind=joint）：同一块画布上展示"库位方案 + 调度闭环"，
 * 因为联合优化的库位侧证据本来就长在库位画布上（哪里放了什么、为什么搬、搬完调度多少钱）。
 */

import { useCallback, useMemo, useState } from 'react';
import { useWarehouseEngine } from '../../core/warehouse/useWarehouseEngine';
import type { WarehouseEnvelope, WarehouseJointResult, WarehouseSlottingResult } from '../../core/warehouse/types';
import { useCapabilities, useDomainAlgorithms } from '../warehouse-shared/capabilities';
import { EnvelopeFooter, IssuesPanel, MetricGrid, VerificationPanel, fmt, type MetricCard } from '../warehouse-shared/EnvelopeViews';
import { SceneIO, generationIssueText, type MockEntry } from '../warehouse-shared/SceneIO';
import { RunsRail } from '../warehouse-shared/RunsRail';
import { WAREHOUSE_MAX_RUNS, makeWarehouseRunRecord, type WarehouseRunRecord } from '../warehouse-shared/runs';
import { buildVerifyDocument, isWarehouseCancelError } from '../../core/warehouse/engine';
import type { WarehouseProblemView } from '../warehouse-shared/geometry';
import { Slotting3D, type Slotting3DLayers } from './Slotting3D';
import { buildSlottingScene, type SlottingScene } from './scene';
import { clusterColor } from '../warehouse-shared/geometry';

/** 关联簇叠加的显示上限（与 scene.ts 的采样上限一致，避免文案与实际不一致）。 */
const MAX_CLUSTER_HINT = 4000;

interface LoadedProblem {
  document: Record<string, unknown>;
  view: WarehouseProblemView;
  entry: MockEntry | null;
  kind: 'slotting' | 'joint';
}

function asProblemView(document: Record<string, unknown>, kind: 'slotting' | 'joint'): WarehouseProblemView {
  const root = kind === 'joint' ? (document.slotting as Record<string, unknown>) : (document.problem as Record<string, unknown>);
  const topology = (root?.topology as WarehouseProblemView['topology']) ?? (document.topology as WarehouseProblemView['topology']) ?? {};
  return {
    kind,
    scenarioId: document.scenarioId as string | undefined,
    name: document.name as string | undefined,
    scale: document.scale as string | undefined,
    goal: document.goal as string | undefined,
    expect: document.expect as string | undefined,
    seed: document.seed as number | undefined,
    topology,
    skus: root?.skus as WarehouseProblemView['skus'],
    inventory: root?.inventory as WarehouseProblemView['inventory'],
    devices: root?.devices as WarehouseProblemView['devices'],
  };
}

export function SlottingPanel() {
  const engine = useWarehouseEngine();
  const capabilities = useCapabilities(engine.assetUrl(''));
  const slottingAlgorithms = useDomainAlgorithms('slotting', capabilities);
  const jointAlgorithms = useDomainAlgorithms('joint', capabilities);

  const [problem, setProblem] = useState<LoadedProblem | null>(null);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [algorithm, setAlgorithm] = useState('affinity-lns');
  const [seed, setSeed] = useState(7);
  const [budgetMs, setBudgetMs] = useState(2000);
  const [verifyInline, setVerifyInline] = useState(true);
  const [envelope, setEnvelope] = useState<WarehouseEnvelope | null>(null);
  const [peakMemoryBytes, setPeakMemoryBytes] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [solving, setSolving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [runs, setRuns] = useState<WarehouseRunRecord[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [layers, setLayers] = useState<Slotting3DLayers>({
    rack: true,
    heat: true,
    clusters: false,
    plan: true,
    migrations: true,
    aisles: true,
  });
  const [fitNonce, setFitNonce] = useState(0);
  const [generating, setGenerating] = useState(false);

  const joint = problem?.kind === 'joint';
  const algorithms = joint && jointAlgorithms.algorithms.length > 0 ? jointAlgorithms.algorithms : slottingAlgorithms.algorithms;

  const scene: SlottingScene | null = useMemo(
    () => (problem ? buildSlottingScene(problem.view, envelope) : null),
    [problem, envelope],
  );

  const load = useCallback((text: string, entry: MockEntry | null) => {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const kind = parsed.kind === 'joint' ? 'joint' : parsed.kind === 'slotting' ? 'slotting' : null;
      if (!kind) {
        setDraftError(`本模块接收 kind=slotting（或联合 kind=joint）的问题，收到 ${String(parsed.kind)}`);
        return;
      }
      setDraftError(null);
      setEnvelope(null);
      setSelected(null);
      setProblem({ document: parsed, view: asProblemView(parsed, kind), entry, kind });
      const declared = (parsed.seed as number) ?? 7;
      setSeed(Number.isFinite(declared) ? declared : 7);
      setNotice(
        `已载入 ${String(parsed.name ?? kind)}（${String(parsed.scenarioId ?? '—')}，规模 ${String(parsed.scale ?? '—')}）：` +
          `目标「${String(parsed.goal ?? '—')}」，期望「${String(parsed.expect ?? '—')}」`,
      );
    } catch (err) {
      setDraftError(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const solve = useCallback(async () => {
    if (!problem || !engine.handle) return;
    setSolving(true);
    engine.setBusy(true);
    setNotice('求解中…（在 Worker 里同步执行，可随时取消）');
    try {
      // 只送引擎 `slotting::options_from_json` 真实实现的键；
      // verify 决定信封里是否内嵌独立核验结论（关闭后仍需单独跑验证器才可交付）。
      const options: Record<string, unknown> = { seed, verify: verifyInline };
      if (algorithm) options.algorithm = algorithm;
      if (budgetMs > 0) options.budgetMs = budgetMs;
      const outcome = await engine.handle.solve(JSON.stringify(problem.document), options);
      if (!outcome.envelope) {
        setNotice(`求解返回 ${outcome.status}，但没有结果信封：${outcome.error ?? '（无错误信息）'}`);
        return;
      }
      setEnvelope(outcome.envelope);
      setPeakMemoryBytes(outcome.peakMemoryBytes ?? null);
      const params =
        `${algorithm || '（问题内默认）'} · seed=${seed}${budgetMs ? ` · ${budgetMs}ms` : ''}` +
        `${verifyInline ? '' : ' · 无内嵌核验'}`;
      const record = makeWarehouseRunRecord(
        runs.length + 1,
        JSON.stringify(problem.document),
        outcome.raw,
        outcome.envelope,
        params,
        outcome.peakMemoryBytes ?? null,
      );
      setRuns((previous) => [record, ...previous].slice(0, WAREHOUSE_MAX_RUNS));
      setActiveRunId(record.id);
      const v = outcome.envelope.verification;
      setNotice(
        `求解完成：${outcome.envelope.status}（${fmt(outcome.envelope.runtimeMs, 0)} ms）` +
          (v ? `，引擎内嵌核验 ${v.ok ? '通过' : '未通过'}` : '，本次未附核验（用「重新核验」单独跑验证器）'),
      );
    } catch (err) {
      setNotice(isWarehouseCancelError(err) ? '已取消本次求解（Worker 已终止，下次求解会自动重建）' : `求解失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSolving(false);
      engine.setBusy(false);
    }
  }, [algorithm, budgetMs, engine, problem, runs.length, seed, verifyInline]);

  const verify = useCallback(async () => {
    if (!problem || !envelope || !engine.handle) return;
    const document = buildVerifyDocument(problem.document, envelope);
    if (!document) {
      setNotice('没有可重放的时间线，无法提交独立核验（无解或未产出时间线）。');
      return;
    }
    setVerifying(true);
    try {
      const outcome = await engine.handle.verify(JSON.stringify(document));
      setEnvelope((previous) =>
        previous ? { ...previous, verification: outcome.report ?? previous.verification } : previous,
      );
      setNotice(`独立核验：${outcome.report?.ok ? '通过' : '未通过'}（${(outcome.report?.violations ?? []).length} 条违规）`);
    } catch (err) {
      setNotice(`核验失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setVerifying(false);
    }
  }, [engine, envelope, problem]);

  const generate = useCallback(
    async (scenarioId: string, scale: string) => {
      if (!engine.handle) return;
      setGenerating(true);
      try {
        const out = await engine.handle.generate(scenarioId, scale, seed);
        if (!out.document) {
          setNotice(`生成 ${scenarioId}/${scale} 失败：${out.status}${generationIssueText(out.raw)}`);
          return;
        }
        const text = JSON.stringify(out.document);
        setDraft(text);
        const kindOfDocument = String((out.document as { kind?: string }).kind ?? '');
        if (kindOfDocument !== 'slotting' && kindOfDocument !== 'joint') {
          // 边界场景族（X 系列）里混着别的域：如实说明去哪儿打开，而不是静默报 kind 错误。
          setNotice(
            `已生成 ${scenarioId}/${scale}，但它的 kind=${kindOfDocument}：本模块接收 slotting / joint，` +
              '请在“密集立库调度”模块打开（草稿已放到下面的 JSON 里）。',
          );
          return;
        }
        load(text, {
          file: '（引擎生成）',
          id: scenarioId,
          name: `${scenarioId} · ${scale}`,
          kind: String((out.document as { kind?: string }).kind ?? 'slotting'),
          goal: String((out.document as { goal?: string }).goal ?? '—'),
          expect: String((out.document as { expect?: string }).expect ?? '—'),
          scale,
          description: '由引擎按场景定义现生成（与 CLI `warehouse generate` 同源）',
        });
      } catch (err) {
        setNotice(`生成失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setGenerating(false);
      }
    },
    [engine, load, seed],
  );

  const metrics = envelope?.metrics;
  const slottingResult = (envelope?.result as WarehouseSlottingResult | undefined) ?? null;
  const jointResult = joint ? ((envelope?.result as WarehouseJointResult | undefined) ?? null) : null;

  const cards: MetricCard[] = useMemo(() => {
    if (!envelope || !metrics) return [];
    const list: MetricCard[] = [];
    if (envelope.objective != null) {
      list.push({
        key: 'objective',
        label: joint ? '联合目标值' : '加权目标值',
        value: fmt(envelope.objective, 4),
        hint: joint ? 'travel·w_t + makespan·0.5 + 每任务周转 + 冲突/倒垛罚项（含拥堵反馈）' : '各目标按问题权重加权（见下方目标分解）',
      });
    }
    if (metrics.expectedPickSeconds != null || metrics.expectedPutSeconds != null) {
      list.push(
        {
          key: 'pick',
          label: '出库预期时间',
          value: `${fmt(metrics.expectedPickSeconds, 2)} s/次`,
          hint: '按设备运动学与流量加权',
        },
        { key: 'put', label: '入库预期时间', value: `${fmt(metrics.expectedPutSeconds, 2)} s/次` },
      );
    }
    for (const [key, label, unit, hint] of [
      ['spaceUtilization', '空间利用率', '', '占用的库位容量比例'],
      ['effectiveUtilization', '有效利用率', '', '扣掉不可用/冻结后的可用率'],
      ['aisleLoadGini', '巷道负载基尼', '', '越小越均衡（0 = 完全均衡）'],
      ['affinityCoherence', '关联一致性', '', '同一关联簇落位聚集度'],
      ['congestionIndex', '拥堵代理指数', '', '巷道/提升机排队延误（秒/天）'],
      ['liftPeakRatio', '提升机峰值比', '', '峰值需求 / 服务能力'],
      ['stability', '鲁棒稳定性', '', '多随机种子下的目标波动（越小越稳）'],
    ] as Array<[string, string, string, string]>) {
      const value = (metrics as Record<string, unknown>)[key];
      if (value == null) continue;
      list.push({ key, label, value: `${fmt(value, 3)}${unit}`, hint });
    }
    if (metrics.relocationCount != null) {
      list.push({
        key: 'relocation',
        label: '搬迁件数',
        value: fmt(metrics.relocationCount),
        hint: `估计设备工时 ${fmt(metrics.relocationDeviceSeconds, 0)} s`,
        tone: 'warn',
      });
    }
    if (metrics.travelSecondsPerDay != null) {
      list.push({ key: 'travel', label: '优化后日运行时间', value: `${fmt(metrics.travelSecondsPerDay, 1)} s/天` });
    }
    if (metrics.tasksDone != null) {
      list.push({
        key: 'closed-loop',
        label: '闭环调度完成',
        value: `${fmt(metrics.tasksDone)} / ${fmt(metrics.tasksTotal)}`,
        hint: metrics.makespan_s != null ? `完工 ${fmt(metrics.makespan_s, 1)} s` : undefined,
      });
    }
    if (metrics.aisleLoads) {
      const loads = metrics.aisleLoads as number[];
      list.push({ key: 'aisleLoads', label: '巷道负载分布', value: loads.map((value) => fmt(value, 1)).join(' | ') });
    }
    list.push({
      key: 'compute',
      label: '求解耗时',
      value: `${fmt(envelope.runtimeMs, 0)} ms`,
      hint: `算法 ${slottingResult?.algorithm ?? '—'} · seed ${slottingResult?.seed ?? seed}`,
    });
    return list;
  }, [envelope, joint, metrics, seed, slottingResult]);

  const objectives = useMemo(() => {
    const list = (metrics?.objectives as Array<Record<string, unknown>> | undefined) ?? [];
    return list;
  }, [metrics]);

  /** 对比矩阵：库位侧（baselines）与联合侧（rows）的字段不同，这里统一成一张表。 */
  const slottingComparison = useMemo(() => {
    const comparison = slottingResult?.comparison ?? jointResult?.comparison;
    if (!comparison) return null;
    const rows: Array<{
      label: string;
      travelSecondsPerDay: number | null;
      congestionSecondsPerDay: number | null;
      makespan_s: number | null;
      tasksDone: number | null;
      relocationCount: number | null;
      verified: boolean | null;
    }> = [];
    if (comparison.baselines) {
      for (const [key, value] of Object.entries(comparison.baselines)) {
        rows.push({
          label: key,
          travelSecondsPerDay: value?.travelSecondsPerDay ?? null,
          congestionSecondsPerDay: value?.congestionSecondsPerDay ?? null,
          makespan_s: null,
          tasksDone: null,
          relocationCount: value?.relocationCount ?? null,
          verified: null,
        });
      }
    }
    for (const row of (comparison.rows ?? []) as Array<Record<string, unknown>>) {
      rows.push({
        label: String(row.label ?? row.variant ?? '—'),
        travelSecondsPerDay: (row.slottingTravelSecondsPerDay as number) ?? null,
        congestionSecondsPerDay: null,
        makespan_s: (row.makespan_s as number) ?? null,
        tasksDone: (row.tasksDone as number) ?? null,
        relocationCount: (row.relocationCount as number) ?? null,
        verified: (row.verified as boolean) ?? null,
      });
    }
    if (rows.length === 0) return null;
    return { rows, notes: (comparison.notes ?? []) as string[] };
  }, [slottingResult, jointResult]);

  /** 解释项：库位侧给的是数组（topic/text），联合侧给的是对象（slotting/dispatch/reasons）。 */
  const explanationItems = useMemo(() => {
    const items: Array<{ topic: string; text: string }> = [];
    const explanation = slottingResult?.explanation ?? jointResult?.explanation;
    if (Array.isArray(explanation)) {
      for (const entry of explanation as Array<{ topic?: string; text?: string }>) {
        items.push({ topic: entry.topic ?? '说明', text: entry.text ?? '' });
      }
    } else if (explanation) {
      const object = explanation as { slotting?: string; dispatch?: string; reasons?: string[] };
      if (object.slotting) items.push({ topic: '库位侧', text: object.slotting });
      if (object.dispatch) items.push({ topic: '调度侧', text: object.dispatch });
      for (const reason of object.reasons ?? []) items.push({ topic: '依据', text: reason });
    }
    return items;
  }, [slottingResult, jointResult]);

  return (
    <section className="panel mapf-panel mapf-visual agv-panel" data-visual-module="slotting" data-solution-status={envelope?.status ?? 'idle'}>
      <div className="engine-banner">
        <div>
          <span className="eyebrow">仓储优化 · 库位分配</span>
          <strong>库位优化{joint ? ' · 联合优化' : ''}</strong>
        </div>
        <div className="engine-cluster">
          <span className="chip">引擎 {engine.status === 'ready' ? `${engine.manifest?.engine ?? 'warehouse-engine'} v${engine.version}` : engine.status === 'error' ? '装载失败' : '装载中…'}</span>
          {capabilities && <span className="chip">档位 {capabilities.profile}</span>}
          {engine.manifest?.selfCheck && (
            <span className="chip" title={JSON.stringify(engine.manifest.selfCheck, null, 1)}>
              自检 {String((engine.manifest.selfCheck as { slotting?: string }).slotting ?? '—')}
            </span>
          )}
          <button type="button" className="btn tiny" onClick={engine.refresh}>
            重新装载
          </button>
        </div>
      </div>

      {engine.error && (
        <div className="error-panel">
          <strong>引擎未就绪。</strong> {engine.error}
        </div>
      )}

      <div className="mapf-workspace">
        <aside className="mapf-left">
          <SceneIO
            manifest={engine.manifest}
            assetUrl={engine.assetUrl}
            kind={joint ? 'joint' : 'slotting'}
            activeFile={problem?.entry?.file ?? null}
            onLoad={load}
            onGenerate={generate}
            generating={generating}
            scenarioCatalog={engine.scenarioCatalog}
            scales={engine.scales}
            draft={draft}
            onDraft={setDraft}
            draftError={draftError}
            disabled={!engine.handle || solving}
          />

          <section className="rail-group">
            <div className="section-heading section-heading-compact">
              <h4>求解参数</h4>
            </div>
            <label className="field">
              <span className="small">算法（来自引擎能力清单）</span>
              <select value={algorithm} onChange={(event) => setAlgorithm(event.target.value)} disabled={solving}>
                <option value="">（用问题内声明的算法）</option>
                {algorithms.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.kindLabel} · {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="small">随机种子（同种子必须复现同一结果）</span>
              <input
                type="number"
                className="input"
                value={seed}
                onChange={(event) => setSeed(Number(event.target.value) || 0)}
                disabled={solving}
              />
            </label>
            <label className="field">
              <span className="small">时间预算（ms）</span>
              <input
                type="number"
                className="input"
                value={budgetMs}
                min={50}
                step={100}
                onChange={(event) => setBudgetMs(Math.max(50, Number(event.target.value) || 50))}
                disabled={solving}
              />
            </label>
            <label className="layer-toggle small">
              <input
                type="checkbox"
                checked={verifyInline}
                onChange={(event) => setVerifyInline(event.target.checked)}
                disabled={solving}
              />
              求解时内嵌独立核验（verify；关闭后仍需用「重新核验」单独跑一次才可交付）
            </label>
            {problem && (
              <p className="muted small">
                实例：{problem.view.name ?? '—'} · {String(problem.document.scenarioId ?? '—')} · 规模 {problem.view.scale ?? '—'}
                {scene ? ` · ${scene.counts.locations} 库位 / ${scene.counts.aisles} 巷道` : ''}
              </p>
            )}
            <div className="solve-row">
              <button type="button" className="btn primary" disabled={!engine.handle || !problem || solving} onClick={() => void solve()}>
                {solving ? '求解中…' : joint ? '联合求解' : '求解库位方案'}
              </button>
              <button type="button" className="btn" disabled={!solving} onClick={() => engine.cancel()}>
                取消
              </button>
            </div>
            <div className="solve-row">
              <button type="button" className="btn tiny" disabled={!envelope || verifying} onClick={() => void verify()}>
                {verifying ? '核验中…' : '重新核验（独立验证器）'}
              </button>
              <button type="button" className="btn tiny" disabled={!envelope} onClick={() => setFitNonce((value) => value + 1)}>
                重新取景
              </button>
            </div>
            {notice && <p className="muted small mapf-notice">{notice}</p>}
          </section>

          <IssuesPanel issues={envelope?.issues ?? []} />
        </aside>

        <div className="mapf-center">
          <div className="mapf-stage-wrap">
            {scene ? (
              <Slotting3D
                scene={scene}
                layers={layers}
                selected={selected}
                onSelect={setSelected}
                fitNonce={fitNonce}
              />
            ) : (
              <div className="mapf-visual sandbox-stage stage-loading">
                <p className="muted small">左侧选择内置实例或导入问题 JSON 后，这里渲染真实拓扑与算法图层。</p>
              </div>
            )}
            <div className="mapf-toolbar">
              <div className="toggles">
                {(
                  [
                    ['rack', '货架结构'],
                    ['heat', '周转热力'],
                    ['clusters', '关联簇叠加'],
                    ['plan', '引擎落位'],
                    ['migrations', '搬迁路径'],
                    ['aisles', '巷道负载'],
                  ] as Array<[keyof Slotting3DLayers, string]>
                ).map(([key, label]) => (
                  <label key={key} className="layer-toggle small">
                    <input
                      type="checkbox"
                      checked={layers[key]}
                      onChange={(event) => setLayers((previous) => ({ ...previous, [key]: event.target.checked }))}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <div className="mapf-legend muted small">
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#244a6b' }} />
                低周转
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#3fe0d4' }} />
                中
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#ff6f6f' }} />
                高周转
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#3fe0d4' }} />
                引擎落位
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#a78bfa' }} />
                搬迁
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#33445f' }} />
                空位/未落货
              </span>
              {scene && scene.clusterCells.length > 0 && (
                <span className="legend-item">
                  关联簇（共 {scene.clusterCount} 个，前 8 个配色）：
                  {Array.from(new Set(scene.clusterCells.map((cell) => cell.cluster)))
                    .sort((a, b) => a - b)
                    .slice(0, 8)
                    .map((cluster, index_) => (
                      <span
                        key={`cluster-swatch-${cluster}`}
                        className="legend-dot"
                        style={{ background: clusterColor(cluster), marginLeft: index_ === 0 ? 6 : 2 }}
                        title={`簇 ${cluster}`}
                      />
                    ))}
                </span>
              )}
              <span className="muted">
                · 热力来自问题数据的 SKU 周转率；落位/搬迁来自引擎方案；关联簇来自引擎聚类
                （<code>result.clusters.bySku</code>）；指标全部来自信封
              </span>
            </div>
            {scene && layers.clusters && scene.clusterCells.length === 0 && (
              <p className="muted small">
                本次结果没有关联簇信息（该实例的订单历史未形成显著关联对，或这是导入的问题）——
                这一层不做占位渲染。
              </p>
            )}
            {scene && layers.clusters && scene.clusterCells.length > 0 && (
              <p className="muted small">
                关联簇：{scene.clusterCount} 个簇 · 叠加 {scene.clusterCells.length} 个库位
                （同簇同色；覆盖上限 {MAX_CLUSTER_HINT} 个，超出部分是采样）
                {scene.clusterNote ? ` · ${scene.clusterNote}` : ''}
              </p>
            )}
          </div>

          <div className="mapf-bottom">
            <div className="mapf-readout muted small">
              {selected && scene
                ? (() => {
                    const cell = scene.heat.find((item) => item.locationId === selected);
                    const occupant = scene.occupant.get(selected);
                    return (
                      <span>
                        选中库位 <strong>{selected}</strong>
                        {cell ? ` · 周转 ${fmt(cell.turnover, 2)} · 类别 ${cell.skuClass || '—'}` : '（无周转数据）'}
                        {occupant ? ` · 引擎落货 ${occupant.loadUnitId}（${occupant.skuId}）` : ' · 方案未占用'}
                      </span>
                    );
                  })()
                : scene
                  ? `库位 ${scene.loadRatio.total} 个，其中 ${scene.loadRatio.assigned} 个在引擎方案里有货；含货库位周转区间 ${fmt(scene.loadRatio.min, 2)}–${fmt(scene.loadRatio.max, 2)} 次/天`
                  : '未载入实例'}
            </div>
            {scene && scene.migrations.length > 0 && (
              <div className="muted small">
                引擎搬迁计划 {scene.migrations.length} 条
                {scene.migrations[0]?.reason ? ` · 例：${scene.migrations[0].reason}` : ''}
              </div>
            )}
          </div>
        </div>

        <div className="mapf-rail">
          <section className="rail-group">
            <div className="section-heading section-heading-compact">
              <h4>结果</h4>
              {envelope && <span className={`badge status-${envelope.status.toLowerCase()}`}>{envelope.status}</span>}
            </div>
            {!envelope && <p className="muted small">还没有结果。载入实例 → 求解 → 结果与核验会出现在这里。</p>}
            {envelope && <MetricGrid cards={cards} columns={2} />}

            {objectives.length > 0 && (
              <details className="mapf-details" open>
                <summary>目标分解（引擎给出，含权重与冲突说明）</summary>
                <table className="small-table small">
                  <thead>
                    <tr>
                      <th>目标</th>
                      <th>权重</th>
                      <th>原始值</th>
                      <th>归一</th>
                    </tr>
                  </thead>
                  <tbody>
                    {objectives.map((item) => (
                      <tr key={String(item.id)}>
                        <td title={String(item.note ?? '')}>{String(item.id)}</td>
                        <td className="tabular-nums">{fmt(item.weight, 2)}</td>
                        <td className="tabular-nums">
                          {fmt(item.raw, 3)} {String(item.unit ?? '')}
                        </td>
                        <td className="tabular-nums">{fmt(item.normalized, 3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}

            {slottingComparison && (
              <details className="mapf-details" open>
                <summary>{joint ? '对比矩阵（同一调度口径下的三种落位）' : '对比基线（同一问题、同一评价口径）'}</summary>
                <table className="small-table small">
                  <thead>
                    <tr>
                      <th>方案</th>
                      <th>日运行时间(s)</th>
                      <th>{joint ? '完工(s)' : '拥堵(s/天)'}</th>
                      <th>完成</th>
                      <th>搬迁</th>
                      <th>核验</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slottingComparison.rows.map((row) => (
                      <tr key={row.label}>
                        <td>{row.label}</td>
                        <td className="tabular-nums">{fmt(row.travelSecondsPerDay, 1)}</td>
                        <td className="tabular-nums">{joint ? fmt(row.makespan_s, 0) : fmt(row.congestionSecondsPerDay, 1)}</td>
                        <td className="tabular-nums">{fmt(row.tasksDone)}</td>
                        <td className="tabular-nums">{fmt(row.relocationCount)}</td>
                        <td>{row.verified == null ? '—' : row.verified ? '✓' : '✗'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {slottingComparison.notes.length > 0 && (
                  <ul className="small muted">
                    {slottingComparison.notes.slice(0, 4).map((note, index) => (
                      <li key={index}>{note}</li>
                    ))}
                  </ul>
                )}
                <p className="muted small">数字口径：全部来自同一轮真实推演（含时空预约与倒垛），不是估算。</p>
              </details>
            )}

            {jointResult?.rounds && jointResult.rounds.length > 0 && (
              <details className="mapf-details" open>
                <summary>联合闭环轮次（每轮都是真实重演）</summary>
                <table className="small-table small">
                  <thead>
                    <tr>
                      <th>轮</th>
                      <th>库位算法</th>
                      <th>日运行(s)</th>
                      <th>完成</th>
                      <th>完工(s)</th>
                      <th>冲突</th>
                      <th>目标</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jointResult.rounds.map((round) => (
                      <tr key={round.round}>
                        <td className="tabular-nums">{round.round}</td>
                        <td>{round.algorithm}</td>
                        <td className="tabular-nums">{fmt(round.slottingTravelSecondsPerDay, 0)}</td>
                        <td className="tabular-nums">
                          {round.tasksDone}
                          {!round.verified && <span className="warn-text">（未核验）</span>}
                        </td>
                        <td className="tabular-nums">{fmt(round.makespan_s, 0)}</td>
                        <td className="tabular-nums">{round.conflicts}</td>
                        <td className="tabular-nums">{fmt(round.jointObjective, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}

            {jointResult?.pareto && jointResult.pareto.length > 0 && (
              <details className="mapf-details" open>
                <summary>Pareto 前沿（{jointResult.pareto.length} 个非支配点）</summary>
                <table className="small-table small">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>库位权重</th>
                      <th>调度权重</th>
                      <th>日运行(s)</th>
                      <th>完工(s)</th>
                      <th>联合目标</th>
                      <th>选中</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jointResult.pareto.map((point, index) => {
                      const weights = (point.weights ?? {}) as Record<string, number>;
                      const metrics = (point.metrics ?? {}) as Record<string, number>;
                      return (
                        <tr key={index}>
                          <td className="tabular-nums">{fmt(point.round ?? index)}</td>
                          <td className="tabular-nums">{fmt(weights.travelWeight, 2)}</td>
                          <td className="tabular-nums">{fmt(weights.throughputWeight, 2)}</td>
                          <td className="tabular-nums">{fmt(metrics.slottingTravelSecondsPerDay, 0)}</td>
                          <td className="tabular-nums">{fmt(metrics.makespan_s, 0)}</td>
                          <td className="tabular-nums">{fmt(point.jointObjective, 1)}</td>
                          <td>{point.chosen ? '✓' : ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {jointResult.paretoNote && <p className="muted small">{jointResult.paretoNote}</p>}
              </details>
            )}

            {explanationItems.length > 0 && (
              <details className="mapf-details" open>
                <summary>为什么这么放 / 这么调度（可复述的解释）</summary>
                <ul className="small">
                  {explanationItems.map((item, index) => (
                    <li key={index}>
                      <strong>{item.topic}</strong>：{item.text}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {slottingResult?.search && (
              <details className="mapf-details">
                <summary>搜索过程（迭代/算子统计）</summary>
                <pre className="small">{JSON.stringify(slottingResult.search, null, 1)}</pre>
              </details>
            )}

            <VerificationPanel verification={envelope?.verification ?? null} onThicken={envelope ? () => void verify() : undefined} />
          </section>

          <RunsRail
            runs={runs}
            activeId={activeRunId}
            onSelect={(run) => {
              setEnvelope(run.envelope);
              setActiveRunId(run.id);
              setPeakMemoryBytes(run.peakMemoryBytes);
            }}
            onDelete={(id) => setRuns((previous) => previous.filter((run) => run.id !== id))}
          />
        </div>
      </div>

      {envelope && (
        <div className="footbar">
          <EnvelopeFooter envelope={envelope} peakMemoryBytes={peakMemoryBytes} />
          <span className="muted small">
            算法 {String((slottingResult?.algorithm ?? jointResult?.algorithm ?? '—'))} · 状态语义见引擎 capabilities.statuses
          </span>
        </div>
      )}
    </section>
  );
}
