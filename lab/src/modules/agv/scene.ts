/**
 * AGV 场景文档内核：AgvScene **就是** agv-dispatch-problem/1.0 的内存表示
 * （复用 MAPF 的教训：无私有场景模型，导出即契约）。
 *
 * - 序列化 = 契约白名单逐字段（可被 `agv solve` / check_contracts 消费）；
 * - 解析宽进：未知合法字段旁路保留（dynamic 等）；
 * - 编辑命令 + 撤销栈与 MAPF SceneHistory 同构（快照式，上限 100）。
 * 纯 TS，Node 可测。
 */

import type { AgvTaskLoc } from '../../core/agv/types';

export const AGV_SCHEMA_VERSION = 'agv-dispatch-problem/1.0';

export interface AgvVehicle {
  id: string;
  start: [number, number];
  capabilities?: string[];
}

export interface AgvTask {
  id: string;
  pickup: AgvTaskLoc;
  dropoff: AgvTaskLoc;
  pickup_service: number;
  dropoff_service: number;
  release_step: number;
  due_step?: number;
  priority?: number;
  required_capability?: string;
}

export interface AgvStation {
  id: string;
  cells: Array<[number, number]>;
  capacity: number;
}

export interface AgvScene {
  schema_version: typeof AGV_SCHEMA_VERSION;
  id: string;
  map: { cells: string[] };
  time_model: { timestep: 'discrete'; horizon: number | 'auto' };
  vehicles: AgvVehicle[];
  tasks: AgvTask[];
  stations: AgvStation[];
  parking: Array<[number, number]>;
  objective: { kind: 'lexicographic-weighted'; weights?: { makespan: number; flow_time: number; empty_travel: number; lateness: number } };
  solver: {
    algorithm: 'auto' | 'baseline' | 'insertion-ls';
    time_limit_ms: number;
    seed: number;
    mapf?: { planner?: string; w?: number; time_limit_ms?: number };
  };
  tags?: { name?: string; description?: string };
  /** 未知合法字段（dynamic / benchmark / notes 等）原样保留，导出回写。 */
  extra?: Record<string, unknown>;
}

export function blankAgvScene(w: number, h: number, id?: string): AgvScene {
  return {
    schema_version: AGV_SCHEMA_VERSION,
    id: id ?? `agv-scene-${Math.random().toString(36).slice(2, 8)}`,
    map: { cells: Array.from({ length: h }, () => '.'.repeat(w)) },
    time_model: { timestep: 'discrete', horizon: 'auto' },
    vehicles: [],
    tasks: [],
    stations: [],
    parking: [],
    objective: { kind: 'lexicographic-weighted', weights: { makespan: 1, flow_time: 1, empty_travel: 1, lateness: 1 } },
    solver: { algorithm: 'insertion-ls', time_limit_ms: 5000, seed: 42 },
  };
}

export function agvDims(scene: AgvScene): { width: number; height: number } {
  return { width: scene.map.cells[0]?.length ?? 0, height: scene.map.cells.length };
}

export function isAgvBlocked(scene: AgvScene, x: number, y: number): boolean {
  const c = scene.map.cells[y]?.[x] ?? '#';
  return c === '#' || c === 'T' || c === 'S';
}

export const AGV_TOP_FIELDS = ['schema_version', 'id', 'map', 'time_model', 'vehicles', 'tasks', 'stations', 'parking', 'objective', 'solver', 'dynamic', 'tags'] as const;

