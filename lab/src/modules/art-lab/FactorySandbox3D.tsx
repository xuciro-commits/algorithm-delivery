/**
 * 透明厂房产线沙盘（3D）：上传厂房构件 + 上传产线设备 + 真实算法叠加层。
 *
 * 这个组件不做任何算法计算，也不造任何坐标：设备摆位来自 layout.ts（与上传模型真实尺寸一致），
 * 叠加层来自 `ArtOverlayLayer` 消费的引擎解投影（overlay.ts）。
 */

import { ArtOverlayLayer } from '../../art/ArtOverlayLayer';
import { RenderOnChange } from '../../art/RenderOnChange';
import { ArtStage } from '../../art/ArtStage';
import type { EquipmentPartInfo } from '../../art/EquipmentModel';
import type { ArtModelPathKey } from '../../art/modelPaths';
import type { AlgoOverlay } from '../../art/overlayModel';
import { FLOOR_ZONES, HALL, HALL_SIZE, LINE_EQUIPMENT } from './layout';

export type FactoryCameraPreset = 'overview' | 'aisle' | 'line' | 'top' | 'entry';

/** 相机预设按厂房真实尺寸推导（换柱距/跨数不用改代码）。 */
export function factoryCameras(): Record<FactoryCameraPreset, { position: [number, number, number]; target: [number, number, number] }> {
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
  /** 光流相位（= 回放步 × 系数，只随离散步变化）。 */
  flowOffset: number;
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
  onHallParts,
}: FactorySandbox3DProps) {
  const cameras = factoryCameras();
  const camera = cameras[cameraPreset];

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
      equipment={LINE_EQUIPMENT}
      camera={camera}
      cameraPreset={cameraPreset}
      active={active}
      onHallParts={onHallParts}
      overlay={
        <>
          {/* 非回放状态下也必须在叠加层变化后重绘：这里只读真实引擎解，不生成任何装饰数据 */}
          <RenderOnChange
            watch={`${overlay.label}|${overlay.status}|${overlay.routes.length}|${overlay.nodes.length}|${overlay.statuses.length}|${overlay.projections.length}|${overlay.marks.length}|${flowOffset}|${cameraPreset}|${showRoof}|${showWalls}|${showMezzanine}`}
          />
          <ArtOverlayLayer overlay={overlay} flowOffset={flowOffset} />
        </>
      }
    />
  );
}
