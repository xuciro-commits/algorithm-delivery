/**
 * 真实工业模型的艺术化装配（需求 §二、§三、§七）。
 *
 * 职责：
 *   1. 载入 `public/models/` 下的**原样复制**资产（源文件在 lab/design/assets 且从未被改写）；
 *   2. 依资产清单里的真实米制尺寸把模型归一到米制（保证多台设备互相同尺度）；
 *   3. 逐部件判定美术角色 → 套用统一材质预设（不是每台设备一份手写材质）；
 *   4. 支持：半透明外壳强度、外壳隐藏、爆炸视图、部件高亮、模式 C 的非关键件弱化；
 *   5. 产出**真实部件清单**（几何统计），供视觉工作室审查与验收引用。
 *
 * 全程不修改几何：只替换网格上挂的材质引用与位置偏移，原始材质对象保留在
 * `mesh.userData.vpOriginalMaterials`，切回模式 A 时原样恢复。
 */

import { useGLTF } from '@react-three/drei';
import { useEffect, useMemo, type ReactNode } from 'react';
import { Box3, Color, Vector3, type Material, type Mesh, type Object3D } from 'three';
import { classifyRole, collectNames } from './roles';
import { dimmedMaterial, emphasizedMaterial, roleMaterial, type MaterialContext } from './materials';
import { inspectModel, partIdOf, type ModelInspection, type PartInfo } from './inspect';
import { useVisualStore } from './store';
import { resolveMode, resolveQuality } from './modes';

export interface ModelAssetRef {
  key: string;
  file: string;
  title: string;
  sizeMeters: number[] | null;
}

export interface ModelStageProps {
  asset: ModelAssetRef;
  /** 资源目录前缀（Pages 子路径安全）。 */
  baseUrl: string;
  position?: [number, number, number];
  rotationY?: number;
  /** 该模型是否属于关键设备（模式 C 不弱化）。 */
  keyMachine?: boolean;
  onInspect?: (inspection: ModelInspection) => void;
  onPartClick?: (part: PartInfo | null) => void;
  /** 关闭指针交互（大场景里由外层统一处理拾取时使用）。 */
  interactive?: boolean;
}

export function useModelClone(asset: ModelAssetRef, baseUrl: string) {
  const url = `${baseUrl}models/${asset.file}`;
  const gltf = useGLTF(url);
  const clone = useMemo(() => {
    const root = gltf.scene.clone(true) as Object3D;
    // —— 归一到米制（用清单里的真实尺寸的最大边做统一比例）——
    root.updateMatrixWorld(true);
    const box = new Box3().setFromObject(root);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const realMax = asset.sizeMeters ? Math.max(...asset.sizeMeters) : 0;
    const rawMax = Math.max(size.x, size.y, size.z) || 1;
    const ratio = realMax > 0 ? realMax / rawMax : 1 / 1000;
    root.scale.setScalar(ratio);
    root.position.set(-center.x * ratio, -box.min.y * ratio, -center.z * ratio);
    root.updateMatrixWorld(true);
    // 记录原始材质与基准位置：模式 A 与爆炸视图依赖这两份“原状”数据
    root.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.userData.vpOriginalMaterials) mesh.userData.vpOriginalMaterials = mesh.material;
      if (!mesh.userData.vpBasePosition) mesh.userData.vpBasePosition = mesh.position.clone();
    });
    return root;
  }, [gltf, asset.file, asset.sizeMeters]);
  return { clone, url };
}