/** 严格白名单序列化（导出即契约）。 */
export function serializeAgvScene(scene: AgvScene): string {
  const out: Record<string, unknown> = {
    schema_version: scene.schema_version,
    id: scene.id,
    map: { cells: [...scene.map.cells] },
    time_model: { timestep: scene.time_model.timestep, horizon: scene.time_model.horizon },
    vehicles: scene.vehicles.map((v) => {
      const o: Record<string, unknown> = { id: v.id, start: [v.start[0], v.start[1]] };
      if (v.capabilities?.length) o.capabilities = [...v.capabilities];
      return o;
    }),
    tasks: scene.tasks.map((t) => {
      const o: Record<string, unknown> = {
        id: t.id,
        pickup: cloneLoc(t.pickup),
        dropoff: cloneLoc(t.dropoff),
        pickup_service: t.pickup_service,
        dropoff_service: t.dropoff_service,
        release_step: t.release_step,
      };
      if (t.due_step != null) o.due_step = t.due_step;
      if (t.priority != null) o.priority = t.priority;
      if (t.required_capability) o.required_capability = t.required_capability;
      return o;
    }),
  };
  if (scene.stations.length) {
    out.stations = scene.stations.map((s) => ({ id: s.id, cells: s.cells.map((c) => [c[0], c[1]]), capacity: s.capacity }));
  }
  if (scene.parking.length) {
    out.parking = scene.parking.map((c) => [c[0], c[1]]);
  }
  out.objective = { kind: 'lexicographic-weighted', ...(scene.objective.weights ? { weights: { ...scene.objective.weights } } : {}) };
  out.solver = {
    algorithm: scene.solver.algorithm,
    time_limit_ms: scene.solver.time_limit_ms,
    seed: scene.solver.seed,
    ...(scene.solver.mapf ? { mapf: { ...scene.solver.mapf } } : {}),
  };
  if (scene.tags?.name || scene.tags?.description) {
    out.tags = { ...(scene.tags.name ? { name: scene.tags.name } : {}), ...(scene.tags.description ? { description: scene.tags.description } : {}) };
  }
  if (scene.extra) {
    for (const [k, v] of Object.entries(scene.extra)) {
      if (!(k in out)) out[k] = v;
    }
  }
  return JSON.stringify(out, null, 2);
}

function cloneLoc(l: AgvTaskLoc): AgvTaskLoc {
  return Array.isArray(l) ? [l[0], l[1]] : { station: l.station };
}

export function parseAgvScene(text: string): AgvScene {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch (err) {
    throw new Error(`不是合法 JSON：${(err as Error).message}`);
  }
  if (j.schema_version !== AGV_SCHEMA_VERSION) {
    throw new Error(`schema_version 应为 ${AGV_SCHEMA_VERSION}，实际 ${String(j.schema_version)}`);
  }
  const map = j.map as { cells?: unknown } | undefined;
  if (!Array.isArray(map?.cells) || !(map!.cells as unknown[]).every((r) => typeof r === 'string')) {
    throw new Error('map.cells 缺失（应为字符串数组）');
  }
  const cells = [...(map!.cells as string[])];
  const w = cells[0]?.length ?? 0;
  if (w === 0 || cells.some((r) => r.length !== w)) throw new Error('map.cells 行长不一致或为空');
  if (!Array.isArray(j.vehicles) || (j.vehicles as unknown[]).length === 0) throw new Error('vehicles 缺失（至少 1 台）');
  const vehicles: AgvVehicle[] = (j.vehicles as Array<Record<string, unknown>>).map((v, i) => ({
    id: String(v.id ?? `V${i + 1}`),
    start: [(v.start as [number, number])[0], (v.start as [number, number])[1]],
    capabilities: Array.isArray(v.capabilities) ? (v.capabilities as string[]) : undefined,
  }));
  const tasks: AgvTask[] = (Array.isArray(j.tasks) ? (j.tasks as Array<Record<string, unknown>>) : []).map((t, i) => ({
    id: String(t.id ?? `T${i + 1}`),
    pickup: normalizeLoc(t.pickup),
    dropoff: normalizeLoc(t.dropoff),
    pickup_service: Number(t.pickup_service ?? 0),
    dropoff_service: Number(t.dropoff_service ?? 0),
    release_step: Number(t.release_step ?? 0),
    due_step: t.due_step == null ? undefined : Number(t.due_step),
    priority: t.priority == null ? undefined : Number(t.priority),
    required_capability: t.required_capability == null ? undefined : String(t.required_capability),
  }));
  const stations: AgvStation[] = (Array.isArray(j.stations) ? (j.stations as Array<Record<string, unknown>>) : []).map((s, i) => ({
    id: String(s.id ?? `ST${i + 1}`),
    cells: (s.cells as Array<[number, number]>).map((c) => [c[0], c[1]]),
    capacity: Number(s.capacity ?? 1),
  }));
  const parking: Array<[number, number]> = (Array.isArray(j.parking) ? (j.parking as Array<[number, number]>) : []).map((c) => [c[0], c[1]]);
  const tm = (j.time_model ?? {}) as Record<string, unknown>;
  const solver = (j.solver ?? {}) as Record<string, unknown>;
  const obj = (j.objective ?? {}) as Record<string, unknown>;
  const objWeights = (obj.weights ?? {}) as Record<string, unknown>;
  const scene: AgvScene = {
    schema_version: AGV_SCHEMA_VERSION,
    id: typeof j.id === 'string' && j.id ? j.id : `agv-scene-${Math.random().toString(36).slice(2, 8)}`,
    map: { cells },
    time_model: { timestep: 'discrete', horizon: tm.horizon === undefined || tm.horizon === 'auto' ? 'auto' : Number(tm.horizon) },
    vehicles,
    tasks,
    stations,
    parking,
    objective: {
      kind: 'lexicographic-weighted',
      weights: {
        makespan: Number(objWeights.makespan ?? 1),
        flow_time: Number(objWeights.flow_time ?? 1),
        empty_travel: Number(objWeights.empty_travel ?? 1),
        lateness: Number(objWeights.lateness ?? 1),
      },
    },
    solver: {
      algorithm: (['auto', 'baseline', 'insertion-ls'] as const).includes(solver.algorithm as never)
        ? (solver.algorithm as AgvScene['solver']['algorithm'])
        : 'auto',
      time_limit_ms: Number(solver.time_limit_ms ?? 5000) || 5000,
      seed: Number(solver.seed ?? 42) || 0,
      mapf: (solver.mapf as AgvScene['solver']['mapf']) ?? undefined,
    },
    tags: j.tags && typeof j.tags === 'object' ? (j.tags as { name?: string; description?: string }) : undefined,
  };
  const known = new Set<string>(AGV_TOP_FIELDS);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(j)) {
    if (!known.has(k)) extra[k] = v;
  }
  if (Object.keys(extra).length) scene.extra = extra;
  return scene;
}

