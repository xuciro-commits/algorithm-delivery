/**
 * APS 实验模块主面板。
 *
 * 需求对照：
 *  - 导入已有 Mock 和用户自己的 PlanProblem → 数据选择 + 文件导入（仅存浏览器本地）；
 *  - 设置种子、求解时间、优化目标及搜索规则 → 参数区（含预设档位）；
 *  - 展示甘特图、资源使用、排程结果与约束验证结果 → GanttChart / ResourcePanel / VerifyPanel；
 *  - 首解时间、总耗时、内存统计、目标值 → MetricsPanel；
 *  - 同一问题下多次运行及方案对比 → RunsPanel；
 *  - 正确处理求解中断与 Worker 生命周期 → 运行中可“取消”，运行器自动重建 Worker。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EngineManifest, PlanProblemLike } from '../../core/types';
import type { RunRecord } from '../../core/aps/records';
import {
  DEFAULT_PARAMS,
  PARAM_PRESETS,
  RULES,
  RULE_LABELS,
  paramsLabel,
  validateParams,
  type Rule,
  type SolveParams,
  type Strategy,
} from '../../core/aps/params';
import {
  clearPersistedImports,
  entriesFromManifest,
  importProblem,
  loadPersistedImports,
  loadProblem,
  persistImports,
  type ProblemEntry,
} from '../../core/aps/mocks';
import { metricCards } from '../../core/aps/transform';
import type { Runner } from '../../core/aps/engine';
import { GanttChart } from '../../components/GanttChart';
import { Gantt, type GanttTimeScale } from '../../components/gantt';
import { adaptApsToGantt } from '../../components/gantt/apsAdapter';
import { MetricsPanel } from '../../components/MetricsPanel';
import { ResourcePanel } from '../../components/ResourcePanel';
import { VerifyPanel } from '../../components/VerifyPanel';
import { RunsPanel } from '../../components/RunsPanel';
import { Segmented } from '../../components/hud';
import { ApsSandbox3D } from './Sandbox3D';
import { opsBusyAt, projectApsLine } from './projection';
import { PlaybackClock, type Speed } from '../mapf/playback/clock';

export interface ApsPanelProps {
  manifest: EngineManifest | null;
  runner: Runner | null;
  engineReady: boolean;
  engineVersion: string;
  assetUrl: (path: string) => string;
  cancelSolve: () => boolean;
}

type Tab = 'gantt' | 'resources' | 'runs' | 'raw';

export function ApsPanel({
  manifest,
  runner,
  engineReady,
  engineVersion,
  assetUrl,
  cancelSolve,
}: ApsPanelProps) {
  const catalog = useMemo(() => entriesFromManifest(manifest), [manifest]);
  const [imported, setImported] = useState<ProblemEntry[]>(() => loadPersistedImports());
  const entries = useMemo(() => [...catalog, ...imported], [catalog, imported]);
  const featured = useMemo(
    () => catalog.filter((entry) => entry.kind === 'baseline' || entry.kind === 'scenario'),
    [catalog],
  );

  const [selectedId, setSelectedId] = useState<string>('mock/baseline.json');
  const [problem, setProblem] = useState<PlanProblemLike | null>(null);
  const [loadedProblemId, setLoadedProblemId] = useState<string | null>(null);
  const [problemLoading, setProblemLoading] = useState(false);
  const [problemError, setProblemError] = useState<string | null>(null);
  const [params, setParams] = useState<SolveParams>(DEFAULT_PARAMS);
  const [strict, setStrict] = useState(false);
  const [phase, setPhase] = useState<string>('');
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('gantt');
  const [selectedOp, setSelectedOp] = useState<string | null>(null);
  /** 3D 产线是否只画“排程里真的有工序”的设备（未排产设备不占位）。 */
  const [onlyScheduledLines, setOnlyScheduledLines] = useState(true);
  const [ganttMode, setGanttMode] = useState<'line3d' | 'advanced' | 'classic'>('line3d');
  const [apsPlaying, setApsPlaying] = useState(false);
  const [apsSpeed, setApsSpeed] = useState<Speed>(2);
  const [apsStep, setApsStep] = useState(0);
  const apsClockRef = useRef<PlaybackClock | null>(null);
  if (typeof window !== 'undefined' && !apsClockRef.current) apsClockRef.current = new PlaybackClock();
  const [ganttTimeScale, setGanttTimeScale] = useState<GanttTimeScale>('day');
  const [ganttCritical, setGanttCritical] = useState(false);
  const [ganttBaseline, setGanttBaseline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const selected = entries.find((e) => e.id === selectedId) ?? entries[0];
  const activeRun = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null;
  const paramErrors = validateParams(params);
  const operationLimit = runner?.capabilities?.max_operations ?? manifest?.capabilities?.max_operations ?? 600;
  const exceedsOperationLimit = Boolean(selected && selected.operations > operationLimit);
  const problemReady = Boolean(selected && problem && loadedProblemId === selected.id);

  const advancedGantt = useMemo(() => {
    if (!problem || !activeRun?.solution) return { tasks: [], dependencies: [] };
    return adaptApsToGantt(problem, activeRun.solution);
  }, [problem, activeRun?.solution]);

  // 首次进入自动选中 baseline
  useEffect(() => {
    if (!selectedId && entries.length > 0) setSelectedId(entries[0].id);
  }, [entries, selectedId]);

  // 切换数据时加载问题文本
  useEffect(() => {
    if (!selected) {
      setProblem(null);
      setLoadedProblemId(null);
      setProblemLoading(false);
      return;
    }
    let cancelled = false;
    setProblem(null);
    setLoadedProblemId(null);
    setProblemLoading(true);
    setProblemError(null);
    loadProblem(selected, assetUrl)
      .then((p) => {
        if (!cancelled) {
          setProblem(p);
          setLoadedProblemId(selected.id);
          setSelectedOp(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setProblemError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setProblemLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, assetUrl]);

  const handleImport = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const added: ProblemEntry[] = [];
      const errors: string[] = [];
      const fileList = Array.from(files);
      if (fileList.length > 5) errors.push('一次最多选择 5 个文件，超出的文件未处理');

      for (const file of fileList.slice(0, 5)) {
        if (file.size > 2 * 1024 * 1024) {
          errors.push(`${file.name}: 文件超过 2 MiB 上限`);
          continue;
        }
        try {
          const text = await file.text();
          const result = importProblem(text, file.name);
          if (result.ok) added.push(...(result.entries ?? (result.entry ? [result.entry] : [])));
          else errors.push(`${file.name}: ${result.error}`);
        } catch (err) {
          errors.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const uniqueAdded = [...new Map(added.map((entry) => [entry.id, entry])).values()];
      const messages: string[] = [];
      if (uniqueAdded.length > 0) {
        const next = [...uniqueAdded, ...imported.filter((entry) => !uniqueAdded.some((addedEntry) => addedEntry.id === entry.id))];
        setImported(next);
        const persisted = persistImports(next);
        setSelectedId(uniqueAdded[0].id);
        if (uniqueAdded[0].kind === 'standard-benchmark') {
          setParams((current) => ({ ...current, strategy: 'makespan' }));
        }
        messages.push(
          persisted
            ? `已加载 ${uniqueAdded.length} 个案例（浏览器本地处理，不会上传）；刷新后保留最近 5 个`
            : `已加载 ${uniqueAdded.length} 个案例；浏览器存储不可用，本次页面会话仍可运行`,
        );
      }
      if (errors.length > 0) messages.push(errors.join('；'));
      if (messages.length > 0) setNotice(messages.join('；'));
      if (fileInput.current) fileInput.current.value = '';
    },
    [imported],
  );

  const run = useCallback(async () => {
    if (!runner || !problemReady || !problem || !selected || exceedsOperationLimit) return;
    if (paramErrors.length > 0) {
      setNotice(paramErrors.join('；'));
      return;
    }
    setBusy(true);
    setNotice(null);
    setPhase('准备');
    try {
      const record = await runner.run({
        problem,
        problemName: selected.name,
        params,
        strict,
        verify: true,
        onPhase: (p, detail) =>
          setPhase(
            p === 'solving'
              ? '求解中（WASM 在 Worker 内同步执行）'
              : p === 'verifying'
                ? `核验中${detail ? `：${detail}` : ''}`
                : p === 'fingerprinting'
                  ? '计算方案指纹'
                  : '完成',
          ),
      });
      record.label = `${selected.name} ${paramsLabel(params)}`;
      setRuns((prev) => [record, ...prev].slice(0, 20));
      setActiveRunId(record.id);
      setTab('gantt');
      if (record.status === 'CANCELLED') {
        setNotice('上一次求解已取消：Worker 已终止并将按需重建，可直接再次运行。');
      } else if (record.error) {
        setNotice(`求解未完成：${record.error}`);
      }
    } finally {
      setBusy(false);
      setPhase('');
    }
  }, [runner, problemReady, problem, selected, params, strict, paramErrors, exceedsOperationLimit]);

  const onCancel = useCallback(() => {
    const did = cancelSolve();
    setNotice(did ? '已请求取消（终止 Worker）…' : '当前没有在途求解。');
  }, [cancelSolve]);

  const cards = activeRun ? metricCards(activeRun.solution ?? {}, activeRun.metrics.wallMs) : [];

  // —— 产线 3D 投影：设备网格 + 工序区间（全部来自引擎解，见 ./projection.ts） ——
  const APS_STEPS = 240;
  const aps3d = useMemo(
    () => {
      // 只画真正排产的产线：资源清单里 operations === 0 的设备不占位，
      // 这样 3D 里“有几条线在跑”与排程结果一致（未排产设备可在界面上放出来）。
      const resources = activeRun?.resources ?? [];
      const used = onlyScheduledLines ? resources.filter((r) => (r.operations ?? 0) > 0) : resources;
      return projectApsLine(activeRun?.gantt ?? null, used);
    },
    [activeRun?.gantt, activeRun?.resources, onlyScheduledLines],
  );
  const previewMachines = useMemo(() => (problem?.machines ?? []).map((machine) => machine.id), [problem]);

  /** 当前回放时刻（毫秒）与该时刻在制工序数（浮层读数）。 */
  const apsNowMs = aps3d.minMs + ((aps3d.maxMs - aps3d.minMs) * apsStep) / Math.max(1, APS_STEPS);
  const apsBusyNow = opsBusyAt(aps3d.ops, apsNowMs).length;

  // 新结果 → 时钟量程重设；播放中只更新读数（不打断回放）
  useEffect(() => {
    const clock = apsClockRef.current;
    if (!clock) return;
    clock.setRange(APS_STEPS, 0);
    setApsStep(0);
    clock.onTick((t, playing) => {
      setApsStep(t);
      setApsPlaying(playing);
    });
    return () => clock.onTick(null);
  }, [aps3d.minMs, aps3d.maxMs]);

  useEffect(() => () => apsClockRef.current?.dispose(), []);

  // 离开甘特页签即暂停回放（3D 产线只在甘特页签内渲染）
  useEffect(() => {
    if (tab !== 'gantt') apsClockRef.current?.pause();
  }, [tab]);
  const chooseEntry = (entry: ProblemEntry) => {
    setSelectedId(entry.id);
    if (entry.kind === 'standard-benchmark') {
      setParams((current) => ({ ...current, strategy: 'makespan' }));
    }
    if (imported.some((stored) => stored.id === entry.id)) {
      const recent = [entry, ...imported.filter((stored) => stored.id !== entry.id)];
      persistImports(recent);
    }
  };

  return (
    <div className="aps-panel" data-visual-module="aps" data-solution-status={activeRun?.solution?.status ?? activeRun?.status ?? 'idle'} data-solution-operations={activeRun?.gantt?.operationCount ?? 0}>
      <section className="panel controls">
        <div className="section-heading">
          <div>
            <span className="eyebrow">01 / CASE LIBRARY</span>
            <h2>选择一个排程场景</h2>
            <p>内置案例已随页面打包，无需上传数据；引擎加载完成后即可运行。</p>
          </div>
          <span className="local-pill"><i aria-hidden="true" />本地数据</span>
        </div>

        <div className="dataset-grid" aria-label="常用内置案例">
          {featured.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={selected?.id === entry.id}
              className={`dataset-card ${selected?.id === entry.id ? 'selected' : ''}`}
              onClick={() => chooseEntry(entry)}
            >
              <span className="dataset-card-top">
                <span className={`kind-pill kind-${entry.kind}`}>{kindLabel(entry.kind)}</span>
                <span className="dataset-card-mark" aria-hidden="true">
                  {selected?.id === entry.id ? '✓' : '↗'}
                </span>
              </span>
              <strong>{entry.name}</strong>
              <span className="dataset-description">{entry.description}</span>
              <span className="dataset-stats">
                <span><b>{entry.orders}</b><small>订单</small></span>
                <span><b>{entry.operations}</b><small>工序</small></span>
                <span><b>{entry.machines}</b><small>机器</small></span>
              </span>
            </button>
          ))}
        </div>

        <label className="field dataset-picker">
          全部案例（含构建基准与最近导入）
          <select
            value={selected?.id ?? ''}
            onChange={(event) => {
              const entry = entries.find((item) => item.id === event.target.value);
              if (entry) chooseEntry(entry);
            }}
          >
            <optgroup label="内置案例与规模基准">
              {catalog.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  [{kindLabel(entry.kind)}] {entry.name} · {entry.orders} 订单 / {entry.operations} 工序
                </option>
              ))}
            </optgroup>
            {imported.length > 0 && (
              <optgroup label="浏览器本地导入">
                {imported.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    [{kindLabel(entry.kind)}] {entry.name} · {entry.orders} 订单 / {entry.operations} 工序
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        {selected && (
          <div className="selected-summary">
            <div className="selected-copy">
              <div className="selected-badges">
                <span className={`kind-pill kind-${selected.kind}`}>{kindLabel(selected.kind)}</span>
                {selected.source && <span className="source-label">{selected.source}</span>}
              </div>
              <strong>{selected.name}</strong>
              <p>{selected.description}</p>
              {selected.expect && <span className="expect-note">评测提示 · {selected.expect}</span>}
            </div>
            <div className="selected-stats">
              <span><b>{selected.orders}</b><small>订单</small></span>
              <span><b>{selected.operations}</b><small>工序</small></span>
              <span><b>{selected.machines}</b><small>机器</small></span>
            </div>
          </div>
        )}

        <div className="import-card">
          <div className="import-icon" aria-hidden="true">↥</div>
          <div className="import-copy">
            <span className="eyebrow">OPTIONAL / LOCAL IMPORT</span>
            <h3>接入公开基准或自有问题</h3>
            <p>支持 PlanProblem JSON、Brandimarte / FJSPLib FJSP 文本、OR-Library jobshop1 JSSP 文件。</p>
            <div className="import-links">
              <a href="https://scheduleopt.github.io/benchmarks/fjsplib/" target="_blank" rel="noreferrer">FJSPLib / Brandimarte ↗</a>
              <a href="https://people.brunel.ac.uk/~mastjjb/jeb/orlib/jobshopinfo.html" target="_blank" rel="noreferrer">OR-Library JSSP ↗</a>
            </div>
            <small>本地解析，不会上传。单文件 ≤ 2 MiB；标准集合每文件最多 100 个实例 / 50,000 道工序，每个实例最多 600 道；一次最多选择 5 个文件。标准集按 makespan 转换，其他 APS 约束采用通用人员与连续日历假设。</small>
          </div>
          <input
            ref={fileInput}
            className="visually-hidden-file"
            type="file"
            accept="application/json,.json,.fjs,.fjsp,.jsp,.jssp,.txt"
            multiple
            aria-label="选择 PlanProblem 或标准排程 benchmark 文件"
            onChange={(event) => void handleImport(event.target.files)}
          />
          <div className="import-actions">
            <button type="button" className="secondary" onClick={() => fileInput.current?.click()}>
              选择文件
            </button>
            {imported.length > 0 && (
              <button
                type="button"
                className="link danger"
                onClick={() => {
                  clearPersistedImports();
                  setImported([]);
                  setSelectedId(catalog[0]?.id ?? 'mock/baseline.json');
                }}
              >
                清空导入
              </button>
            )}
          </div>
        </div>

        <div className="section-heading section-heading-compact solver-heading">
          <div>
            <span className="eyebrow">02 / SOLVER</span>
            <h3>求解配置</h3>
          </div>
          <span className="config-hint">浏览器 WASM · 上限 {operationLimit} 工序</span>
        </div>

        <div className="presets">
          {PARAM_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              title={preset.note}
              className={paramsLabel(preset.params) === paramsLabel(params) ? 'active' : ''}
              onClick={() => setParams(preset.params)}
            >
              {preset.name}
            </button>
          ))}
        </div>

        <div className="param-grid">
          <label className="field">
            种子 seed
            <input
              type="number"
              min={0}
              value={params.seed}
              onChange={(event) => setParams({ ...params, seed: Number(event.target.value) })}
            />
          </label>
          <label className="field">
            求解时间（ms）
            <input
              type="number"
              min={50}
              step={50}
              value={params.timeLimitMs}
              onChange={(event) => setParams({ ...params, timeLimitMs: Number(event.target.value) })}
            />
          </label>
          <label className="field">
            优化目标
            <select
              value={params.strategy}
              onChange={(event) => setParams({ ...params, strategy: event.target.value as Strategy })}
            >
              <option value="lexicographic">lexicographic（先压延期，再压 makespan）</option>
              <option value="makespan">makespan（先压总工期）</option>
            </select>
          </label>
          <label className="field">
            搜索规则
            <select
              value={params.rule}
              onChange={(event) => setParams({ ...params, rule: event.target.value as Rule })}
            >
              {RULES.map((rule) => (
                <option key={rule} value={rule}>
                  {RULE_LABELS[rule]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            迭代上限
            <input
              type="number"
              min={0}
              value={params.maxIterations}
              onChange={(event) => setParams({ ...params, maxIterations: Number(event.target.value) })}
            />
          </label>
          <label className="field checkbox">
            <input
              type="checkbox"
              checked={params.repair}
              onChange={(event) => setParams({ ...params, repair: event.target.checked })}
            />
            启用局部修复（ruin &amp; recreate）
          </label>
          <label className="field checkbox">
            <input type="checkbox" checked={strict} onChange={(event) => setStrict(event.target.checked)} />
            严格核验（要求 tenant_id / problem_hash 绑定）
          </label>
        </div>

        <div className="run-row">
          <button
            type="button"
            className="primary"
            disabled={!engineReady || !problemReady || problemLoading || busy || exceedsOperationLimit}
            onClick={() => void run()}
          >
            {busy ? '运行中…' : '运行排程'}
          </button>
          <button type="button" disabled={!busy} onClick={onCancel}>
            取消（终止 Worker）
          </button>
          {busy && <span className="muted small">{phase}</span>}
        </div>
        {problemLoading && <p className="muted small">正在准备所选案例…</p>}
        {problemError && <p className="bad-text small" role="alert">数据加载失败：{problemError}</p>}
        {exceedsOperationLimit && (
          <p className="warn-text small" role="status">
            当前实例有 {selected?.operations} 道工序，超过此引擎的 {operationLimit} 道上限；数据仍可查看，但不能在该档位运行。
          </p>
        )}
        {notice && <p className="notice small" role="status">{notice}</p>}
        {!engineReady && (
          <p className="engine-wait-note">
            <i aria-hidden="true" />案例与参数已就绪；引擎加载完成后可运行。若长时间未就绪，请查看顶部错误提示并重试。
          </p>
        )}
      </section>

      <section className="panel results">
        <div className="results-head">
          <h3>运行结果</h3>
          {activeRun && (
            <span className="muted small">
              {activeRun.problemName} · 引擎 v{activeRun.engineVersion ?? engineVersion} ·{' '}
              {paramsLabel(activeRun.params)}
              {activeRun.workerRestarted && ' · Worker 曾重建'}
            </span>
          )}
        </div>

        {!activeRun && (
          <>
            {previewMachines.length > 0 && (
              <section className="aps-static-preview" aria-label="求解前生产线预览">
                <div className="aps-preview-heading">
                  <span className="eyebrow">WORKCELL / IDLE</span>
                  <span className="muted small">静态设备结构 · 尚未执行调度 · 工件只在真实排程区间出现</span>
                </div>
                <div className="lab-stage aps-stage" data-testid="aps-static-stage">
                  <ApsSandbox3D
                    machines={previewMachines}
                    ops={[]}
                    minMs={0}
                    maxMs={1}
                    step={0}
                    steps={APS_STEPS}
                    playing={false}
                    selectedOp={null}
                  />
                  <div className="stage-float stage-float-tl">
                    <span className="stage-note">{previewMachines.length} 个设备单元</span>
                    <span className="stage-note">待求解 · 无虚构工件或路径</span>
                  </div>
                </div>
              </section>
            )}
            <div className="empty-state aps-empty-state">
              <span className="eyebrow">RESULTS / PREVIEW</span>
              <h4>还没有排程结果</h4>
              <p>运行真实 APS 引擎后，这里会出现产线状态、甘特图、资源负载与独立核验结果。</p>
              <div className="empty-tags"><span>甘特图</span><span>资源使用</span><span>方案对比</span><span>约束核验</span></div>
            </div>
          </>
        )}

        {activeRun && (
          <>
            <MetricsPanel cards={cards} />

            <div className="tabs">
              <button type="button" className={tab === 'gantt' ? 'active' : ''} onClick={() => setTab('gantt')}>
                甘特图
              </button>
              <button type="button" className={tab === 'resources' ? 'active' : ''} onClick={() => setTab('resources')}>
                资源使用
              </button>
              <button type="button" className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>
                多次运行与对比（{runs.length}）
              </button>
              <button type="button" className={tab === 'raw' ? 'active' : ''} onClick={() => setTab('raw')}>
                原始输出
              </button>
            </div>

            {tab === 'gantt' && (
              <>
                <div className="hud-row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <Segmented
                    ariaLabel="排程视图"
                    value={ganttMode}
                    onChange={(mode) => {
                      setGanttMode(mode);
                      if (mode !== 'line3d') apsClockRef.current?.pause();
                    }}
                    options={[
                      { id: 'line3d', label: '3D 产线' },
                      { id: 'advanced', label: '工业甘特' },
                      { id: 'classic', label: '紧凑甘特' },
                    ]}
                  />
                  <span className="muted small">
                    {ganttMode === 'line3d'
                      ? '工件只在引擎给出的工序区间内出现在设备上；细发光线 = 同一订单的真实工序先后'
                      : ganttMode === 'advanced'
                        ? '支持 Ctrl/⌘+滚轮缩放、工序依赖箭头连线、关键路径高亮、基线对比与 SVG/PNG 导出'
                        : '按实际排程完工时间自适应撑满，顶部刻度吸顶'}
                  </span>
                </div>

                {ganttMode === 'line3d' ? (
                  <div className="lab-stage aps-stage">
                    <ApsSandbox3D
                      machines={aps3d.machines}
                      ops={aps3d.ops}
                      minMs={aps3d.minMs}
                      maxMs={aps3d.maxMs}
                      step={apsStep}
                      steps={APS_STEPS}
                      playing={apsPlaying}
                      selectedOp={selectedOp}
                      onSelectOp={(opId) => setSelectedOp(opId)}
                    />
                    <div className="stage-vignette" aria-hidden="true" />
                    <div className="stage-float stage-float-tl">
                      <span className="stage-note">T = {apsStep} / {APS_STEPS}</span>
                      <span className="stage-note">{fmtApsTime(apsNowMs)}</span>
                      <span className="stage-note">
                        在制 {apsBusyNow} 道工序 · {aps3d.machines.length} 台设备
                      </span>
                      <button
                        type="button"
                        className={`btn tiny ${onlyScheduledLines ? 'primary' : ''}`}
                        title="只画排程结果里真正有工序的产线；关掉则连未排产的设备一起显示"
                        onClick={() => setOnlyScheduledLines((v) => !v)}
                      >
                        {onlyScheduledLines ? '仅排产产线' : '含未排产'}
                      </button>
                    </div>
                    <div className="stage-float stage-float-bl">
                      <div className="mapf-play">
                        <button
                          type="button"
                          className="btn tiny"
                          onClick={() => {
                            apsClockRef.current?.seek(0);
                            setApsStep(0);
                          }}
                        >
                          ⏮
                        </button>
                        <button type="button" className="btn tiny" onClick={() => apsClockRef.current?.step(-1)}>
                          ◀
                        </button>
                        <button type="button" className="btn tiny primary" onClick={() => apsClockRef.current?.toggle()}>
                          {apsPlaying ? '⏸' : '▶'}
                        </button>
                        <button type="button" className="btn tiny" onClick={() => apsClockRef.current?.step(1)}>
                          ▶
                        </button>
                        <input
                          type="range"
                          min={0}
                          max={APS_STEPS}
                          value={apsStep}
                          aria-label="排程回放进度"
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            apsClockRef.current?.seek(v);
                            setApsStep(v);
                          }}
                          style={{ width: 180 }}
                        />
                        <select
                          value={apsSpeed}
                          onChange={(e) => {
                            const v = Number(e.target.value) as Speed;
                            setApsSpeed(v);
                            apsClockRef.current?.setSpeed(v);
                          }}
                          aria-label="播放速度"
                        >
                          {[0.25, 0.5, 1, 2, 4, 8].map((v) => (
                            <option key={v} value={v}>
                              {v}×
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                ) : ganttMode === 'advanced' ? (
                  <div className="aps-gantt-glass">
                    <Gantt
                      tasks={advancedGantt.tasks}
                      dependencies={advancedGantt.dependencies}
                      timeScale={ganttTimeScale}
                      onTimeScaleChange={setGanttTimeScale}
                      showCritical={ganttCritical}
                      onShowCriticalChange={setGanttCritical}
                      showBaseline={ganttBaseline}
                      onShowBaselineChange={setGanttBaseline}
                      readOnly={true}
                      selectedTaskId={selectedOp ?? undefined}
                      onTaskSelect={(id) => setSelectedOp(id)}
                    />
                  </div>
                ) : (
                  <GanttChart model={activeRun.gantt} selectedOp={selectedOp} onSelectOp={(bar) => setSelectedOp(bar?.opId ?? null)} />
                )}

                {selectedOp && (
                  <p className="muted small">
                    已选工序 <code>{selectedOp}</code>：点击其他工序可切换。资源与物料轨迹见 CLI `aps explain`（实验室仅展示排程结果与核验结论）。
                  </p>
                )}
              </>
            )}
            {tab === 'resources' && <ResourcePanel usage={activeRun.resources} timelines={activeRun.timelines} />}
            {tab === 'runs' && (
              <RunsPanel
                runs={runs}
                activeId={activeRun.id}
                onSelect={(r) => {
                  setActiveRunId(r.id);
                  setTab('gantt');
                }}
                onDelete={(id) => setRuns((prev) => prev.filter((r) => r.id !== id))}
              />
            )}
            {tab === 'raw' && (
              <pre className="raw-json">{activeRun.raw ? safePretty(activeRun.raw) : '（无输出）'}</pre>
            )}

            <h3>约束验证结果</h3>
            <VerifyPanel report={activeRun.verify} strict={strict} fingerprint={activeRun.fingerprint} />
          </>
        )}
      </section>
    </div>
  );
}

function kindLabel(kind: ProblemEntry['kind']): string {
  const labels: Record<ProblemEntry['kind'], string> = {
    baseline: 'BASELINE',
    scenario: 'SCENARIO',
    benchmark: 'BENCHMARK',
    custom: 'CUSTOM',
    imported: 'LOCAL',
    'standard-benchmark': 'PUBLIC BENCHMARK',
  };
  return labels[kind];
}

function safePretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 排程时间（毫秒）→ MM-DD HH:mm（面板浮层与读数共用同一口径）。 */
function fmtApsTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
