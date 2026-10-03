/**
 * MAPF 右栏：问题清单 · 机器人列表 · 选中车详情 · 冲突与核验 · 图层控制 · 运行历史
 * （M0 §5.3/§6/§8/§4.4/§10）。纯展示 + 回调，无引擎依赖。
 */

import type { PrecheckIssue } from './scene/precheck';
import type { SceneDoc } from './scene/SceneDoc';
import type { MapfSolution, MapfIssue } from '../../core/mapf/types';
import type { RunRecord } from './runs/runs';
import { waitSteps } from './playback/clock';
import { robotColor } from './render/MapfLayers';

export interface LayerFlags {
  goals: boolean;
  paths: boolean;
  executed: boolean;
  robots: boolean;
  conflicts: boolean;
  events: boolean;
}

export interface ViolationItem {
  code: string;
  robots?: string[];
  at_time?: number;
  cell?: [number, number];
  message: string;
}

export interface MapfRightRailProps {
  doc: SceneDoc;
  issues: PrecheckIssue[];
  solution: MapfSolution | null;
  verifyChecks: Array<{ name: string; ok: boolean }> | null;
  verifyViolations: ViolationItem[];
  primary: string | null;
  selected: string[];
  layers: LayerFlags;
  runs: RunRecord[];
  onSelectRobot: (id: string) => void;
  onSetPrimary: (id: string) => void;
  onToggleLayer: (key: keyof LayerFlags) => void;
  onLocateIssue: (issue: PrecheckIssue) => void;
  onLocateViolation: (v: ViolationItem) => void;
  onCompare: (a: RunRecord, b: RunRecord) => void;
}

