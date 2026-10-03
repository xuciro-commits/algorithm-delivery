/**
 * AGV 动态事件向导（V2 §5-2 / COMPONENT-DESIGN §5）：回放模式内的子模式。
 * ① 回放定位 t=T → ② 选事件类型 → ③（按需）点选格子 / 选车辆 / 选任务 / 填新任务参数
 * → ④ 预览 dynamic 块 + 提交前预检 → ⑤ 真实 WASM 重调度（旧计划保留为对照）。
 * 无法执行的操作如实说明原因；引擎 errors 原文照登，不伪造成功。
 */

import { useMemo } from 'react';
import type { AgvSolution } from '../../core/agv/types';
import { buildAgvDynamic, precheckAgvDynamic, type AgvDynamicEventInput, type BuiltAgvDynamic } from './dynamic/contractBlock';
import { locCells, type AgvScene } from './scene';

export type AgvWizardKind = AgvDynamicEventInput['kind'] | null;

export interface AgvDynamicWizardProps {
  scene: AgvScene;
  solution: AgvSolution;
  time: number;
  maxT: number;
  maxEvents: number;
  busy: boolean;
  events: AgvDynamicEventInput[];
  kind: AgvWizardKind;
  pendingCell: [number, number] | null;
  editingIndex: number | null;
  taskPickTarget: 'pickup' | 'dropoff';
  /** 新任务草稿（task_add 用）。 */
  draft: {
    id: string;
    pickup: [number, number] | null;
    dropoff: [number, number] | null;
    pickupService: number;
    dropoffService: number;
    releaseStep: number;
    priority: number;
    dueStep: number | null;
    requiredCapability: string;
  };
  /** 事件目标选择（task_cancel / task_priority / vehicle_pause / vehicle_resume）。 */
  targetTask: string;
  targetVehicle: string;
  priority: number;
  /** obstacle_add 的 until（null = 永久）。 */
  until: number | null;
  pickLabel: string | null;
  onPickKind: (kind: AgvWizardKind) => void;
  onDraftChange: (patch: Partial<AgvDynamicWizardProps['draft']>) => void;
  onTargetTaskChange: (id: string) => void;
  onTargetVehicleChange: (id: string) => void;
  onPriorityChange: (n: number) => void;
  onUntilChange: (n: number | null) => void;
  onRemoveEvent: (index: number) => void;
  onEditEvent: (index: number) => void;
  onTaskPickTargetChange: (target: 'pickup' | 'dropoff') => void;
  onAddEvent: () => void;
  onSubmit: (built: BuiltAgvDynamic) => void;
  onCancel: () => void;
}

const KINDS: Array<{ id: AgvDynamicEventInput['kind']; label: string; hint: string }> = [
  { id: 'task_add', label: '新增任务', hint: '填写任务参数后「加入事件列表」；取/送点也可在地图上点选' },
  { id: 'task_cancel', label: '取消任务', hint: '选择任务：尚未开始/完成的任务才能取消' },
  { id: 'task_priority', label: '改优先级', hint: '选择任务并设新优先级（≥1）' },
  { id: 'vehicle_pause', label: '暂停车辆', hint: '选择车辆：该车在 T 时刻起暂停' },
  { id: 'vehicle_resume', label: '恢复车辆', hint: '选择车辆：该车在 T 时刻起恢复' },
  { id: 'obstacle_add', label: '加障碍', hint: '点选一个空格：该格自 T 起变为障碍' },
  { id: 'obstacle_remove', label: '移除障碍', hint: '点选一个障碍格：自 T 起恢复通行' },
];

