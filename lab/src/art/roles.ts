/**
 * 部件语义判定：把上传模型的**材质名 / 节点名**翻译成统一角色与部件组。
 *
 * 规则单一来源：`lab/src/art/part-roles.json`（构建期审计脚本读同一份文件，
 * 保证“离线审查结论”和“运行时材质分配”不会漂移）。
 *
 * 判定顺序：
 *   1. 材质名精确命中 → 2. 材质名子串命中 → 3. 节点名子串命中（材质缺失时）
 *   → 4. 几何启发式（很扁很大且在高处的面 → 屋顶；贴地的面 → 地面）
 *   → 5. 回退到 `unknown`（**不会**被静默当成金属或玻璃）。
 *
 * 为什么要几何启发式：部分整合场景（assembled-scenes）在导出时把子模型按材质
 * 合并，节点名里仍带 `hall-roof-cladding-bay` 之类信息，但材质只剩 `charcoal`。
 * 此时只靠材质名会把屋顶当成“深色金属”而错误地不透明化。
 */

import * as THREE from 'three';
import rulesJson from './part-roles.json';
import type {
  ArtModeConfig,
  PartGroup,
  PartRole,
  PartSemantics,
  RoleRulesFile,
  TransparencyRule,
  TransparencyScope,
} from './types';

export const RULES = rulesJson as unknown as RoleRulesFile;

export const ALL_ROLES: PartRole[] = [
  'shell',
  'frame',
  'graphite',
  'machined',
  'glazing',
  'rubber',
  'hazard',
  'accent',
  'emissive',
  'fluid',
  'polymer',
  'floor',
  'organic',
  'metalWarm',
  'consumable',
  'skin',
  'unknown',
];

/**
 * 规则匹配：末段优先 + 长命中保护。
 *
 * 这些资产的节点名常带 pack 前缀（machine-shop-and-factory-hall-hall-window-bay_0）：
 *   - 按规则表顺序做包含匹配时，开头的 machine 会盖过真正有意义的 window；
 *   - 只按最长命中时，skylight 又会被其中的 light 抢走。
 * 因此：先剔除被更长命中完全包住的候选（light ⊂ skylight），再取最靠后的命中。
 */
function matchRules<T extends { match: string }>(text, list) {
  const lower = String(text ?? '').toLowerCase();
  if (!lower) return null;
  let best = null;
  let bestIdx = -1;
  let bestLen = -1;
  for (const rule of list) {
    if (lower === rule.match) return rule;
    const idx = lower.lastIndexOf(rule.match);
    if (idx < 0) continue;
    const end = idx + rule.match.length;
    let shadowed = false;
    for (const other of list) {
      if (other === rule) continue;
      const oIdx = lower.lastIndexOf(other.match);
      if (oIdx < 0) continue;
      if (other.match.length > rule.match.length && oIdx <= idx && oIdx + other.match.length >= end) {
        shadowed = true;
        break;
      }
    }
    if (shadowed) continue;
    if (idx > bestIdx || (idx === bestIdx && rule.match.length > bestLen)) {
      best = rule;
      bestIdx = idx;
      bestLen = rule.match.length;
    }
  }
  return best;
}

/** 材质名 → 角色（未命中返回 null，由调用方继续用节点名 / 几何判定）。 */
export function roleOfMaterialName(name: string | null | undefined): PartRole | null {
  if (!name) return null;
  return matchRules(String(name), RULES.materialRules)?.role ?? null;
}

/** 节点名 → 部件组（未命中返回 'other'）。 */
export function groupOfPartName(name: string | null | undefined): PartGroup {
  if (!name) return 'other';
  return matchRules(String(name), RULES.partGroupRules)?.group ?? 'other';
}

/**
 * 几何启发式：仅在材质名与节点名都没命中时使用。
 * 判据取自模型自身包围盒，不做任何“贴图假设”。
 */
export function geometryRoleHint(mesh: THREE.Mesh, rootBox: THREE.Box3): PartRole {
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const rootSize = rootBox.getSize(new THREE.Vector3());
  const rootMin = rootBox.min;
  const height = Math.max(1e-4, rootSize.y);
  const relTop = (center.y - rootMin.y) / height;
  const flat = size.y < Math.min(size.x, size.z) * 0.06;
  const huge = size.x * size.z > (rootSize.x * rootSize.z) * 0.45;

  if (flat && huge && relTop > 0.62) return 'floor'; // 大面积高位平面 = 屋顶/顶棚
  if (flat && huge && relTop < 0.12) return 'floor'; // 大面积贴地平面 = 地面
  if (relTop > 0.55 && size.x * size.z > (rootSize.x * rootSize.z) * 0.12) return 'polymer'; // 墙面板
  if (size.y > height * 0.35 && size.x * size.z < (rootSize.x * rootSize.z) * 0.05) return 'frame'; // 细长立柱
  return 'unknown';
}

