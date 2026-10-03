/**
 * 透明厂房产线沙盘（3D）：上传厂房构件 + 上传产线设备 + 真实算法叠加层。
 *
 * 这个组件不做任何算法计算，也不造任何坐标：
 *   - 设备摆位来自 `layout.ts`（与上传模型真实尺寸一致）；
 *   - 叠加层来自 `overlay.ts` 对引擎输出的投影；
 *   - 正在被算法使用的设备只做"强调"（提高反射与自发光），不改几何、不隐藏其它设备。
 */

import { useMemo } from 'react';
import { ArtOverlayLayer } from '../../art/ArtOverlayLayer';
import { ArtStage, type ArtEquipmentPlacement } from '../../art/ArtStage';
import { RenderOnChange } from '../../art/RenderOnChange';
import type { EquipmentPartInfo } from '../../art/EquipmentModel';
import type { ArtModelPathKey } from '../../art/modelPaths';
import type { AlgoOverlay } from '../../art/overlayModel';
import { FLOOR_ZONES, HALL, HALL_SIZE, LINE_EQUIPMENT } from './layout';

export type FactoryCameraPreset = 'overview' | 'aisle' | 'line' | 'top' | 'entry' | 'follow';

export const FACTORY_CAMERAS: Array<{ id: FactoryCameraPreset; label: string; hint: string }> = [
  { id: 'overview', label: '全景', hint: '俯视角俯瞰整个厂房与产线布置' },
  { id: 'aisle', label: '通道', hint: '站在 AGV 通道高度观察作业面' },
  { id: 'line', label: '产线', hint: '沿产线方向观察设备序列与输送线' },
  { id: 'top', label: '俯视', hint: '正俯视，用于核对设备与格阵映射关系' },
  { id: 'entry', label: '入口', hint: '从厂房入口进入的第一视角' },
  { id: 'follow', label: '跟随载体', hint: '镜头跟随第一台 AGV/机器人的真实位置（回放时生效）' },
];

/** 相机预设按厂房真实尺寸推导（换柱距/跨数不用改代码）。 */
export function factoryCameras(): Record<Exclude<FactoryCameraPreset, 'follow'>, { position: [number, number, number]; target: [number, number, number] }> {
  const { width, depth } = HALL_SIZE;
  const target: [number, number, number] = [width / 2, HALL.height * 0.28, depth / 2];
  return {
    overview: { position: [width * 0.72, 15.5, depth * 1.62], target },
    aisle: { position: [width * 0.42, 3.6, depth * 1.28], target: [width * 0.45, 0.9, depth * 0.62] },
    line: { position: [width * 0.86, 5.4, depth * 0.92], target: [width * 0.5, 1.2, depth * 0.5] },
    top: { position: [width / 2, 27, depth / 2 + 0.02], target: [width / 2, 0, depth / 2] },
    entry: { position: [-4.5, 6.2, depth * 1.15], target: [width * 0.35, 1.6, depth * 0.45] },
  };
}

export interface FactorySandbox3DProps {
  urls: Partial<Record<ArtModelPathKey, string>>;
  overlay: AlgoOverlay;
  cameraPreset: FactoryCameraPreset;
  active: boolean;
  showRoof: boolean;
  showWalls: boolean;
  showMezzanine: boolean;
  /** 光流相位（= 平滑回放位置 × 系数）。 */
  flowOffset: number;
  /** 算法正在使用的设备（按 equipment key 强调）。 */
  emphasizeKeys?: string[];
  /** 跟踪目标（第一台载体的真实位置）：仅在"跟随"机位 + 回放时提供。 */
  follow?: [number, number, number] | null;
  onHallParts?: (parts: EquipmentPartInfo[]) => void;
}

export function FactorySandbox3D({
  urls,
  overlay,
  cameraPreset,
  active,
  showRoof,
  showWalls,
  showMezzanine,
  flowOffset,
  emphasizeKeys = [],
  follow = null,
  onHallParts,
}: FactorySandbox3DProps) {
  const cameras = factoryCameras();
  const following = cameraPreset === 'follow';
  // 'follow' 机位沿用全景的机位作为基础，再由 follow 参数做跟踪。
  const cameraKey: Exclude<FactoryCameraPreset, 'follow'> = following ? 'overview' : cameraPreset;
  const camera = cameras[cameraKey];

  // 强调只是给同一份布置打标记：几何、位置、数量都不变。
  const equipment: ArtEquipmentPlacement[] = useMemo(() => {
    if (!emphasizeKeys.length) return LINE_EQUIPMENT;
    const active = new Set(emphasizeKeys);
    return LINE_EQUIPMENT.map((item) => (active.has(item.key) ? { ...item, emphasize: true } : item));
  }, [emphasizeKeys]);

  return (
    <ArtStage
      urls={urls}
      baysX={HALL.baysX}
      baysZ={HALL.baysZ}
      bay={HALL.bay}
      height={HALL.height}
      showRoof={showRoof}
      showWalls={showWalls}
      showMezzanine={showMezzanine}
      zones={FLOOR_ZONES}
      equipment={equipment}
      camera={camera}
      cameraPreset={cameraPreset}
      follow={following ? follow : null}
      active={active}
      onHallParts={onHallParts}
      overlay={
        <>
          {/*
            非回放状态下也必须在叠加层变化后重绘：这里只读真实引擎解，不生成任何装饰数据。
            （回放中由 `active` 常驻渲染，这里不会重复排帧。）
          */}
          <RenderOnChange
            watch={`${overlay.label}|${overlay.status}|${overlay.routes.length}|${overlay.nodes.length}|${overlay.statuses.length}|${overlay.projections.length}|${overlay.marks.length}|${flowOffset}|${cameraPreset}|${showRoof}|${showWalls}|${showMezzanine}|${emphasizeKeys.join(',')}`}
          />
          <ArtOverlayLayer overlay={overlay} flowOffset={flowOffset} />
        </>
      }
    />
  );
}
