/**
 * 模型部件审查与角色装配（对应需求 §二）。
 *
 * 把载入的 GLB 遍历成一份**真实部件清单**（路径、三角面数、世界尺寸、材质、
 * 判定角色），供：
 *   - 视觉工作室的“部件审查表”展示（阶段一交付的审查依据）；
 *   - 按角色套用材质预设、决定哪些部件可半透明、哪些必须保持不透明；
 *   - 爆炸视图（沿部件中心外移，展示内部机构）。
 *
 * 全过程只读：原始 GLB 的几何与材质对象不会被修改（构建时拷贝的模型文件亦是
 * 只读使用；运行时只替换网格上挂的材质引用）。所有数字来自真实几何统计。
 */

import { Box3, Vector3, type BufferGeometry, type Material, type Mesh, type Object3D } from 'three';
import { classifyRole, collectNames, type PartRole } from './roles';

export interface PartInfo {
  /** 稳定 id：层级路径（同一模型内唯一）。 */
  id: string;
  name: string;
  /** 祖先层级（用于展示 “cnc-door/glass” 这样的分组）。 */
  parent: string | null;
  role: PartRole;
  /** 该网格的三角面数（真实统计）。 */
  triangles: number;
  /** 世界尺寸（米，已按清单里的真实尺寸归一）。 */
  size: [number, number, number];
  /** 中心点（世界坐标，用于爆炸视图与相机聚焦）。 */
  center: [number, number, number];
  materials: string[];
  /** 是否原本就带透明材质（原始资源里的玻璃/亚克力）。 */
  originalTransparent: boolean;
}

export interface ModelInspection {
  parts: PartInfo[];
  totals: {
    parts: number;
    triangles: number;
    byRole: Record<string, number>;
    materials: string[];
    /** 模型真实尺寸（米），来自资产清单。 */
    size: [number, number, number];
    /** 归一化后场景中的实际尺寸。 */
    fitted: [number, number, number];
  };
}

const MAX_PARTS = 900;

function triangleCount(geometry: BufferGeometry): number {
  if (geometry.index) return Math.round(geometry.index.count / 3);
  const position = geometry.attributes?.position;
  return position?.count ? Math.round(position.count / 3) : 0;
}

function materialNamesOf(material: Material | Material[]): string[] {
  const list = Array.isArray(material) ? material : [material];
  return list.map((entry) => entry?.name ?? 'unnamed');
}

function isTransparent(material: Material | Material[]): boolean {
  const list = Array.isArray(material) ? material : [material];
  return list.some((entry) => {
    if (!entry) return false;
    const transmission = (entry as { transmission?: number }).transmission ?? 0;
    return Boolean(entry.transparent) || transmission > 0;
  });
}

export function partIdOf(object: Object3D): string {
  const names: string[] = [];
  let current: Object3D | null = object;
  while (current && names.length < 6) {
    if (current.name) names.unshift(current.name);
    current = current.parent;
  }
  return names.join('/') || '(unnamed)';
}

/** 遍历模型，生成部件清单（世界包围盒基于当前变换，需在归一化之后调用）。 */
export function inspectModel(root: Object3D, realSize: [number, number, number] | null): ModelInspection {
  const parts: PartInfo[] = [];
  const box = new Box3();
  const materials = new Set<string>();
  let triangles = 0;
  const byRole: Record<string, number> = {};

  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh || parts.length >= MAX_PARTS) return;
    const materialNames = materialNamesOf(mesh.material);
    materialNames.forEach((name) => materials.add(name));
    const geometry = mesh.geometry as BufferGeometry;
    const tris = triangleCount(geometry);
    triangles += tris;
    box.setFromObject(mesh);
    const size = new Vector3();
    const center = new Vector3();
    if (!box.isEmpty()) {
      box.getSize(size);
      box.getCenter(center);
    }
    const role = classifyRole(materialNames, collectNames(mesh, materialNames));
    byRole[role] = (byRole[role] ?? 0) + 1;
    parts.push({
      id: partIdOf(mesh),
      name: mesh.name || '(mesh)',
      parent: mesh.parent && mesh.parent !== root ? partIdOf(mesh.parent) : null,
      role,
      triangles: tris,
      size: [size.x, size.y, size.z],
      center: [center.x, center.y, center.z],
      materials: materialNames,
      originalTransparent: isTransparent(mesh.material),
    });
  });

  const bounds = new Box3().setFromObject(root);
  const fitted = new Vector3();
  if (!bounds.isEmpty()) bounds.getSize(fitted);

  return {
    parts,
    totals: {
      parts: parts.length,
      triangles,
      byRole,
      materials: [...materials].sort(),
      size: realSize ?? [fitted.x, fitted.y, fitted.z],
      fitted: [fitted.x, fitted.y, fitted.z],
    },
  };
}
