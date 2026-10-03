/**
 * 三种视觉模式（A 工业原貌 / B 工业科技艺术化 / C 算法观察）的统一配置。
 *
 * 三者**共用同一套几何与算法数据**：切换模式只改变材质、光照、透明层与发光强度，
 * 不重新加载场景、也不维护三份模型（对应需求 §八）。
 *
 * 视觉方向：C4D / Octane 风格的工业科技插画 —— 冷色工业材质 + 选择性半透明 +
 * 柔和冷暖渐变 + 克制的发光。仓库性能红线禁用后处理/泛光，因此发光由
 * 「自发光材质 + 细两级发光线 + 低透明外晕」实现（见 components/sandbox/GlowPath 与
 * ART-DIRECTION-C4D-INDUSTRIAL.md §6）。
 */

import { COOL, GLASS_TONES, GLOW, GRAPHITE, LIGHT_TONES, SHELL_TONES, WARM } from './tokens';
import type { ArtModeConfig, RoleAppearance } from './types';
import type { ArtModeId } from './tokens';

/** 全部角色（用于把外观表写成穷尽映射：漏一个角色编译期就会报错）。 */
const ROLE_LOOKUP = {
  shell: true,
  frame: true,
  graphite: true,
  machined: true,
  glazing: true,
  rubber: true,
  hazard: true,
  accent: true,
  emissive: true,
  fluid: true,
  polymer: true,
  floor: true,
  organic: true,
  metalWarm: true,
  consumable: true,
  skin: true,
  unknown: true,
} as const;

type RoleKey = keyof typeof ROLE_LOOKUP;

/** 角色 → 材质外观（模式 B/C 的“工业科技材质”定义）。 */
export const INDUSTRIAL_ROLE_APPEARANCE: Record<RoleKey, RoleAppearance> = {
  /** 设备外壳：冷银白漆面，轻微清漆高光（可选择性半透明）。 */
  shell: {
    kind: 'physical',
    color: SHELL_TONES.silver,
    roughness: 0.38,
    metalness: 0.34,
    clearcoat: 0.55,
    clearcoatRoughness: 0.28,
    envMapIntensity: 1.12,
    transparent: true,
    opacity: 0.42,
  },
  /** 结构钢构 / 机架：深色金属，保持清晰机械轮廓（永不透明）。 */
  frame: {
    kind: 'standard',
    color: '#46555f',
    roughness: 0.34,
    metalness: 0.86,
    envMapIntensity: 1.05,
  },
  /** 深石墨结构件：压出层次（永不透明）。 */
  graphite: {
    kind: 'standard',
    color: SHELL_TONES.graphite,
    roughness: 0.52,
    metalness: 0.62,
    envMapIntensity: 0.9,
  },
  /** 精密加工件：导轨 / 主轴 / 工作台，高反射（永不透明）。 */
  machined: {
    kind: 'standard',
    color: SHELL_TONES.machined,
    roughness: 0.22,
    metalness: 0.96,
    envMapIntensity: 1.35,
  },
  /** 玻璃 / 防护罩：冰蓝透明工业亚克力（保持顺序稳定，默认不用 transmission）。 */
  glazing: {
    kind: 'physical',
    color: GLASS_TONES.acrylic,
    roughness: 0.12,
    metalness: 0.08,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.45,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    side: 'double',
  },
  /** 橡胶 / 密封 / 轮胎：哑光深灰。 */
  rubber: {
    kind: 'standard',
    color: SHELL_TONES.rubber,
    roughness: 0.88,
    metalness: 0.04,
    envMapIntensity: 0.35,
  },
  /** 安全黄：降饱和的琥珀（避免廉价警示色）。 */
  hazard: {
    kind: 'standard',
    color: SHELL_TONES.hazard,
    roughness: 0.46,
    metalness: 0.28,
    envMapIntensity: 0.8,
  },
  /** 强调橙：操作件、危险区、任务节点。 */
  accent: {
    kind: 'standard',
    color: SHELL_TONES.accent,
    roughness: 0.42,
    metalness: 0.3,
    envMapIntensity: 0.85,
  },
  /** 自发光：状态灯 / 屏幕 / 灯具（必须来自真实状态语义）。 */
  emissive: {
    kind: 'standard',
    color: '#0e2733',
    roughness: 0.32,
    metalness: 0.2,
    emissive: GLOW.active,
    emissiveIntensity: 1.5,
    envMapIntensity: 0.6,
  },
  /** 冷却液 / 液体。 */
  fluid: {
    kind: 'physical',
    color: COOL.cyanDeep,
    roughness: 0.18,
    metalness: 0.05,
    clearcoat: 0.8,
    clearcoatRoughness: 0.14,
    envMapIntensity: 1.1,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  },
  /** 洁净室 / 塑料 / 复合面板：冷灰白。 */
  polymer: {
    kind: 'standard',
    color: '#b6c0c7',
    roughness: 0.5,
    metalness: 0.14,
    envMapIntensity: 0.72,
  },
  /** 地面与基础：精细网格科技地坪（反射受控）。 */
  floor: {
    kind: 'standard',
    color: '#1b232b',
    roughness: 0.34,
    metalness: 0.32,
    envMapIntensity: 0.85,
  },
  /** 木材：低饱和，弱化。 */
  organic: {
    kind: 'standard',
    color: '#6c5946',
    roughness: 0.82,
    metalness: 0.02,
    envMapIntensity: 0.4,
  },
  /** 有色金属：暖色点缀（铜/黄铜）。 */
  metalWarm: {
    kind: 'standard',
    color: '#a87c50',
    roughness: 0.3,
    metalness: 0.92,
    envMapIntensity: 1.1,
  },
  /** 工件 / 被加工物（纸箱、食品、工件）：低饱和中性色。 */
  consumable: {
    kind: 'standard',
    color: '#b9ac95',
    roughness: 0.86,
    metalness: 0.03,
    envMapIntensity: 0.4,
  },
  /** 人形标尺的皮肤材质：弱化，避免抢镜。 */
  skin: {
    kind: 'standard',
    color: '#a98d7c',
    roughness: 0.72,
    metalness: 0.02,
    envMapIntensity: 0.35,
  },
  /** 未分类：中性石墨色（不会伪装成玻璃或金属），并在面板上如实提示。 */
  unknown: {
    kind: 'standard',
    color: '#556069',
    roughness: 0.6,
    metalness: 0.34,
    envMapIntensity: 0.8,
  },
};

