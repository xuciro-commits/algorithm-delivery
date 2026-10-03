/**
 * 三种可切换视觉模式（需求 §八）· 唯一的场景视觉配置。
 *
 *   模式 A《工业原貌》 —— 忠实呈现原始材质/默认光照，用于核对结构与布局；
 *   模式 B《工业科技艺术化》 —— 本轮主要目标：冷色工业材质 + 选择性半透明 +
 *                                柔和冷暖渐变 + 精细轮廓与克制的自发光；
 *   模式 C《算法观察》 —— 在 B 的基础上弱化非关键建筑与设备，强化算法路径、
 *                          关键节点、任务状态与动态事件。
 *
 * 三种模式**共用同一份场景几何与同一份真实算法数据**，这里只切换视觉参数
 * （材质角色映射、透明策略、灯光、曝光、地面、发光强度），不维护三套模型。
 */

import { VP } from './palette';

export type VisualModeId = 'A' | 'B' | 'C';
/** 渲染质量档：透明实现方式、阴影、分辨率随之切换（大场景性能红线）。 */
export type QualityTier = 'high' | 'balanced' | 'low';

export interface LightingConfig {
  /** 环境光照度（HDRI 作为反射与补光）。 */
  environmentIntensity: number;
  ambient: { intensity: number; color: string };
  hemisphere: { intensity: number; sky: string; ground: string };
  /** 主光：有方向性、投射软阴影。 */
  key: { intensity: number; color: string; dir: [number, number, number]; castShadow: boolean };
  /** 补光：压暗面部阴影，保持机械细节可读。 */
  fill: { intensity: number; color: string; dir: [number, number, number] };
  /** 轮廓光：勾出机械轮廓（冷色，位于主体后方）。 */
  rim: { intensity: number; color: string; dir: [number, number, number] };
  /** 局部工业灯：沿产线的暖白点光，制造冷暖渐变。 */
  practical: { intensity: number; color: string; distance: number; count: number };
}

export interface ShellConfig {
  /** original = 原样（模式 A）；dim = 保留原材质但压暗（模式 C 的非关键对象）。 */
  treatment: 'original' | 'glass' | 'dim';
  opacity: number;
  transmission: number;
  roughness: number;
  thickness: number;
  tint: string;
  /** 边缘菲涅尔描边强度（"精致的机械轮廓"）。 */
  rimStrength: number;
  rimAlpha: number;
  rimTint: string;
}

export interface GroundConfig {
  gridIntensity: number;
  majorEvery: number;
  zoneIntensity: number;
  tint: string;
  lineColor: string;
  /** 地面粗糙度：越小反射越清晰（科技地面的“合理反射”）。 */
  roughness: number;
  metalness: number;
  fadeRadius: number;
}

export interface VisualModeConfig {
  id: VisualModeId;
  name: string;
  tagline: string;
  /** 背景与雾：冷色渐变，保证设备与发光之间有明确层次。 */
  background: string;
  fog: { color: string; near: number; far: number } | null;
  exposure: number;
  /** 材质明度/饱和的整体调子（>1 更亮，<1 更沉）。 */
  materialTint: number;
  /** 自发光整体倍率：算法观察模式稍高，工业原貌为 1。 */
  glow: number;
  /** 是否使用艺术化材质预设（false = 完全保留原始材质，模式 A）。 */
  artisticMaterials: boolean;
  /** 非关键对象（建筑/次要设备）的弱化系数：1 = 不弱化。 */
  dim: number;
  lighting: LightingConfig;
  shell: ShellConfig;
  building: ShellConfig;
  ground: GroundConfig;
  /** 是否渲染接触阴影盘（廉价、可控的局部 AO）。 */
  contactShadows: boolean;
  /** 是否高亮算法相关部件（仅当模块提供真实数据时生效）。 */
  highlightAlgorithm: boolean;
}

const SHARED_GROUND: GroundConfig = {
  gridIntensity: 0.5,
  majorEvery: 5,
  zoneIntensity: 0.34,
  tint: VP.base,
  lineColor: VP.ice,
  roughness: 0.34,
  metalness: 0.62,
  fadeRadius: 1,
};

/** 主光方向（单位向量方向，实际距离由场景尺度决定）。 */
const KEY_DIR: [number, number, number] = [0.62, 1.35, 0.58];
const FILL_DIR: [number, number, number] = [-0.85, 0.5, -0.45];
const RIM_DIR: [number, number, number] = [-0.35, 0.55, -1.0];

