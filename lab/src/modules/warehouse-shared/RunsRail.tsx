/** 运行历史面板（两个新模块共用）：选点、对比、删除；对比语义与 AGV/MAPF 一致。 */

import { useMemo, useState } from 'react';
import { fmtNum, MAX_RUNS } from '../../core/runs';
import {
  compareWarehouseRuns,
  sameWarehouseProblem,
  type WarehouseRunDiffRow,
  type WarehouseRunRecord,
} from './runs';

export interface RunsRailProps {
  runs: WarehouseRunRecord[];
  activeId: string | null;
  onSelect: (run: WarehouseRunRecord) => void;
  onDelete: (id: string) => void;
}

/** 联合优化：把某一轮的调度指标覆盖到记录上，便于与整体运行做对比。 */
function withRound(run: WarehouseRunRecord): WarehouseRunRecord {
  if (!run.roundSnapshot) return run;
  const round = run.roundSnapshot;
  return {
    ...run,
    tasksDone: round.tasksDone,
    makespan: round.makespan_s,
    conflicts: round.conflicts,
    relocationCount: round.relocationTasks ?? round.relocationCount ?? null,
    jointObjective: round.jointObjective,
    verified: round.verified,
  };
}

export function RunsRail({ runs, activeId, onSelect, onDelete }: RunsRailProps) {
  const [baseId, setBaseId] = useState<string | null>(null);
  const [otherId, setOtherId] = useState<string | null>(null);
  const history = useMemo(() => {
    const items: WarehouseRunRecord[] = [];
    for (const run of runs) {
      items.push(run);
      for (const step of run.rounds ?? []) {
        items.push({ ...run, id: `${run.id}#r${step.round}`, roundSnapshot: step });
      }
    }
    return items;
  }, [runs]);

  const { base, other, rows } = useMemo(() => {
    const baseRun = history.find((run) => run.id === baseId) ?? null;
    const otherRun =
      history.find((run) => run.id === otherId) ??
      (baseRun ? history.find((run) => run.id !== baseRun.id) ?? null : null);
    const diff =
      baseRun && otherRun
        ? compareWarehouseRuns(withRound(baseRun), withRound(otherRun))
        : ([] as WarehouseRunDiffRow[]);
    return { base: baseRun, other: otherRun, rows: diff };
  }, [history, baseId, otherId]);

  const comparable = base && other ? sameWarehouseProblem(base, other) : true;

  return (
    <div className="runs-panel">
      <div className="section-heading section-heading-compact">
        <h4>运行历史</h4>
        <span className="muted small">{history.length} 条（上限 {MAX_RUNS}）</span>
      </div>
      {history.length === 0 && <p className="muted small">求解后会在这里留下记录（含指纹与核验结论）。</p>}
      <ul className="run-list">
        {history.map((run) => (
          <li key={run.id} className={`run-row${run.id === activeId ? ' tag--on' : ''}`}>
            <button type="button" className="link-btn" onClick={() => onSelect(run)} title="载入该次运行">
              <strong>{run.id}</strong>
              <span className="tag tag--tight">{run.status}</span>
              <span className="muted small">{run.paramSummary}</span>
            </button>
            <span className="muted small tabular-nums">
              {run.tasksTotal ? `${fmtNum(run.tasksDone)}/${fmtNum(run.tasksTotal)}` : ''}
              {run.makespan != null ? ` · ${fmtNum(run.makespan, 1)}s` : ''}
              {run.verified === false ? ' · 核验未过' : run.verified ? ' · 已核验' : ''}
            </span>
            <span className="row-actions">
              <button type="button" className="btn tiny" onClick={() => setBaseId(run.id)} title="设为对比基准">
                基准
              </button>
              <button type="button" className="btn tiny" onClick={() => setOtherId(run.id)} title="设为对比对象">
                对比
              </button>
              <button type="button" className="btn tiny" onClick={() => onDelete(run.id)} title="删除">
                ✕
              </button>
            </span>
          </li>
        ))}
      </ul>
      {base && other && base.id !== other.id && (
        <div className="compare-result">
          <div className="compare-controls">
            <span className="muted small">
              基准 {base.id} ↔ {other.id}
            </span>
            {!comparable && <span className="warn-text small">两次运行的问题不同，数值不可直接比较</span>}
          </div>
          <table className="runs-table small">
            <thead>
              <tr>
                <th>指标</th>
                <th>{base.id}</th>
                <th>{other.id}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.label}>
                  <td>{item.label}</td>
                  <td className="tabular-nums">{item.a}</td>
                  <td className={`tabular-nums${item.verdict === 'better' ? ' ok-text' : item.verdict === 'worse' ? ' warn-text' : ''}`}>
                    {item.b}
                    {item.verdict === 'better' ? ' ↑' : item.verdict === 'worse' ? ' ↓' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