/** 模式 A 的“原貌”外观：不参与材质分配（`originalMaterials = true`）。 */
const ORIGINAL_APPEARANCE: RoleAppearance = {
  kind: 'standard',
  color: '#ffffff',
  roughness: 1,
  metalness: 0,
  envMapIntensity: 1,
};

export const ART_MODES: Record<ArtModeId, ArtModeConfig> = {
  A: {
    id: 'A',
    label: '工业原貌',
    tagline: '忠实呈现上传模型的原始材质与配置，用于结构检查与布局核对',
    background: GRAPHITE.deep,
    fog: null,
    toneMapping: 'aces',
    exposure: 1.12,
    lights: {
      ambient: { intensity: 0.72, color: '#d8e3ee' },
      hemisphere: { intensity: 0.92, sky: LIGHT_TONES.hemiSky, ground: LIGHT_TONES.hemiGround },
      key: { intensity: 2.15, color: LIGHT_TONES.key, shadow: true, mapSize: 1024 },
      fill: { intensity: 0.72, color: LIGHT_TONES.fill },
      rim: { intensity: 0.0, color: LIGHT_TONES.rim },
      locals: { intensity: 0, color: LIGHT_TONES.industrial, height: 0.9, distance: 2.3 },
      envIntensity: 1,
    },
    roleOverrides: {},
    baseAppearance: ORIGINAL_APPEARANCE,
    structureTransparency: 0,
    shellTransparency: 0,
    deEmphasis: 1,
    glowScale: 1,
    ground: { gridColor: '#596b77', sectionColor: '#82919b', reflectivity: 0.24, tint: '#38444a' },
    originalMaterials: true,
    contactShadow: 0,
    shadowQuality: 1,
  },
  B: {
    id: 'B',
    label: '工业科技艺术化',
    tagline: '冷色工业材质 + 选择性半透明 + 电影级冷暖光影（本轮主目标）',
    background: GRAPHITE.base,
    fog: { color: GRAPHITE.deep, near: 18, far: 74 },
    toneMapping: 'aces',
    exposure: 1.06,
    lights: {
      ambient: { intensity: 0.4, color: '#cfdcea' },
      hemisphere: { intensity: 0.55, sky: LIGHT_TONES.hemiSky, ground: LIGHT_TONES.hemiGround },
      key: { intensity: 2.45, color: LIGHT_TONES.key, shadow: true, mapSize: 2048 },
      fill: { intensity: 0.78, color: LIGHT_TONES.fill },
      rim: { intensity: 1.5, color: LIGHT_TONES.rim },
      locals: { intensity: 5.5, color: LIGHT_TONES.industrial, height: 0.92, distance: 1.6 },
      envIntensity: 1.15,
    },
    roleOverrides: INDUSTRIAL_ROLE_APPEARANCE,
    baseAppearance: INDUSTRIAL_ROLE_APPEARANCE.unknown,
    structureTransparency: 1,
    shellTransparency: 1,
    deEmphasis: 1,
    glowScale: 1,
    ground: { gridColor: '#4d6472', sectionColor: COOL.iceDeep, reflectivity: 0.42, tint: '#1d262e' },
    originalMaterials: false,
    contactShadow: 0.55,
    shadowQuality: 2,
  },
  C: {
    id: 'C',
    label: '算法观察',
    tagline: '弱化建筑与非关键设备，强化算法路径、任务节点与设备状态',
    background: GRAPHITE.void,
    fog: { color: GRAPHITE.void, near: 14, far: 62 },
    toneMapping: 'aces',
    exposure: 1.0,
    lights: {
      ambient: { intensity: 0.28, color: '#c3d4e4' },
      hemisphere: { intensity: 0.4, sky: LIGHT_TONES.hemiSky, ground: LIGHT_TONES.hemiGround },
      key: { intensity: 2.1, color: LIGHT_TONES.key, shadow: true, mapSize: 1024 },
      fill: { intensity: 0.66, color: LIGHT_TONES.fill },
      rim: { intensity: 1.9, color: LIGHT_TONES.rim },
      locals: { intensity: 4.2, color: LIGHT_TONES.industrial, height: 0.92, distance: 1.5 },
      envIntensity: 0.95,
    },
    roleOverrides: INDUSTRIAL_ROLE_APPEARANCE,
    baseAppearance: INDUSTRIAL_ROLE_APPEARANCE.unknown,
    structureTransparency: 1,
    shellTransparency: 0.85,
    deEmphasis: 0.45,
    glowScale: 1.4,
    ground: { gridColor: '#3c5162', sectionColor: GLOW.planned, reflectivity: 0.3, tint: '#151c23' },
    originalMaterials: false,
    contactShadow: 0.35,
    shadowQuality: 1,
  },
};

export const ART_MODE_IDS: ArtModeId[] = ['A', 'B', 'C'];

/** 模式 A 是唯一不做材质替换的模式；用于 UI 上给出“结构性提示”。 */
export function isOriginalMode(id: ArtModeId): boolean {
  return ART_MODES[id].originalMaterials;
}

export { WARM as ART_WARM };
