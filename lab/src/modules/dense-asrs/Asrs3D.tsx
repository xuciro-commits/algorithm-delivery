/**
 * 密集立库 3D 沙盘：自动化立库尺度（米）+ 调度算法图层。
 *
 * 图层：
 *   * 结构层：货架（列×层×深，真实尺寸）/ 巷道地面 / 设备基座；
 *   * 巷道层：每巷负载条 + 封闭巷道警示（来自问题的 `aisle-closure` 事件）；
 *   * 站台层：站台泊位 + 缓冲占用脉冲（占用来自时间线 `bufferStates`，是引擎数据）；
 *   * 设备层：按时间线插值出的当前姿态（穿梭车按层高、提升机按井道），
 *             选中设备时画出它本次运行的完整轨迹（引擎步骤的 from→to 直线，红线：不做曲线美化）；
 *   * 任务层：任务目标点的状态光环（done/unserved/blocked 用同一套状态语义着色）；
 *   * 倒垛层：深位让位事件（被让出格 / 落位格 + 一次搬运的连线），来自时间线 `locationStates`。
 */

import { useMemo } from 'react';
import { GlowNode, GlowPath, GroundPlate, IsoCamera, SB, SandboxScene } from '../../components/sandbox';
import type { Pt3 } from '../../components/sandbox';
import { poseAt } from '../warehouse-shared/geometry';
import { RackStructure } from '../warehouse-shared/RackStructure';
import { deviceKindLabel, taskStatusColor, type AsrsScene } from './scene';

export interface Asrs3DLayers {
  rack: boolean;
  lanes: boolean;
  stations: boolean;
  devices: boolean;
  tasks: boolean;
  paths: boolean;
  /** 深位让位/倒垛：密集库的核心代价，来自时间线 `locationStates`。 */
  relocations: boolean;
}

export interface Asrs3DProps {
  scene: AsrsScene;
  layers: Asrs3DLayers;
  t: number;
  selectedDevice: string | null;
  onSelectDevice?: (deviceId: string | null) => void;
  fitNonce: number;
  /**
   * 是否连续渲染：只在回放中为真（暂停 / 拖动时间轴时按需渲染）。
   * 与其他模块（MAPF / AGV / APS 传 `active={playing}`）同一约定：
   * 不播放就不常驻 GPU（性能红线审计第 7 条）。
   */
  active: boolean;
  height?: number;
}

const AISLE_COLORS = ['#7fd7ff', '#3fe0d4', '#4fe3a7', '#a78bfa', '#ffb454'];