function normalizeLoc(l: unknown): AgvTaskLoc {
  if (Array.isArray(l)) return [Number(l[0]), Number(l[1])];
  if (l && typeof l === 'object' && 'station' in (l as Record<string, unknown>)) {
    return { station: String((l as { station: unknown }).station) };
  }
  throw new Error('任务位置应为 [x,y] 或 {"station": id}');
}

/** loc → 候选格（站引用 → 站泊位；显式格 → 自身）。 */
export function locCells(scene: AgvScene, loc: AgvTaskLoc): Array<[number, number]> {
  if (Array.isArray(loc)) return [loc];
  const st = scene.stations.find((s) => s.id === loc.station);
  return st ? st.cells : [];
}

// ---------------------------------------------------------------------------
// 编辑命令 + 撤销栈（快照式）
// ---------------------------------------------------------------------------

export type AgvCommand =
  | { type: 'toggleWall'; cell: [number, number]; blocked: boolean }
  | { type: 'addVehicle'; at: [number, number]; id: string }
  | { type: 'removeVehicle'; id: string }
  | { type: 'setVehicleStart'; id: string; at: [number, number] }
  | { type: 'addTask'; pickup: [number, number]; dropoff: [number, number] | null; id: string }
  | { type: 'setTaskPickup'; id: string; at: AgvTaskLoc }
  | { type: 'setTaskDropoff'; id: string; at: AgvTaskLoc }
  | { type: 'removeTask'; id: string }
  | { type: 'setTaskService'; id: string; pickup_service: number; dropoff_service: number }
  | {
      type: 'setTaskParams';
      id: string;
      release_step?: number;
      due_step?: number | null;
      priority?: number;
      required_capability?: string | null;
    }
  | { type: 'setVehicleCapabilities'; id: string; capabilities: string[] }
  | { type: 'addStationDock'; stationId: string; cell: [number, number] }
  | { type: 'finishStation'; stationId: string; capacity: number }
  | { type: 'removeStation'; id: string }
  | { type: 'clearWalls' }
  | { type: 'replace'; doc: AgvScene };

