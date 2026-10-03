/**
 * 上传工业模型的艺术化实例（阶段一实验与透明厂房的公共原件）。
 *
 * 关键设计：
 *  - **不重制几何**：用 `useGLTF` 载入原模型后克隆一份给本实例，
 *    原始材质与可见性在替换前保存 —— 模式 A 一键还原，绝不破坏原始资源；
 *  - **按语义角色分配材质**（见 roles.ts / materials.ts），而不是整机套一个材质；
 *  - **部件检查**：可隔离“外壳 / 内部机构 / 防护罩 / 传送部件”，配合半透明外壳做
 *    结构与内部机构的对照展示（阶段一要求 3、4）；
 *  - 每个模型都会输出真实部件清单（名称/角色/组/三角形）供面板显示，不硬编码部件名。
 */

import { useGLTF } from '@react-three/drei';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { ART_MODES } from './modes';
import type { ArtModeId } from './tokens';
import { ArtMaterialLibrary, applyArtMaterials, restoreOriginalMaterials, type ApplyStats } from './materials';
import { classifyMesh } from './roles';
import { useArtStore } from './settings';
import type { PartGroup, PartRole } from './types';
import { artAssetUrl } from './manifest';

/** 面板可显示的部件信息（来自真实遍历，不含任何硬编码）。 */
export interface EquipmentPartInfo {
  name: string;
  role: PartRole;
  group: PartGroup;
  /** 该部件是否命中透明策略（外壳 / 玻璃 / 建筑遮挡）。 */
  transparent: boolean;
  triangles: number;
}

export interface EquipmentModelProps {
  /** `public/models/...` 相对路径（见模型清单的 url 字段）。 */
  url: string;
  /** 世界坐标（模型原点在底面中心，可直接落位）。 */
  position?: [number, number, number];
  /** 绕 Y 轴旋转（弧度）。 */
  rotationY?: number;
  /** 统一缩放（厂房柱高等需要微调时使用，默认 1）。 */
  scale?: number;
  /** 隐藏指定的部件组（例如透明厂房模式下的屋顶 / 墙板）。 */
  hiddenGroups?: PartGroup[];
  /** 隐藏名称命中这些子串的部件（忽略大小写）——比"整组隐藏"更精确，例如只隐藏墙板而保留柱子。 */
  hiddenParts?: string[];
  /** 隔离观察：只有这些角色保持正常，其余压暗（内部机构对照用）。 */
  isolateRoles?: PartRole[];
  /**
   * 是否把本实例当作“次要对象”（模式 C 的弱化层）。
   * 由上层按真实语义给出：非关键设备、次要建筑构件传 true，关键工位传 false。
   */
  dimSecondary?: boolean;
  /** 需要强调的部件名（子串匹配，忽略大小写）。 */
  emphasizeParts?: string[];
  /**
   * 强制使用指定模式的外观（英雄实验的“工业科技材质 / 半透明外壳 / 内部机构”视图），
   * 不改变全局模式，也不影响其它场景。
   */
  modeOverride?: ArtModeId;
  /** 强制保留原始 glTF 材质（英雄实验的“原始材质”视图 / 模式 A）。 */
  forceOriginals?: boolean;
  /** 覆盖透明强度（0–1；用于把外壳透明化推满或完全关闭）。 */
  shellScaleOverride?: number;
  structureScaleOverride?: number;
  /** 部件清单回调。 */
  onParts?: (parts: EquipmentPartInfo[]) => void;
  /** 应用统计回调（透明件数量、隐藏件数量、角色分布）。 */
  onStats?: (stats: ApplyStats) => void;
  children?: ReactNode;
}

/**
 * 材质库注册表：按 (模式, 是否高质量玻璃) 复用。
 * 整个实验室 + 三种模式最多 6 个库，保证“统一材质系统”而不是每台设备一套材质。
 */
const libraries = new Map<string, ArtMaterialLibrary>();

export function artLibraryFor(modeId: keyof typeof ART_MODES, physicalGlass: boolean): ArtMaterialLibrary {
  const key = `${modeId}:${physicalGlass ? 1 : 0}`;
  let library = libraries.get(key);
  if (!library) {
    library = new ArtMaterialLibrary(ART_MODES[modeId], {
      ...useArtStore.getState(),
      mode: modeId,
      physicalGlass,
    });
    libraries.set(key, library);
  }
  return library;
}

/** 供测试与调试：列出当前缓存了几个材质库。 */
export function artLibraryCount(): number {
  return libraries.size;
}