function LaneLayer({ scene }: { scene: AsrsScene }) {
  const maxTasks = Math.max(1, ...scene.aisles.map((aisle) => aisle.taskCount));
  return (
    <group>
      {scene.aisles.map((aisle, index) => {
        const ratio = aisle.taskCount / maxTasks;
        const closed = scene.closedAisles.includes(aisle.aisleId);
        const height = 0.16 + ratio * 2.6;
        const color = closed ? '#ff6f6f' : AISLE_COLORS[index % AISLE_COLORS.length];
        return (
          <group key={aisle.aisleId}>
            <mesh position={[aisle.center[0], 0.015, aisle.center[2]]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
              <planeGeometry args={[2.4, aisle.length]} />
              <meshStandardMaterial color="#141f33" roughness={0.85} metalness={0.12} />
            </mesh>
            <mesh position={[aisle.center[0], height / 2, aisle.center[2]]}>
              <boxGeometry args={[0.36, height, aisle.length * 0.94]} />
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={closed ? 0.85 : 0.3}
                transparent
                opacity={closed ? 0.62 : 0.42}
                roughness={0.35}
                metalness={0.2}
              />
            </mesh>
            {closed && (
              <>
                <GlowNode x={aisle.center[0]} z={aisle.center[2] - aisle.length * 0.42} y={0.5} color={SB.coral} radius={0.34} pulse />
                <GlowNode x={aisle.center[0]} z={aisle.center[2] + aisle.length * 0.42} y={0.5} color={SB.coral} radius={0.34} pulse />
              </>
            )}
          </group>
        );
      })}
    </group>
  );
}

function StationLayer({ scene }: { scene: AsrsScene }) {
  return (
    <group>
      {scene.stations.map((station) => {
        const occupancy = station.peakOccupancy;
        const pressure = station.bufferCapacity > 0 ? Math.min(1, occupancy / station.bufferCapacity) : 0;
        const color = station.direction === 'inbound' ? SB.ice : SB.amber;
        return (
          <group key={station.stationId} position={station.position}>
            <mesh position={[0, 0.08, 0]} receiveShadow castShadow>
              <boxGeometry args={[2.6, 0.16, 1.8]} />
              <meshStandardMaterial color={station.direction === 'inbound' ? '#2d4a6b' : '#4a3a24'} roughness={0.62} metalness={0.3} />
            </mesh>
            <mesh position={[0, 0.34, 0]}>
              <boxGeometry args={[2.2, 0.36, 1.4]} />
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={0.2 + pressure * 0.6}
                transparent
                opacity={0.35 + pressure * 0.4}
                roughness={0.4}
              />
            </mesh>
            {occupancy > 0 && (
              <GlowNode
                x={0}
                z={0}
                y={0.62 + pressure * 0.5}
                color={color}
                radius={0.26 + pressure * 0.22}
                pulse={pressure > 0.6}
              />
            )}
            <GlowNode x={0} z={0} y={0.05} color={color} radius={0.28} />
            {/* 停靠环：有缓冲占用时点亮（占用来自引擎时间线的 bufferStates） */}
            <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.9, 1.05, 24]} />
              <meshBasicMaterial color={color} transparent opacity={occupancy > 0 ? 0.55 : 0.16} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

function DeviceLayer({
  scene,
  t,
  selectedDevice,
  onSelectDevice,
  showPaths,
}: {
  scene: AsrsScene;
  t: number;
  selectedDevice: string | null;
  onSelectDevice?: (deviceId: string | null) => void;
  showPaths: boolean;
}) {
  const markers = useMemo(() => {
    const list: Array<{
      deviceId: string;
      kind: string;
      color: string;
      position: [number, number, number];
      active: boolean;
      phase: string;
    }> = [];
    for (const device of scene.devices) {
      if (!device.track) {
        // 没有排到任何步骤的设备：停在拓扑给出的 home 节点（如果有）
        const spec = (scene.topology.devices ?? []).find((item) => item.id === device.deviceId);
        const node = (scene.topology.nodes ?? []).find((item) => item.id === spec?.homeNodeId);
        list.push({
          deviceId: device.deviceId,
          kind: device.kind,
          color: device.color,
          position: (node?.position ?? [0, 0, 0]) as [number, number, number],
          active: false,
          phase: 'idle',
        });
        continue;
      }
      const pose = poseAt(device.track, t);
      if (!pose) continue;
      list.push({
        deviceId: device.deviceId,
        kind: device.kind,
        color: device.color,
        position: [pose.x, pose.y, pose.z],
        active: t >= device.track.firstStart && t <= device.track.lastEnd,
        phase: pose.phase,
      });
    }
    return list;
  }, [scene, t]);

  return (
    <group>
      {showPaths &&
        selectedDevice &&
        (scene.stepPaths.get(selectedDevice) ?? []).map((segment, index) => (
          <GlowPath key={index} points={segment.points as unknown as Pt3[]} color="#7fd7ff" glow={0.75} />
        ))}
      {markers.map((marker) => (
        <group
          key={marker.deviceId}
          position={marker.position}
          onClick={(event) => {
            event.stopPropagation();
            onSelectDevice?.(marker.deviceId === selectedDevice ? null : marker.deviceId);
          }}
        >
          <mesh position={[0, 0.18, 0]} castShadow>
            <boxGeometry args={[marker.kind === 'shuttle' ? 0.7 : 0.95, 0.36, marker.kind === 'shuttle' ? 0.9 : 1.3]} />
            <meshStandardMaterial
              color={marker.color}
              emissive={marker.color}
              emissiveIntensity={marker.deviceId === selectedDevice ? 0.7 : marker.active ? 0.28 : 0.08}
              roughness={0.35}
              metalness={0.4}
              transparent
              opacity={marker.active ? 1 : 0.55}
            />
          </mesh>
          <mesh position={[0, 0.42, 0]}>
            <boxGeometry args={[marker.kind === 'shuttle' ? 0.5 : 0.7, 0.16, marker.kind === 'shuttle' ? 0.6 : 0.8]} />
            <meshStandardMaterial color="#0d1728" emissive={marker.color} emissiveIntensity={0.5} />
          </mesh>
          {marker.deviceId === selectedDevice && <GlowNode x={0} z={0} y={0.02} color={marker.color} radius={0.9} pulse />}
        </group>
      ))}
    </group>
  );
}

function TaskLayer({ scene, t }: { scene: AsrsScene; t: number }) {
  const visible = useMemo(() => scene.tasks.filter((task) => task.release_s <= t + 1e-6).slice(-260), [scene, t]);
  return (
    <group>
      {visible.map((task) => {
        const color = taskStatusColor(task.status);
        return (
          <group key={task.taskId}>
            {task.from && <GlowNode x={task.from[0]} z={task.from[2]} y={task.from[1] + 0.4} color={color} radius={0.2} />}
            {task.to && (
              <GlowNode
                x={task.to[0]}
                z={task.to[2]}
                y={task.to[1] + 0.4}
                color={color}
                radius={task.status === 'unserved' ? 0.34 : 0.22}
                pulse={task.status === 'unserved' || task.status === 'blocked'}
              />
            )}
          </group>
        );
      })}
    </group>
  );
}

/**
 * 深位让位/倒垛图层：每个倒垛事件画「被让出的深位（琥珀）」与「落位格（紫）」两个标记，
 * 并在两格之间拉一条细线表示这一趟搬运的起讫。时间轴上按 `at_s` 累积出现，
 * 因此拖动播放条就能看到"哪一次任务的深位被挡、为了让位搬了几趟"。
 */
function RelocationLayer({ scene, t }: { scene: AsrsScene; t: number }) {
  const visible = useMemo(
    () => scene.relocations.filter((move) => move.at_s <= t + 1e-6),
    [scene, t],
  );
  return (
    <group>
      {visible.map((move, index_) => (
        <group key={`reloc-${move.vacatedLocationId}-${move.at_s}-${index_}`}>
          {move.vacatedPosition && (
            <GlowNode
              x={move.vacatedPosition[0]}
              z={move.vacatedPosition[2]}
              y={move.vacatedPosition[1] + 0.42}
              color="#ffb454"
              radius={0.3}
            />
          )}
          {move.placedPosition && (
            <GlowNode
              x={move.placedPosition[0]}
              z={move.placedPosition[2]}
              y={move.placedPosition[1] + 0.42}
              color="#a78bfa"
              radius={0.24}
            />
          )}
          {move.vacatedPosition && move.placedPosition && (
            <GlowPath
              points={[
                [move.vacatedPosition[0], move.vacatedPosition[1] + 0.2, move.vacatedPosition[2]],
                [move.placedPosition[0], move.placedPosition[1] + 0.2, move.placedPosition[2]],
              ]}
              color="#ffb454"
              glow={0.7}
            />
          )}
        </group>
      ))}
    </group>
  );
}

export function Asrs3D({ scene, layers, t, selectedDevice, onSelectDevice, fitNonce, active, height }: Asrs3DProps) {
  const { centerX, centerZ, span, minX, maxX, minZ, maxZ } = scene.bounds;
  const plateWidth = Math.max(maxX - minX + 8, span * 1.15, 16);
  const plateHeight = Math.max(maxZ - minZ + 8, span * 0.85, 12);
  const maxSpan = Math.max(span, 12);
  const sceneCenter = useMemo(() => [centerX, centerZ] as [number, number], [centerX, centerZ]);
  const cameraCenter = useMemo(() => [centerX, 0, centerZ] as [number, number, number], [centerX, centerZ]);
  const selected = selectedDevice ? scene.devices.find((device) => device.deviceId === selectedDevice) ?? null : null;
  return (
    <div className="sandbox-stage" style={height ? { height } : undefined}>
      <SandboxScene width={plateWidth} height={plateHeight} center={sceneCenter} lighting="art" active={active}>
        <IsoCamera key={fitNonce} span={maxSpan} width={plateWidth} height={plateHeight} center={cameraCenter} />
        <GroundPlate width={plateWidth} height={plateHeight} centerX={centerX} centerZ={centerZ} cellSize={2} sectionSize={10} />
        {layers.rack && <RackStructure racks={scene.rackSpecs} />}
        {layers.lanes && <LaneLayer scene={scene} />}
        {layers.stations && <StationLayer scene={scene} />}
        {layers.devices && (
          <DeviceLayer
            scene={scene}
            t={t}
            selectedDevice={selectedDevice}
            onSelectDevice={onSelectDevice}
            showPaths={layers.paths}
          />
        )}
        {layers.tasks && <TaskLayer scene={scene} t={t} />}
        {layers.relocations && <RelocationLayer scene={scene} t={t} />}
        {layers.devices && selected && (
          <GlowNode
            x={selected.track ? poseAt(selected.track, t)?.x ?? 0 : 0}
            z={selected.track ? poseAt(selected.track, t)?.z ?? 0 : 0}
            y={0.02}
            color={selected.color}
            radius={1.1}
            pulse
          />
        )}
      </SandboxScene>
      {/* 设备类型说明（视觉形态与契约 device.kind 的对应关系，不是"指标"） */}
      <div
        className="stage-note muted small"
        style={{ position: 'absolute', bottom: 8, left: 8, zIndex: 5, pointerEvents: 'none' }}
      >
        {scene.devices.slice(0, 4).map((device) => (
          <span key={device.deviceId} className="legend-item">
            <span className="legend-dot" style={{ background: device.color }} />
            {device.deviceId}（{deviceKindLabel(device.kind)}）
          </span>
        ))}
        {scene.devices.length > 4 && <span className="muted">…共 {scene.devices.length} 台</span>}
      </div>
    </div>
  );
}