export function MapfRightRail(props: MapfRightRailProps) {
  const { doc, issues, solution, verifyChecks, verifyViolations, primary, selected, layers, runs } = props;
  const robots = solution?.robots ?? [];
  const detail = robots.find((r) => r.id === primary);

  return (
    <div className="mapf-rail">
      {issues.length > 0 && (
        <section className="rail-group">
          <h4>
            问题清单 <span className="badge bad-text">{issues.filter((i) => i.level === 'error').length} 项</span>
          </h4>
          <ul className="issue-list">
            {issues.slice(0, 12).map((it, i) => (
              <li key={i} className={it.level} onClick={() => props.onLocateIssue(it)}>
                <code>{it.code}</code> {it.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rail-group">
        <h4>机器人（{robots.length || doc.robots.length}）</h4>
        <div className="robot-list">
          {(robots.length ? robots.map((r, i) => ({ id: r.id, i, sub: r.arrival != null ? `t=${r.arrival} 到达` : '—' })) : doc.robots.map((r, i) => ({ id: r.id, i, sub: r.goal ? '' : '终点未设' }))).map((r) => (
            <button
              key={r.id}
              type="button"
              className={`robot-row ${primary === r.id ? 'active' : ''} ${selected.includes(r.id) ? 'multi' : ''}`}
              onClick={() => props.onSetPrimary(r.id)}
            >
              <span className="mapf-swatch" style={{ background: robotColor(r.i) }} />
              <span className="robot-id">{r.id}</span>
              <span className="muted small">{r.sub}</span>
            </button>
          ))}
        </div>
      </section>

      {detail && (
        <section className="rail-group">
          <h4>选中车 · {detail.id}</h4>
          <table className="data-table small-table">
            <tbody>
              <tr>
                <td>起点 → 终点</td>
                <td>
                  ({detail.start[0]},{detail.start[1]}) → ({detail.goal[0]},{detail.goal[1]})
                </td>
              </tr>
              <tr>
                <td>到达时刻</td>
                <td>{detail.arrival ?? '—'}</td>
              </tr>
              <tr>
                <td>步数 / 等待</td>
                <td>
                  {detail.steps ?? (detail.path?.length ?? 1) - 1} / {waitSteps(detail)}
                </td>
              </tr>
              <tr>
                <td>冻结前缀</td>
                <td>{detail.locked ? '是' : '—'}</td>
              </tr>
            </tbody>
          </table>
          <details className="mapf-details">
            <summary>逐步明细（{detail.path?.length ?? 0} 步）</summary>
            <div className="step-table">
              {(detail.path ?? []).slice(0, 200).map((p, t) => {
                const prev = t > 0 ? detail.path[t - 1] : null;
                const moved = prev ? p[0] !== prev[0] || p[1] !== prev[1] : true;
                const label = t === detail.arrival ? '√ 到达' : moved ? (prev ? (p[0] > prev[0] ? '→' : p[0] < prev[0] ? '←' : p[1] > prev[1] ? '↓' : '↑') : '起') : '⏸ 等待';
                return (
                  <div key={t} className="step-row">
                    <span className="tabular-nums">t={t}</span>
                    <span>
                      ({p[0]},{p[1]})
                    </span>
                    <span className={moved ? '' : 'muted'}>{label}</span>
                  </div>
                );
              })}
            </div>
          </details>
        </section>
      )}

      <section className="rail-group">
        <h4>冲突与核验</h4>
        {verifyChecks && (
          <ul className="check-list">
            {verifyChecks.map((c, i) => (
              <li key={i} className={c.ok ? 'ok' : 'bad'}>
                {c.ok ? '✓' : '✗'} {c.name}
              </li>
            ))}
          </ul>
        )}
        {verifyViolations.length > 0 ? (
          <ul className="violation-list">
            {verifyViolations.map((v, i) => (
              <li key={i} onClick={() => props.onLocateViolation(v)}>
                <code>{v.code}</code>
                {v.at_time != null && <span className="muted small"> t={v.at_time}</span>}
                {v.cell && (
                  <span className="muted small">
                    {' '}
                    ({v.cell[0]},{v.cell[1]})
                  </span>
                )}
                <div className="small">{v.message}</div>
              </li>
            ))}
          </ul>
        ) : (
          verifyChecks && <p className="muted small">✓ {verifyChecks.filter((c) => c.ok).length} 项检查全部通过（独立验证器）</p>
        )}
        {(solution?.errors?.length ?? 0) > 0 && (
          <div className="error-panel small">
            {(solution!.errors as MapfIssue[]).slice(0, 6).map((e, i) => (
              <p key={i}>
                <code>{e.code}</code> {e.message}
              </p>
            ))}
          </div>
        )}
      </section>

      <section className="rail-group">
        <h4>图层</h4>
        <div className="layer-grid">
          {(Object.keys(layers) as Array<keyof LayerFlags>).map((k) => (
            <label key={k} className="layer-toggle">
              <input type="checkbox" checked={layers[k]} onChange={() => props.onToggleLayer(k)} />
              {LAYER_LABEL[k]}
            </label>
          ))}
        </div>
      </section>

      <section className="rail-group">
        <h4>运行历史（{runs.length}/20）</h4>
        {runs.length === 0 && <p className="muted small">暂无运行</p>}
        <div className="run-list">
          {[...runs].reverse().slice(0, 8).map((r) => (
            <div key={r.seq} className="run-row">
              <span className="muted small">#{r.seq}</span>
              <span className={`badge ${r.status === 'OPTIMAL' ? 'ok' : r.status === 'FEASIBLE' ? 'warn' : 'muted-badge'}`}>{r.status}</span>
              <span className="small">
                SOC {r.soc ?? '—'} · {r.solveMs ?? '—'} ms{r.verified === false ? ' · ✗核验' : ''}
              </span>
            </div>
          ))}
        </div>
        {runs.length >= 2 && (
          <ComparePicker runs={runs} onCompare={props.onCompare} />
        )}
      </section>
    </div>
  );
}

const LAYER_LABEL: Record<keyof LayerFlags, string> = {
  goals: '起终点',
  paths: '规划路径',
  executed: '已执行轨迹',
  robots: '机器人',
  conflicts: '冲突标记',
  events: '事件标记',
};

function ComparePicker({ runs, onCompare }: { runs: RunRecord[]; onCompare: (a: RunRecord, b: RunRecord) => void }) {
  const sameHash = (a: RunRecord, b: RunRecord) => Boolean(a.problemHash && a.problemHash === b.problemHash);
  const last = runs[runs.length - 1];
  const candidates = runs.filter((r) => r !== last && sameHash(r, last));
  return (
    <div className="compare-picker">
      {candidates.length === 0 ? (
        <p className="muted small">最近两次运行问题不同（指纹不一致）——同问题重跑后可对比</p>
      ) : (
        <button type="button" className="btn tiny" onClick={() => onCompare(candidates[candidates.length - 1], last)}>
          对比最近两次同题运行
        </button>
      )}
    </div>
  );
}
