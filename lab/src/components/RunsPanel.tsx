/**
 * 运行列表与方案对比：同一问题下的多次运行并排比较（需求：“支持同一问题下的多次运行及方案对比”）。
 *
 * 对比口径与 CLI `compare` 一致：`(machine_id, worker_id, start_at)` 三元组变化即计为“变更工序”。
 * 指纹相同则说明两次求解给出的是同一个方案（引擎确定性，见 solver/mod.rs 的契约说明）。
 */

import { useMemo, useState } from 'react';
import type { RunRecord } from '../core/aps/records';
import { compareRuns } from '../core/aps/transform';
import { paramsLabel } from '../core/aps/params';

export interface RunsPanelProps {
  runs: RunRecord[];
  onSelect: (run: RunRecord) => void;
  onDelete: (id: string) => void;
  activeId?: string | null;
}

function num(v: number | null, digits = 1): string {
  return v === null ? '—' : v.toFixed(digits);
}

function signed(v: number | null, digits = 1): string {
  if (v === null) return '—';
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}

export function RunsPanel({ runs, onSelect, onDelete, activeId }: RunsPanelProps) {
  const [baseId, setBaseId] = useState<string | null>(null);
  const [otherId, setOtherId] = useState<string | null>(null);

  const comparison = useMemo(() => {
    const base = runs.find((r) => r.id === baseId);
    const other = runs.find((r) => r.id === otherId);
    if (!base || !other || base.id === other.id) return null;
    return compareRuns(base, other);
  }, [runs, baseId, otherId]);

  if (runs.length === 0) {
    return <p className="muted">还没有运行记录。设置参数后点击“运行”，每次结果都会保留在这里。</p>;
  }

  return (
    <div className="runs-panel">
      <table className="data-table runs-table">
        <thead>
          <tr>
            <th>#</th>
            <th>数据</th>
            <th>参数</th>
            <th>状态</th>
            <th>加权延期</th>
            <th>makespan</th>
            <th>首解</th>
            <th>总耗时</th>
            <th>内存</th>
            <th>核验</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map((run, i) => {
            const obj = run.solution?.objective ?? {};
            const late = (obj.late_orders as number | undefined) ?? null;
            return (
              <tr key={run.id} className={activeId === run.id ? 'active' : ''}>
                <td>{runs.length - i}</td>
                <td className="small">
                  {run.problemName}
                  {run.snapshotId && <div className="muted small">{run.snapshotId}</div>}
                </td>
                <td className="small">{paramsLabel(run.params)}</td>
                <td>
                  <span className={`status status-${run.status.toLowerCase()}`}>{run.status}</span>
                  {run.cancelled && <div className="muted small">已取消</div>}
                  {run.error && <div className="warn-text small">{run.error}</div>}
                </td>
                <td>{String(obj.weighted_tardiness_minutes ?? '—')}</td>
                <td>{String(obj.makespan_minutes ?? '—')}</td>
                <td>{num(run.metrics.firstFeasibleMs)} ms</td>
                <td>{num(run.metrics.totalMs)} ms</td>
                <td>{run.metrics.peakMemoryBytes === null ? '—' : `${(run.metrics.peakMemoryBytes / 1048576).toFixed(2)} MB`}</td>
                <td>{run.verify ? (run.verify.ok ? '✓' : `✗ ${run.verify.counts?.errors ?? '?'}`) : '—'}</td>
                <td className="row-actions">
                  <button type="button" className="link" onClick={() => onSelect(run)}>
                    查看
                  </button>
                  <button type="button" className="link danger" onClick={() => onDelete(run.id)}>
                    删除
                  </button>
                  {late !== null && late > 0 && <span className="muted small">延期 {late}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="compare-controls">
        <label>
          对比基准
          <select value={baseId ?? ''} onChange={(e) => setBaseId(e.target.value || null)}>
            <option value="">选择…</option>
            {runs.map((r, i) => (
              <option key={r.id} value={r.id}>
                #{runs.length - i} {r.problemName} {paramsLabel(r.params)}
              </option>
            ))}
          </select>
        </label>
        <label>
          对比对象
          <select value={otherId ?? ''} onChange={(e) => setOtherId(e.target.value || null)}>
            <option value="">选择…</option>
            {runs.map((r, i) => (
              <option key={r.id} value={r.id}>
                #{runs.length - i} {r.problemName} {paramsLabel(r.params)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {comparison && (
        <div className="compare-result">
          <h4>方案对比</h4>
          <p className="small">
            变更工序 {comparison.changedOperations} / 可比 {comparison.comparedOperations}
            {comparison.sameFingerprint ? ' · 方案指纹相同（同一方案）' : ' · 方案指纹不同'}
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>指标</th>
                <th>差值（对象 − 基准）</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>加权延期（分钟）</td>
                <td>{signed(comparison.deltas.weightedTardiness)}</td>
              </tr>
              <tr>
                <td>makespan（分钟）</td>
                <td>{signed(comparison.deltas.makespan)}</td>
              </tr>
              <tr>
                <td>首解时间（ms）</td>
                <td>{signed(comparison.deltas.firstFeasibleMs)}</td>
              </tr>
              <tr>
                <td>总耗时（ms）</td>
                <td>{signed(comparison.deltas.totalMs)}</td>
              </tr>
              <tr>
                <td>峰值内存（字节）</td>
                <td>{signed(comparison.deltas.peakMemoryBytes, 0)}</td>
              </tr>
            </tbody>
          </table>
          {comparison.changed.length > 0 && (
            <details>
              <summary>变更的工序（{comparison.changed.length}）</summary>
              <table className="data-table small">
                <thead>
                  <tr>
                    <th>工序</th>
                    <th>基准</th>
                    <th>对象</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.changed.slice(0, 50).map((c) => (
                    <tr key={c.opId}>
                      <td>
                        <code>{c.opId}</code>
                      </td>
                      <td>{c.from}</td>
                      <td>{c.to}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {comparison.changed.length > 50 && <p className="muted small">仅显示前 50 条。</p>}
            </details>
          )}
        </div>
      )}
    </div>
  );
}
