/**
 * 统一工业材质系统：按**语义角色**生成材质，而不是给每个 mesh 单独写材质、也不是
 * 把所有 mesh 刷成同一种颜色/透明度。
 *
 * 关键工程约束（需求 §二·2 与 §七）：
 *  1. 材质按 (模式, 角色, 变体) 缓存复用 —— 一整个厂房只有十几种材质实例；
 *  2. 透明只发生在策略表允许的角色上（外壳 / 玻璃 / 建筑遮挡），内部机构永不透明；
 *  3. 透明材质统一 `depthWrite = false` + 提升 renderOrder，避免重叠面排序噪声；
 *  4. alpha ≈ 0 的建筑遮挡直接隐藏，而不是画一层几乎不可见的面（减少穿透伪影）；
 *  5. 原始材质与可见性在替换前保存，模式 A 一键还原（禁止破坏原始模型资源）。
 */

import * as THREE from 'three';
import { classifyMesh, resolveTransparency } from './roles';
import type { ArtModeConfig, ArtMaterialSpec, PartRole, RoleAppearance } from './types';
import type { ArtSettings } from './settings';

/** 材质变体：常规 / 弱化（非关键）/ 强调（选中或状态）/ 幽灵（历史数据）。 */
export type MaterialVariant = 'base' | 'dim' | 'emphasis' | 'ghost';

interface OriginalRecord {
  material: THREE.Material | THREE.Material[];
  visible: boolean;
  renderOrder: number;
  castShadow: boolean;
  receiveShadow: boolean;
}

const ORIGINAL_KEY = 'artOriginal';

function specToMaterial(spec: ArtMaterialSpec): THREE.Material {
  const common = {
    color: new THREE.Color(spec.color),
    roughness: spec.roughness,
    metalness: spec.metalness,
    envMapIntensity: spec.envMapIntensity ?? 1,
    flatShading: spec.flatShading ?? false,
  };
  let material: THREE.Material;
  if (spec.kind === 'physical') {
    const physical = new THREE.MeshPhysicalMaterial({
      ...common,
      clearcoat: spec.clearcoat ?? 0,
      clearcoatRoughness: spec.clearcoatRoughness ?? 0.2,
      transmission: spec.transmission ?? 0,
      thickness: spec.thickness ?? 0,
      ior: spec.ior ?? 1.45,
    });
    material = physical;
  } else {
    material = new THREE.MeshStandardMaterial(common);
  }
  if (spec.emissive) {
    const std = material as THREE.MeshStandardMaterial;
    std.emissive = new THREE.Color(spec.emissive);
    std.emissiveIntensity = spec.emissiveIntensity ?? 1;
  }
  const anyMaterial = material as THREE.MeshStandardMaterial;
  if (spec.transparent || (spec.opacity != null && spec.opacity < 1)) {
    anyMaterial.transparent = true;
    anyMaterial.opacity = spec.opacity ?? 1;
    anyMaterial.depthWrite = spec.depthWrite ?? false;
  }
  anyMaterial.side = spec.side === 'double' ? THREE.DoubleSide : spec.side === 'back' ? THREE.BackSide : THREE.FrontSide;
  material.name = `art:${spec.color}`;
  return material;
}

