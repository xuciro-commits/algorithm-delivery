/**
 * 库位优化 3D 沙盘：工业立库尺度（米）× 算法图层。
 *
 * 图层（全部由引擎结果或问题数据驱动，前端不做任何指标计算）：
 *   * 结构层：货架立柱/横梁/层板/货位（按 locationSize 与 levels 的 y_m 真实比例）；
 *   * 热力层：有货库位按 SKU 周转率着色（冷→热），未落货的库位降饱和；
 *   * 方案层：引擎 assignment 里的落位打冷色标记，migrations 画成"搬迁路径"（紫罗兰）；
 *   * 巷道层：巷道负载条（按问题数据聚合的周转量，用于定位热点）+ 站台泊位；
 *   * 高亮层：本次运行的 Top-N 热点库位用脉冲光环标出。
 */

import { Instance, Instances } from '@react-three/drei';
import { useMemo } from 'react';
import { GlowNode, GlowPath, GroundPlate, IsoCamera, SB, SandboxScene } from '../../components/sandbox';
import type { Pt3 } from '../../components/sandbox';
import { heatColor } from '../warehouse-shared/geometry';
import { RackStructure } from '../warehouse-shared/RackStructure';
import type { SlottingScene } from './scene';

/**
 * 热力/簇格子的抬升高度（米）：`RackStructure` 把层板抬了 +0.04 避免共面闪烁，
 * 热力块再抬一点盖住层板；簇层在热力块之上再抬（见 `ClusterLayer`），两层同时打开也不互相遮。
 */
const HEAT_LIFT = 0.1;

export interface Slotting3DLayers {
  rack: boolean;
  heat: boolean;
  /** 关联簇叠加：同簇同色（引擎 `result.clusters`），用于肉眼检查"该靠近的是否真的靠近"。 */
  clusters: boolean;
  plan: boolean;
  migrations: boolean;
  aisles: boolean;
}

export interface Slotting3DProps {
  scene: SlottingScene;
  layers: Slotting3DLayers;
  selected: string | null;
  onSelect?: (locationId: string | null) => void;
  fitNonce: number;
  height?: number;
}

function HeatLayer({
  scene,
  selected,
  onSelect,
}: {
  scene: SlottingScene;
  selected: string | null;
  onSelect?: (locationId: string | null) => void;
}) {
  const cells = scene.heat;
  return (
    <Instances
      limit={Math.max(1, cells.length)}
      onClick={(event) => {
        event.stopPropagation();
        const id = (event.object.userData as { locationId?: string }).locationId ?? null;
        onSelect?.(id === selected ? null : id);
      }}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        roughness={0.45}
        metalness={0.2}
        emissive="#0b1a2c"
        emissiveIntensity={0.35}
        envMapIntensity={0.8}
        transparent
        opacity={0.96}
      />
      {cells.map((cell) => {
        const size = 0.86;
        const isSelected = selected === cell.locationId;
        return (
          <Instance
            key={cell.locationId}
            position={[cell.position[0], cell.position[1] + HEAT_LIFT, cell.position[2]]}
            scale={[size, 0.42, size]}
            color={cell.assigned ? heatColor(cell.ratio) : '#33445f'}
            userData={{ locationId: cell.locationId }}
            visible={!isSelected}
          />
        );
      })}
      {selected &&
        (() => {
          const cell = cells.find((item) => item.locationId === selected);
          if (!cell) return null;
          return (
            <Instance
              position={[cell.position[0], cell.position[1] + HEAT_LIFT + 0.12, cell.position[2]]}
              scale={[1.05, 0.62, 1.05]}
              color={SB.amber}
              userData={{ locationId: cell.locationId }}
            />
          );
        })()}
    </Instances>
  );
}

/**
 * 关联簇图层：把引擎聚类结果落到库位格子上（同簇同色）。
 *
 * 与热力层的区别：热力回答"哪儿的货忙"，这一层回答"算法认为哪些货该待在一起"；
 * 两层同时打开时用不同高度错开（簇层略高、略小），避免互相遮盖。
 */
function ClusterLayer({ scene, selected, onSelect }: {
  scene: SlottingScene;
  selected: string | null;
  onSelect?: (locationId: string | null) => void;
}) {
  const cells = scene.clusterCells;
  // 没有簇信息（导入的问题、或该实例没形成显著关联对）就不画任何东西：
  // 不画占位几何、也不假装"这一层没打开"。
  if (cells.length === 0) return null;
  return (
    <Instances
      limit={Math.max(1, cells.length)}
      onClick={(event) => {
        event.stopPropagation();
        const id = (event.object.userData as { locationId?: string }).locationId ?? null;
        onSelect?.(id === selected ? null : id);
      }}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        roughness={0.35}
        metalness={0.15}
        emissive="#101c33"
        emissiveIntensity={0.5}
        transparent
        opacity={0.9}
      />
      {cells.map((cell) => (
        <Instance
          key={`cluster-${cell.locationId}-${cell.skuId}`}
          position={[cell.position[0], cell.position[1] + HEAT_LIFT + 0.34, cell.position[2]]}
          scale={[0.6, 0.24, 0.6]}
          color={cell.color}
          userData={{ locationId: cell.locationId }}
        />
      ))}
    </Instances>
  );
}

