/**
 * 视口变换：cell↔px 换算只经这一处（M0 设计 §4.2）。
 *
 * - `fitViewport`：全图含 margin 格边距的适配视口；
 * - culling：给可视矩形内的格/段遍历提供边界。
 * 纯函数，Node 可直接测。
 */

import type { Cell, GridDims, PixelSize, Viewport } from './types';

export function cellToPx(vp: Viewport, c: Cell): { x: number; y: number } {
  return { x: vp.tx + c.x * vp.cellPx, y: vp.ty + c.y * vp.cellPx };
}

export function pxToCell(vp: Viewport, px: number, py: number): Cell {
  return { x: Math.floor((px - vp.tx) / vp.cellPx), y: Math.floor((py - vp.ty) / vp.cellPx) };
}

export function inBounds(dims: GridDims, c: Cell): boolean {
  return c.x >= 0 && c.y >= 0 && c.x < dims.width && c.y < dims.height;
}

/**
 * 适配窗口：全图 + margin 格边距（默认 1）。
 *
 * `opts.minExtent`：按“至少这么多格”来定 cellPx（地图仍按真实尺寸居中）。
 *
 * 为什么需要它：极小地图（例如 2×2 的 MAPF 最小规模样例）如果按真实尺寸全屏适配，
 * cellPx 会到几百像素，格内的起点方框/终点菱形被放大成“巨型框 + 巨菱形”，整屏看不见
 * 网格、只剩一堆重叠图元——真实反馈里的「MAPF 显示有问题」。给一个最小视野（与 3D
 * 等距相机的 span 下限一致）之后，小地图就是屏幕中央一块正常大小的网格。
 */
export function fitViewport(
  dims: GridDims,
  size: PixelSize,
  margin = 1,
  opts: { minExtent?: number } = {},
): Viewport {
  const extent = Math.max(1, opts.minExtent ?? 1);
  const w = Math.max(dims.width, extent);
  const h = Math.max(dims.height, extent);
  const mw = Math.max(1, w + margin * 2);
  const mh = Math.max(1, h + margin * 2);
  const cellPx = Math.max(0.5, Math.min(size.w / mw, size.h / mh));
  return {
    cellPx,
    tx: (size.w - dims.width * cellPx) / 2,
    ty: (size.h - dims.height * cellPx) / 2,
  };
}

/** 以 (px,py) 为锚点缩放：锚点下的格保持在锚点下。 */
export function zoomAt(vp: Viewport, px: number, py: number, factor: number, min = 0.3, max = 8, fitCellPx?: number): Viewport {
  const lo = Math.max(0.5, (fitCellPx ?? 8) * min);
  const hi = (fitCellPx ?? 8) * max;
  const cellPx = Math.min(hi, Math.max(lo, vp.cellPx * factor));
  const k = cellPx / vp.cellPx;
  return { cellPx, tx: px - (px - vp.tx) * k, ty: py - (py - vp.ty) * k };
}

/** 可视格范围（含 1 格冗余），用于 L1/L2/L3 culling。 */
export function visibleCells(vp: Viewport, size: PixelSize, dims: GridDims): { x0: number; y0: number; x1: number; y1: number } {
  const x0 = Math.max(0, Math.floor(-vp.tx / vp.cellPx) - 1);
  const y0 = Math.max(0, Math.floor(-vp.ty / vp.cellPx) - 1);
  const x1 = Math.min(dims.width - 1, Math.ceil((size.w - vp.tx) / vp.cellPx) + 1);
  const y1 = Math.min(dims.height - 1, Math.ceil((size.h - vp.ty) / vp.cellPx) + 1);
  return { x0, y0, x1, y1 };
}

/** cellPx → LOD 档位（M0 §4.3）。 */
export function lodLevel(cellPx: number): 0 | 1 | 2 | 3 {
  if (cellPx >= 22) return 0;
  if (cellPx >= 14) return 1;
  if (cellPx >= 8) return 2;
  return 3;
}
