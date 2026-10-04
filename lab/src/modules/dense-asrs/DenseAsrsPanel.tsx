/**
 * 密集立库调度面板（模块 id `dense-asrs`）。
 *
 * 与库位优化共用同一套运行时（Worker、核验、运行历史），但关注点完全不同：
 *   * 中心是**设备时间线**（回放、逐步检查、冲突/倒垛/等待在哪儿发生）；
 *   * 右侧是调度指标 + 双指令配对 + 缓冲峰值 + 设备利用率（全部来自引擎）；
 *   * 支持故障/封闭巷道等动态事件场景：画布上明确标出"某段时间这台设备停了/这条巷道封了"。
 *
 * 同时支持**联合优化**（kind=joint）：联合实例的调度段等同于一个立库调度问题，
 * 时间线回放与核验走同一条路径，额外展示库位侧的落位与联合对比矩阵。
 */

import { useCallback, useMemo, useState } from 'react';
import { useWarehouseEngine } from '../../core/warehouse/useWarehouseEngine';
import type { WarehouseAsrsResult, WarehouseEnvelope, WarehouseJointResult, WarehouseTaskState } from '../../core/warehouse/types';
import { useCapabilities, useDomainAlgorithms } from '../warehouse-shared/capabilities';
import { EnvelopeFooter, IssuesPanel, MetricGrid, VerificationPanel, fmt, type MetricCard } from '../warehouse-shared/EnvelopeViews';
import { SceneIO, generationIssueText, type MockEntry } from '../warehouse-shared/SceneIO';
import { RunsRail } from '../warehouse-shared/RunsRail';
import { WAREHOUSE_MAX_RUNS, makeWarehouseRunRecord, type WarehouseRunRecord } from '../warehouse-shared/runs';
import { PlaybackBar } from '../warehouse-shared/PlaybackBar';
import { usePlayback } from '../warehouse-shared/usePlayback';
import { buildVerifyDocument, isWarehouseCancelError } from '../../core/warehouse/engine';
import type { WarehouseProblemView } from '../warehouse-shared/geometry';
import { timelineHorizon } from '../warehouse-shared/geometry';
import { Asrs3D, type Asrs3DLayers } from './Asrs3D';
import { buildAsrsScene, deviceKindLabel, taskStatusLabel } from './scene';

interface LoadedProblem {
  document: Record<string, unknown>;
  view: WarehouseProblemView;
  entry: MockEntry | null;
  kind: 'asrs' | 'joint';
}

function asProblemView(document: Record<string, unknown>, kind: 'asrs' | 'joint'): WarehouseProblemView {
  const root = kind === 'joint' ? (document.asrs as Record<string, unknown>) : (document.problem as Record<string, unknown>);
  return {
    kind,
    scenarioId: document.scenarioId as string | undefined,
    name: document.name as string | undefined,
    scale: document.scale as string | undefined,
    goal: document.goal as string | undefined,
    expect: document.expect as string | undefined,
    seed: document.seed as number | undefined,
    topology: (root?.topology as WarehouseProblemView['topology']) ?? (document.topology as WarehouseProblemView['topology']) ?? {},
    devices: root?.devices as WarehouseProblemView['devices'],
    tasks: root?.tasks as WarehouseProblemView['tasks'],
    events: root?.events as WarehouseProblemView['events'],
    skus: root?.skus as WarehouseProblemView['skus'],
    inventory: root?.inventory as WarehouseProblemView['inventory'],
  };
}