export interface ClassifyOptions {
  /** 物体整体包围盒（用于几何启发式）。 */
  rootBox: THREE.Box3;
  /** 是否允许几何启发式（导入模型 true；程序化几何 false）。 */
  allowGeometry?: boolean;
}

const cache = new WeakMap<THREE.Object3D, PartSemantics>();

function materialNamesOf(mesh: THREE.Mesh): string[] {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.map((m) => m?.name ?? '').filter(Boolean);
}

/** 判定一个 mesh 的语义角色（带缓存；同一个 mesh 只算一次）。 */
export function classifyMesh(mesh: THREE.Mesh, options: ClassifyOptions): PartSemantics {
  const cached = cache.get(mesh);
  if (cached) return cached;

  let role: PartRole | null = null;
  let roleSource: PartSemantics['roleSource'] = 'material';
  for (const name of materialNamesOf(mesh)) {
    role = roleOfMaterialName(name);
    if (role) break;
  }
  if (!role) {
    const byNode = roleOfMaterialName(mesh.name.replace(/^.*[_/]/, ''));
    if (byNode) {
      role = byNode;
      roleSource = 'material';
    }
  }
  if (!role && options.allowGeometry !== false) {
    const hint = geometryRoleHint(mesh, options.rootBox);
    if (hint !== 'unknown') {
      role = hint;
      roleSource = 'geometry';
    }
  }
  if (!role) {
    role = 'unknown';
    roleSource = 'fallback';
  }

  const group = groupOfPartName(mesh.name);
  const semantics: PartSemantics = {
    role,
    group,
    roleSource,
    transparency: transparencyFor(role, group, 1),
  };
  cache.set(mesh, semantics);
  return semantics;
}

export function clearSemanticsCache(): void {
  // WeakMap 无需手动清理；保留 API 以便调用方表达“重新载入后需重算”的意图。
}

/** 命中透明策略？（alpha 由模式缩放，见 `resolveTransparency`） */
export function transparencyFor(role: PartRole, group: PartGroup, scale: number): PartSemantics['transparency'] {
  const never = new Set(RULES.transparencyPolicy.never);
  if (never.has(role) || never.has(group)) return null;
  for (const rule of RULES.transparencyPolicy.rules as TransparencyRule[]) {
    const hit = rule.kind === 'role' ? rule.match === role : rule.match === group;
    if (!hit) continue;
    const alpha = rule.alpha * Math.max(0, Math.min(1, scale));
    return { scope: rule.scope, alpha };
  }
  return null;
}

/**
 * 模式 + 部件 → 最终透明不透明度。
 * - `mode.structureTransparency` 作用于建筑层（屋顶/墙体/地面）；
 * - `mode.shellTransparency` 作用于设备层（外壳/玻璃）；
 * - 两者为 0（模式 A）时返回 null = 保留原始材质，不做任何半透明处理。
 */
export function resolveTransparency(
  semantics: PartSemantics,
  mode: ArtModeConfig,
): { scope: TransparencyScope; alpha: number } | null {
  const hit = semantics.transparency;
  if (!hit) return null;
  if (mode.originalMaterials && hit.scope === 'equipment') return null;
  const scale = hit.scope === 'structure' ? mode.structureTransparency : mode.shellTransparency;
  if (scale <= 0) return null;
  const alpha = clamp01(hit.alpha * scale);
  // alpha = 0 表示“该层完全隐去”（例如透明厂房模式下的屋顶/地面遮挡物）。
  return { scope: hit.scope, alpha };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** 该角色是否属于“必须保持清晰可辨”的机械结构（透明策略的 never 集合）。 */
export function isProtectedMechanism(semantics: PartSemantics): boolean {
  const never = new Set(RULES.transparencyPolicy.never);
  return never.has(semantics.role) || never.has(semantics.group);
}

/** 统计一棵子树的角色分布（用于资产面板显示与自检）。 */
export function summarizeRoles(root: THREE.Object3D, rootBox: THREE.Box3): Record<PartRole, number> {
  const out = {} as Record<PartRole, number>;
  for (const role of ALL_ROLES) out[role] = 0;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    out[classifyMesh(mesh, { rootBox }).role] += 1;
  });
  return out;
}

/** 统计部件组分布（判断资产是否具备可单独控制的部件）。 */
export function summarizeGroups(root: THREE.Object3D): Record<PartGroup, number> {
  const out = {} as Record<PartGroup, number>;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const group = groupOfPartName(mesh.name);
    out[group] = (out[group] ?? 0) + 1;
  });
  return out;
}
