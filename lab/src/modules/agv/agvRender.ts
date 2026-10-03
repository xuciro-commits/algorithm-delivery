/**
 * AGV 语义图层：车辆轨迹（含任务相位着色）、载货状态、任务起终点标记、
 * 工作站泊位与容量、停车格。由 MapStage 的 L1/L2/L3 painter 工厂组成。
 */

import type { Cell, PixelSize, Viewport } from '../../components/grid-map/types';
import { GRID_COLORS } from '../../components/grid-map/types';
import { lodLevel } from '../../components/grid-map/viewport';
import type { AgvSolution } from '../../core/agv/types';
import type { AgvScene } from './scene';
import { locCells } from './scene';

export const AGV_PALETTE = ['#2f7de1', '#e2593b', '#3fa45a', '#b08300', '#8a5fc9', '#1e9aa7', '#c94f7c', '#5b7c00', '#4b6eaf', '#a5572f'];

export function agvColor(i: number): string {
  return AGV_PALETTE[i % AGV_PALETTE.length];
}

export type AgvPhase = 'idle' | 'to_pickup' | 'servicing_pickup' | 'to_dropoff' | 'servicing_dropoff' | 'parking' | 'relocating';

export interface AgvRenderState {
  scene: AgvScene;
  solution: AgvSolution | null;
  t: number;
  primary: string | null;
  layers: { paths: boolean; executed: boolean; markers: boolean; vehicles: boolean };
  hover: Cell | null;
  invalidCells: Array<Cell>;
  conflictCells: Array<Cell>;
}

type Painter = (ctx: CanvasRenderingContext2D, vp: Viewport, size: PixelSize) => void;

const cx = (vp: Viewport, x: number) => vp.tx + x * vp.cellPx + vp.cellPx / 2;
const cy = (vp: Viewport, y: number) => vp.ty + y * vp.cellPx + vp.cellPx / 2;

export function phaseAt(solution: AgvSolution, vi: number, t: number): AgvPhase {
  const v = solution.plan?.vehicles?.[vi];
  if (!v) return 'idle';
  for (const m of v.missions ?? []) {
    if (t >= m.from && t <= m.to) {
      return (m.phase as AgvPhase) ?? 'idle';
    }
  }
  return 'idle';
}

export function taskOfAt(solution: AgvSolution, vi: number, t: number): string | null {
  const v = solution.plan?.vehicles?.[vi];
  if (!v) return null;
  for (const m of v.missions ?? []) {
    if (t >= m.from && t <= m.to) return m.task;
  }
  return null;
}