export function ModelStage({
  asset,
  baseUrl,
  position = [0, 0, 0],
  rotationY = 0,
  keyMachine = false,
  onInspect,
  onPartClick,
  interactive = true,
}: ModelStageProps) {
  const { clone } = useModelClone(asset, baseUrl);
  const modeId = useVisualStore((state) => state.mode);
  const qualityId = useVisualStore((state) => state.quality);
  const shellScale = useVisualStore((state) => state.shellScale);
  const explode = useVisualStore((state) => state.explode);
  const showShells = useVisualStore((state) => state.showShells);
  const highlight = useVisualStore((state) => state.highlight);
  const setHighlight = useVisualStore((state) => state.setHighlight);

  const mode = resolveMode(modeId);
  const quality = resolveQuality(qualityId);

  /** 真实部件清单（几何统计，非人工编造）。 */
  const inspection = useMemo(() => inspectModel(clone, [0, 0, 0]), [clone]);
  useEffect(() => {
    onInspect?.(inspection);
  }, [inspection, onInspect]);

  const modelCenter = useMemo(() => {
    const box = new Box3().setFromObject(clone);
    return box.isEmpty() ? new Vector3() : box.getCenter(new Vector3());
  }, [clone]);

  const modelRadius = useMemo(() => {
    const box = new Box3().setFromObject(clone);
    if (box.isEmpty()) return 1;
    const size = box.getSize(new Vector3());
    return Math.max(size.x, size.y, size.z) * 0.5;
  }, [clone]);

  /** 材质 / 可见性 / 高亮 / 爆炸 —— 全部按当前视觉模式生效。 */
  useEffect(() => {
    const context: MaterialContext = { mode, quality, shellScale };
    const shellHidden = !showShells;
    const offset = new Vector3();
    const direction = new Vector3();

    clone.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      const original = (mesh.userData.vpOriginalMaterials ?? mesh.material) as Material | Material[];
      const source = Array.isArray(original) ? original[0] : original;
      const names = Array.isArray(original)
        ? original.map((entry) => entry?.name ?? 'unnamed')
        : [original?.name ?? 'unnamed'];
      const role = classifyRole(names, collectNames(mesh, names));
      mesh.userData.vpRole = role;

      // —— 材质 ——
      if (!mode.artisticMaterials) {
        mesh.material = original;
      } else {
        const sourceColor = (source as unknown as { color?: Color }).color;
        const hint = sourceColor ? sourceColor.clone() : null;
        let material = roleMaterial(role, hint, source?.name ?? 'unnamed', context);
        // 模式 C：非关键设备/建筑弱化，但保留空间关系（不隐藏、不透明化）
        if (mode.dim < 0.999 && (!keyMachine || role === 'building' || role === 'structure' || role === 'floor')) {
          material = dimmedMaterial(material, mode.dim);
        }
        mesh.material = material;
      }

      // —— 选中高亮：局部强调，不画整个线框 ——
      const id = partIdOf(mesh);
      const isHighlighted = highlight !== null && id === highlight;
      if (isHighlighted && mode.artisticMaterials) {
        mesh.material = emphasizedMaterial(Array.isArray(mesh.material) ? mesh.material[0] : mesh.material, mode.shell.rimTint);
      }

      // —— 外壳显示开关：透明厂房/设备维护视图需要“隐藏外壳、直看机构” ——
      mesh.visible = !(shellHidden && role === 'shell');

      // —— 爆炸视图：沿“部件中心 → 模型中心”的反方向平移（展示内部机构）——
      const base = mesh.userData.vpBasePosition as Vector3 | undefined;
      if (base) {
        if (explode > 0.001) {
          offset.copy(mesh.position).sub(modelCenter);
          if (offset.lengthSq() < 1e-6) offset.set(0, 1, 0);
          direction.copy(offset).normalize();
          mesh.position.copy(base).addScaledVector(direction, explode * modelRadius * 0.55);
        } else {
          mesh.position.copy(base);
        }
      }
    });
  }, [clone, mode, quality, shellScale, showShells, explode, highlight, keyMachine, modelCenter, modelRadius]);

  // 阴影：只在渲染质量允许时投射，避免轻量档掉帧
  useEffect(() => {
    const cast = quality.shadowMapSize >= 1024;
    clone.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
    });
  }, [clone, quality.shadowMapSize]);

  const handleClick = (event: { stopPropagation: () => void; object: Object3D }) => {
    if (!interactive) return;
    event.stopPropagation();
    const id = partIdOf(event.object);
    setHighlight(highlight === id ? null : id);
    const part = inspection.parts.find((entry) => entry.id === id) ?? null;
    onPartClick?.(part);
  };

  return (
    <group position={position} rotation={[0, rotationY, 0]} onClick={handleClick}>
      <primitive object={clone} />
    </group>
  );
}

/** 场景尺度辅助：给舞台外壳用的内容包围盒。 */
export function inspectionBounds(inspection: ModelInspection | null, fallback = 3) {
  const size = inspection?.totals.fitted ?? [fallback * 2, fallback, fallback * 2];
  const radius = Math.max(size[0], size[2]) * 0.5;
  return {
    radius,
    center: [0, size[1] * 0.4, 0] as [number, number, number],
    height: size[1],
  };
}

export function StageChildren({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
