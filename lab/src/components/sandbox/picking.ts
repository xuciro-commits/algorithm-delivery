/**
 * 沙盘拾取（纯函数，Node 可测）：把三维空间里的指针交点换算成格坐标。
 * 3D 与 2D 编辑器共用同一回调协议（onCellDown/onCellMove/onCellUp/onHover）。
 */

import type { Cell } from '../grid-map/types';

/** 世界坐标（XZ 平面，底板铺在 [0,width]×[0,height]）→ 格坐标；越界返回 null。 */
export function cellFromWorld(x: number, z: number, width: number, height: number): Cell | null {
  const cx = Math.floor(x);
  const cy = Math.floor(z);
  if (cx < 0 || cy < 0 || cx >= width || cy >= height) return null;
  return { x: cx, y: cy };
}

/** 同一格里是否算「移动到了新格」（笔画去重，配合 stroke 级撤销）。 */
export function cellChanged(a: Cell | null, b: Cell | null): boolean {
  if (a === b) return false;
  if (!a || !b) return true;
  return a.x !== b.x || a.y !== b.y;
}
