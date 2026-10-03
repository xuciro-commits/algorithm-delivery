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
import { MetricsPanel } from '../../components/MetricsPanel';
import { ResourcePanel } from '../../components/ResourcePanel';
import { VerifyPanel } from '../../components/VerifyPanel';
import { RunsPanel } from '../../components/RunsPanel';

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

  const [selectedId, setSelectedId] = useState<string>('');
  const [problem, setProblem] = useState<PlanProblemLike | null>(null);
  const [problemError, setProblemError] = useState<string | null>(null);
  const [params, setParams] = useState<SolveParams>(DEFAULT_PARAMS);
  const [strict, setStrict] = useState(false);
  const [phase, setPhase] = useState<string>('');
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('gantt');
  const [selectedOp, setSelectedOp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const selected = entries.find((e) => e.id === selectedId) ?? entries[0];
  const activeRun = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null;
  const paramErrors = validateParams(params);

  // 首次进入自动选中 baseline
  useEffect(() => {
    if (!selectedId && entries.length > 0) setSelectedId(entries[0].id);
  }, [entries, selectedId]);

  // 切换数据时加载问题文本
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setProblemError(null);
    loadProblem(selected, assetUrl)
      .then((p) => {
        if (!cancelled) {
          setProblem(p);
          setSelectedOp(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setProblem(null);
          setProblemError(err instanceof Error ? err.message : String(err));
        }
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
      for (const file of Array.from(files).slice(0, 5)) {
        const text = await file.text();
        const result = importProblem(text, file.name);
        if (result.ok && result.entry) added.push(result.entry);
        else errors.push(`${file.name}: ${result.error}`);
      }
      if (added.length > 0) {
        setImported((prev) => {
          const next = [...added, ...prev.filter((p) => !added.some((a) => a.id === p.id))];
          persistImports(next);
          return next;
        });
        setSelectedId(added[0].id);
        setNotice(`已导入 ${added.length} 个数据（仅保存在浏览器本地，不会上传）`);
      }
      if (errors.length > 0) setNotice(errors.join('；'));
      if (fileInput.current) fileInput.current.value = '';
    },
    [],
  );

  const run = useCallback(async () => {
    if (!runner || !problem || !selected) return;
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
  }, [runner, problem, selected, params, strict, paramErrors]);

  const onCancel = useCallback(() => {
    const did = cancelSolve();
    setNotice(did ? '已请求取消（终止 Worker）…' : '当前没有在途求解。');
  }, [cancelSolve]);

  const cards = activeRun ? metricCards(activeRun.solution ?? {}, activeRun.metrics.wallMs) : [];

  return (
    <div className="aps-panel">
      <section className="panel controls">
        <h3>数据与参数</h3>

        <label className="field">
          测试数据（内置 Mock / 基准 / 导入）
          <select value={selected?.id ?? ''} onChange={(e) => setSelectedId(e.target.value)}>
            {entries.map((e) => (
              <option key={e.id} value={e.id}>
                [{e.kind}] {e.name}（{e.orders} 订单 / {e.operations} 工序）
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <p className="muted small">
            {selected.description}
            {selected.expect && <> · 本例看点：{selected.expect}</>}
          </p>
        )}

        <div className="import-row">
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            multiple
            onChange={(e) => void handleImport(e.target.files)}
          />
          <span className="muted small">导入自己的 PlanProblem JSON（本地解析，不上传）</span>
          {imported.length > 0 && (
            <button
              type="button"
              className="link danger"
              onClick={() => {
                clearPersistedImports();
                setImported([]);
                setSelectedId(catalog[0]?.id ?? '');
              }}
            >
              清空导入
            </button>
          )}
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
              onChange={(e) => setParams({ ...params, seed: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            求解时间（ms）
            <input
              type="number"
              min={50}
              step={50}
              value={params.timeLimitMs}
              onChange={(e) => setParams({ ...params, timeLimitMs: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            优化目标
            <select
              value={params.strategy}
              onChange={(e) => setParams({ ...params, strategy: e.target.value as Strategy })}
            >
              <option value="lexicographic">lexicographic（先压延期，再压 makespan）</option>
              <option value="makespan">makespan（先压总工期）</option>
            </select>
          </label>
          <label className="field">
            搜索规则
            <select
              value={params.rule}
              onChange={(e) => setParams({ ...params, rule: e.target.value as Rule })}
            >
              {RULES.map((r) => (
                <option key={r} value={r}>
                  {RULE_LABELS[r]}
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
              onChange={(e) => setParams({ ...params, maxIterations: Number(e.target.value) })}
            />
          </label>
          <label className="field checkbox">
            <input
              type="checkbox"
              checked={params.repair}
              onChange={(e) => setParams({ ...params, repair: e.target.checked })}
            />
            启用局部修复（ruin &amp; recreate）
          </label>
          <label className="field checkbox">
            <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
            严格核验（要求 tenant_id / problem_hash 绑定）
          </label>
        </div>

        <div className="run-row">
          <button type="button" className="primary" disabled={!engineReady || !problem || busy} onClick={() => void run()}>
            {busy ? '运行中…' : '运行'}
          </button>
          <button type="button" disabled={!busy} onClick={onCancel}>
            取消（终止 Worker）
          </button>
          {busy && <span className="muted small">{phase}</span>}
        </div>
        {problemError && <p className="bad-text small">数据加载失败：{problemError}</p>}
        {notice && <p className="notice small">{notice}</p>}
        {!engineReady && <p className="muted small">引擎尚未就绪，请等待顶部状态条变为绿色。</p>}
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

        {!activeRun && <p className="muted">还没有结果。点击“运行”开始。</p>}

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
                <GanttChart model={activeRun.gantt} selectedOp={selectedOp} onSelectOp={(bar) => setSelectedOp(bar?.opId ?? null)} />
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

function safePretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
