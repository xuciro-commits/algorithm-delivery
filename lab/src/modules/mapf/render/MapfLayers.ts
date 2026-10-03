/**
 * MAPF 语义图层（M0 §4/§7）：由 MapStage 的 L1/L2/L3 painter 工厂组成。
 * - L1 轨迹：规划路径（未来虚线/已执行实线）、冻结前缀、旧方案参照；
 * - L2 实体：机器人当前位置 + 4 态符号、起终点标记；
 * - L3 交互：悬停格、编辑预览、冲突脉冲、事件标记。
 * LOD 由 cellPx 驱动（§4.3）；选中车任何 LOD 全细节。
 */

import type { Cell, PixelSize, Viewport } from '../../../components/grid-map/types';
import { GRID_COLORS } from '../../../components/grid-map/types';
import { lodLevel } from '../../../components/grid-map/viewport';
import type { MapfSolution } from '../../../core/mapf/types';
import { phaseAt } from '../playback/clock';
import { SB, SB_ROBOT_COLORS } from '../../../components/sandbox/theme';

/** 机器人识别色（V2 §三：冰蓝/青/紫罗兰/琥珀…，与 3D 沙盘完全一致）。 */
export const ROBOT_PALETTE: readonly string[] = SB_ROBOT_COLORS;

export function robotColor(i: number): string {
  return ROBOT_PALETTE[i % ROBOT_PALETTE.length];
}

export interface MapfRenderState {
  /** 场景地图（编辑态）起终点；键 = 机器人 id。 */
  sceneRobots: Array<{ id: string; start: [number, number]; goal: [number, number] | null }>;
  solution: MapfSolution | null;
  /** 旧方案参照线（对比/重规划前）。 */
  ghostSolution: MapfSolution | null;
  t: number;
  primary: string | null;
  selected: string[];
  layers: {
    goals: boolean;
    paths: boolean;
    executed: boolean;
    robots: boolean;
    conflicts: boolean;
    events: boolean;
  };
  hover: Cell | null;
  /** 编辑预览：非法红框格。 */
  invalidCells: Array<Cell>;
  /** 验证器冲突定位（脉冲）。 */
  conflictCells: Array<{ cell: Cell; at: number }>;
  /** 动态事件标记。 */
  eventMarks: Array<{ cell: Cell; at: number; kind: string }>;
  /** 冻结前缀长度（动态模式；每车 t ≤ frozen 为锁定段）。 */
  frozenAt: number | null;
  pathLimit: number; // 路径显示上限（>0 时只画前 N 台选中/前 N 台）
}

type Painter = (ctx: CanvasRenderingContext2D, vp: Viewport, size: PixelSize) => void;

const cx = (vp: Viewport, x: number) => vp.tx + x * vp.cellPx + vp.cellPx / 2;
const cy = (vp: Viewport, y: number) => vp.ty + y * vp.cellPx + vp.cellPx / 2;

