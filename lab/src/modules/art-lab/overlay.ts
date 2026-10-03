/**
 * 引擎解 → 空间叠加层（`AlgoOverlay`）的投影。
 *
 * 三个算法共用同一套空间语汇（见 art/ArtAlgorithmOverlay.tsx）：
 *   纤细发光路径 = 已执行 / 计划中的运动；半透明节点 = 任务与工位；
 *   状态光 = 设备或车辆的**真实状态**；事件标记 = 引擎报告的真实异常或动态事件。
 *
 * 红线：本文件只做“坐标换算 + 状态映射”，不产生任何引擎没有给出的运动、时刻或数量。
 * 所有格坐标都通过 `createGridMapping` 的等比映射落到厂房地面上，映射规则会显示在面板上。
 */

import type { AgvProblemLite, AgvSolution } from '../../core/agv/types';
import type { MapfProblemLite, MapfSolution } from '../../core/mapf/types';
import type { RawOperation, VerifyReport } from '../../core/types';
import { parseIsoMs } from '../../core/aps/transform';
import { sbRobotColor } from '../../components/sandbox/theme';
import { GLOW } from '../../art/tokens';
import type { AlgoOverlay, OverlayNodeItem, OverlayRoute, OverlayStatusItem } from '../../art/overlayModel';
import { cellToWorld, createGridMapping, mapStringsToCells, STATION_PADS, type StationPad } from './layout';

/** AGV 相位 → 状态语义（与既有 2D/3D 沙盘一致）。 */
function agvPhaseTone(phase: string | undefined): 'running' | 'idle' | 'done' {
  if (!phase) return 'idle';
  if (phase.startsWith('servicing_')) return 'running';
  if (phase === 'parking' || phase === 'idle') return 'idle';
  return 'running';
}

function taskColor(status: string | undefined): string {
  switch (status) {
    case 'DONE':
    case 'done':
      return GLOW.done;
    case 'FAILED':
    case 'failed':
    case 'aborted':
      return GLOW.alert;
    case 'PENDING':
    case 'pending':
      return GLOW.task;
    default:
      return GLOW.planned;
  }
}

export interface AgvOverlayInput {
  problem: AgvProblemLite;
  solution: AgvSolution;
  /** 回放步（真实离散步，来自引擎时间轴）。 */
  step: number;
  selectedTask?: string | null;
}