function eventLabel(e: AgvDynamicEventInput): string {
  switch (e.kind) {
    case 'task_add':
      return `新增任务 ${e.taskId}（${Array.isArray(e.pickup) ? e.pickup.join(',') : e.pickup.station} → ${
        Array.isArray(e.dropoff) ? e.dropoff.join(',') : e.dropoff.station
      }，p=${e.priority}）`;
    case 'task_cancel':
      return `取消任务 ${e.task}`;
    case 'task_priority':
      return `任务 ${e.task} 优先级 → ${e.priority}`;
    case 'vehicle_pause':
      return `暂停车辆 ${e.vehicle}`;
    case 'vehicle_resume':
      return `恢复车辆 ${e.vehicle}`;
    case 'obstacle_add':
      return `加障碍 (${e.cell[0]},${e.cell[1]})${e.until != null ? ` 至 t=${e.until}` : '（永久）'}`;
    case 'obstacle_remove':
      return `移除障碍 (${e.cell[0]},${e.cell[1]})`;
  }
}

export function AgvDynamicWizard(props: AgvDynamicWizardProps) {
  const { scene, solution, time, maxT, maxEvents, busy, events, kind, draft, pickLabel, pendingCell, editingIndex, taskPickTarget } = props;

  const built = useMemo(
    () => buildAgvDynamic({ scene, solution, time, events, maxEvents }),
    [scene, solution, time, events, maxEvents],
  );
  const issues = useMemo(() => precheckAgvDynamic({ scene, solution, time, events, maxEvents }, built), [
    scene,
    solution,
    time,
    events,
    maxEvents,
    built,
  ]);
  const draftEvent = useMemo<AgvDynamicEventInput | null>(() => {
    if (!kind) return null;
    if (kind === 'obstacle_add' && pendingCell) return { kind, cell: pendingCell, until: props.until };
    if (kind === 'obstacle_remove' && pendingCell) return { kind, cell: pendingCell };
    if (kind === 'task_add' && draft.id.trim() && draft.pickup && draft.dropoff) {
      return {
        kind,
        taskId: draft.id.trim(),
        pickup: draft.pickup,
        dropoff: draft.dropoff,
        pickupService: draft.pickupService,
        dropoffService: draft.dropoffService,
        releaseStep: draft.releaseStep,
        priority: draft.priority,
        dueStep: draft.dueStep,
        requiredCapability: draft.requiredCapability.trim() || null,
      };
    }
    if (kind === 'task_cancel' && props.targetTask) return { kind, task: props.targetTask };
    if (kind === 'task_priority' && props.targetTask) return { kind, task: props.targetTask, priority: props.priority };
    if (kind === 'vehicle_pause' && props.targetVehicle) return { kind, vehicle: props.targetVehicle };
    if (kind === 'vehicle_resume' && props.targetVehicle) return { kind, vehicle: props.targetVehicle };
    return null;
  }, [kind, pendingCell, props.until, draft, props.targetTask, props.targetVehicle, props.priority]);
  const previewEvents = useMemo(() => {
    if (!draftEvent) return events;
    if (editingIndex == null) return [...events, draftEvent];
    return events.map((event, index) => (index === editingIndex ? draftEvent : event));
  }, [events, draftEvent, editingIndex]);
  const previewBuilt = useMemo(
    () => buildAgvDynamic({ scene, solution, time, events: previewEvents, maxEvents }),
    [scene, solution, time, previewEvents, maxEvents],
  );
  const previewIssues = useMemo(
    () => precheckAgvDynamic({ scene, solution, time, events: previewEvents, maxEvents }, previewBuilt),
    [scene, solution, time, previewEvents, maxEvents, previewBuilt],
  );
  const draftIssues = draftEvent
    ? previewIssues.filter((issue) => issue.eventIndex === (editingIndex ?? events.length) || issue.eventIndex == null)
    : [];
  const cannotAddDraft = busy || !draftEvent || draftIssues.length > 0 || (editingIndex == null && events.length >= maxEvents);

  const needsCell = kind === 'obstacle_add' || kind === 'obstacle_remove';
  const needsTask = kind === 'task_cancel' || kind === 'task_priority';
  const needsVehicle = kind === 'vehicle_pause' || kind === 'vehicle_resume';

  return (
    <div className="dynamic-wizard">
      <header>
        <b>⚡ 在 t={time} 注入动态事件</b>
        <button type="button" className="btn tiny" onClick={props.onCancel} disabled={busy}>
          关闭
        </button>
      </header>

      <ol className="wizard-steps">
        <li className="muted small">
          时间轴已定位 t={time}（0–{maxT}）；快照 = 当前解在 T 的投影（pos / path / 任务状态），事件在 T 生效
        </li>

        <li>
          事件类型：
          <div className="wizard-kinds">
            {KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                className={`btn tiny ${kind === k.id ? 'primary' : ''}`}
                title={k.hint}
                onClick={() => props.onPickKind(k.id)}
              >
                {k.label}
              </button>
            ))}
          </div>
          {kind && <p className="muted small">{KINDS.find((k) => k.id === kind)?.hint}</p>}
          {pickLabel && <p className="warn-text small">{pickLabel}</p>}
        </li>

        {kind === 'task_add' && (
          <li>
            <div className="param-grid">
              <label className="field">
                任务 id
                <input value={draft.id} onChange={(e) => props.onDraftChange({ id: e.target.value })} placeholder="T-new" />
              </label>
              <label className="field">
                取货点
                <input value={draft.pickup ? `${draft.pickup[0]},${draft.pickup[1]}` : ''} readOnly placeholder="选择后在地图点格" />
              </label>
              <label className="field">
                送达点
                <input value={draft.dropoff ? `${draft.dropoff[0]},${draft.dropoff[1]}` : ''} readOnly placeholder="选择后在地图点格" />
              </label>
              <label className="field">
                取货服务
                <input type="number" min={0} value={draft.pickupService} onChange={(e) => props.onDraftChange({ pickupService: Number(e.target.value) || 0 })} />
              </label>
              <label className="field">
                送达服务
                <input type="number" min={0} value={draft.dropoffService} onChange={(e) => props.onDraftChange({ dropoffService: Number(e.target.value) || 0 })} />
              </label>
              <label className="field">
                释放步
                <input type="number" min={0} value={draft.releaseStep} onChange={(e) => props.onDraftChange({ releaseStep: Number(e.target.value) || 0 })} />
              </label>
              <label className="field">
                优先级
                <input type="number" min={1} value={draft.priority} onChange={(e) => props.onDraftChange({ priority: Math.max(1, Number(e.target.value) || 1) })} />
              </label>
              <label className="field">
                交期步（可空）
                <input
                  type="number"
                  min={0}
                  value={draft.dueStep ?? ''}
                  onChange={(e) => props.onDraftChange({ dueStep: e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
              <label className="field">
                能力要求（可空）
                <input value={draft.requiredCapability} onChange={(e) => props.onDraftChange({ requiredCapability: e.target.value })} placeholder="如 cold" />
              </label>
            </div>
            <div className="wizard-target-pick">
              <button type="button" className={`btn tiny ${taskPickTarget === 'pickup' ? 'primary' : ''}`} onClick={() => props.onTaskPickTargetChange('pickup')}>
                地图选择取货点
              </button>
              <button type="button" className={`btn tiny ${taskPickTarget === 'dropoff' ? 'primary' : ''}`} onClick={() => props.onTaskPickTargetChange('dropoff')}>
                地图选择送达点
              </button>
              <span className="muted small">当前地图点击设置：{taskPickTarget === 'pickup' ? '取货点' : '送达点'}</span>
            </div>
          </li>
        )}

        {needsTask && (
          <li>
            <label className="field">
              目标任务
              <select value={props.targetTask} onChange={(e) => props.onTargetTaskChange(e.target.value)}>
                {scene.tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id}
                  </option>
                ))}
              </select>
            </label>
            {kind === 'task_priority' && (
              <label className="field">
                新优先级
                <input type="number" min={1} value={props.priority} onChange={(e) => props.onPriorityChange(Math.max(1, Number(e.target.value) || 1))} />
              </label>
            )}
          </li>
        )}

        {needsVehicle && (
          <li>
            <label className="field">
              目标车辆
              <select value={props.targetVehicle} onChange={(e) => props.onTargetVehicleChange(e.target.value)}>
                {scene.vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.id}
                  </option>
                ))}
              </select>
            </label>
          </li>
        )}

        {needsCell && (
          <li>
            {kind === 'obstacle_add' && (
              <label className="field">
                持续到（until，可空 = 永久）
                <input
                  type="number"
                  min={time + 1}
                  value={props.until ?? ''}
                  onChange={(e) => props.onUntilChange(e.target.value === '' ? null : Math.max(time + 1, Number(e.target.value) || 0))}
                />
              </label>
            )}
            <p className="muted small">
              {pickLabel ?? '在舞台地图上点选格子'}；
              {pendingCell ? ` 当前选择 (${pendingCell[0]},${pendingCell[1]})，确认后加入事件列表` : '地图选择只建立草稿，不会直接入队'}
            </p>
            {pendingCell && (
              <div className="solve-row">
                <button type="button" className="btn tiny primary" disabled={cannotAddDraft} onClick={props.onAddEvent}>
                  {editingIndex != null ? '保存事件修改' : '加入事件列表'}
                </button>
              </div>
            )}
          </li>
        )}

        {kind && draftEvent && (
          <li className="wizard-draft">
            <b>{editingIndex != null ? `正在修改第 ${editingIndex + 1} 项` : '待加入事件'}</b>
            <p>{eventLabel(draftEvent)}</p>
            {draftIssues.length > 0 && (
              <div className="error-panel small">
                {draftIssues.map((issue, index) => <p key={index}>⚠ {issue.message}</p>)}
              </div>
            )}
            {!needsCell && (
              <div className="solve-row">
                <button type="button" className="btn tiny primary" disabled={cannotAddDraft} onClick={props.onAddEvent}>
                  {editingIndex != null ? '保存事件修改' : '加入事件列表'}
                </button>
              </div>
            )}
          </li>
        )}

        <li>
          事件列表（{events.length}/{maxEvents}）：
          {events.length === 0 ? (
            <p className="muted small">还没有事件</p>
          ) : (
            <ul className="event-list">
              {events.map((e, i) => (
                <li key={i}>
                  <span>
                    #{i + 1} {eventLabel(e)}
                  </span>
                  <div className="event-actions">
                    <button type="button" className="btn tiny" onClick={() => props.onEditEvent(i)} disabled={busy}>
                      编辑
                    </button>
                    <button type="button" className="btn tiny" onClick={() => props.onRemoveEvent(i)} disabled={busy}>
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </li>

        <li>
          {issues.length > 0 ? (
            <div className="error-panel">
              <b>提交前预检未通过（{issues.length}）</b>
              <ul className="violation-list">
                {issues.map((it, i) => (
                  <li key={i}>{it.message}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="ok-text small">预检通过：dynamic 块已按契约构造，可提交引擎重调度</p>
          )}
          <div className="solve-row">
            <button
              type="button"
              className="btn primary"
              disabled={busy || issues.length > 0 || events.length === 0 || draftEvent != null || pendingCell != null}
              onClick={() => props.onSubmit(built)}
            >
              {busy ? '重调度中…' : '提交重调度'}
            </button>
            <span className="muted small">
              快照覆盖 {Object.keys(built.snapshot.vehicles).length} 辆车 / {Object.keys(built.snapshot.tasks).length} 个任务
            </span>
          </div>
        </li>
      </ol>

      <details className="mapf-details">
        <summary>dynamic 块预览（agv-dispatch-problem/1.0）</summary>
        <pre className="small">{JSON.stringify(built, null, 1)}</pre>
      </details>

      {scene.stations.length > 0 && (
        <p className="muted small">
          工作站：{scene.stations.map((s) => `${s.id}（${s.cells.length} 泊位 / 容量 ${s.capacity}）`).join(' · ')}
          {' · '}
          取送点引用：{scene.tasks.filter((t) => !Array.isArray(t.pickup) || !Array.isArray(t.dropoff)).length} 个任务使用站点
          {locCells(scene, scene.tasks[0]?.pickup ?? [0, 0]).length > 0 ? '' : ''}
        </p>
      )}
    </div>
  );
}
