/**
 * 场景文档内核（M0 设计 §5.1）：SceneDoc **就是** mapf-problem/1.0 的内存表示，
 * 不另建私有场景模型（用户红线）。
 *
 * - 序列化 = 严格按契约白名单逐字段输出（多一字段都不出）；
 * - 导入兼容引擎产出的任意 mapf-problem/1.0：`map.width/height + blocked` 表达
 *   会转成 `cells`；未知合法字段（benchmark 等）原样保留在 `extra`，导出时回写；
 * - 纯 TS，Node 可直接测（roundtrip 语义等价）。
 */

export type Coord = [number, number];

export interface SceneRobot {
  id: string;
  start: Coord;
  goal: Coord;
}

export interface SceneDoc {
  schema_version: 'mapf-problem/1.0';
  id: string;
  map: { cells: string[] };
  time_model: { timestep: 'discrete'; horizon: number | 'auto' };
  objective: { kind: 'soc' | 'makespan'; direction: 'min' | 'max' };
  robots: SceneRobot[];
  solver: {
    planner: 'auto' | 'ecbs' | 'cbs' | 'pp';
    time_limit_ms: number;
    seed: number;
    suboptimality_factor: number;
  };
  tags?: { name: string; description: string };
  /** 引擎合法但编辑器不消费的字段（原样保留，导出回写）。 */
  extra?: Record<string, unknown>;
}

export const SCHEMA_VERSION = 'mapf-problem/1.0';

export function blankScene(w: number, h: number, id = ''): SceneDoc {
  return {
    schema_version: SCHEMA_VERSION,
    id: id || `mapf-scene-${Math.random().toString(36).slice(2, 8)}`,
    map: { cells: Array.from({ length: h }, () => '.'.repeat(w)) },
    time_model: { timestep: 'discrete', horizon: 'auto' },
    objective: { kind: 'soc', direction: 'min' },
    robots: [],
    solver: { planner: 'auto', time_limit_ms: 3000, seed: 42, suboptimality_factor: 1.5 },
    tags: { name: '', description: '' },
  };
}

export function sceneDims(doc: SceneDoc): { width: number; height: number } {
  return { width: doc.map.cells[0]?.length ?? 0, height: doc.map.cells.length };
}

export function cellOf(doc: SceneDoc, x: number, y: number): string {
  return doc.map.cells[y]?.[x] ?? '#';
}

export function isBlockedCell(doc: SceneDoc, x: number, y: number): boolean {
  const c = cellOf(doc, x, y);
  return c === '#' || c === 'T' || c === 'S';
}

/** 严格白名单序列化（导出即契约，可被 mapf solve / check_contracts 消费）。 */
export function serializeScene(doc: SceneDoc): string {
  const out: Record<string, unknown> = {
    schema_version: doc.schema_version,
    id: doc.id,
    map: { cells: [...doc.map.cells] },
    time_model: { timestep: doc.time_model.timestep, horizon: doc.time_model.horizon },
    objective: { kind: doc.objective.kind, direction: doc.objective.direction },
    robots: doc.robots.map((r) => ({ id: r.id, start: [r.start[0], r.start[1]], goal: [r.goal[0], r.goal[1]] })),
    solver: { ...doc.solver },
  };
  if (doc.tags && (doc.tags.name || doc.tags.description)) {
    out.tags = { name: doc.tags.name, description: doc.tags.description };
  }
  if (doc.extra) {
    for (const [k, v] of Object.entries(doc.extra)) {
      if (!(k in out)) out[k] = v;
    }
  }
  return JSON.stringify(out, null, 2);
}