/** L1：路径/轨迹。 */
export function paintPathsL1(state: MapfRenderState): Painter {
  return (ctx, vp) => {
    const sol = state.solution;
    if (!sol?.robots?.length) return;
    const lod = lodLevel(vp.cellPx);
    const lineWidth = lod === 0 ? 3 : lod === 1 ? 2.5 : lod === 2 ? 2 : 1.5;
    const idx = new Map(sol.robots.map((r, i) => [r.id, i]));
    const visible = (id: string, i: number) => (state.pathLimit <= 0 ? true : state.selected.includes(id) || i < state.pathLimit);
    // 参照旧方案（灰虚线）
    if (state.ghostSolution?.robots?.length) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = SB.inactive;
      ctx.lineWidth = Math.max(1, lineWidth - 1);
      ctx.setLineDash([4, 4]);
      for (const r of state.ghostSolution.robots) {
        ctx.beginPath();
        r.path?.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(cx(vp, x), cy(vp, y)) : ctx.lineTo(cx(vp, x), cy(vp, y))));
        ctx.stroke();
      }
      ctx.restore();
    }
    for (const [i, r] of sol.robots.entries()) {
      if (!visible(r.id, i)) continue;
      const path = r.path ?? [];
      if (path.length < 2) continue;
      const dim = state.primary && state.primary !== r.id && !state.selected.includes(r.id);
      const color = robotColor(idx.get(r.id) ?? i);
      ctx.save();
      ctx.globalAlpha = dim ? 0.16 : 1;
      // 已执行段（实线加粗）
      if (state.layers.executed) {
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth + 0.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let k = 0; k <= Math.min(state.t, path.length - 1); k++) {
          const [x, y] = path[k];
          if (k === 0) ctx.moveTo(cx(vp, x), cy(vp, y));
          else ctx.lineTo(cx(vp, x), cy(vp, y));
        }
        ctx.stroke();
        // 冻结前缀锁纹（虚线罩层）
        if (state.frozenAt != null && state.frozenAt > 0) {
          ctx.strokeStyle = 'rgba(6,11,22,0.85)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          for (let k = 0; k <= Math.min(state.frozenAt, path.length - 1); k++) {
            const [x, y] = path[k];
            if (k === 0) ctx.moveTo(cx(vp, x), cy(vp, y));
            else ctx.lineTo(cx(vp, x), cy(vp, y));
          }
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      // 未来段（虚线变细）
      if (state.layers.paths && state.t < path.length - 1) {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, lineWidth - 0.5);
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        for (let k = Math.max(0, state.t); k < path.length; k++) {
          const [x, y] = path[k];
          if (k === state.t) ctx.moveTo(cx(vp, x), cy(vp, y));
          else ctx.lineTo(cx(vp, x), cy(vp, y));
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }
  };
}

