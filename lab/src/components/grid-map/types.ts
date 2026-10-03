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

/** 主题色 token（V2 深色实验室主题：与 styles.css / sandbox/theme.ts 同一色板）。 */
export const GRID_COLORS = {
  /** 深海军蓝底（避免纯黑丢失细节）。 */
  background: '#0a1220',
  /** 细密工程网格（双色刻线）。 */
  gridLine: 'rgba(127, 215, 255, 0.07)',
  gridLineMajor: 'rgba(127, 215, 255, 0.15)',
  /** 石墨 / 冷灰蓝障碍。 */
  wall: '#22334e',
  wallEdge: '#33445f',
  hover: 'rgba(127, 215, 255, 0.16)',
  hoverEdge: 'rgba(127, 215, 255, 0.7)',
  invalid: 'rgba(255, 111, 111, 0.2)',
  invalidEdge: 'rgba(255, 111, 111, 0.85)',
  label: '#8296b0',
} as const;

/** 设备像素比上限（防 4K 高 DPI 离屏超限，M0 §4.2）。 */
export const MAX_DPR = 2;