/** 解析为 SceneDoc；抛错带行级信息。宽进严出：接受 blocked 表达 / 未知合法字段。 */
export function parseScene(text: string): SceneDoc {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch (err) {
    throw new Error(`不是合法 JSON：${(err as Error).message}`);
  }
  if (j.schema_version !== SCHEMA_VERSION) {
    throw new Error(`schema_version 应为 ${SCHEMA_VERSION}，实际 ${String(j.schema_version)}`);
  }
  // map：cells 或 width/height + blocked
  let cells: string[];
  const map = j.map as Record<string, unknown> | undefined;
  if (Array.isArray(map?.cells) && (map!.cells as unknown[]).every((r) => typeof r === 'string')) {
    cells = [...(map!.cells as string[])];
  } else if (
    typeof map?.width === 'number' &&
    typeof map?.height === 'number' &&
    Array.isArray(map?.blocked)
  ) {
    const { width, height } = map as { width: number; height: number };
    const grid = Array.from({ length: height }, () => Array<string>(width).fill('.'));
    for (const b of map!.blocked as Array<[number, number] | { x: number; y: number }>) {
      const bx = Array.isArray(b) ? b[0] : (b as { x: number }).x;
      const by = Array.isArray(b) ? b[1] : (b as { y: number }).y;
      if (grid[by]) grid[by][bx] = '#';
    }
    cells = grid.map((r) => r.join(''));
  } else {
    throw new Error('map.cells 缺失或格式不符（应为字符串数组）');
  }
  const w = cells[0]?.length ?? 0;
  if (w === 0 || cells.some((r) => r.length !== w)) {
    throw new Error('map.cells 行长不一致或为空');
  }
  const robots: SceneRobot[] = [];
  if (!Array.isArray(j.robots)) throw new Error('robots 缺失（应为数组）');
  for (const r of j.robots as Array<Record<string, unknown>>) {
    const s = r.start as Coord;
    const g = r.goal as Coord;
    if (!Array.isArray(s) || !Array.isArray(g)) throw new Error(`机器人 ${String(r.id)} 缺 start/goal`);
    robots.push({ id: String(r.id), start: [s[0], s[1]], goal: [g[0], g[1]] });
  }
  const tm = (j.time_model ?? {}) as Record<string, unknown>;
  const horizon = tm.horizon === 'auto' || tm.horizon === undefined ? 'auto' : Number(tm.horizon);
  const obj = (j.objective ?? {}) as Record<string, unknown>;
  const solverRaw = (j.solver ?? {}) as Record<string, unknown>;
  const doc: SceneDoc = {
    schema_version: SCHEMA_VERSION,
    id: typeof j.id === 'string' && j.id ? j.id : `mapf-scene-${Math.random().toString(36).slice(2, 8)}`,
    map: { cells },
    time_model: { timestep: 'discrete', horizon },
    objective: {
      kind: obj.kind === 'makespan' ? 'makespan' : 'soc',
      direction: obj.direction === 'max' ? 'max' : 'min',
    },
    robots,
    solver: {
      planner: (['auto', 'ecbs', 'cbs', 'pp'] as const).includes(solverRaw.planner as never)
        ? (solverRaw.planner as SceneDoc['solver']['planner'])
        : 'auto',
      time_limit_ms: Number(solverRaw.time_limit_ms ?? 3000) || 3000,
      seed: Number(solverRaw.seed ?? 42) || 0,
      suboptimality_factor: Number(solverRaw.suboptimality_factor ?? 1.5) || 1.5,
    },
  };
  if (j.tags && typeof j.tags === 'object') {
    const t = j.tags as Record<string, unknown>;
    doc.tags = { name: String(t.name ?? ''), description: String(t.description ?? '') };
  } else {
    doc.tags = { name: '', description: '' };
  }
  // 未知合法字段旁路保留（benchmark / dynamic / notes 等）
  const known = new Set(['schema_version', 'id', 'map', 'time_model', 'objective', 'robots', 'solver', 'tags']);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(j)) {
    if (!known.has(k)) extra[k] = v;
  }
  if (Object.keys(extra).length) doc.extra = extra;
  return doc;
}

/** roundtrip 语义等价（规范化深比较：键排序 + 数组序保持）。 */
export function sceneEquivalent(a: SceneDoc, b: SceneDoc): boolean {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x as Record<string, unknown>).sort()) {
        o[k] = norm((x as Record<string, unknown>)[k]);
      }
      return o;
    }
    return x;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
