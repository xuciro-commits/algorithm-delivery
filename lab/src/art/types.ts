/**
 * 艺术化系统的公共类型：部件语义角色、部件组、透明策略、三种视觉模式的配置。
 *
 * 设计红线（对应需求 §二、§七）：
 *  - 材质按**语义角色**分配，不按 mesh 名字硬编码，也不给所有 mesh 统一透明度；
 *  - 三种模式共用同一套几何与算法数据，只切换**视觉配置**（材质/灯光/透明度/发光）；
 *  - 任何透明都必须在策略表里显式声明（`transparencyPolicy`），内部机构永不透明。
 */

import type { ArtModeId } from './tokens';

/** 材质语义角色（来自 lab/src/art/part-roles.json，由资产实测统计得到）。 */
export type PartRole =
  | 'shell'
  | 'frame'
  | 'graphite'
  | 'machined'
  | 'glazing'
  | 'rubber'
  | 'hazard'
  | 'accent'
  | 'emissive'
  | 'fluid'
  | 'polymer'
  | 'floor'
  | 'organic'
  | 'metalWarm'
  | 'consumable'
  | 'skin'
  | 'unknown';

/** 部件组（按节点名归类：屋顶、墙体、门、传送、机器人、货架…）。 */
export type PartGroup =
  | 'roof'
  | 'structure'
  | 'floor'
  | 'aperture'
  | 'conveyor'
  | 'robot'
  | 'racking'
  | 'panel'
  | 'lighting'
  | 'guard'
  | 'drive'
  | 'cargo'
  | 'services'
  | 'vehicle'
  | 'vessel'
  | 'signage'
  | 'workstation'
  | 'machine'
  | 'utilities'
  | 'other';

/** 透明作用域：建筑（厂房）还是设备（外壳/防护罩）。 */
export type TransparencyScope = 'structure' | 'equipment';

export interface TransparencyRule {
  kind: 'role' | 'group';
  match: string;
  scope: TransparencyScope;
  /** 目标不透明度；0 = 直接隐藏（如地面、屋顶）。 */
  alpha: number;
}

export interface RoleRulesFile {
  version: string;
  roles: Record<string, string>;
  unlitRiskRoles: string[];
  transparencyCandidates: string[];
  materialRules: Array<{ match: string; role: PartRole }>;
  partGroupRules: Array<{ match: string; group: PartGroup }>;
  transparencyPolicy: {
    note: string;
    rules: TransparencyRule[];
    never: string[];
  };
}

/** 材质预设：模式 B/C 下按角色统一生成，保证“统一材质系统但保留材料差异”。 */
export interface ArtMaterialSpec {
  kind: 'standard' | 'physical';
  color: string;
  roughness: number;
  metalness: number;
  /** 透明相关（仅 kind === 'physical' 有意义）。 */
  transmission?: number;
  thickness?: number;
  ior?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  opacity?: number;
  transparent?: boolean;
  /** 透明排序提示：透明材质统一 depthWrite=false，避免重叠面排序噪声。 */
  depthWrite?: boolean;
  side?: 'front' | 'back' | 'double';
  emissive?: string;
  emissiveIntensity?: number;
  envMapIntensity?: number;
  flatShading?: boolean;
}

/** 一个角色在某一模式下的最终外观。 */
export interface RoleAppearance extends ArtMaterialSpec {
  /** 该角色是否参与透明外壳层。 */
  transparent?: boolean;
  /** 该角色在模式 C 下的弱化系数（1 = 不弱化）。 */
  focusDim?: number;
}

export interface ArtLightConfig {
  ambient: { intensity: number; color: string };
  hemisphere: { intensity: number; sky: string; ground: string };
  key: { intensity: number; color: string; shadow: boolean; mapSize: number };
  fill: { intensity: number; color: string };
  rim: { intensity: number; color: string };
  /** 工业局部光（灯带/工位灯）：数量与强度，由场景尺寸推导。 */
  locals: { intensity: number; color: string; height: number; distance: number };
  /** 环境贴图强度倍率。 */
  envIntensity: number;
}

export interface ArtModeConfig {
  id: ArtModeId;
  label: string;
  tagline: string;
  /** 背景与雾。 */
  background: string;
  fog: { color: string; near: number; far: number } | null;
  /** 色调映射与曝光。 */
  toneMapping: 'aces' | 'neutral' | 'linear';
  exposure: number;
  lights: ArtLightConfig;
  /** 每角色外观覆盖：未列出的角色回落到 `baseAppearance`。 */
  roleOverrides: Partial<Record<PartRole, RoleAppearance>>;
  baseAppearance: RoleAppearance;
  /** 建筑（厂房）层透明策略：0 = 完全保留原始外观。 */
  structureTransparency: number;
  /** 设备外壳透明策略：0 = 完全保留原始外观。 */
  shellTransparency: number;
  /** 非关键物体的弱化系数（模式 C 用于压暗背景设备）。 */
  deEmphasis: number;
  /** 发光倍率（路径/节点/状态灯）。 */
  glowScale: number;
  /** 地面：网格亮度与反射强度。 */
  ground: { gridColor: string; sectionColor: string; reflectivity: number; tint: string };
  /** 是否使用原始 glTF 材质（模式 A = true，忠实呈现工业原貌）。 */
  originalMaterials: boolean;
  /** 接触阴影（柔和 AO 投影）强度。 */
  contactShadow: number;
  /** 阴影贴图档位：0 = 关闭，1 = 1024，2 = 2048。 */
  shadowQuality: 0 | 1 | 2;
}

/** 场景里任一物体被判定出的语义（部件级）。 */
export interface PartSemantics {
  role: PartRole;
  group: PartGroup;
  /** 角色来源：材质名规则 / 几何启发式 / 回退。 */
  roleSource: 'material' | 'geometry' | 'fallback';
  /** 该 mesh 是否命中透明策略。 */
  transparency: { scope: TransparencyScope; alpha: number } | null;
}
