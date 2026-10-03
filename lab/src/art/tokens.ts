/**
 * Algorithm Lab · 工业科技美术语言（C4D / Octane 视觉参考）· 设计令牌
 *
 * 这一层只放**颜色与材质语义**，不放任何算法语义：算法模块把自己的数据
 * （设备状态、任务、路径）映射到这里的语义色，从而保证三个实验室 + 三种
 * 视觉模式使用同一套颜色语言。
 *
 * 颜色体系（对应本轮艺术方向要求）：
 *   深石墨色  —— 背景 / 次要建筑 / 深色结构
 *   冰蓝 青   —— 透明外壳、路径、发光状态（克制）
 *   银白      —— 设备主体（冷灰 / 浅银白漆面）
 *   琥珀橙    —— 少量强调（操作件、警告、任务节点）
 *
 * 禁止：把全部模型统一涂成蓝色；也禁止把整场刷成霓虹灯。
 */

/** 场景基底（比 SB 更暗，用于艺术化的深石墨空间）。 */
export const GRAPHITE = {
  void: '#05080c',
  deep: '#080d13',
  base: '#0d131a',
  raise: '#141c25',
  edge: '#1f2b36',
  line: '#2a3a48',
} as const;

/** 冷色体系：冰蓝 / 青 / 银白。 */
export const COOL = {
  ice: '#8fd9ff',
  iceDeep: '#3f9ec9',
  cyan: '#3fe0d4',
  cyanDeep: '#1d8f8a',
  silver: '#dbe6ee',
  silverMid: '#aebdc9',
  steel: '#8798a6',
  steelDeep: '#4d5c68',
} as const;

/** 暖色强调：琥珀橙（克制使用）+ 状态色。 */
export const WARM = {
  amber: '#ffae57',
  amberDeep: '#b4741f',
  coral: '#ff6f6f',
  running: '#5fe0a0',
  idle: '#6d7f8f',
  violet: '#a78bfa',
} as const;

/** 设备主体涂装（模式 B/C 下的真实色相区分，避免“一片蓝”）。 */
export const SHELL_TONES = {
  /** 冷银白：主设备外壳。 */
  silver: '#c6d2da',
  /** 浅银灰：次级设备外壳。 */
  silverWarm: '#b8bdc2',
  /** 深色金属：机座、面板、结构件。 */
  graphite: '#2c3742',
  /** 精密加工件：导轨、主轴、工作台。 */
  machined: '#9fb0bb',
  /** 深色橡胶/密封。 */
  rubber: '#1b2126',
  /** 安全黄（降饱和，克制）。 */
  hazard: '#d9a441',
  /** 强调橙（操作件、警示）。 */
  accent: '#e8843c',
} as const;

/** 透明材质色（冰蓝 / 青）。 */
export const GLASS_TONES = {
  /** 磨砂玻璃（半透明厂房墙体）。 */
  frosted: '#9fb9c9',
  /** 冰蓝透明树脂（设备外壳）。 */
  resin: '#7fc9e8',
  /** 半透明工业亚克力（防护罩）。 */
  acrylic: '#5fa8c6',
  /** 观察窗（高级科技玻璃）。 */
  tech: '#6fbfe0',
} as const;

/** 发光语义（必须对应真实状态，不可装饰性伪装成运行数据）。 */
export const GLOW = {
  /** 运行中 / 已执行路径。 */
  active: '#7fe3ff',
  /** 排队 / 计划中。 */
  planned: '#8fd9ff',
  /** 任务节点（琥珀）。 */
  task: '#ffb454',
  /** 完成 / 就绪。 */
  done: '#5fe0a0',
  /** 冲突 / 违规（珊瑚）。 */
  alert: '#ff6f6f',
  /** 事件 / 动态重调度。 */
  event: '#c39bff',
} as const;

/**
 * 既有 2D / 沙盘色板（深海军蓝体系）。
 *
 * 历史背景：这套色板原先是 `components/sandbox/theme.ts` 的独立来源，与上面的
 * 石墨体系（GRAPHITE/COOL/WARM）并存，导致"两套单一来源"。现在**唯一来源是本文件**，
 * `components/sandbox/theme.ts` 只做转出（re-export），不再自己定义颜色。
 *
 * 用途：2D Canvas 回退渲染器（grid-map）与部分三维单元（底板、障碍、机器人识别色）
 * 仍然按深海军蓝体系取色，保持与三维场景的对比关系；新的艺术化材质请用上面的语义令牌。
 */
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

/**
 * 环境光颜色（用于 HDRI 之外的方向性补充）：
 * 主光偏暖白、补光偏冰蓝、轮廓光偏青，形成克制的冷暖渐变。
 */
export const LIGHT_TONES = {
  key: '#fff3e2',
  fill: '#a9cdff',
  rim: '#6fe6ff',
  hemiSky: '#cfe4ff',
  hemiGround: '#3d4753',
  industrial: '#cfe6ff',
} as const;

/** 三种视觉模式（A 工业原貌 / B 工业科技艺术化 / C 算法观察）。 */
export type ArtModeId = 'A' | 'B' | 'C';

export const ART_MODE_LABEL: Record<ArtModeId, string> = {
  A: '工业原貌',
  B: '工业科技艺术化',
  C: '算法观察',
};

export const ART_MODE_TAGLINE: Record<ArtModeId, string> = {
  A: '忠实呈现原始模型与设备布局，用于结构检查',
  B: '冷色工业材质 + 选择性半透明 + 电影级光影（本轮主目标）',
  C: '弱化建筑与非关键设备，强化算法路径 / 任务 / 状态',
};

/** 视觉模式选择项：给分段器用（id 保持 ArtModeId 字面量类型，避免被推断成 string）。 */
export const ART_MODE_OPTIONS: Array<{ id: ArtModeId; label: string; title: string }> = (
  ['A', 'B', 'C'] as const
).map((id) => ({ id, label: ART_MODE_LABEL[id], title: ART_MODE_TAGLINE[id] }));