/** 把角色外观折算成最终材质规格（模式 + 用户设置共同决定透明度与玻璃质量）。 */
export function resolveRoleSpec(
  role: PartRole,
  mode: ArtModeConfig,
  settings: ArtSettings,
  variant: MaterialVariant,
  transparencyAlpha: number | null,
): ArtMaterialSpec {
  const appearance: RoleAppearance = mode.roleOverrides[role] ?? mode.baseAppearance;
  const spec: ArtMaterialSpec = { ...appearance };

  // 半透明外壳：只有命中策略的部件才拿到 alpha；其余保持不透明。
  if (transparencyAlpha != null && appearance.transparent) {
    spec.opacity = Math.min(spec.opacity ?? 1, transparencyAlpha);
    spec.transparent = true;
    spec.depthWrite = false;
    // 高质量玻璃（可选）：给透明件加入真实 transmission；大场景默认关闭以控制开销。
    if (settings.physicalGlass && spec.kind === 'physical' && !spec.transmission) {
      spec.transmission = 0.28;
      spec.thickness = 0.06;
      spec.ior = 1.46;
    }
  } else if (appearance.transparent) {
    // 角色本身是透明件（玻璃），但模式未开启透明层 → 保留为不透明冰蓝材质，
    // 这样模式 A/C 关闭半透明时也不会出现“全透明看不见”的破面。
    spec.transparent = false;
    spec.opacity = 1;
    spec.depthWrite = true;
    spec.kind = 'physical';
    spec.roughness = Math.min(0.28, spec.roughness);
  }

  if (variant === 'dim') {
    const factor = mode.deEmphasis;
    const dimColor = new THREE.Color(spec.color).clone().lerp(new THREE.Color(mode.background), 1 - factor);
    spec.color = `#${dimColor.getHexString()}`;
    spec.envMapIntensity = (spec.envMapIntensity ?? 1) * (0.55 + 0.45 * factor);
    if (spec.emissive) spec.emissiveIntensity = (spec.emissiveIntensity ?? 1) * (0.3 + 0.7 * factor);
  } else if (variant === 'ghost') {
    // 历史/失效数据：更暗、更冷，只作为空间参考存在。
    spec.color = mode.background;
    spec.opacity = 0.28;
    spec.transparent = true;
    spec.depthWrite = false;
    spec.emissiveIntensity = 0;
  } else if (variant === 'emphasis') {
    const boosted = (spec.emissiveIntensity ?? 1) * 1.35;
    spec.emissiveIntensity = boosted;
    spec.envMapIntensity = (spec.envMapIntensity ?? 1) * 1.25;
  }
  return spec;
}

export interface ApplyStats {
  meshes: number;
  transparent: number;
  hidden: number;
  dimmed: number;
  roles: Partial<Record<PartRole, number>>;
  unknownRoles: string[];
}

/**
 * 材质库：一次构建，整场景复用。key = `${mode.id}:${role}:${variant}:${alphaBucket}`。
 * alpha 量化到 0.01，避免连续 alpha 造出无数材质实例。
 */
export class ArtMaterialLibrary {
  private readonly materials = new Map<string, THREE.Material>();

  constructor(
    private readonly mode: ArtModeConfig,
    private readonly settings: ArtSettings,
  ) {}

  get modeId(): string {
    return this.mode.id;
  }

  materialFor(role: PartRole, variant: MaterialVariant, alpha: number | null): THREE.Material {
    const alphaKey = alpha == null ? 'o' : `a${Math.round(alpha * 100)}`;
    const key = `${this.mode.id}:${role}:${variant}:${alphaKey}:${this.settings.physicalGlass ? 1 : 0}`;
    const cached = this.materials.get(key);
    if (cached) return cached;
    const material = specToMaterial(resolveRoleSpec(role, this.mode, this.settings, variant, alpha));
    material.name = key;
    this.materials.set(key, material);
    return material;
  }

  dispose(): void {
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
  }
}

function originalOf(object: THREE.Mesh): OriginalRecord | undefined {
  return object.userData[ORIGINAL_KEY] as OriginalRecord | undefined;
}

function rememberOriginal(mesh: THREE.Mesh): OriginalRecord {
  const existing = originalOf(mesh);
  if (existing) return existing;
  const record: OriginalRecord = {
    material: mesh.material,
    visible: mesh.visible,
    renderOrder: mesh.renderOrder,
    castShadow: mesh.castShadow,
    receiveShadow: mesh.receiveShadow,
  };
  mesh.userData[ORIGINAL_KEY] = record;
  return record;
}

export interface ApplyOptions {
  /** 只作用在这棵子树上（默认整个 root）。 */
  root?: THREE.Object3D;
  /** 不需要艺术化处理的对象（例如算法叠加层、辅助线）。 */
  skip?: (object: THREE.Object3D) => boolean;
  /** 强制弱化的对象（模式 C 中的非关键设备）。 */
  dim?: (object: THREE.Object3D) => boolean;
  /** 强调的对象（选中设备 / 英雄实验的观察部件）。 */
  emphasis?: (object: THREE.Object3D) => boolean;
  /** 建筑层缩放（透明厂房强度）；不传则用设置推导。 */
  structureScale?: number;
  shellScale?: number;
}