export function DenseAsrsPanel() {
  const engine = useWarehouseEngine();
  const capabilities = useCapabilities(engine.assetUrl(''));
  const asrsAlgorithms = useDomainAlgorithms('asrs', capabilities);
  const jointAlgorithms = useDomainAlgorithms('joint', capabilities);

  const [problem, setProblem] = useState<LoadedProblem | null>(null);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [policy, setPolicy] = useState('joint-alns');
  const [seed, setSeed] = useState(7);
  const [budgetMs, setBudgetMs] = useState(3000);
  const [includeTimeline, setIncludeTimeline] = useState(true);
  const [dualCommand, setDualCommand] = useState(true);
  const [verifyInline, setVerifyInline] = useState(true);
  const [envelope, setEnvelope] = useState<WarehouseEnvelope | null>(null);
  const [peakMemoryBytes, setPeakMemoryBytes] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [solving, setSolving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [runs, setRuns] = useState<WarehouseRunRecord[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [layers, setLayers] = useState<Asrs3DLayers>({
    rack: true,
    lanes: true,
    stations: true,
    devices: true,
    tasks: true,
    paths: true,
    relocations: false,
  });
  const [fitNonce, setFitNonce] = useState(0);
  const [generating, setGenerating] = useState(false);

  const joint = problem?.kind === 'joint';
  const algorithms = joint && jointAlgorithms.algorithms.length > 0 ? jointAlgorithms.algorithms : asrsAlgorithms.algorithms;

  const scene = useMemo(() => (problem ? buildAsrsScene(problem.view, envelope) : null), [problem, envelope]);
  // 时间轴上限：信封里声明的 horizon_s 优先，缺失时从步骤端点回推；再与场景投影取最大，
  // 避免"设备还在动、播放条已经到底"这种观感与数据不一致。
  const horizon = scene ? Math.max(scene.horizon, timelineHorizon(envelope)) : 0;

  // 事件/冲突时刻：回放条上的"跳到下一个节点"直接用这些真实时刻。
  const boundaries = useMemo(() => {
    const list: Array<{ t: number; label: string }> = [];
    for (const outage of scene?.outages ?? []) {
      list.push({ t: outage.from, label: `${outage.deviceId} 故障开始` });
      list.push({ t: outage.to, label: `${outage.deviceId} 恢复` });
    }
    for (const task of scene?.tasks ?? []) {
      if (task.status === 'unserved' || task.status === 'blocked') list.push({ t: task.release_s, label: `${task.taskId} ${taskStatusLabel(task.status)}` });
    }
    for (const conflict of (envelope?.result as WarehouseAsrsResult | undefined)?.conflicts ?? []) {
      // 引擎的冲突文案形如「SH-A02-1-L1 在 6259s 等待 PL-01 释放 …」——只认这个时刻，
      // 不从字符串里瞎猜数字（设备号里的数字会骗人）。
      const match = /在\s*([0-9]+(?:\.[0-9]+)?)s/.exec(conflict);
      if (match) list.push({ t: Number(match[1]), label: conflict.slice(0, 40) });
    }
    return list;
  }, [scene, envelope]);

  const clock = usePlayback(horizon, boundaries.map((item) => item.t));

  const load = useCallback((text: string, entry: MockEntry | null) => {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const kind = parsed.kind === 'joint' ? 'joint' : parsed.kind === 'asrs' || parsed.kind === 'dense-asrs' ? 'asrs' : null;
      if (!kind) {
        setDraftError(`本模块接收 kind=asrs（或联合 kind=joint）的问题，收到 ${String(parsed.kind)}`);
        return;
      }
      setDraftError(null);
      setEnvelope(null);
      setSelectedDevice(null);
      setSelectedTask(null);
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
    setNotice('求解中…（含时空预约推演与倒垛；大实例请用较小规模）');
    try {
      const options: Record<string, unknown> = {
        seed,
        includeTimeline,
        // 只送引擎 `AsrsOptions::from_json` 真实实现的键：
        // dualCommand（单/双指令配对）与 verify（是否内嵌独立核验）。
        dualCommand,
        verify: verifyInline,
      };
      if (policy) options.algorithm = policy;
      if (budgetMs > 0) options.budgetMs = budgetMs;
      const outcome = await engine.handle.solve(JSON.stringify(problem.document), options);
      if (!outcome.envelope) {
        setNotice(`求解返回 ${outcome.status}，但没有结果信封：${outcome.error ?? '（无错误信息）'}`);
        return;
      }
      setEnvelope(outcome.envelope);
      setPeakMemoryBytes(outcome.peakMemoryBytes ?? null);
      setSelectedDevice(outcome.envelope.timeline?.devices?.[0]?.deviceId ?? null);
      const params =
        `${policy || '（问题内默认）'} · seed=${seed}${budgetMs ? ` · ${budgetMs}ms` : ''}` +
        `${includeTimeline ? '' : ' · 无时间线'}${dualCommand ? '' : ' · 单指令'}${verifyInline ? '' : ' · 无内嵌核验'}`;
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
      const metrics = outcome.envelope.metrics;
      setNotice(
        `求解完成：${outcome.envelope.status} · 完成 ${fmt(metrics.tasksDone)}/${fmt(metrics.tasksTotal)}` +
          ` · 完工 ${fmt(metrics.makespan_s, 1)}s · 冲突 ${fmt(metrics.conflicts)} · 倒垛 ${fmt(metrics.relocationTasks)}` +
          `（${fmt(outcome.envelope.runtimeMs, 0)} ms）`,
      );
    } catch (err) {
      setNotice(isWarehouseCancelError(err) ? '已取消本次求解（Worker 已终止，下次求解会自动重建）' : `求解失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSolving(false);
      engine.setBusy(false);
    }
  }, [budgetMs, dualCommand, engine, includeTimeline, policy, problem, runs.length, seed, verifyInline]);

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
      setEnvelope((previous) => (previous ? { ...previous, verification: outcome.report ?? previous.verification } : previous));
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
        if (kindOfDocument !== 'asrs' && kindOfDocument !== 'joint') {
          // 边界场景族（X 系列）里混着别的域：如实说明去哪儿打开，而不是静默报 kind 错误。
          setNotice(
            `已生成 ${scenarioId}/${scale}，但它的 kind=${kindOfDocument}：本模块接收 asrs / joint，` +
              '请在“库位优化”模块打开（草稿已放到下面的 JSON 里）。',
          );
          return;
        }
        load(text, {
          file: '（引擎生成）',
          id: scenarioId,
          name: `${scenarioId} · ${scale}`,
          kind: String((out.document as { kind?: string }).kind ?? 'asrs'),
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
  const asrsResult = (envelope?.result as WarehouseAsrsResult | undefined) ?? null;
  const jointResult = joint ? ((envelope?.result as WarehouseJointResult | undefined) ?? null) : null;

  /**
   * 解释项：AS/RS 结果是对象（dispatch/reasons），联合结果是对象（slotting/dispatch/reasons）；
   * 两边的文案都由引擎按本次真实指标生成，面板只做渲染（不写模板话术）。
   */
  const explanationItems = useMemo(() => {
    const items: Array<{ topic: string; text: string }> = [];
    const asrsExplanation = asrsResult?.explanation ?? null;
    const jointExplanation = jointResult?.explanation ?? null;
    const object = asrsExplanation ?? jointExplanation;
    if (object && typeof object === 'object') {
      if (object.slotting) items.push({ topic: '库位侧', text: String(object.slotting) });
      if (object.dispatch) items.push({ topic: '调度侧', text: String(object.dispatch) });
      for (const reason of object.reasons ?? []) items.push({ topic: '依据', text: String(reason) });
      if (object.note) items.push({ topic: '口径', text: String(object.note) });
    }
    if (asrsResult?.policy) items.push({ topic: '策略语义', text: String(asrsResult.policy) });
    return items;
  }, [asrsResult, jointResult]);

  const taskStates: WarehouseTaskState[] = useMemo(() => {
    const fromResult = asrsResult?.taskStates;
    if (Array.isArray(fromResult) && fromResult.length > 0) return fromResult;
    return (envelope?.timeline?.tasks ?? []) as WarehouseTaskState[];
  }, [asrsResult, envelope]);

  const cards: MetricCard[] = useMemo(() => {
    if (!envelope || !metrics) return [];
    const list: MetricCard[] = [];
    const done = metrics.tasksDone ?? 0;
    const total = metrics.tasksTotal ?? 0;
    list.push({
      key: 'tasks',
      label: '完成 / 总任务',
      value: `${fmt(done)} / ${fmt(total)}`,
      hint: metrics.tasksUnserved ? `未服务 ${fmt(metrics.tasksUnserved)}（无解的原因会写在 issues 里）` : undefined,
      tone: metrics.tasksUnserved ? 'bad' : 'good',
    });
    list.push(
      { key: 'makespan', label: '完工时间', value: `${fmt(metrics.makespan_s, 1)} s` },
      { key: 'throughput', label: '吞吐', value: `${fmt(metrics.throughputPerHour, 2)} 件/h` },
      {
        key: 'meancycle',
        label: '平均周期 / 等待',
        value: `${fmt(metrics.meanCycle_s, 1)} / ${fmt(metrics.meanWait_s, 1)} s`,
      },
      {
        key: 'conflicts',
        label: '时空冲突',
        value: fmt(metrics.conflicts),
        tone: (metrics.conflicts ?? 0) === 0 ? 'good' : 'warn',
        hint: `预防死锁 ${fmt(metrics.deadlocksPrevented)} · 预约 ${fmt(metrics.reservations)}`,
      },
      {
        key: 'relocation',
        label: '倒垛任务',
        value: fmt(metrics.relocationTasks),
        hint: `受堵移动 ${fmt(metrics.blockedMoves)}`,
        tone: (metrics.relocationTasks ?? 0) > 0 ? 'warn' : 'normal',
      },
      {
        key: 'dual',
        label: '双指令配对',
        value: fmt(metrics.dualCommandPairs),
        hint: '一趟同时取放，减少空驶',
        tone: (metrics.dualCommandPairs ?? 0) > 0 ? 'good' : 'normal',
      },
      { key: 'travel', label: '行驶里程', value: `${fmt(metrics.travelMeters, 1)} m`, hint: `能耗 ${fmt(metrics.energyKwh, 3)} kWh` },
      {
        key: 'lateness',
        label: '逾期任务',
        value: fmt(metrics.lateTasks),
        hint: metrics.maxLateness_s != null ? `最大逾期 ${fmt(metrics.maxLateness_s, 1)} s` : undefined,
        tone: (metrics.lateTasks ?? 0) > 0 ? 'warn' : 'good',
      },
      { key: 'derived', label: '派生任务完成', value: fmt(metrics.derivedTasksDone), hint: '倒垛等派生动作（不计入 tasksDone）' },
      { key: 'occupy', label: '占用库位', value: fmt(metrics.locationsOccupied) },
      { key: 'sim', label: '搜索重演次数', value: fmt(metrics.searchedSimulations), hint: `算法 ${asrsResult?.policy ?? asrsResult?.algorithm ?? '-'}` },
      { key: 'runtime', label: '求解耗时', value: `${fmt(envelope.runtimeMs, 0)} ms` },
    );
    return list;
  }, [asrsResult, envelope, metrics]);

  const deviceRows = useMemo(() => {
    const rows = (metrics?.deviceUtilization ?? []).map((entry) => {
      const spec = (scene?.topology.devices ?? []).find((device) => device.id === entry.deviceId);
      return {
        deviceId: entry.deviceId,
        kind: spec?.kind ?? '—',
        busySeconds: entry.busySeconds,
        utilization: entry.utilization,
      };
    });
    rows.sort((a, b) => b.utilization - a.utilization);
    return rows;
  }, [metrics, scene]);

  const selectedTaskState = useMemo(
    () => (selectedTask ? taskStates.find((state) => state.taskId === selectedTask) ?? null : null),
    [selectedTask, taskStates],
  );

  return (
    <section className="panel mapf-panel mapf-visual agv-panel" data-visual-module="dense-asrs" data-solution-status={envelope?.status ?? 'idle'}>
      <div className="engine-banner">
        <div>
          <span className="eyebrow">仓储优化 · 高密度立库</span>
          <strong>密集立库调度{joint ? ' · 联合优化' : ''}</strong>
        </div>
        <div className="engine-cluster">
          <span className="chip">
            引擎 {engine.status === 'ready' ? `${engine.manifest?.engine ?? 'warehouse-engine'} v${engine.version}` : engine.status === 'error' ? '装载失败' : '装载中…'}
          </span>
          {capabilities && <span className="chip">档位 {capabilities.profile}</span>}
          {engine.manifest?.selfCheck && (
            <span className="chip" title={JSON.stringify(engine.manifest.selfCheck, null, 1)}>
              自检 {String((engine.manifest.selfCheck as { asrs?: string }).asrs ?? '—')}
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
            kind={joint ? 'joint' : 'asrs'}
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
              <h4>调度参数</h4>
            </div>
            <label className="field">
              <span className="small">策略（来自引擎能力清单）</span>
              <select value={policy} onChange={(event) => setPolicy(event.target.value)} disabled={solving}>
                <option value="">（用问题内声明的策略）</option>
                {algorithms.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.kindLabel} · {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="small">随机种子</span>
              <input type="number" className="input" value={seed} onChange={(event) => setSeed(Number(event.target.value) || 0)} disabled={solving} />
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
              <input type="checkbox" checked={includeTimeline} onChange={(event) => setIncludeTimeline(event.target.checked)} disabled={solving} />
              产出时间线（关闭可显著减小输出，但无法回放与逐步核验）
            </label>
            <label className="layer-toggle small">
              <input type="checkbox" checked={dualCommand} onChange={(event) => setDualCommand(event.target.checked)} disabled={solving} />
              双指令配对（出库 + 入库复合；关闭 = 单指令对照，可对比空驶）
            </label>
            <p className="muted small">
              冲突处理：时空预约（<code>conflictPolicy=reservation</code>，互斥资源 / 井道 / 站台按预约表推迟，
              并做死锁预防）。引擎未实现其他策略，传入非受支持取值会返回 <code>UNSUPPORTED</code>——
              不做静默降级。
            </p>
            <label className="layer-toggle small">
              <input
                type="checkbox"
                checked={verifyInline}
                onChange={(event) => setVerifyInline(event.target.checked)}
                disabled={solving}
              />
              求解时内嵌独立核验（verify；关闭后仍需用「重新核验」单独跑一次才可交付）
            </label>
            {problem?.view && (
              <p className="muted small">
                实例：{problem.view.name ?? '—'} · {String(problem.document.scenarioId ?? '—')} · 规模 {problem.view.scale ?? '—'}
                {scene ? ` · ${scene.counts.aisles} 巷道 / ${scene.counts.locations} 库位 / ${scene.devices.length} 设备` : ''}
              </p>
            )}
            <div className="solve-row">
              <button type="button" className="btn primary" disabled={!engine.handle || !problem || solving} onClick={() => void solve()}>
                {solving ? '求解中…' : joint ? '联合求解' : '求解调度'}
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
              <Asrs3D
                scene={scene}
                layers={layers}
                t={clock.t}
                selectedDevice={selectedDevice}
                onSelectDevice={setSelectedDevice}
                fitNonce={fitNonce}
                active={clock.playing}
              />
            ) : (
              <div className="mapf-visual sandbox-stage stage-loading">
                <p className="muted small">左侧选择内置实例或导入问题 JSON 后，这里按真实时间线回放设备动作。</p>
              </div>
            )}
            <div className="mapf-toolbar">
              <div className="toggles">
                {(
                  [
                    ['rack', '货架'],
                    ['lanes', '巷道负载'],
                    ['stations', '站台/缓冲'],
                    ['devices', '设备'],
                    ['tasks', '任务状态'],
                    ['paths', '选中设备轨迹'],
                    ['relocations', '倒垛/深位让位'],
                  ] as Array<[keyof Asrs3DLayers, string]>
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
                <span className="legend-dot" style={{ background: '#4fe3a7' }} />
                已完成
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#ffb454' }} />
                受堵
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#ff6f6f' }} />
                未服务 / 封闭巷道
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#7fd7ff' }} />
                执行中
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#ffb454' }} />
                被让出的深位
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#a78bfa' }} />
                倒垛落位
              </span>
              <span className="muted">· 姿态由时间线步骤端点插值；轨迹直接画引擎给的 from→to，不做美化</span>
            </div>
            {scene && layers.relocations && (
              <p className="muted small mapf-notice">
                {scene.relocationEvents === 0
                  ? '本次结果没有倒垛事件（目标深位全程未被阻挡，或该实例是单深位货架）——这一层不做占位渲染。'
                  : `倒垛事件 ${scene.relocationEvents} 次，画布显示最近 ${scene.relocations.length} 次（时间轴按事件时刻累积出现）；` +
                    '深位被挡时引擎会在同一时刻写下"让空"与"落位"两条库位状态迁移，这里把它们配成一次让位。'}
              </p>
            )}
          </div>

          <div className="mapf-bottom">
            <PlaybackBar
              clock={clock}
              boundaries={boundaries}
              disabled={!scene || horizon <= 0}
              extra={
                <span className="muted small">
                  {scene ? `${scene.devices.filter((device) => device.track).length}/${scene.devices.length} 台设备在时间线里工作` : ''}
                </span>
              }
            />
            <div className="mapf-metrics muted small">
              {selectedDevice && scene
                ? (() => {
                    const device = scene.devices.find((item) => item.deviceId === selectedDevice);
                    if (!device) return <span>选中设备 {selectedDevice}</span>;
                    return (
                      <span>
                        <strong>{device.deviceId}</strong>（{deviceKindLabel(device.kind)}）·{' '}
                        {device.track
                          ? `步骤 ${device.track.steps.length} 个 · 忙时 ${fmt(device.track.busySeconds, 1)}s · 区间 ${fmt(device.track.firstStart, 1)}–${fmt(device.track.lastEnd, 1)}s`
                          : '时间线里没有动作（空闲/停机）'}
                        {device.utilization != null ? ` · 引擎利用率 ${fmt(device.utilization * 100, 1)}%` : ''}
                        {device.track ? ` · 当前时刻 ${fmt(clock.t, 1)}s` : ''}
                      </span>
                    );
                  })()
                : scene
                  ? '点击画布上的设备可查看它的步骤与利用率；点任务光环可查看任务状态'
                  : '未载入实例'}
            </div>
          </div>
        </div>

        <div className="mapf-rail">
          <section className="rail-group">
            <div className="section-heading section-heading-compact">
              <h4>结果</h4>
              {envelope && <span className="badge">{envelope.status}</span>}
            </div>
            {!envelope && <p className="muted small">还没有结果。载入实例 → 求解 → 时间线、指标与核验会出现在这里。</p>}
            {envelope && <MetricGrid cards={cards} columns={2} />}

            {deviceRows.length > 0 && (
              <details className="mapf-details" open>
                <summary>设备利用率（引擎统计 · 共 {deviceRows.length} 台）</summary>
                <table className="small-table small">
                  <thead>
                    <tr>
                      <th>设备</th>
                      <th>类型</th>
                      <th>忙时(s)</th>
                      <th>利用率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deviceRows.slice(0, 18).map((row) => (
                      <tr key={row.deviceId} className={row.deviceId === selectedDevice ? 'tag--on' : ''}>
                        <td>
                          <button type="button" className="link-btn" onClick={() => setSelectedDevice(row.deviceId)}>
                            {row.deviceId}
                          </button>
                        </td>
                        <td>{deviceKindLabel(row.kind)}</td>
                        <td className="tabular-nums">{fmt(row.busySeconds, 1)}</td>
                        <td className="tabular-nums">{fmt(row.utilization * 100, 1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {deviceRows.length > 18 && <p className="muted small">仅显示利用率最高的 18 台（完整清单在引擎输出的 metrics.deviceUtilization 里）</p>}
              </details>
            )}

            {metrics?.bufferPeak && metrics.bufferPeak.length > 0 && (
              <details className="mapf-details">
                <summary>缓冲峰值 / 站台峰值</summary>
                <ul className="small muted">
                  {metrics.bufferPeak.slice(0, 8).map((entry) => (
                    <li key={entry.bufferId}>
                      {entry.bufferId} 峰值 {entry.peak}
                    </li>
                  ))}
                  {(metrics.stationPeak ?? []).slice(0, 8).map((entry) => (
                    <li key={entry.stationId}>
                      {entry.stationId} 峰值 {entry.peak}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {taskStates.length > 0 && (
              <details className="mapf-details">
                <summary>任务状态（{taskStates.length}）</summary>
                <table className="small-table small">
                  <thead>
                    <tr>
                      <th>任务</th>
                      <th>状态</th>
                      <th>设备</th>
                      <th>起止(s)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {taskStates.slice(0, 24).map((state) => (
                      <tr key={state.taskId} className={state.taskId === selectedTask ? 'tag--on' : ''}>
                        <td>
                          <button type="button" className="link-btn" onClick={() => setSelectedTask(state.taskId)}>
                            {state.taskId}
                          </button>
                        </td>
                        <td>{taskStatusLabel(state.status)}</td>
                        <td>{(state.deviceIds ?? []).join('+') || '—'}</td>
                        <td className="tabular-nums">
                          {fmt(state.start_s, 1)}–{fmt(state.end_s, 1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}

            {selectedTaskState && (
              <div className="notice">
                <strong>{selectedTaskState.taskId}</strong>
                {` · ${taskStatusLabel(selectedTaskState.status)} · 设备 ${(selectedTaskState.deviceIds ?? []).join('+') || '—'}`}
                {selectedTaskState.note ? ` · ${selectedTaskState.note}` : ''}
                <button type="button" className="btn tiny" onClick={() => clock.seekToEvent(Math.max(0, Number(selectedTaskState.start_s) - 1))}>
                  跳到该任务
                </button>
              </div>
            )}

            {scene && scene.outages.length > 0 && (
              <details className="mapf-details" open>
                <summary>动态事件（故障 / 停机，共 {scene.outages.length} 条）</summary>
                <ul className="small">
                  {scene.outages.slice(0, 12).map((outage, index) => (
                    <li key={index}>
                      <button type="button" className="link-btn" onClick={() => clock.seekToEvent(outage.from)}>
                        {fmt(outage.from, 0)}s
                      </button>{' '}
                      {outage.deviceId} · {outage.note} · 恢复于 {fmt(outage.to, 0)}s
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {scene && scene.closedAisles.length > 0 && (
              <div className="notice notice--warn">
                封闭巷道：{scene.closedAisles.join('、')}（来自问题事件 `aisle-closure`；画布上以珊瑚色标出，这些巷道不会有任何设备动作）
              </div>
            )}

            {explanationItems.length > 0 && (
              <details className="mapf-details" open>
                <summary>为什么这么调度（可复述的解释）</summary>
                <ul className="small">
                  {explanationItems.map((item, index) => (
                    <li key={index}>
                      <strong>{item.topic}</strong>：{item.text}
                    </li>
                  ))}
                </ul>
                <p className="muted small">
                  改善幅度按"同实例、换策略/指令模式再跑一次"的口径算：运行历史里逐指标给出更好/更差方向（不做跨规模比较）。
                </p>
              </details>
            )}

            {asrsResult?.conflicts && asrsResult.conflicts.length > 0 && (
              <details className="mapf-details">
                <summary>冲突/让行记录（{asrsResult.conflicts.length}）</summary>
                <ul className="small muted">
                  {asrsResult.conflicts.slice(0, 20).map((conflict, index) => (
                    <li key={index}>{conflict}</li>
                  ))}
                </ul>
              </details>
            )}

            {jointResult?.rounds && jointResult.rounds.length > 0 && (
              <details className="mapf-details">
                <summary>联合闭环轮次</summary>
                <table className="small-table small">
                  <thead>
                    <tr>
                      <th>轮</th>
                      <th>库位算法</th>
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
                        <td className="tabular-nums">{round.tasksDone}</td>
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
              <p className="muted small">
                Pareto 前沿：{jointResult.pareto.length} 个非支配点 · {jointResult.paretoNote ?? ''}
              </p>
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
              setSelectedDevice(run.envelope.timeline?.devices?.[0]?.deviceId ?? null);
            }}
            onDelete={(id) => setRuns((previous) => previous.filter((run) => run.id !== id))}
          />
        </div>
      </div>

      {envelope && (
        <div className="footbar">
          <EnvelopeFooter envelope={envelope} peakMemoryBytes={peakMemoryBytes} />
          <span className="muted small">
            策略 {String(asrsResult?.policy ?? asrsResult?.algorithm ?? jointResult?.algorithm ?? '—')} · 时间线{' '}
            {envelope.timeline ? `${(envelope.timeline.devices ?? []).length} 台设备 / ${(envelope.timeline.tasks ?? []).length} 任务` : '未产出'}
          </span>
        </div>
      )}
    </section>
  );
}