export function applyAgvCommand(doc: AgvScene, cmd: AgvCommand): AgvScene {
  switch (cmd.type) {
    case 'toggleWall': {
      const [x, y] = cmd.cell;
      const row = doc.map.cells[y];
      if (!row || x < 0 || x >= row.length) return doc;
      const cells = [...doc.map.cells];
      cells[y] = row.substring(0, x) + (cmd.blocked ? '#' : '.') + row.substring(x + 1);
      return { ...doc, map: { cells } };
    }
    case 'addVehicle':
      return { ...doc, vehicles: [...doc.vehicles, { id: cmd.id, start: [...cmd.at] as [number, number] }] };
    case 'removeVehicle':
      return { ...doc, vehicles: doc.vehicles.filter((v) => v.id !== cmd.id) };
    case 'setVehicleStart':
      return { ...doc, vehicles: doc.vehicles.map((v) => (v.id === cmd.id ? { ...v, start: [...cmd.at] as [number, number] } : v)) };
    case 'addTask':
      return {
        ...doc,
        tasks: [
          ...doc.tasks,
          {
            id: cmd.id,
            pickup: [...cmd.pickup] as [number, number],
            dropoff: (cmd.dropoff ? [...cmd.dropoff] : null) as [number, number],
            pickup_service: 0,
            dropoff_service: 0,
            release_step: 0,
          },
        ],
      };
    case 'setTaskPickup':
      return { ...doc, tasks: doc.tasks.map((t) => (t.id === cmd.id ? { ...t, pickup: cloneLoc(cmd.at) } : t)) };
    case 'setTaskDropoff':
      return { ...doc, tasks: doc.tasks.map((t) => (t.id === cmd.id ? { ...t, dropoff: cloneLoc(cmd.at) } : t)) };
    case 'removeTask':
      return { ...doc, tasks: doc.tasks.filter((t) => t.id !== cmd.id) };
    case 'setTaskService':
      return {
        ...doc,
        tasks: doc.tasks.map((t) =>
          t.id === cmd.id ? { ...t, pickup_service: cmd.pickup_service, dropoff_service: cmd.dropoff_service } : t,
        ),
      };
    case 'setTaskParams':
      return {
        ...doc,
        tasks: doc.tasks.map((t) =>
          t.id === cmd.id
            ? {
                ...t,
                ...(cmd.release_step != null ? { release_step: Math.max(0, Math.floor(cmd.release_step)) } : {}),
                ...(cmd.due_step !== undefined ? { due_step: cmd.due_step == null ? undefined : Math.max(0, Math.floor(cmd.due_step)) } : {}),
                ...(cmd.priority != null ? { priority: Math.max(1, Math.floor(cmd.priority)) } : {}),
                ...(cmd.required_capability !== undefined ? { required_capability: cmd.required_capability || undefined } : {}),
              }
            : t,
        ),
      };
    case 'setVehicleCapabilities':
      return {
        ...doc,
        vehicles: doc.vehicles.map((v) =>
          v.id === cmd.id ? { ...v, capabilities: cmd.capabilities.filter((c) => c.trim().length > 0) } : v,
        ),
      };
    case 'addStationDock': {
      const exists = doc.stations.find((s) => s.id === cmd.stationId);
      if (exists) {
        return {
          ...doc,
          stations: doc.stations.map((s) =>
            s.id === cmd.stationId && !s.cells.some((c) => c[0] === cmd.cell[0] && c[1] === cmd.cell[1])
              ? { ...s, cells: [...s.cells, [...cmd.cell] as [number, number]] }
              : s,
          ),
        };
      }
      return { ...doc, stations: [...doc.stations, { id: cmd.stationId, cells: [[...cmd.cell] as [number, number]], capacity: 1 }] };
    }
    case 'finishStation':
      return { ...doc, stations: doc.stations.map((s) => (s.id === cmd.stationId ? { ...s, capacity: cmd.capacity } : s)) };
    case 'removeStation':
      return { ...doc, stations: doc.stations.filter((s) => s.id !== cmd.id) };
    case 'clearWalls':
      return { ...doc, map: { cells: doc.map.cells.map((r) => '.'.repeat(r.length)) } };
    case 'replace':
      return cmd.doc;
  }
}

export const AGV_HISTORY_LIMIT = 100;

export class AgvSceneHistory {
  private past: AgvScene[] = [];
  private future: AgvScene[] = [];
  /** 进行中的笔画起点（拖刷）：整笔一个撤销步（与 MAPF SceneHistory 同构）。 */
  private strokeBase: AgvScene | null = null;
  constructor(public doc: AgvScene) {}

  exec(cmd: AgvCommand): AgvScene {
    const next = applyAgvCommand(this.doc, cmd);
    if (next === this.doc) return this.doc;
    if (this.strokeBase && cmd.type === 'toggleWall') {
      this.future = [];
      this.doc = next;
      return next;
    }
    this.past.push(this.doc);
    if (this.past.length > AGV_HISTORY_LIMIT) this.past.shift();
    this.future = [];
    this.doc = next;
    return next;
  }

  /** 开始一笔（pointerdown）。 */
  beginStroke(): void {
    this.strokeBase = this.doc;
  }

  /** 结束一笔（pointerup）：有变化才入栈。 */
  endStroke(): void {
    const base = this.strokeBase;
    this.strokeBase = null;
    if (base && base !== this.doc) {
      this.past.push(base);
      if (this.past.length > AGV_HISTORY_LIMIT) this.past.shift();
    }
  }

  get stroking(): boolean {
    return this.strokeBase != null;
  }

