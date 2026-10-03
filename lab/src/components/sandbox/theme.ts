/**
 * V2 视觉方向色板与材质基准（lab/design/VISUAL-DIRECTION-V2.md）。
 * 2D Canvas 渲染器与 3D 沙盘共用，保证两种模式同一视觉语言。
 */

/** 深海军蓝背景（避免纯黑丢失细节）。 */
export const SB = {
  bg: '#0a1220',
  bgDeep: '#070d18',
  fog: '#0a1220',
  /** 底板 / 建筑材质（石墨灰、冷灰蓝、深金属）。 */
  plate: '#101a2c',
  plateEdge: '#1d2b44',
  plateLine: '#22334e',
  obstacle: '#2c3a52',
  obstacleEdge: '#3d5273',
  obstacleCold: '#33445f',
  rack: '#26334a',
  /** 轨迹主色：冰蓝 / 青 / 青绿 / 紫罗兰 / 琥珀。 */
  ice: '#7fd7ff',
  cyan: '#3fe0d4',
  teal: '#4fe3a7',
  violet: '#a78bfa',
  amber: '#ffb454',
  coral: '#ff6f6f',
  inactive: '#5d6d84',
  text: '#edf4ff',
} as const;

/** 机器人/车辆识别色序列（主：冰蓝青系；次：紫绿琥珀）。 */
export const SB_ROBOT_COLORS: readonly string[] = [
  SB.ice,
  SB.cyan,
  SB.violet,
  SB.amber,
  SB.teal,
  '#f78fb3',
  '#67c2ff',
  '#ffd479',
  '#8ef0c6',
  '#c9a2ff',
];

export function sbRobotColor(i: number): string {
  return SB_ROBOT_COLORS[i % SB_ROBOT_COLORS.length];
}

/** 相位 → 颜色（AGV 任务相位着色，语义与 2D 模式一致）。 */
export const SB_PHASE_COLOR: Record<string, string> = {
  to_pickup: SB.ice,
  servicing_pickup: '#1f5f8f',
  to_dropoff: SB.amber,
  servicing_dropoff: '#a5652a',
  relocating: SB.violet,
  parking: SB.inactive,
  idle: SB.inactive,
};
