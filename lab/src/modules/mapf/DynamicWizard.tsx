/**
 * 动态事件向导（M0 §9）：回放模式内子模式（受控组件，状态在 MapfPanel）。
 * ① 在 t=T 注入事件 → ② 选类型（含改目标/作废路径的机器人）→ ③ 地图点选目标格
 * → ④ 预览 dynamic 块 + 冻结窗 → ⑤ 重新规划（真实 WASM 求解）。
 * 无法执行的操作说明原因（提交前预检 + 引擎 errors 原文照登），不伪造成功。
 */

import { useMemo } from 'react';
import type { SceneDoc } from './scene/SceneDoc';
import type { MapfSolution } from '../../core/mapf/types';
import { buildDynamic, precheckDynamic, type DynamicEventInput } from './dynamic/contractBlock';

export type WizardKind = DynamicEventInput['kind'] | null;

export interface DynamicWizardProps {
  scene: SceneDoc;
  solution: MapfSolution;
  time: number;
  maxT: number;
  maxEvents: number;
  busy: boolean;
  events: DynamicEventInput[];
  kind: WizardKind;
  robot: string;
  frozenSteps: number;
  pickLabel: string | null;
  onPickKind: (kind: WizardKind, robot?: string) => void;
  onRobotChange: (robot: string) => void;
  onRemoveEvent: (index: number) => void;
  onFrozenChange: (n: number) => void;
  onSubmit: (problemText: string, frozenAt: number) => void;
  onCancel: () => void;
}

const KINDS: Array<{ id: DynamicEventInput['kind']; label: string; hint: string }> = [
  { id: 'obstacle_add', label: '加障碍', hint: '点选一个格子：该格自 at 起变为障碍' },
  { id: 'obstacle_remove', label: '移除障碍', hint: '点选一个障碍格：自 at 起恢复可通行' },
  { id: 'goal_change', label: '改目标', hint: '选择机器人后点新终点' },
  { id: 'path_invalid', label: '作废路径', hint: '选择一台机器人：其规划路径作废重排' },
];

export function DynamicWizard(props: DynamicWizardProps) {
  const { scene, solution, time, maxT, maxEvents, busy, events, kind, robot, frozenSteps } = props;

  const built = useMemo(
    () => buildDynamic({ scene, solution, time, frozenSteps, events, maxEvents }),
    [scene, solution, time, frozenSteps, events, maxEvents],
  );
  const issues = useMemo(() => precheckDynamic(events, built, scene), [events, built, scene]);
  const needsRobot = kind === 'goal_change' || kind === 'path_invalid';

  return (
    <div className="dynamic-wizard">
      <header>
        <b>⚡ 在 t={time} 注入动态事件</b>
        <button type="button" className="btn tiny" onClick={props.onCancel}>
          关闭
        </button>
      </header>
      <ol className="wizard-steps">
        <li className="muted small">
          时间轴已定位 t={time}（0–{maxT}）；事件生效时刻 at = {time}
        </li>
        <li>
          事件类型：
          <div className="wizard-kinds">
            {KINDS.map((k) => (
              <button key={k.id} type="button" className={`btn tiny ${kind === k.id ? 'primary' : ''}`} title={k.hint} onClick={() => props.onPickKind(k.id, k.id === 'goal_change' || k.id === 'path_invalid' ? solution.robots?.[0]?.id : undefined)}>
                {k.label}
              </button>
            ))}
          </div>
          {kind && needsRobot && (
            <label className="field">
              机器人
              <select value={robot} onChange={(e) => props.onRobotChange(e.target.value)}>
                {(solution.robots ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id}
                  </option>
                ))}
              </select>
            </label>
          )}
          {props.pickLabel && <p className="muted small">▸ {props.pickLabel}</p>}
        </li>
        <li>
          已排事件（{events.length}）：{events.length === 0 && <span className="muted small">在地图上点选目标格</span>}
          <ul className="event-list">
            {events.map((e, i) => (
              <li key={i}>
                <code>{e.kind}</code> {'cell' in e ? `(${e.cell[0]},${e.cell[1]})` : 'robot' in e ? e.robot : ''} at={e.at}
                <button type="button" className="btn tiny" onClick={() => props.onRemoveEvent(i)}>
                  移除
                </button>
              </li>
            ))}
          </ul>
        </li>
        <li>
          冻结窗 frozen_steps：
          <input type="range" min={0} max={4} value={frozenSteps} onChange={(e) => props.onFrozenChange(Number(e.target.value))} />
          <span className="tabular-nums">{frozenSteps}</span>
          <span className="muted small">（承诺 [T, T+{frozenSteps}] 内原路径不变）</span>
        </li>
      </ol>
      <details className="mapf-details">
        <summary>将提交的 dynamic 块（JSON 预览，高级用户可核对）</summary>
        <pre>{JSON.stringify(built, null, 2)}</pre>
      </details>
      {issues.length > 0 && (
        <div className="error-panel small">
          {issues.map((it, i) => (
            <p key={i}>⚠ {it.message}</p>
          ))}
        </div>
      )}
      <footer>
        <button
          type="button"
          className="btn primary tiny"
          disabled={busy || events.length === 0 || issues.length > 0}
          onClick={() => {
            const problem: Record<string, unknown> = {
              schema_version: scene.schema_version,
              id: `${scene.id}-dyn`,
              map: { cells: scene.map.cells },
              time_model: scene.time_model,
              objective: scene.objective,
              robots: scene.robots,
              solver: scene.solver,
              dynamic: built,
            };
            props.onSubmit(JSON.stringify(problem), time + frozenSteps);
          }}
        >
          {busy ? '重规划中…' : '重新规划（真实求解）'}
        </button>
        <span className="muted small">提交 = 基础场景 + dynamic 块 → WASM 引擎重解</span>
      </footer>
    </div>
  );
}
