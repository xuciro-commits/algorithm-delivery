/**
 * 三维实验室沙盘：透明厂房 + 上传设备 + 算法叠加层，跑在一个 Canvas 里。
 *
 * 组合关系（全部来自已有资产与已有引擎输出，不新造几何语义）：
 *   ArtGroundField  —— 科技地坪（细网格 + 分区标识 + 受控反射）
 *   ArtFactoryHall  —— 上传构件按柱距装配的厂房（分层透明 / 可隐藏）
 *   EquipmentModel  —— 上传的产线设备与工位实例
 *   overlay         —— 算法模块从真实解投影出来的路径 / 节点 / 状态光
 *
 * 相机：透视 + SmoothOrbit（预设之间补间飞行 + 可选的跟踪镜头），预设视角由模块传入；
 * 渲染：始终走 SandboxScene，因此继续满足“按需渲染 + active 开关 + 受控泛光”的性能红线。
 */

import { Suspense, useMemo, type ReactNode } from 'react';
import { SandboxScene } from '../components/sandbox/SandboxScene';
import { ART_MODES } from './modes';
import { useArtStore } from './settings';
import { ArtFactoryHall } from './ArtFactoryHall';
import { ArtGroundField, type FloorZone } from './ArtGroundField';
import { EquipmentModel, type EquipmentPartInfo } from './EquipmentModel';
import { RenderOnChange } from './RenderOnChange';
import { SmoothOrbit } from './SmoothOrbit';
import type { ArtModelPathKey } from './modelPaths';

/** 产线设备实例描述：位置由模块根据真实工艺/算法数据给出。 */
export interface ArtEquipmentPlacement {
  key: string;
  model: ArtModelPathKey;
  position: [number, number, number];
  rotationY?: number;
  /** 是否当前被算法/交互强调（模式 C 下保持清晰，其余弱化）。 */
  emphasize?: boolean;
  /** 是否隐藏（例如该工位在本次排程中未被使用）。 */
  hidden?: boolean;
  scale?: number;
  /** 该设备顶部的状态光（由真实状态给出）。 */
  status?: ReactNode;
}

export interface ArtStageProps {
  /** 逻辑键 → 运行时 URL（来自 art-manifest.json）。 */
  urls: Partial<Record<ArtModelPathKey, string>>;
  /** 厂房参数。 */
  baysX?: number;
  baysZ?: number;
  bay?: number;
  height?: number;
  showRoof?: boolean;
  showWalls?: boolean;
  showMezzanine?: boolean;
  /** 地坪分区（语义由模块给出：产线区 / AGV 通道 / 存储区…）。 */
  zones?: FloorZone[];
  /** 产线设备布置。 */
  equipment?: ArtEquipmentPlacement[];
  /** 算法叠加层（路径 / 节点 / 事件）。 */
  overlay?: ReactNode;
  /** 相机预设。 */
  camera: { position: [number, number, number]; target: [number, number, number] };
  /** 跟踪目标（真实 AGV/机器人位置）；提供后镜头跟随。 */
  follow?: [number, number, number] | null;
  /** 相机是否需要随预设变化重新定位（预设 id 变化即复位）。 */
  cameraPreset?: string;
  active: boolean;
  /** 厂房构件部件回调（自检用）。 */
  onHallParts?: (parts: EquipmentPartInfo[]) => void;
}

export function ArtStage({
  urls,
  baysX = 4,
  baysZ = 3,
  bay = 6,
  height = 6,
  showRoof = true,
  showWalls = true,
  showMezzanine = false,
  zones,
  equipment = [],
  overlay,
  camera,
  cameraPreset = 'default',
  follow = null,
  active,
  onHallParts,
}: ArtStageProps) {
  const settings = useArtStore();
  const mode = ART_MODES[settings.mode];
  const width = baysX * bay;
  const depth = baysZ * bay;
  const span = Math.max(width, depth, 10);
  const margin = 3.2;

  const equipmentList = useMemo(() => equipment.filter((item) => !item.hidden && urls[item.model]), [equipment, urls]);

  return (
    <SandboxScene
      width={width + margin * 2}
      height={depth + margin * 2}
      className="sandbox-stage art-stage"
      active={active}
      lighting="art"
      artMode={settings.mode}
      orthographic={false}
      cameraPosition={camera.position}
      fov={mode.id === 'C' ? 34 : 30}
    >
      <SmoothOrbit
        preset={`${cameraPreset}:${camera.position.join(',')}`}
        position={camera.position}
        target={camera.target}
        span={span}
        duration={0.85}
        follow={follow}
      />
      {/* 按需渲染：相机预设 / 模式 / 布置变化后补几帧，避免离散步切换后画面停在上一帧。 */}
      <RenderOnChange
        watch={`${cameraPreset}|${settings.mode}|${settings.transparentFactory}|${settings.physicalGlass}|${settings.structureAlpha}|${settings.shellAlpha}|${settings.deEmphasize}|${settings.showGrid}|${settings.showScaleMarks}|${settings.showOverlays}|${equipmentList.length}`}
      />
      <ArtGroundField width={width + margin * 2} height={depth + margin * 2} zones={zones} showScaleMarks={settings.showScaleMarks} />

      <Suspense fallback={null}>
        <ArtFactoryHall
          baysX={baysX}
          baysZ={baysZ}
          bay={bay}
          height={height}
          showRoof={showRoof}
          showWalls={showWalls}
          showMezzanine={showMezzanine}
          urls={urls}
          dimSecondary={settings.mode === 'C'}
          onHallParts={onHallParts}
        />
        {equipmentList.map((item) => (
          <EquipmentModel
            key={item.key}
            url={urls[item.model] ?? ''}
            position={item.position}
            rotationY={item.rotationY ?? 0}
            scale={item.scale ?? 1}
            emphasized={Boolean(item.emphasize)}
            dimSecondary={settings.mode === 'C' && !item.emphasize}
          >
            {item.status}
          </EquipmentModel>
        ))}
      </Suspense>

      {settings.showOverlays && overlay}
    </SandboxScene>
  );
}