/** AGV 解 → 叠加层：车辆轨迹、任务节点、工位状态光、载荷、超期事件。 */
export function buildAgvOverlay({ problem, solution, step, selectedTask = null }: AgvOverlayInput): AlgoOverlay {
  const grid = mapStringsToCells(problem.map.cells);
  const mapping = createGridMapping(grid.width, grid.height);
  const vehicles = solution.plan?.vehicles ?? [];
  const tasks = solution.plan?.tasks ?? [];

  const routes: OverlayRoute[] = [];
  const statuses: OverlayStatusItem[] = [];
  const marks: AlgoOverlay['marks'] = [];

  vehicles.forEach((vehicle, index) => {
    const timeline = vehicle.timeline ?? [];
    if (timeline.length < 2) return;
    const color = sbRobotColor(index);
    const executedTo = Math.max(0, Math.min(step, timeline.length - 1));
    routes.push({
      id: `agv-${vehicle.id}`,
      color,
      points: timeline.map((cell) => cellToWorld(mapping, cell, 0)),
      executedTo,
      y: 0.06,
    });
    const mission = (vehicle.missions ?? []).find((m) => step >= m.from && step <= m.to);
    const cell = timeline[executedTo] ?? timeline[0];
    statuses.push({ id: `agv-status-${vehicle.id}`, position: cellToWorld(mapping, cell, 0), tone: agvPhaseTone(mission?.phase) });
  });

  const nodes: OverlayNodeItem[] = [];
  const projections: AlgoOverlay['projections'] = [];

  tasks.forEach((task) => {
    const color = taskColor(task.status);
    const docks: Array<[string, [number, number] | null]> = [
      ['pickup', task.pickup_dock],
      ['dropoff', task.dropoff_dock],
    ];
    for (const [kind, dock] of docks) {
      if (!dock) continue;
      const position = cellToWorld(mapping, dock, 0);
      const existing = nodes.find((n) => n.id.endsWith(`-${dock[0]}-${dock[1]}`) && n.color === color);
      if (existing) {
        existing.ticks = (existing.ticks ?? 0) + 1;
      } else {
        nodes.push({
          id: `task-${task.id}-${kind}-${dock[0]}-${dock[1]}`,
          position,
          color,
          radius: 0.3,
          selected: task.id === selectedTask,
          filled: kind === 'pickup',
          ticks: 1,
        });
      }
      // 目标位置投影：只在“尚未完成”的任务上出现（完成的格子不再有目标含义）。
      if (kind === 'dropoff' && task.status !== 'DONE') {
        projections.push({ id: `proj-${task.id}`, position, color, radius: mapping.scale * 1.05 });
      }
    }
    // 超期是引擎给出的真实指标（lateness > 0），不是装饰。
    if (typeof task.lateness === 'number' && task.lateness > 0 && task.dropoff_dock) {
      marks.push({ id: `late-${task.id}`, position: cellToWorld(mapping, task.dropoff_dock, 0), color: GLOW.alert });
    }
  });

  const done = tasks.filter((t) => t.status === 'DONE').length;
  return {
    label: `AGV 调度 · ${problem.id ?? '问题'} · ${vehicles.length} 车 / ${tasks.length} 任务`,
    status: `${solution.status}${solution.verified ? ' · 已独立核验' : ''} · 完成 ${done}/${tasks.length} · 当前步 ${step}`,
    routes,
    nodes,
    statuses,
    marks,
    projections,
    legend: [
      { color: GLOW.active, text: '已执行轨迹' },
      { color: GLOW.planned, text: '计划中轨迹（虚线）' },
      { color: GLOW.task, text: '待执行任务点' },
      { color: GLOW.done, text: '已完成任务点' },
      { color: GLOW.alert, text: '超期（引擎 lateness>0）' },
    ],
    mapping: `格阵 ${grid.width}×${grid.height} 等比映射到作业区 ${mapping.scale.toFixed(2)} m/格（保持正交与相对间距）`,
  };
}

export interface MapfOverlayInput {
  problem: MapfProblemLite;
  solution: MapfSolution;
  step: number;
  selectedRobot?: string | null;
}

/** MAPF 解 → 叠加层：机器人路径、目标投影、当前位置状态光、障碍轮廓。 */
export function buildMapfOverlay({ problem, solution, step, selectedRobot = null }: MapfOverlayInput): AlgoOverlay {
  const grid = mapStringsToCells(problem.map.cells);
  const mapping = createGridMapping(grid.width, grid.height);

  const routes: OverlayRoute[] = [];
  const statuses: OverlayStatusItem[] = [];
  const nodes: OverlayNodeItem[] = [];
  const projections: AlgoOverlay['projections'] = [];

  solution.robots.forEach((robot, index) => {
    const path = robot.path ?? [];
    if (path.length === 0) return;
    const color = sbRobotColor(index);
    const executedTo = Math.max(0, Math.min(step, path.length - 1));
    if (path.length >= 2) {
      routes.push({
        id: `mapf-${robot.id}`,
        color,
        points: path.map((cell) => cellToWorld(mapping, cell, 0)),
        executedTo,
        selected: robot.id === selectedRobot,
        y: 0.07,
      });
    }
    const current = path[executedTo] ?? path[0];
    statuses.push({ id: `mapf-status-${robot.id}`, position: cellToWorld(mapping, current, 0), tone: executedTo >= path.length - 1 ? 'done' : 'running' });
    nodes.push({ id: `mapf-goal-${robot.id}`, position: cellToWorld(mapping, robot.goal, 0), color, radius: 0.28, filled: false });
    projections.push({ id: `mapf-goalproj-${robot.id}`, position: cellToWorld(mapping, robot.goal, 0), color, radius: mapping.scale * 0.75 });
  });

  const madeSpan = typeof solution.makespan === 'number' ? solution.makespan : null;
  return {
    label: `MAPF 路径规划 · ${problem.id ?? '问题'} · ${solution.robots.length} 机器人`,
    status: `${solution.status}${solution.optimality_proven ? '（已证明最优）' : ''}${solution.verified ? ' · 已独立核验' : ''}${madeSpan != null ? ` · makespan ${madeSpan}` : ''} · 当前步 ${step}`,
    routes,
    nodes,
    statuses,
    marks: [],
    projections,
    legend: [
      { color: GLOW.active, text: '机器人路径（已执行）' },
      { color: GLOW.planned, text: '剩余路径（虚线）' },
      { color: GLOW.done, text: '已到达目标' },
    ],
    mapping: `格阵 ${grid.width}×${grid.height} 等比映射到作业区 ${mapping.scale.toFixed(2)} m/格`,
  };
}