export const VISUAL_MODES: Record<VisualModeId, VisualModeConfig> = {
  A: {
    id: 'A',
    name: '工业原貌',
    tagline: '保留原始材质与默认光照，用于核对设备结构与生产布局',
    background: VP.deep,
    fog: null,
    exposure: 1.0,
    materialTint: 1,
    glow: 1,
    artisticMaterials: false,
    dim: 1,
    contactShadows: false,
    highlightAlgorithm: false,
    lighting: {
      environmentIntensity: 0.75,
      ambient: { intensity: 0.55, color: '#d8e3ee' },
      hemisphere: { intensity: 0.7, sky: '#dbe8f5', ground: '#4a545e' },
      key: { intensity: 2.1, color: '#fff4e2', dir: KEY_DIR, castShadow: true },
      fill: { intensity: 0.6, color: '#cfe0f2', dir: FILL_DIR },
      rim: { intensity: 0.25, color: '#bcd4ef', dir: RIM_DIR },
      practical: { intensity: 2.6, color: '#fff0d8', distance: 9, count: 2 },
    },
    shell: { treatment: 'original', opacity: 1, transmission: 0, roughness: 0.2, thickness: 0.02, tint: VP.iceGlass, rimStrength: 0, rimAlpha: 0, rimTint: VP.ice },
    building: { treatment: 'original', opacity: 1, transmission: 0, roughness: 0.5, thickness: 0.02, tint: VP.iceGlass, rimStrength: 0, rimAlpha: 0, rimTint: VP.ice },
    ground: { ...SHARED_GROUND, gridIntensity: 0.16, zoneIntensity: 0 },
  },
  B: {
    id: 'B',
    name: '工业科技艺术化',
    tagline: '冷色工业材质 · 选择性半透明 · 柔和冷暖渐变 · 克制的自发光',
    background: VP.base,
    fog: { color: VP.fog, near: 62, far: 240 },
    exposure: 1.06,
    materialTint: 1.06,
    glow: 1,
    artisticMaterials: true,
    dim: 1,
    contactShadows: true,
    highlightAlgorithm: false,
    lighting: {
      environmentIntensity: 1.15,
      ambient: { intensity: 0.42, color: '#cfe0f5' },
      hemisphere: { intensity: 0.62, sky: '#dcf0ff', ground: '#2c3846' },
      key: { intensity: 2.75, color: '#fff6e8', dir: KEY_DIR, castShadow: true },
      fill: { intensity: 0.95, color: '#a9cdf5', dir: FILL_DIR },
      rim: { intensity: 1.35, color: '#b6dcff', dir: RIM_DIR },
      practical: { intensity: 3.4, color: '#ffeccf', distance: 11, count: 3 },
    },
    shell: {
      treatment: 'glass',
      opacity: 0.34,
      transmission: 0.92,
      roughness: 0.18,
      thickness: 0.045,
      tint: VP.iceGlass,
      rimStrength: 0.5,
      rimAlpha: 0.16,
      rimTint: VP.ice,
    },
    building: {
      treatment: 'glass',
      opacity: 0.14,
      transmission: 0.88,
      roughness: 0.3,
      thickness: 0.06,
      tint: VP.iceGlassDeep,
      rimStrength: 0.42,
      rimAlpha: 0.1,
      rimTint: VP.cyan,
    },
    ground: { ...SHARED_GROUND },
  },
  C: {
    id: 'C',
    name: '算法观察',
    tagline: '弱化非关键建筑与设备，强化算法路径、关键节点与动态事件',
    background: VP.void,
    fog: { color: VP.void, near: 48, far: 190 },
    exposure: 1.02,
    materialTint: 0.92,
    glow: 1.18,
    artisticMaterials: true,
    dim: 0.42,
    contactShadows: false,
    highlightAlgorithm: true,
    lighting: {
      environmentIntensity: 0.85,
      ambient: { intensity: 0.3, color: '#c6dcf5' },
      hemisphere: { intensity: 0.4, sky: '#cfe8ff', ground: '#1f2933' },
      key: { intensity: 2.1, color: '#fff6ea', dir: KEY_DIR, castShadow: false },
      fill: { intensity: 0.6, color: '#9ec6f2', dir: FILL_DIR },
      rim: { intensity: 1.6, color: '#a8d6ff', dir: RIM_DIR },
      practical: { intensity: 1.9, color: '#ffe9cc', distance: 9, count: 2 },
    },
    shell: {
      treatment: 'glass',
      opacity: 0.16,
      transmission: 0.86,
      roughness: 0.26,
      thickness: 0.04,
      tint: VP.iceGlassDeep,
      rimStrength: 0.34,
      rimAlpha: 0.08,
      rimTint: VP.ice,
    },
    building: {
      treatment: 'dim',
      opacity: 0.06,
      transmission: 0,
      roughness: 0.5,
      thickness: 0.02,
      tint: VP.iceGlassDeep,
      rimStrength: 0.0,
      rimAlpha: 0.0,
      rimTint: VP.cyan,
    },
    ground: { ...SHARED_GROUND, gridIntensity: 0.34, zoneIntensity: 0.22, roughness: 0.42 },
  },
};

export const VISUAL_MODE_LIST: VisualModeConfig[] = [VISUAL_MODES.A, VISUAL_MODES.B, VISUAL_MODES.C];

/** 质量档 → 渲染参数（dpd / 阴影 / 透明实现）。 */
export interface QualityConfig {
  id: QualityTier;
  label: string;
  dpr: [number, number];
  shadowMapSize: number;
  /** high/balanced 用物理透射（无排序噪声）；low 用 alpha 混合兜底。 */
  useTransmission: boolean;
  contactShadowResolution: number;
  environmentResolution: number;
}

export const QUALITY_TIERS: Record<QualityTier, QualityConfig> = {
  high: {
    id: 'high',
    label: '高（物理透射 · 2K 阴影）',
    dpr: [1, 2],
    shadowMapSize: 2048,
    useTransmission: true,
    contactShadowResolution: 512,
    environmentResolution: 256,
  },
  balanced: {
    id: 'balanced',
    label: '均衡（物理透射 · 1K 阴影）',
    dpr: [1, 1.5],
    shadowMapSize: 1024,
    useTransmission: true,
    contactShadowResolution: 384,
    environmentResolution: 256,
  },
  low: {
    id: 'low',
    label: '轻量（透明混合 · 无阴影贴图）',
    dpr: [1, 1],
    shadowMapSize: 512,
    useTransmission: false,
    contactShadowResolution: 256,
    environmentResolution: 128,
  },
};

export function resolveMode(id: VisualModeId | string | undefined): VisualModeConfig {
  if (id === 'A' || id === 'B' || id === 'C') return VISUAL_MODES[id];
  return VISUAL_MODES.B;
}

export function resolveQuality(id: QualityTier | string | undefined): QualityConfig {
  if (id === 'high' || id === 'balanced' || id === 'low') return QUALITY_TIERS[id];
  return QUALITY_TIERS.balanced;
}
