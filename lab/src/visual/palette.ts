/**
 * V3 工业科技美术语言 · 色板与语义常量（唯一颜色来源）。
 *
 * 参考方向：Cinema 4D / Octane 风格的工业科技插画与半透明数字孪生。
 * 颜色体系（需求 §三-1）：深石墨 + 冰蓝 + 青 + 银白 + 少量琥珀橙。
 *
 * 注意：这里定义的是**渲染用线性色空间下的 sRGB 十六进制值**，Three.js 会自动
 * 依据 `ColorManagement` 转换；不要在场景里再手写颜色字面量，统一从这里取，
 * 保证 2D 面板、DOM、3D 场景是同一套视觉语言。
 */

export const VP = {
  // —— 空间与背景（深石墨 / 深蓝，不用纯黑，避免丢失细节）——
  void: '#05080c',
  deep: '#0a0f16',
  base: '#0e141d',
  fog: '#0b1119',
  gradientTop: '#152030',
  gradientBottom: '#05080c',

  // —— 材质基色 ——
  graphite: '#1b2027',
  graphiteLight: '#2a3138',
  cast: '#39424b',
  steel: '#8d99a6',
  steelDark: '#5b6672',
  brushed: '#a7b2bd',
  silverWhite: '#d9e2ea',
  enamel: '#c9d6e2',

  // —— 透明外壳（冰蓝 / 青 / 工业亚克力）——
  iceGlass: '#cfe9ff',
  iceGlassDeep: '#8cc6f0',
  cyanGlass: '#7fe6f2',
  acrylic: '#bcd8ea',

  // —— 状态与算法语义（克制使用，只给真实数据/状态）——
  ice: '#7fd7ff',
  cyan: '#3fe0d4',
  teal: '#4fe3a7',
  amber: '#ffb454',
  coral: '#ff6f6f',
  violet: '#a78bfa',
  inactive: '#5d6d84',

  // —— 文本/DOM（与 styles.css 的 token 对齐）——
  text: '#edf4ff',
  textDim: '#b9cbe2',
  muted: '#8296b0',
} as const;

/** 状态灯色（真实状态驱动；缺失状态一律 inactive，不猜）。 */
export const VP_STATUS = {
  running: VP.teal,
  setup: VP.ice,
  blocked: VP.amber,
  down: VP.coral,
  idle: VP.inactive,
  maintained: VP.violet,
} as const;

/** 算法可视化语义色（APS / AGV / MAPF 共用同一套语义）。 */
export const VP_ALGO = {
  /** 任务/订单主体路径 */
  route: VP.ice,
  /** 已完成/已执行轨迹 */
  executed: VP.teal,
  /** 目标位/取放点 */
  goal: VP.cyan,
  /** 冲突/阻塞（真实冲突数据） */
  conflict: VP.coral,
  /** 动态事件（插入任务、故障、暂停） */
  event: VP.amber,
  /** 幽灵方案（重规划前旧解） */
  ghost: '#5f7488',
} as const;

export type VpColor = keyof typeof VP;