export interface ApsOverlayInput {
  /** 引擎输出的工序（绝对时间 ISO）。 */
  operations: RawOperation[];
  /** 机器 id → 工位泊位（未列出的机器不会被摆放，面板会提示）。 */
  machineStations: Map<string, StationPad>;
  /** 回放时刻（ms）。 */
  nowMs: number;
  verify?: VerifyReport | null;
}

/** APS 解 → 叠加层：工位状态光、订单工序流转线、违规事件标记。 */
export function buildApsOverlay({ operations, machineStations, nowMs, verify }: ApsOverlayInput): AlgoOverlay {
  const statuses: OverlayStatusItem[] = [];
  const nodes: OverlayNodeItem[] = [];
  const routes: OverlayRoute[] = [];
  const marks: OverlayMarkList = [];

  const perStation = new Map<string, number>();
  for (const op of operations) {
    const station = machineStations.get(op.machine_id);
    if (!station) continue;
    const start = parseIsoMs(op.start_at);
    const end = parseIsoMs(op.end_at);
    perStation.set(op.machine_id, (perStation.get(op.machine_id) ?? 0) + 1);
    const tone = nowMs >= end ? 'done' : nowMs >= start ? 'running' : 'idle';
    statuses.push({ id: `aps-${op.machine_id}-${op.operation_id}`, position: [station.x, 0, station.z], tone });
  }

  for (const [machineId, count] of perStation) {
    const station = machineStations.get(machineId)!;
    nodes.push({ id: `aps-station-${machineId}`, position: [station.x, 0, station.z], color: GLOW.planned, radius: 0.42, ticks: count, filled: false });
  }

  // 同订单工序先后 = 真实工艺流转（相邻工序之间连一条细线）。
  const byOrder = new Map<string, RawOperation[]>();
  for (const op of operations) {
    const list = byOrder.get(op.order_id) ?? [];
    list.push(op);
    byOrder.set(op.order_id, list);
  }
  let orderIndex = 0;
  for (const [orderId, list] of byOrder) {
    const sorted = [...list].sort((a, b) => parseIsoMs(a.start_at) - parseIsoMs(b.start_at));
    const points = sorted
      .map((op) => machineStations.get(op.machine_id))
      .filter((station): station is StationPad => Boolean(station))
      .map((station) => [station.x, 0, station.z] as [number, number, number]);
    if (points.length >= 2) {
      routes.push({ id: `aps-order-${orderId}`, color: sbRobotColor(orderIndex), points, executedTo: null, y: 0.42 });
    }
    orderIndex += 1;
  }

  const violations = verify?.violations ?? [];
  for (const violation of violations.slice(0, 8)) {
    const station = violation.resource_id ? machineStations.get(violation.resource_id) : undefined;
    if (station) marks.push({ id: `aps-violation-${violation.code}-${station.id}`, position: [station.x, 0, station.z], color: GLOW.alert });
  }

  const unmapped = [...new Set(operations.map((op) => op.machine_id))].filter((id) => !machineStations.has(id));
  return {
    label: `APS 排程 · ${operations.length} 道工序 / ${byOrder.size} 个订单`,
    status: `${unmapped.length ? `${unmapped.length} 台机器未映射到泊位；` : ''}当前时刻 ${
      Number.isFinite(nowMs) ? new Date(nowMs).toISOString().slice(11, 19) : '—'
    }`,
    routes,
    nodes,
    statuses,
    marks,
    projections: [],
    legend: [
      { color: GLOW.active, text: '在制工位' },
      { color: GLOW.planned, text: '等待加工' },
      { color: GLOW.done, text: '工序完成' },
      { color: GLOW.alert, text: '核验违规位置' },
    ],
    mapping: `机器 → 工位泊位映射（${machineStations.size}/${STATION_PADS.length} 个泊位被占用）`,
  };
}

type OverlayMarkList = AlgoOverlay['marks'];