function PlanLayer({ scene }: { scene: SlottingScene }) {
  const assigned = useMemo(() => [...scene.occupant.keys()].slice(0, 240), [scene]);
  const positions = useMemo(() => {
    const map = new Map(scene.heat.map((cell) => [cell.locationId, cell.position]));
    return assigned
      .map((id) => map.get(id))
      .filter((position): position is [number, number, number] => Array.isArray(position));
  }, [assigned, scene]);
  return (
    <group>
      {positions.map((position, index) => (
        <GlowNode
          key={index}
          x={position[0]}
          z={position[2]}
          y={position[1] + 0.34}
          color={SB.cyan}
          radius={0.16}
        />
      ))}
    </group>
  );
}

function MigrationLayer({ scene }: { scene: SlottingScene }) {
  const paths = useMemo(
    () =>
      scene.migrations
        .filter((move) => move.from && move.to)
        .slice(0, 24)
        .map((move) => ({
          points: [move.from as Pt3, [0, 2.2, 0] as Pt3, move.to as Pt3],
          key: `${move.loadUnitId}-${move.to?.[0] ?? 0}-${move.to?.[2] ?? 0}`,
        })),
    [scene],
  );
  return (
    <group>
      {paths.map((path) => (
        <GlowPath key={path.key} points={path.points} color={SB.violet} glow={0.8} />
      ))}
      {scene.migrations
        .filter((move) => move.to)
        .slice(0, 24)
        .map((move, index) => (
          <GlowNode
            key={`node-${index}`}
            x={(move.to as [number, number, number])[0]}
            z={(move.to as [number, number, number])[2]}
            y={(move.to as [number, number, number])[1] + 0.5}
            color={SB.violet}
            radius={0.24}
            pulse
          />
        ))}
    </group>
  );
}

function AisleLayer({ scene }: { scene: SlottingScene }) {
  const maxLoad = Math.max(1, ...scene.aisles.map((aisle) => aisle.load));
  return (
    <group>
      {scene.aisles.map((aisle) => {
        const ratio = aisle.load / maxLoad;
        const height = 0.2 + ratio * 3.2;
        return (
          <group key={aisle.aisleId}>
            <mesh position={[aisle.center[0], height / 2, aisle.center[2]]} castShadow>
              <boxGeometry args={[0.42, height, aisle.length * 0.92]} />
              <meshStandardMaterial
                color={heatColor(ratio)}
                emissive={heatColor(ratio)}
                emissiveIntensity={0.35}
                transparent
                opacity={0.5}
                roughness={0.4}
                metalness={0.1}
              />
            </mesh>
            <mesh position={[aisle.center[0], 0.01, aisle.center[2]]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[1.1, aisle.length]} />
              <meshStandardMaterial color="#16233a" transparent opacity={0.55} roughness={0.9} />
            </mesh>
          </group>
        );
      })}
      {scene.stations.map((station) => (
        <group key={station.id} position={station.position}>
          <mesh position={[0, 0.09, 0]} receiveShadow>
            <boxGeometry args={[2.2, 0.18, 1.6]} />
            <meshStandardMaterial
              color={station.direction === 'inbound' ? '#2d4a6b' : '#4a3a24'}
              roughness={0.65}
              metalness={0.25}
            />
          </mesh>
          <GlowNode
            x={0}
            z={0}
            y={0.3}
            color={station.direction === 'inbound' ? SB.ice : SB.amber}
            radius={0.3}
          />
        </group>
      ))}
    </group>
  );
}

export function Slotting3D({ scene, layers, selected, onSelect, fitNonce, height = 460 }: Slotting3DProps) {
  const span = Math.max(scene.bounds.span, 12);
  return (
    <div className="sandbox-stage" style={{ height }}>
      {/*
        这里是"始终常驻"而不是 `active={playing}`：库位画布没有回放时钟，
        高热库位的脉动高亮（HeatLayer/GlowNode 的 pulse）需要连续帧才动得起来；
        组件只在模块挂载时存在（切走即卸载），不构成后台 GPU 负载。
        `active` 必须显式写出（性能红线审计第 7 条）。
      */}
      <SandboxScene width={span} height={span * 0.72} lighting="art" active>
        <IsoCamera key={fitNonce} span={span} width={span} height={span * 0.72} />
        <GroundPlate width={span * 1.25} height={span} cellSize={2} sectionSize={10} />
        {layers.rack && <RackStructure racks={scene.rackSpecs} />}
        {layers.heat && <HeatLayer scene={scene} selected={selected} onSelect={onSelect} />}
        {layers.clusters && <ClusterLayer scene={scene} selected={selected} onSelect={onSelect} />}
        {layers.plan && <PlanLayer scene={scene} />}
        {layers.migrations && <MigrationLayer scene={scene} />}
        {layers.aisles && <AisleLayer scene={scene} />}
        {layers.rack && (
          <group>
            {scene.hot.slice(0, 12).map((cell) => (
              <GlowNode
                key={cell.locationId}
                x={cell.position[0]}
                z={cell.position[2]}
                y={cell.position[1] + 0.9}
                color={heatColor(cell.ratio)}
                radius={0.22}
                pulse={cell.ratio > 0.75}
              />
            ))}
          </group>
        )}
      </SandboxScene>
    </div>
  );
}
