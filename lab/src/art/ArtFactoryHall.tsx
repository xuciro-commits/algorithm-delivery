/**
 * 透明厂房（需求 §五「特别要求：透明厂房」）。
 *
 * 用**上传的厂房构件原模型**按真实柱距装配，而不是重新建一座厂房：
 *   hall-steel-column · hall-roof-truss-bay-6-m · hall-roof-cladding-bay-6-m ·
 *   hall-ridge-skylight-bay · hall-wall-bay-with-high-windows · hall-wall-cladding-bay-6-m ·
 *   hall-window-band-bay · hall-roller-door-bay · hall-personnel-door-bay ·
 *   high-bay-light-fitting · gantry-crane-runway-rail-6-m · mezzanine-floor-bay-with-handrail-6-m
 *
 * 分层的透明化控制（不是整场刷透明）：
 *   - 屋面（roof）：透明厂房模式下最先隐去，避免俯视遮挡产线；
 *   - 墙板 / 窗带：磨砂半透明，保留空间边界感；
 *   - 柱子 / 桁架（structure）：保持清晰，构成空间骨架；
 *   - 天窗与门窗：保持玻璃质感，作为视觉焦点。
 *
 * 每个构件都是独立实例（克隆的 geometry 共享，材质由统一材质库提供），
 * 因此可以在不重建几何的前提下逐层开关与半透明化。
 */

import { Suspense, useMemo } from 'react';
import { EquipmentModel, type EquipmentPartInfo } from './EquipmentModel';
import type { ArtModelPathKey } from './modelPaths';
import { useArtStore } from './settings';
import type { PartGroup, PartRole } from './types';

export interface ArtFactoryHallProps {
  /** 柱距（米）。上传构件是 6 m 体系，其它值会等比缩放。 */
  bay?: number;
  baysX?: number;
  baysZ?: number;
  /** 屋架下弦高度（米）。构件按此高度等比缩放。 */
  height?: number;
  /** 屋面层：false = 隐去屋面板与天窗（透明厂房的主要手段）。 */
  showRoof?: boolean;
  /** 墙板层：false = 隐去墙板（保留柱/桁架骨架）。 */
  showWalls?: boolean;
  /** 半透明外壳（防护罩 / 观察窗）隔离观察时传入的角色。 */
  isolateRoles?: PartRole[];
  /** 模式 C 的弱化层：次要建筑构件（屋面 / 墙板 / 夹层）。 */ 
  dimSecondary?: boolean;
  /** 高棚灯实例密度：每个柱距一盏（默认）或隔跨一盏。 */
  lightEvery?: 1 | 2;
  /** 夹层平台（次要结构，可关）。 */
  showMezzanine?: boolean;
  /** 构件统计回调（真实部件数量，用于面板自检）。 */
  onHallParts?: (parts: EquipmentPartInfo[]) => void;
  /** 逻辑键 → 运行时 URL（由 ArtStage 从 art-manifest.json 解析后传入）。 */
  urls: Partial<Record<ArtModelPathKey, string>>;
}

/** 单个厂房构件的放置描述（全部由柱距体系推导，不用魔法数字）。 */
interface Placement {
  key: string;
  model: ArtModelPathKey;
  position: [number, number, number];
  rotationY?: number;
  scale?: number;
  group: PartGroup;
}

const HALF = 0.5;