/** L1：车辆轨迹（时间线）—— 任务相位分段着色，未来虚线。 */
export function paintAgvPathsL1(state: AgvRenderState): Painter {
  return (ctx, vp) => {
    const sol = state.solution;
    if (!sol?.plan?.vehicles?.length) return;
    const lod = lodLevel(vp.cellPx);
    const lw = lod === 0 ? 3 : lod === 1 ? 2.5 : lod === 2 ? 2 : 1.5;
    for (const [vi, v] of sol.plan.vehicles.entries()) {
      const tl = v.timeline ?? [];
      if (tl.length < 2) continue;
      const color = agvColor(vi);
      const dim = state.primary && state.primary !== v.id;
      ctx.save();
      ctx.globalAlpha = dim ? 0.18 : 1;
      const endT = Math.min(state.t, tl.length - 1);
      // 已执行（分段：按相位着色）
      if (state.layers.executed) {
        let segStart = 0;
        let phase = phaseAt(sol, vi, 0);
        const flush = (end: number) => {
          if (end <= segStart) return;
          ctx.strokeStyle = phase.includes('dropoff') ? '#b06a00' : phase === 'idle' ? color : color;
          ctx.lineWidth = lw + 0.5;
          ctx.setLineDash([]);
          if (phase === 'idle' || phase === 'parking') {
            ctx.globalAlpha = (dim ? 0.18 : 1) * 0.4;
          }
          ctx.beginPath();
          for (let k = segStart; k <= end; k++) {
            const [x, y] = tl[k];
            if (k === segStart) ctx.moveTo(cx(vp, x), cy(vp, y));
            else ctx.lineTo(cx(vp, x), cy(vp, y));
          }
          ctx.stroke();
          ctx.globalAlpha = dim ? 0.18 : 1;
        };
        for (let k = 1; k <= endT; k++) {
          const ph = phaseAt(sol, vi, k);
          if (ph !== phase) {
            flush(k - 1);
            segStart = k - 1;
            phase = ph;
          }
        }
        flush(endT);
      }
      // 未来（虚线）
      if (state.layers.paths && endT < tl.length - 1) {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, lw - 0.5);
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        for (let k = endT; k < tl.length; k++) {
          const [x, y] = tl[k];
          if (k === endT) ctx.moveTo(cx(vp, x), cy(vp, y));
          else ctx.lineTo(cx(vp, x), cy(vp, y));
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }
  };
}

/** L2：实体 —— 车辆当前位置（载货方标）、任务起终点、工作站、停车格。 */
export function paintAgvEntitiesL2(state: AgvRenderState): Painter {
  return (ctx, vp) => {
    const cell = vp.cellPx;
    const sol = state.solution;
    const lod = lodLevel(vp.cellPx);
    const scene = state.scene;

    // 停车格（p 标）
    for (const [px, py] of scene.parking) {
      ctx.fillStyle = 'rgba(120,130,140,0.16)';
      ctx.fillRect(vp.tx + px * cell, vp.ty + py * cell, cell, cell);
      if (lod <= 1) {
        ctx.fillStyle = '#8a949e';
        ctx.font = `${Math.max(7, Math.round(cell * 0.4))}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('P', cx(vp, px), cy(vp, py));
      }
    }

    // 工作站（泊位格 + 容量标牌）
    for (const s of scene.stations) {
      for (const [dx, dy] of s.cells) {
        ctx.fillStyle = 'rgba(176,131,0,0.16)';
        ctx.fillRect(vp.tx + dx * cell, vp.ty + dy * cell, cell, cell);
        ctx.strokeStyle = 'rgba(176,131,0,0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(vp.tx + dx * cell + 0.5, vp.ty + dy * cell + 0.5, cell - 1, cell - 1);
        if (lod <= 1) {
          ctx.fillStyle = '#8a5300';
          ctx.font = `${Math.max(7, Math.round(cell * 0.38))}px system-ui`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('▣', cx(vp, dx), cy(vp, dy));
        }
      }
    }

    // 任务起终点（编辑态或标记层）
    if (state.layers.markers) {
      for (const [ti, task] of scene.tasks.entries()) {
        const hue = 210 + (ti * 47) % 120;
        const pickupCells = locCells(scene, task.pickup);
        const dropCells = locCells(scene, task.dropoff);
        for (const [x, y] of pickupCells) {
          drawTriangle(ctx, vp, x, y, 'up', `hsl(${hue} 62% 46%)`, cell);
        }
        for (const [x, y] of dropCells) {
          drawTriangle(ctx, vp, x, y, 'down', `hsl(${hue} 62% 46%)`, cell);
        }
        if (lod === 0 && Array.isArray(task.pickup) && Array.isArray(task.dropoff) && pickupCells.length && dropCells.length) {
          ctx.strokeStyle = `hsl(${hue} 62% 46% / 0.3)`;
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.moveTo(cx(vp, pickupCells[0][0]), cy(vp, pickupCells[0][1]));
          ctx.lineTo(cx(vp, dropCells[0][0]), cy(vp, dropCells[0][1]));
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // 车辆：起点框（编辑态）与当前位置（解）
    for (const [vi, v] of scene.vehicles.entries()) {
      const color = agvColor(vi);
      if (!sol?.plan?.vehicles?.[vi]) {
        // 编辑态：起点描边框
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        const inset = Math.max(2, cell * 0.12);
        ctx.strokeRect(vp.tx + v.start[0] * cell + inset, vp.ty + v.start[1] * cell + inset, cell - inset * 2, cell - inset * 2);
      }
    }
    if (state.layers.vehicles && sol?.plan?.vehicles) {
      for (const [vi, v] of sol.plan.vehicles.entries()) {
        const tl = v.timeline ?? [];
        if (!tl.length) continue;
        const k = Math.min(state.t, tl.length - 1);
        const [x, y] = tl[k];
        const color = agvColor(vi);
        const dim = state.primary && state.primary !== v.id;
        const px = cx(vp, x);
        const py = cy(vp, y);
        const rad = cell * 0.34;
        const phase = phaseAt(sol, vi, state.t);
        ctx.save();
        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(px - rad, py - rad, rad * 2, rad * 2, Math.max(1.5, rad * 0.3));
        ctx.fill();
        // 载货：橙色方块内芯 + 车顶标记
        if (phase.includes('dropoff')) {
          ctx.fillStyle = '#fff';
          ctx.fillRect(px - rad * 0.4, py - rad * 0.4, rad * 0.8, rad * 0.8);
          ctx.fillStyle = '#b06a00';
          ctx.fillRect(px - rad * 0.26, py - rad * 0.26, rad * 0.52, rad * 0.52);
        }
        if (phase.startsWith('servicing')) {
          ctx.strokeStyle = '#101418';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(px, py, rad + 2, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (lod <= 1 || state.primary === v.id) {
          ctx.fillStyle = '#fff';
          ctx.font = `bold ${Math.max(8, Math.round(rad * 0.9))}px system-ui`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(vi + 1), px, py + (phase.includes('dropoff') ? rad * 1.15 : 0.5));
        }
        if (state.primary === v.id) {
          ctx.strokeStyle = '#101418';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.roundRect(px - rad - 2.5, py - rad - 2.5, (rad + 2.5) * 2, (rad + 2.5) * 2, 4);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  };
}

function drawTriangle(ctx: CanvasRenderingContext2D, vp: Viewport, x: number, y: number, dir: 'up' | 'down', color: string, cell: number) {
  const px = cx(vp, x);
  const py = cy(vp, y);
  const r = cell * 0.26;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (dir === 'up') {
    ctx.moveTo(px, py - r);
    ctx.lineTo(px + r, py + r * 0.8);
    ctx.lineTo(px - r, py + r * 0.8);
  } else {
    ctx.moveTo(px, py + r);
    ctx.lineTo(px + r, py - r * 0.8);
    ctx.lineTo(px - r, py - r * 0.8);
  }
  ctx.closePath();
  ctx.globalAlpha *= 0.85;
  ctx.fill();
  ctx.globalAlpha /= 0.85;
}

/** L3：悬停 / 非法预览 / 冲突脉冲。 */
export function paintAgvOverlayL3(state: AgvRenderState, nowTs: () => number = () => performance.now()): Painter {
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
    }
    const pulse = 0.5 + 0.5 * Math.sin(nowTs() / 260);
    for (const c of state.conflictCells) {
      ctx.strokeStyle = `rgba(226, 89, 59, ${0.45 + 0.5 * pulse})`;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(vp.tx + c.x * cell - 2, vp.ty + c.y * cell - 2, cell + 4, cell + 4);
    }
  };
}
