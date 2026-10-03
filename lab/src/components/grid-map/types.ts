/**
 * grid-map 通用原语：无算法语义的栅格地图类型（M0 设计 §12.1）。
 *
 * 边界纪律：这里只知道「格子、尺寸、视口、拾取」——不知道机器人、路径、
 * 任务、起终点。MAPF 与 AGV 的语义图层由各自模块实现。
 */

/** 格坐标（整数格心）。 */
export type Cell = { x: number; y: number };

/** 地图尺寸（格数）。 */
export type GridDims = { width: number; height: number };

/**
 * 视口：世界坐标（格）→ 屏幕坐标（px）的唯一变换。
 * `cellPx` = 1 格的屏幕边长（CSS px）；(tx, ty) = 世界原点在屏幕上的位置。
 */
export type Viewport = {
  cellPx: number;
  tx: number;
  ty: number;
};

/** 屏幕像素尺寸（CSS px）。 */
export type PixelSize = { w: number; h: number };

/** 拾取结果：点击落在哪个格（越界时为 null）。 */
export type CellPick = { cell: Cell; px: number; py: number };

/** 主题色 token（浅色实验室主题，与 styles.css 变量对齐）。 */
export const GRID_COLORS = {
  background: '#f6f7f9',
  gridLine: '#e2e6ea',
  gridLineMajor: '#c9cfd6',
  wall: '#3a3f46',
  wallEdge: '#23272c',
  hover: 'rgba(47, 125, 225, 0.18)',
  hoverEdge: 'rgba(47, 125, 225, 0.65)',
  invalid: 'rgba(226, 89, 59, 0.25)',
  invalidEdge: 'rgba(226, 89, 59, 0.8)',
  label: '#5b6470',
} as const;

/** 设备像素比上限（防 4K 高 DPI 离屏超限，M0 §4.2）。 */
export const MAX_DPR = 2;
