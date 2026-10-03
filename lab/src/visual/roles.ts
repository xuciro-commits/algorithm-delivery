/**
 * 部件角色判定（模型几何 + 材质命名 → 美术角色）。
 *
 * 需求 §二：先审查已有模型的部件划分，判断哪些是外壳 / 支架 / 内部机构 /
 * 传动部件 / 防护罩。本轮**不重新建模**，只对已有网格做语义分组——
 * 分组结果只影响材质与显示策略，不改动原始几何。
 *
 * 判定依据来自 `scripts/inspect-glb.mjs` 对 lab/design/assets 的实测：
 *   - cnc-machining-centre：材质 enamel / cream / charcoal / cast / steel / glass /
 *     blue / red / yellow / rubber，节点组 `cnc-door`（含 glass 子网格）
 *   - engine-lathe：材质 steel / cast / enamel / orange / dark / copper …
 *   - agv-mover：材质 steel / dark / yellow / glow / orange，轮组独立
 * 因此“材质名 + 节点名 + 尺寸 + 透明标记”足以稳定分类，无需人工逐个标注。
 */

import type { Object3D } from 'three';

/** 美术角色：决定用哪套材质预设、是否允许半透明、是否属于“内部机构”。 */
export type PartRole =
  | 'shell' // 设备外壳 / 罩壳：艺术化模式的首选半透明对象
  | 'glass' // 原本就是玻璃/窗口
  | 'structure' // 结构件：立柱、桁架、支架、机架、围栏
  | 'building' // 厂房围护：墙板、屋面、天窗、卷帘门
  | 'metal' // 精加工金属：导轨、主轴、台面、镀铬件
  | 'darkmetal' // 铸铁 / 深色金属：床身、底座、重结构
  | 'mechanism' // 内部机构：可动部件（卡盘、夹爪、刀库、辊道、传动）
  | 'rubber' // 皮带 / 轮胎 / 密封
  | 'accent' // 厂家涂装色（橙/黄/红/蓝）：克制保留
  | 'emissive' // 灯 / 屏幕 / 指示灯（真实状态可驱动）
  | 'floor' // 地面 / 地坪构件
  | 'detail'; // 其余小件

export interface RoleRule {
  role: PartRole;
  /** 材质名匹配（小写子串）。 */
  materials?: string[];
  /** 节点/网格名匹配（小写子串）。 */
  names?: string[];
}

/**
 * 规则表（从上到下，第一个命中生效）。
 *
 * 顺序很重要：先判“显式透明/发光”，再判“建筑构件”，再判“机构”，
 * 最后才是“外壳”。否则一个叫 `machine-shell` 的内部机架会被误判成外壳。
 */
export const ROLE_RULES: RoleRule[] = [
  { role: 'emissive', materials: ['glow', 'light', 'lamp', 'screen', 'display', 'led', 'lens'] },
  { role: 'emissive', names: ['light-fitting', 'skylight', 'signal-tower', 'andon', 'lamp', 'screen'] },
  { role: 'glass', materials: ['glass', 'window', 'acrylic', 'plexi'] },
  { role: 'glass', names: ['glass', 'window', 'glazing'] },
  { role: 'rubber', materials: ['rubber', 'tyre', 'tire', 'belt', 'seal', 'gasket'] },
  { role: 'floor', materials: ['floor', 'concrete', 'asphalt', 'tile'] },
  { role: 'floor', names: ['floor-tile', 'floor-module', 'lane-marking', 'walkway', 'deck-plate'] },
  { role: 'building', names: ['hall-wall', 'hall-roof', 'cladding', 'ridge-skylight', 'roller-door', 'wall-panel', 'ceiling-panel', 'cleanroom-wall'] },
  { role: 'structure', names: ['hall-steel-column', 'steel-hall-column', 'roof-truss', 'mezzanine', 'runway-rail', 'gantry', 'crane', 'scaffold', 'stair', 'handrail'] },
  { role: 'structure', materials: ['fence', 'mesh', 'frame'] },
  { role: 'mechanism', names: ['chuck', 'spindle', 'carriage', 'tool-changer', 'turret', 'jaw', 'clamp', 'conveyor-belt', 'roller', 'wheel', 'arm-main', 'arm-', 'gripper', 'piston'] },
  { role: 'accent', materials: ['orange', 'yellow', 'red', 'safety', 'blue'] },
  { role: 'metal', materials: ['steel', 'chrome', 'metal', 'aluminium', 'aluminum', 'copper', 'brass', 'nickel'] },
  { role: 'darkmetal', materials: ['cast', 'charcoal', 'dark', 'graphite', 'black', 'iron'] },
  { role: 'shell', materials: ['enamel', 'cream', 'white', 'shell', 'panel', 'cover', 'housing', 'casing', 'body'] },
  { role: 'shell', names: ['enclosure', 'guarding', 'guard', 'cover', 'housing', 'casing', 'door', 'cabinet', 'shell'] },
  { role: 'structure', names: ['rack', 'shelf', 'bench', 'table', 'stand', 'cabinet', 'locker', 'trolley', 'cart'] },
  { role: 'darkmetal', names: ['base', 'bed', 'frame', 'skid', 'plinth', 'foundation'] },
];

/** 判断材质/节点名是否命中规则（全部小写匹配）。 */
function matches(rule: RoleRule, materialNames: string[], nodeNames: string[]): boolean {
  if (rule.materials?.some((needle) => materialNames.some((name) => name.includes(needle)))) return true;
  if (rule.names?.some((needle) => nodeNames.some((name) => name.includes(needle)))) return true;
  return false;
}

export function classifyRole(materialNames: string[], nodeNames: string[]): PartRole {
  const materials = materialNames.map((name) => name.toLowerCase());
  const names = nodeNames.map((name) => name.toLowerCase());
  for (const rule of ROLE_RULES) {
    if (matches(rule, materials, names)) return rule.role;
  }
  return 'detail';
}

/** 角色是否属于“内部机构”（半透明外壳下必须保持清晰可辨）。 */
export const MECHANICAL_ROLES: ReadonlySet<PartRole> = new Set<PartRole>([
  'metal',
  'darkmetal',
  'mechanism',
  'rubber',
  'detail',
]);

/** 角色是否允许在艺术化模式下转为半透明外壳。 */
export const SHELLABLE_ROLES: ReadonlySet<PartRole> = new Set<PartRole>([
  'shell',
  'glass',
  'building',
]);

/** 从 Object3D 收集用于角色判定的名字（自身 + 材质 + 祖先名前缀）。 */
export function collectNames(object: Object3D, materialNames: string[]): string[] {
  const out: string[] = [];
  if (object.name) out.push(object.name);
  let parent = object.parent;
  let depth = 0;
  while (parent && depth < 4) {
    if (parent.name) out.push(parent.name);
    parent = parent.parent;
    depth += 1;
  }
  out.push(...materialNames);
  return out;
}