/**
 * 把艺术材质应用到一棵已加载的模型树上。
 *
 * 注意：这里**不会**改变几何、不删除任何 mesh；被隐藏的遮挡物（如屋顶）只是
 * `visible = false`，随时可以在模式 A 或关闭透明厂房时恢复。
 */
export function applyArtMaterials(
  root: THREE.Object3D,
  library: ArtMaterialLibrary,
  mode: ArtModeConfig,
  settings: ArtSettings,
  options: ApplyOptions = {},
): ApplyStats {
  const stats: ApplyStats = { meshes: 0, transparent: 0, hidden: 0, dimmed: 0, roles: {}, unknownRoles: [] };
  const target = options.root ?? root;
  const rootBox = new THREE.Box3().setFromObject(root);
  const structureScale = options.structureScale ?? mode.structureTransparency;
  const shellScale = options.shellScale ?? mode.shellTransparency;

  target.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (options.skip?.(mesh)) return;
    const original = rememberOriginal(mesh);
    stats.meshes += 1;

    const semantics = classifyMesh(mesh, { rootBox });
    stats.roles[semantics.role] = (stats.roles[semantics.role] ?? 0) + 1;
    if (semantics.role === 'unknown' && stats.unknownRoles.length < 8) stats.unknownRoles.push(mesh.name);

    const hit = resolveTransparency(semantics, mode);
    const scaledAlpha = hit
      ? hit.scope === 'structure'
        ? hit.alpha * structureScale
        : hit.alpha * shellScale
      : null;

    let variant: MaterialVariant = 'base';
    if (options.dim?.(mesh) && mode.deEmphasis < 1 && settings.deEmphasize) {
      variant = 'dim';
      stats.dimmed += 1;
    } else if (options.emphasis?.(mesh)) {
      variant = 'emphasis';
    }

    const material = library.materialFor(semantics.role, variant, scaledAlpha);
    mesh.material = material;

    // 透明件：统一排到不透明几何之后再画，并关掉阴影投射，
    // 避免“半透明外壳在地面投出硬阴影”的低质量观感。
    const isTransparent = (material as THREE.MeshStandardMaterial).transparent === true;
    if (isTransparent) {
      mesh.renderOrder = 12;
      mesh.castShadow = false;
    } else {
      mesh.renderOrder = original.renderOrder;
      mesh.castShadow = original.castShadow;
    }

    if (scaledAlpha != null && scaledAlpha <= 0.02) {
      // 完全隐去的遮挡层（屋顶/地面/墙体）：直接隐藏，减少穿透伪影与填充率。
      mesh.visible = false;
      stats.hidden += 1;
    } else {
      mesh.visible = true;
      if (scaledAlpha != null) stats.transparent += 1;
    }
  });

  return stats;
}

/** 还原原始材质与可见性（模式 A / 卸载模型时调用，保证不破坏原始资源）。 */
export function restoreOriginalMaterials(root: THREE.Object3D): number {
  let restored = 0;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const record = originalOf(mesh);
    if (!record) return;
    mesh.material = record.material;
    mesh.visible = record.visible;
    mesh.renderOrder = record.renderOrder;
    mesh.castShadow = record.castShadow;
    mesh.receiveShadow = record.receiveShadow;
    delete mesh.userData[ORIGINAL_KEY];
    restored += 1;
  });
  return restored;
}

/** 释放模型自身的原始材质（仅在卸载 GLB 时使用；材质缓存的释放由库负责）。 */
export function disposeModelResources(root: THREE.Object3D): void {
  const disposed = new Set<THREE.Material>();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const record = originalOf(mesh);
    const materials = record ? (Array.isArray(record.material) ? record.material : [record.material]) : Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material || disposed.has(material)) continue;
      disposed.add(material);
      material.dispose();
    }
    mesh.geometry?.dispose();
  });
}