export function EquipmentModel({
  url,
  position = [0, 0, 0],
  rotationY = 0,
  scale = 1,
  hiddenGroups,
  hiddenParts,
  isolateRoles,
  dimSecondary = false,
  emphasizeParts,
  modeOverride,
  forceOriginals = false,
  shellScaleOverride,
  structureScaleOverride,
  onParts,
  onStats,
  children,
}: EquipmentModelProps) {
  // 空 URL（清单缺该模型）不应该发起请求：由上层过滤，这里再兜一层。
  const gltf = useGLTF(artAssetUrl(url || 'models/__missing__.glb'));
  /** 克隆一份：绝不修改 useGLTF 的缓存场景（缓存被多个实例共享）。 */
  const model = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  const groupRef = useRef<THREE.Group>(null);

  const settings = useArtStore();
  const activeModeId = modeOverride ?? settings.mode;
  const mode = ART_MODES[activeModeId];
  const enabled = !mode.originalMaterials && !forceOriginals;
  const library = useMemo(() => artLibraryFor(activeModeId, settings.physicalGlass), [activeModeId, settings.physicalGlass]);

  const hiddenKey = (hiddenGroups ?? []).join(',');
  const hiddenPartsKey = (hiddenParts ?? []).join(',');
  const isolateKey = (isolateRoles ?? []).join(',');
  const emphasizeKey = (emphasizeParts ?? []).join(',');

  useEffect(() => {
    const root = groupRef.current;
    if (!root) return;
    if (!enabled) {
      restoreOriginalMaterials(root);
      return;
    }

    const rootBox = new THREE.Box3().setFromObject(root);
    const hidden = new Set(hiddenGroups ?? []);
    const hiddenByName = (hiddenParts ?? []).map((p) => p.toLowerCase());
    const isolate = isolateRoles && isolateRoles.length ? new Set(isolateRoles) : null;
    const emphasize = (emphasizeParts ?? []).map((p) => p.toLowerCase());

    const stats = applyArtMaterials(root, library, mode, settings, {
      structureScale: structureScaleOverride ?? mode.structureTransparency,
      shellScale: shellScaleOverride ?? mode.shellTransparency,
      dim: (object) => {
        const mesh = object as THREE.Mesh;
        const name = mesh.name.toLowerCase();
        if (emphasize.some((p) => name.includes(p))) return false;
        const semantics = classifyMesh(mesh, { rootBox });
        if (hidden.has(semantics.group)) return true;
        if (isolate) return !isolate.has(semantics.role);
        // 模式 C 的弱化：只作用于上层标记为次要的对象，关键工位不受影响。
        return dimSecondary;
      },
      emphasis: (object) => {
        const name = (object as THREE.Mesh).name.toLowerCase();
        return emphasize.some((p) => name.includes(p));
      },
    });

    // 隐藏指定部件：面板上的“隐藏屋顶 / 墙体 / 防护罩”直接作用在这里。
    // 组级隐藏（roof/structure）与名字级隐藏（wall-cladding、fence…）都支持，
    // 后者用于“只隐藏墙板、保留柱子”这类精确控制。
    if (hidden.size || hiddenByName.length) {
      root.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const semantics = classifyMesh(mesh, { rootBox });
        const lower = mesh.name.toLowerCase();
        if (hidden.has(semantics.group) || hiddenByName.some((p) => lower.includes(p))) mesh.visible = false;
      });
    }

    onStats?.(stats);

    if (onParts) {
      const parts: EquipmentPartInfo[] = [];
      root.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const semantics = classifyMesh(mesh, { rootBox });
        const geometry = mesh.geometry;
        const triangles = geometry?.index ? geometry.index.count / 3 : (geometry?.attributes?.position?.count ?? 0) / 3;
        parts.push({
          name: mesh.name,
          role: semantics.role,
          group: semantics.group,
          transparent: Boolean(semantics.transparency),
          triangles: Math.round(triangles),
        });
      });
      onParts(parts.sort((a, b) => b.triangles - a.triangles));
    }
    // 依赖刻意使用序列化后的键：数组身份变化不应触发重算，内容变化才重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, settings, enabled, library, url, hiddenKey, hiddenPartsKey, isolateKey, emphasizeKey, dimSecondary, shellScaleOverride, structureScaleOverride]);

  // 卸载时还原原始材质，保证 useGLTF 缓存与后续实例干净。
  useEffect(() => {
    const root = groupRef.current;
    return () => {
      if (root) restoreOriginalMaterials(root);
    };
  }, []);

  return (
    <group ref={groupRef} position={position} rotation={[0, rotationY, 0]} scale={scale} name={`equipment:${url.split('/').pop()}`}>
      <primitive object={model} />
      {children}
    </group>
  );
}

/** 预加载（鼠标悬停/选中前调用，避免切换英雄设备时出现空白帧）。 */
export function preloadArtModel(url: string): void {
  useGLTF.preload(artAssetUrl(url));
}