  /** 可撤销步数（编辑器读数）。 */
  get steps(): number {
    return this.past.length;
  }

  load(doc: AgvScene): void {
    this.strokeBase = null;
    this.doc = doc;
    this.past = [];
    this.future = [];
  }

  undo(): AgvScene | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.unshift(this.doc);
    this.doc = prev;
    return prev;
  }

  redo(): AgvScene | null {
    const next = this.future.shift();
    if (!next) return null;
    this.past.push(this.doc);
    this.doc = next;
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
}

// ---------------------------------------------------------------------------
// 预检（结构层；引擎永远是最终裁决者）
// ---------------------------------------------------------------------------

export interface AgvPrecheckIssue {
  level: 'error' | 'warn';
  code: string;
  message: string;
  cell?: [number, number];
}

export function precheckAgvScene(scene: AgvScene, limits: { maxVehicles: number; maxTasks: number; maxCells: number; maxBudgetMs: number }): AgvPrecheckIssue[] {
  const issues: AgvPrecheckIssue[] = [];
  const { width, height } = agvDims(scene);
  if (width * height > limits.maxCells) {
    issues.push({ level: 'error', code: 'E-CAP-LIMIT-MAP', message: `地图 ${width}×${height} 超过档位上限 ${limits.maxCells} 格` });
  }
  if (scene.vehicles.length > limits.maxVehicles) {
    issues.push({ level: 'error', code: 'E-CAP-LIMIT-VEHICLES', message: `车辆 ${scene.vehicles.length} 超过档位上限 ${limits.maxVehicles}` });
  }
  if (scene.tasks.length > limits.maxTasks) {
    issues.push({ level: 'error', code: 'E-CAP-LIMIT-TASKS', message: `任务 ${scene.tasks.length} 超过档位上限 ${limits.maxTasks}` });
  }
  if (scene.solver.time_limit_ms > limits.maxBudgetMs) {
    issues.push({ level: 'error', code: 'E-CAP-LIMIT-BUDGET', message: `预算 ${scene.solver.time_limit_ms} ms 超过档位上限 ${limits.maxBudgetMs} ms` });
  }
  const seenStart = new Set<string>();
  for (const v of scene.vehicles) {
    const [x, y] = v.start;
    if (x >= width || y >= height) {
      issues.push({ level: 'error', code: 'E-VEHICLE-START-RANGE', message: `车辆 ${v.id} 起点 (${x},${y}) 越界`, cell: [x, y] });
    } else if (isAgvBlocked(scene, x, y)) {
      issues.push({ level: 'error', code: 'E-VEHICLE-START-BLOCKED', message: `车辆 ${v.id} 起点在障碍格`, cell: [x, y] });
    }
    const k = `${x},${y}`;
    if (seenStart.has(k)) {
      issues.push({ level: 'error', code: 'E-VEHICLE-DUP-START', message: `车辆起点重复在 (${x},${y})`, cell: [x, y] });
    }
    seenStart.add(k);
  }
  for (const t of scene.tasks) {
    for (const [label, loc] of [['pickup', t.pickup], ['dropoff', t.dropoff]] as const) {
      if (Array.isArray(loc)) {
        const [x, y] = loc;
        if (x >= width || y >= height) {
          issues.push({ level: 'error', code: 'E-TASK-LOC-RANGE', message: `任务 ${t.id} ${label} (${x},${y}) 越界`, cell: [x, y] });
        } else if (isAgvBlocked(scene, x, y)) {
          issues.push({ level: 'error', code: 'E-TASK-LOC-BLOCKED', message: `任务 ${t.id} ${label} 在障碍格`, cell: [x, y] });
        }
      } else if (!scene.stations.some((s) => s.id === loc.station)) {
        issues.push({ level: 'error', code: 'E-TASK-UNKNOWN-STATION', message: `任务 ${t.id} ${label} 引用不存在的工作站 ${loc.station}` });
      }
    }
    if (Array.isArray(t.pickup) && Array.isArray(t.dropoff) && t.pickup[0] === t.dropoff[0] && t.pickup[1] === t.dropoff[1]) {
      issues.push({ level: 'warn', code: 'E-TASK-TRIVIAL', message: `任务 ${t.id} 取送同格（合法但无运输量）`, cell: t.pickup });
    }
  }
  return issues;
}

export function agvSceneEquivalent(a: AgvScene, b: AgvScene): boolean {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x as Record<string, unknown>).sort()) o[k] = norm((x as Record<string, unknown>)[k]);
      return o;
    }
    return x;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