/** L2：实体（机器人当前位置 + 4 态）与起终点。 */
export function paintEntitiesL2(state: MapfRenderState): Painter {
  return (ctx, vp) => {
    const lod = lodLevel(vp.cellPx);
    const cell = vp.cellPx;
    const sol = state.solution;
    const robots = sol?.robots?.length
      ? sol.robots.map((r, i) => {
          const path = r.path ?? [];
          const pos = path[Math.min(state.t, Math.max(0, path.length - 1))] ?? r.start;
          return { id: r.id, pos, hasSolution: true, i, arrival: r.arrival, path };
        })
      : state.sceneRobots.map((r, i) => ({ id: r.id, pos: r.start as [number, number], hasSolution: false, i, arrival: null, path: [r.start] as Array<[number, number]> }));

    // 起终点（编辑态或 goal 层开）
    if (state.layers.goals) {
      for (const r of robots) {
        const scene = state.sceneRobots.find((s) => s.id === r.id);
        if (!scene) continue;
        const color = robotColor(r.i);
        const [sx, sy] = scene.start;
        // 起点：描边框
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        const inset = Math.max(2, cell * 0.12);
        ctx.strokeRect(vp.tx + sx * cell + inset, vp.ty + sy * cell + inset, cell - inset * 2, cell - inset * 2);
        // 终点：菱形
        if (scene.goal) {
          const [gx, gy] = scene.goal;
          const gx0 = vp.tx + gx * cell;
          const gy0 = vp.ty + gy * cell;
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.4;
          ctx.beginPath();
          ctx.moveTo(gx0 + cell / 2, gy0 + 2);
          ctx.lineTo(gx0 + cell - 2, gy0 + cell / 2);
          ctx.lineTo(gx0 + cell / 2, gy0 + cell - 2);
          ctx.lineTo(gx0 + 2, gy0 + cell / 2);
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
    }

    // 机器人当前位置
    if (state.layers.robots) {
      for (const r of robots) {
        if (!r.hasSolution) continue;
        const dim = state.primary && state.primary !== r.id && !state.selected.includes(r.id);
        const color = robotColor(r.i);
        const isPrimary = state.primary === r.id;
        const [x, y] = r.pos;
        const px = cx(vp, x);
        const py = cy(vp, y);
        const rad = cell * 0.32;
        ctx.save();
        ctx.globalAlpha = dim ? 0.2 : 1;
        const phase = r.path.length > 1 ? phaseAt({ path: r.path, arrival: r.arrival }, state.t) : 'waiting';
        if (phase === 'waiting') {
          // 空心圆 + 内点
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(px, py, rad, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(px, py, rad * 0.28, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(px, py, rad, 0, Math.PI * 2);
          ctx.fill();
          if (phase === 'moving' && state.t > 0) {
            // 运动方向楔形
            const [px0, py0] = r.path[Math.max(0, state.t - 1)];
            const dx = Math.sign(x - px0);
            const dy = Math.sign(y - py0);
            ctx.fillStyle = '#eaf6ff';
            ctx.beginPath();
            const wx = px + dx * rad * 0.55;
            const wy = py + dy * rad * 0.55;
            ctx.arc(wx, wy, rad * 0.22, 0, Math.PI * 2);
            ctx.fill();
          }
          if (phase === 'arrived') {
            ctx.strokeStyle = '#eaf6ff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(px, py, rad + 2, 0, Math.PI * 2);
            ctx.stroke();
          }
          if (phase === 'staying') {
            ctx.strokeStyle = color;
            ctx.globalAlpha = 0.45;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(px, py, rad + 3.5, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = dim ? 0.2 : 1;
          }
        }
        // 序号徽标
        if (lod <= 1 || isPrimary) {
          ctx.fillStyle = '#eaf6ff';
          ctx.font = `${Math.max(8, Math.round(rad))}px system-ui`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(r.i + 1), px, py + 0.5);
        }
        // 选中强调（描边 + 标牌）
        if (isPrimary) {
          ctx.strokeStyle = '#060b16';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(px, py, rad + 2.5, 0, Math.PI * 2);
          ctx.stroke();
          if (cell >= 12) {
            ctx.font = '11px system-ui';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            const label = `${r.i + 1}·${r.id}`;
            const tw = ctx.measureText(label).width;
            ctx.fillStyle = 'rgba(6,11,22,0.86)';
            ctx.fillRect(px + rad + 4, py - rad - 12, tw + 8, 16);
            ctx.fillStyle = '#dff0ff';
            ctx.fillText(label, px + rad + 8, py - rad + 3);
          }
        }
        ctx.restore();
      }
    }
  };
}

/** L3：交互（悬停/非法预览/冲突脉冲/事件标记）。 */
export function paintOverlayL3(state: MapfRenderState, nowTs: () => number = () => performance.now()): Painter {
  return (ctx, vp) => {
    const cell = vp.cellPx;
    if (state.hover) {
      ctx.fillStyle = GRID_COLORS.hover;
      ctx.fillRect(vp.tx + state.hover.x * cell, vp.ty + state.hover.y * cell, cell, cell);
      ctx.strokeStyle = GRID_COLORS.hoverEdge;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(vp.tx + state.hover.x * cell + 0.5, vp.ty + state.hover.y * cell + 0.5, cell - 1, cell - 1);
    }
    for (const c of state.invalidCells) {
      ctx.fillStyle = GRID_COLORS.invalid;
      ctx.fillRect(vp.tx + c.x * cell, vp.ty + c.y * cell, cell, cell);
      ctx.strokeStyle = GRID_COLORS.invalidEdge;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(vp.tx + c.x * cell + 0.5, vp.ty + c.y * cell + 0.5, cell - 1, cell - 1);
    }
    if (state.layers.conflicts) {
      const pulse = 0.5 + 0.5 * Math.sin(nowTs() / 260);
      for (const c of state.conflictCells) {
        ctx.strokeStyle = `rgba(255, 111, 111, ${0.45 + 0.5 * pulse})`;
        ctx.lineWidth = 2.5;
        ctx.strokeRect(vp.tx + c.cell.x * cell - 2, vp.ty + c.cell.y * cell - 2, cell + 4, cell + 4);
      }
    }
    if (state.layers.events) {
      for (const e of state.eventMarks) {
        const px = cx(vp, e.cell.x);
        const py = cy(vp, e.cell.y);
        ctx.font = `${Math.max(10, Math.round(cell * 0.7))}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = e.kind.includes('obstacle') ? SB.coral : SB.amber;
        ctx.fillText('⚡', px, py);
      }
    }
  };
}