export function ArtFactoryHall({
  bay = 6,
  baysX = 4,
  baysZ = 3,
  height = 6,
  showRoof = true,
  showWalls = true,
  isolateRoles,
  dimSecondary = false,
  lightEvery = 1,
  showMezzanine = false,
  onHallParts,
  urls,
}: ArtFactoryHallProps) {
  const settings = useArtStore();
  const width = baysX * bay;
  const depth = baysZ * bay;
  const bayScale = bay / 6;
  /** 上传的钢柱高 8 m，按目标高度等比缩放（保证构件比例正确，不重制几何）。 */
  const columnScale = (height / 8) * bayScale;
  const roofY = height + 0.62 * bayScale;

  const placements = useMemo<Placement[]>(() => {
    const out: Placement[] = [];

    // —— 柱：每个柱网交点一根 ——
    for (let i = 0; i <= baysX; i += 1) {
      for (let j = 0; j <= baysZ; j += 1) {
        out.push({
          key: `col-${i}-${j}`,
          model: 'hallSteelColumn',
          position: [i * bay, 0, j * bay],
          scale: columnScale,
          group: 'structure',
        });
      }
    }

    // —— 屋架：沿柱网线，每跨一榀（跨度方向 X）——
    for (let j = 0; j <= baysZ; j += 1) {
      for (let i = 0; i < baysX; i += 1) {
        out.push({
          key: `truss-${i}-${j}`,
          model: 'hallRoofTruss',
          position: [i * bay + bay * HALF, height, j * bay],
          scale: bayScale,
          group: 'structure',
        });
      }
    }

    // —— 屋面板：每跨一块；天窗沿屋脊 ——
    for (let i = 0; i < baysX; i += 1) {
      for (let j = 0; j < baysZ; j += 1) {
        out.push({
          key: `roof-${i}-${j}`,
          model: 'hallRoofCladding',
          position: [i * bay + bay * HALF, roofY, j * bay + bay * HALF],
          scale: bayScale,
          group: 'roof',
        });
      }
    }
    const ridge = depth * HALF;
    for (let i = 0; i < baysX; i += 1) {
      out.push({
        key: `skylight-${i}`,
        model: 'hallRidgeSkylight',
        position: [i * bay + bay * HALF, roofY + 0.42 * bayScale, ridge],
        scale: bayScale,
        group: 'roof',
      });
    }

    // —— 墙体：南北主立面用带高窗墙板；东西山墙用墙板；开两个门洞 ——
    for (let i = 0; i < baysX; i += 1) {
      const isDoorBay = i === baysX - 2;
      for (const [k, z] of [[0, 0], [1, depth]] as Array<[number, number]>) {
        out.push({
          key: `wall-${k}-${i}`,
          model: isDoorBay && k === 1 ? 'hallRollerDoor' : 'hallWallHighWindows',
          position: [i * bay + bay * HALF, 0, z],
          rotationY: k === 0 ? 0 : Math.PI,
          scale: bayScale,
          group: 'structure',
        });
      }
    }
    for (let j = 0; j < baysZ; j += 1) {
      const isDoorBay = j === 1;
      out.push({
        key: `gable-0-${j}`,
        model: isDoorBay ? 'hallPersonnelDoor' : 'hallWallCladding',
        position: [0, 0, j * bay + bay * HALF],
        rotationY: Math.PI * HALF,
        scale: bayScale,
        group: 'structure',
      });
      out.push({
        key: `gable-1-${j}`,
        model: j === baysZ - 1 ? 'hallWindowBand' : 'hallWallCladding',
        position: [width, 0, j * bay + bay * HALF],
        rotationY: -Math.PI * HALF,
        scale: bayScale,
        group: 'structure',
      });
    }

    // —— 高棚灯：吊挂在屋架下（工业局部光源的实体依据）——
    for (let i = 0; i < baysX; i += lightEvery) {
      for (let j = 0; j < baysZ; j += lightEvery) {
        out.push({
          key: `light-${i}-${j}`,
          model: 'highBayLight',
          position: [i * bay + bay * HALF, height - 1.15, j * bay + bay * HALF],
          scale: 1,
          group: 'lighting',
        });
      }
    }

    // —— 天车轨道：沿两侧柱列（真实构件，强化厂房的机械层次）——
    for (let j = 0; j < baysZ; j += 1) {
      out.push({
        key: `rail-0-${j}`,
        model: 'gantryRail',
        position: [0.55, height * 0.74, j * bay + bay * HALF],
        rotationY: Math.PI * HALF,
        scale: bayScale,
        group: 'structure',
      });
      out.push({
        key: `rail-1-${j}`,
        model: 'gantryRail',
        position: [width - 0.55, height * 0.74, j * bay + bay * HALF],
        rotationY: Math.PI * HALF,
        scale: bayScale,
        group: 'structure',
      });
    }

    if (showMezzanine) {
      out.push({
        key: 'mezzanine-0',
        model: 'mezzanineBay',
        position: [width - bay, 0, depth - bay],
        scale: bayScale,
        group: 'structure',
      });
    }

    return out;
  }, [bay, baysX, baysZ, height, bayScale, columnScale, roofY, lightEvery, showMezzanine, width, depth]);

  // —— 分层透明 / 隐藏：屋面最先隐去，其次墙板，柱子与桁架始终清晰 ——
  const hiddenParts = useMemo(() => {
    const list: string[] = [];
    if (!showRoof) list.push('roof-cladding', 'skylight', 'roof_cladding');
    if (!showWalls) list.push('wall-cladding', 'wall-bay', 'window-band', 'roller-door', 'personnel-door');
    return list;
  }, [showRoof, showWalls]);

  // 清单里缺失的构件直接跳过（不画占位几何），由面板如实提示缺哪些模型。
  const visible = placements.filter((p) => {
    if (p.group === 'roof' && !showRoof) return false;
    return Boolean(urls[p.model]);
  });

  return (
    <group name="art-factory-hall">
      <Suspense fallback={null}>
        {visible.map((p) => (
          <EquipmentModel
            key={p.key}
            url={urls[p.model] ?? ''}
            position={p.position}
            rotationY={p.rotationY ?? 0}
            scale={p.scale ?? 1}
            hiddenParts={hiddenParts}
            isolateRoles={isolateRoles}
            // 模式 C：屋面 / 墙板 / 夹层这类次要建筑层弱化，柱与屋架（structure）保持清晰，
            // 才能“弱化次要建筑、保住空间关系”。
            dimSecondary={dimSecondary && p.group !== 'structure'}
            onParts={p.key === 'col-0-0' ? onHallParts : undefined}
          />
        ))}
      </Suspense>
    </group>
  );
}

/** 厂房外轮廓（用于相机取景与地面尺寸推导）。 */
export function hallFootprint(baysX: number, baysZ: number, bay: number): { width: number; depth: number } {
  return { width: baysX * bay, depth: baysZ * bay };
}
