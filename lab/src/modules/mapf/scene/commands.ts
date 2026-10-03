/**
 * 场景命令与撤销栈（M0 §5.2）：快照式命令栈，上限 100 步，栈满丢最旧。
 * 纯 TS 可测。命令 = (doc, payload) => doc'（纯函数），历史由 SceneHistory 持有。
 */

import type { Coord, SceneDoc } from './SceneDoc';
import { blankScene, sceneDims } from './SceneDoc';

export const HISTORY_LIMIT = 100;

export type SceneCommand =
  | { type: 'toggleWall'; cell: Coord; blocked: boolean } // true=画, false=擦
  | { type: 'addRobot'; at: Coord; id: string }
  | { type: 'removeRobot'; id: string }
  | { type: 'setStart'; id: string; at: Coord }
  | { type: 'setGoal'; id: string; at: Coord }
  | { type: 'renameRobot'; id: string; nextId: string }
  | { type: 'clearWalls' }
  | { type: 'clearRobots' }
  | { type: 'resize'; width: number; height: number }
  | { type: 'replace'; doc: SceneDoc }; // 导入 / 载入场景 / JSON 应用

export function applyCommand(doc: SceneDoc, cmd: SceneCommand): SceneDoc {
  switch (cmd.type) {
    case 'toggleWall': {
      const [x, y] = cmd.cell;
      const row = doc.map.cells[y];
      if (!row || x < 0 || x >= row.length) return doc;
      const cells = [...doc.map.cells];
      cells[y] = row.substring(0, x) + (cmd.blocked ? '#' : '.') + row.substring(x + 1);
      return { ...doc, map: { cells } };
    }
    case 'addRobot': {
      const robot = { id: cmd.id, start: [...cmd.at] as Coord, goal: null as unknown as Coord };
      return { ...doc, robots: [...doc.robots, robot] };
    }
    case 'removeRobot':
      return { ...doc, robots: doc.robots.filter((r) => r.id !== cmd.id) };
    case 'setStart':
      return { ...doc, robots: doc.robots.map((r) => (r.id === cmd.id ? { ...r, start: [...cmd.at] as Coord } : r)) };
    case 'setGoal':
      return { ...doc, robots: doc.robots.map((r) => (r.id === cmd.id ? { ...r, goal: [...cmd.at] as Coord } : r)) };
    case 'renameRobot': {
      if (doc.robots.some((r) => r.id === cmd.nextId)) return doc;
      return { ...doc, robots: doc.robots.map((r) => (r.id === cmd.id ? { ...r, id: cmd.nextId } : r)) };
    }
    case 'clearWalls':
      return { ...doc, map: { cells: doc.map.cells.map((r) => '.'.repeat(r.length)) } };
    case 'clearRobots':
      return { ...doc, robots: [] };
    case 'resize': {
      const { width, height } = sceneDims(doc);
      const cells: string[] = [];
      for (let y = 0; y < cmd.height; y++) {
        const src = doc.map.cells[y] ?? '';
        cells.push((src + '.'.repeat(Math.max(0, cmd.width - src.length))).slice(0, Math.max(0, cmd.width)));
      }
      const clamp = (c: Coord): Coord | null =>
        c && c[0] < cmd.width && c[1] < cmd.height ? c : null;
      return {
        ...doc,
        map: { cells },
        robots: doc.robots.flatMap((r) => {
          const s = clamp(r.start);
          const g = clamp(r.goal);
          return s && g ? [{ ...r, start: s, goal: g }] : [];
        }),
        ...(width === cmd.width && height === cmd.height ? {} : {}),
      };
    }
    case 'replace':
      return cmd.doc;
  }
}

export interface HistoryState {
  doc: SceneDoc;
  /** 可撤销步数。 */
  canUndo: boolean;
  canRedo: boolean;
}

/** 撤销栈：引用共享快照（SceneDoc 不可变更新，快照零拷贝）。 */
export class SceneHistory {
  private past: SceneDoc[] = [];
  private future: SceneDoc[] = [];
  /** 进行中的笔画起点（拖刷刷墙）：整笔只产生一个撤销步。 */
  private strokeBase: SceneDoc | null = null;
  constructor(public doc: SceneDoc) {}

  /** 应用命令（入撤销栈）。 */
  exec(cmd: SceneCommand): SceneDoc {
    const next = applyCommand(this.doc, cmd);
    if (next === this.doc) return this.doc;
    if (this.strokeBase && cmd.type === 'toggleWall') {
      // 笔画中：只推进文档，历史在 endStroke 一次性入栈
      this.future = [];
      this.doc = next;
      return next;
    }
    this.past.push(this.doc);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    this.doc = next;
    return next;
  }

  /** 开始一笔（pointerdown）：此后同笔的 toggleWall 合并为一个撤销步。 */
  beginStroke(): void {
    this.strokeBase = this.doc;
  }

  /** 结束一笔（pointerup）：笔画有变化才入栈。 */
  endStroke(): void {
    const base = this.strokeBase;
    this.strokeBase = null;
    if (base && base !== this.doc) {
      this.past.push(base);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
    }
  }

  /** 当前是否处于笔画中（编辑器状态提示用）。 */
  get stroking(): boolean {
    return this.strokeBase != null;
  }

  /** 可撤销步数（编辑器读数）。 */
  get steps(): number {
    return this.past.length;
  }

  /** 直接替换（求解/切场景不消耗撤销栈时用 silent 载入）。 */
  load(doc: SceneDoc): void {
    this.strokeBase = null;
    this.doc = doc;
    this.past = [];
    this.future = [];
  }

  undo(): SceneDoc | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.unshift(this.doc);
    this.doc = prev;
    return prev;
  }

  redo(): SceneDoc | null {
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

export function nextRobotId(doc: SceneDoc): string {
  let n = doc.robots.length + 1;
  const ids = new Set(doc.robots.map((r) => r.id));
  while (ids.has(`R${n}`)) n += 1;
  return `R${n}`;
}

export { blankScene };
