/**
 * AGV 智能工业调度沙盘 · 3D 装配（V2 §五-02 / COMPONENT-DESIGN-V2 §2）。
 *
 * 把 AgvScene（问题）+ AgvSolution（引擎解）+ 回放时钟投影到 3D：
 *   - 底板/障碍 = 场景；货架用冷灰蓝变体（与 MAPF 石墨障碍区分）；
 *   - 工作站 = 发光泊位 + 容量灯条；任务取/送点 = 发光节点；
 *   - 车辆轨迹按任务相位分段着色（冰蓝=去取货 / 琥珀=去送达 / 紫罗兰=重定位）；
 *   - 车辆位置 = lerp(timeline[t], timeline[t+1], frac)（离散时间红线）。
 * 前端零伪造：所有路径/相位/时间只来自引擎输出。
 */

import { useFrame, useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type * as THREE from 'three';
import type { Cell, GridDims } from '../../components/grid-map/types';
import {
  AgvUnit,
  GlowNode,
  GlowPath,
  GroundPlate,
  IsoCamera,
  SandboxScene,
  SB,
  SB_PHASE_COLOR,
  StationPad,
  WarehouseEnvironment,
  WarehouseRackField,
  cellsToWorld,
  sbRobotColor,
  stepInterp,
} from '../../components/sandbox';
import { cellFromWorld } from '../../components/sandbox/picking';
import type { AgvSolution } from '../../core/agv/types';
import type { PlaybackClock } from '../mapf/playback/clock';
import { locCells, type AgvScene } from './scene';
import { phaseAt } from './agvRender';

export interface AgvSandbox3DProps {
  scene: AgvScene;
  solution: AgvSolution | null;
  t: number;
  primary: string | null;
  layers: { paths: boolean; executed: boolean; markers: boolean; vehicles: boolean };
  hover: Cell | null;
  invalidCells: Cell[];
  conflictCells: Cell[];
  view: 'iso' | 'top';
  clock: PlaybackClock | null;
  playing: boolean;
  onCellClick?: (cell: Cell) => void;
  onCellDrag?: (cell: Cell) => void;
  onCellDown?: (cell: Cell) => void;
  onCellUp?: (cell: Cell) => void;
  onHover?: (cell: Cell | null) => void;
}

const PATH_Y = 0.22;
const NODE_Y = 0.05;

/**
 * 工作站当前占用数（引擎数据投影）：已到达本站取/送点且尚未完成的任务数。
 * 只读 solution.plan.tasks，前端不推断占用。
 */
function stationOccupancy(solution: AgvSolution | null, cells: Array<[number, number]>): number {
  const tasks = solution?.plan?.tasks;
  if (!tasks?.length || cells.length === 0) return 0;
  const here = new Set(cells.map(([x, y]) => `${x},${y}`));
  let n = 0;
  for (const tk of tasks) {
    if (tk.vehicle == null) continue;
    const servingPickup = tk.pickup_dock != null && here.has(`${tk.pickup_dock[0]},${tk.pickup_dock[1]}`) && tk.pickup_arrival != null && tk.pickup_done == null;
    const servingDropoff = tk.dropoff_dock != null && here.has(`${tk.dropoff_dock[0]},${tk.dropoff_dock[1]}`) && tk.dropoff_arrival != null && tk.dropoff_done == null;
    if (servingPickup || servingDropoff) n += 1;
  }
  return n;
}

export function AgvSandbox3D(props: AgvSandbox3DProps) {
  const { scene, solution, t, primary, layers, view, clock, playing } = props;
  const width = scene.map.cells[0]?.length ?? 0;
  const height = scene.map.cells.length;
  const dims: GridDims = { width, height };

  const blocked = useMemo(() => {
    const out: Array<[number, number]> = [];
    scene.map.cells.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = row[x];
        if (c === '#' || c === 'T' || c === 'S') out.push([x, y]);
      }
    });
    return out;
  }, [scene.map.cells]);

  const vehicles = useMemo(() => {
    const plan = solution?.plan?.vehicles ?? [];
    return scene.vehicles.map((v, i) => {
      const pv = plan.find((p) => p.id === v.id);
      return {
        id: v.id,
        index: i,
        color: sbRobotColor(i),
        timeline: pv?.timeline?.length ? pv.timeline : ([v.start] as Array<[number, number]>),
        missions: pv?.missions ?? [],
      };
    });
  }, [scene.vehicles, solution]);

  const span = Math.max(width, height, 8);

  return (
    <SandboxScene width={width} height={height} className="sandbox-stage" active={playing}>
      <IsoCamera span={span} width={width} height={height} view={view} rotatable={false} />
      <GroundPlate width={width} height={height} />
      <WarehouseEnvironment width={width} height={height} />

      {/* 货架实体从真实占用格投影；每格包含立柱、横梁、层板、托盘与货箱。 */}
      <WarehouseRackField cells={blocked} />

      {/* 工作站泊位（发光垫面 + 容量灯条） */}
      {layers.markers &&
        scene.stations.map((st) => (
          <StationPad
            key={st.id}
            cells={st.cells}
            capacity={st.capacity}
            occupied={stationOccupancy(solution, st.cells)}
            selected={primary === st.id}
          />
        ))}

      {/* 任务取货 / 送达节点 */}
      {layers.markers &&
        scene.tasks.map((tk) => (
          <group key={tk.id}>
            {locCells(scene, tk.pickup).map(([x, y]) => (
              <GlowNode key={`p-${x},${y}`} x={x + 0.5} z={y + 0.5} y={NODE_Y} color={SB.ice} radius={0.3} />
            ))}
            {locCells(scene, tk.dropoff).map(([x, y]) => (
              <GlowNode key={`d-${x},${y}`} x={x + 0.5} z={y + 0.5} y={NODE_Y} color={SB.amber} radius={0.3} />
            ))}
          </group>
        ))}

      {/* 车辆轨迹：按任务相位分段着色 */}
      {layers.paths &&
        vehicles.map((v) => {
          const dim = primary != null && primary !== v.id;
          const segs = v.missions.length
            ? v.missions.map((m) => ({
                from: Math.max(0, Math.min(v.timeline.length - 1, m.from)),
                to: Math.max(0, Math.min(v.timeline.length - 1, m.to)),
                color: SB_PHASE_COLOR[m.phase] ?? v.color,
              }))
            : [{ from: 0, to: v.timeline.length - 1, color: v.color }];
          return (
            <group key={`veh-${v.id}`}>
              {segs.map((seg, si) => {
                const pts = cellsToWorld(v.timeline.slice(seg.from, seg.to + 1), PATH_Y);
                if (pts.length < 2) return null;
                return (
                  <GlowPath
                    key={`seg-${si}`}
                    points={pts}
                    color={seg.color}
                    executedTo={layers.executed ? Math.max(0, Math.min(t, v.timeline.length - 1) - seg.from) : null}
                    selected={primary === v.id}
                    flowOffset={t * 0.34}
                    dimmed={dim}
                  />
                );
              })}
            </group>
          );
        })}

      {/* 核验冲突（珊瑚红脉冲） */}
      {props.conflictCells.map((c, i) => (
        <GlowNode key={`cf-${i}`} x={c.x + 0.5} z={c.y + 0.5} y={NODE_Y} color={SB.coral} radius={0.34} pulse />
      ))}

      {/* 编辑期非法格 */}
      {props.invalidCells.map((c) => (
        <mesh key={`inv-${c.x}-${c.y}`} rotation={[-Math.PI / 2, 0, 0]} position={[c.x + 0.5, 0.014, c.y + 0.5]}>
          <planeGeometry args={[0.96, 0.96]} />
          <meshBasicMaterial color={SB.coral} transparent opacity={0.22} depthWrite={false} />
        </mesh>
      ))}

      {/* 悬停格 */}
      {props.hover && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[props.hover.x + 0.5, 0.016, props.hover.y + 0.5]}>
          <planeGeometry args={[0.98, 0.98]} />
          <meshBasicMaterial color={SB.ice} transparent opacity={0.16} depthWrite={false} />
        </mesh>
      )}

      {/* 车辆 */}
      {layers.vehicles &&
        vehicles.map((v) => (
          <AgvRobot
            key={`agv-${v.id}`}
            timeline={v.timeline}
            color={v.color}
            selected={primary === v.id}
            dimmed={primary != null && primary !== v.id}
            t={t}
            solution={solution}
            index={v.index}
            clock={clock}
            playing={playing}
          />
        ))}

      <PickPlane
        dims={dims}
        onCellClick={props.onCellClick}
        onCellDrag={props.onCellDrag}
        onCellDown={props.onCellDown}
        onCellUp={props.onCellUp}
        onHover={props.onHover}
      />
    </SandboxScene>
  );
}

/** AGV 小车：静止落在第 t 步，播放时按 frac 在相邻两步间插值。 */
function AgvRobot({
  timeline,
  color,
  selected,
  dimmed,
  t,
  solution,
  index,
  clock,
  playing,
}: {
  timeline: Array<[number, number]>;
  color: string;
  selected: boolean;
  dimmed: boolean;
  t: number;
  solution: AgvSolution | null;
  index: number;
  clock: PlaybackClock | null;
  playing: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const still = stepInterp(timeline, t) ?? { x: 0.5, z: 0.5, heading: 0 };
  const phase = solution && timeline.length ? phaseAt(solution, index, t) : 'idle';
  const loaded = phase === 'to_dropoff' || phase === 'servicing_dropoff';

  useFrame(({ invalidate }) => {
    const g = groupRef.current;
    if (!g) return;
    const tf = clock ? clock.t + clock.frac : t;
    const pos = stepInterp(timeline, tf);
    if (pos) {
      g.position.set(pos.x, 0, pos.z);
      g.rotation.y = -pos.heading;
    }
    if (playing) invalidate();
  });

  return (
    <group ref={groupRef} position={[still.x, 0, still.z]} rotation={[0, -still.heading, 0]}>
      <AgvUnit x={0} z={0} heading={0} color={color} selected={selected} phase={phase} loaded={loaded} />
      {dimmed && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
          <ringGeometry args={[0.62, 0.68, 24]} />
          <meshBasicMaterial color={SB.inactive} transparent opacity={0.3} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}

/** 拾取平面（与 MAPF 3D 同一协议）。 */
function PickPlane({
  dims,
  onCellClick,
  onCellDrag,
  onCellDown,
  onCellUp,
  onHover,
}: {
  dims: GridDims;
  onCellClick?: (cell: Cell) => void;
  onCellDrag?: (cell: Cell) => void;
  onCellDown?: (cell: Cell) => void;
  onCellUp?: (cell: Cell) => void;
  onHover?: (cell: Cell | null) => void;
}) {
  const gestureRef = useRef<{ start: Cell | null; last: Cell | null; moved: boolean }>({ start: null, last: null, moved: false });
  const { gl } = useThree();
  const resetGesture = () => {
    gestureRef.current = { start: null, last: null, moved: false };
  };
  useEffect(() => {
    const onLostCapture = () => {
      const gesture = gestureRef.current;
      if (!gesture.start) return;
      onCellUp?.(gesture.last ?? gesture.start);
      resetGesture();
    };
    gl.domElement.addEventListener('lostpointercapture', onLostCapture);
    return () => gl.domElement.removeEventListener('lostpointercapture', onLostCapture);
  }, [gl, onCellUp]);
  const capture = (ev: ThreeEvent<PointerEvent>, release = false) => {
    const target = ev.nativeEvent.currentTarget as (EventTarget & {
      setPointerCapture?: (id: number) => void;
      releasePointerCapture?: (id: number) => void;
    }) | null;
    try {
      if (release) target?.releasePointerCapture?.(ev.pointerId);
      else target?.setPointerCapture?.(ev.pointerId);
    } catch {
      // Capture can be unavailable for synthetic/unsupported pointer events; normal
      // canvas events still work, and the canvas lost-capture listener below always settles history.
    }
  };
  const cellAt = (point: THREE.Vector3 | null | undefined) =>
    point ? cellFromWorld(point.x, point.z, dims.width, dims.height) : null;
  const finish = (ev: ThreeEvent<PointerEvent>, cancelled: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture.start) {
      resetGesture();
      return;
    }
    const cell = cellAt(ev.point);
    const end = cell ?? gesture.last ?? gesture.start;
    const crossed = Boolean(cell && (cell.x !== gesture.start.x || cell.y !== gesture.start.y));
    const dragged = gesture.moved || crossed;
    if (!cancelled && dragged) {
      if (!gesture.moved) onCellDrag?.(gesture.start);
      if (cell && (cell.x !== gesture.last?.x || cell.y !== gesture.last?.y)) onCellDrag?.(cell);
    } else if (!cancelled && cell && !dragged && cell.x === gesture.start.x && cell.y === gesture.start.y) {
      onCellClick?.(cell);
    }
    onCellUp?.(end);
    resetGesture();
    capture(ev, true);
  };

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[dims.width / 2, 0.02, dims.height / 2]}
      onPointerMove={(ev) => {
        const cell = cellAt(ev.point);
        onHover?.(cell);
        const gesture = gestureRef.current;
        if (!gesture.start || !cell) return;
        const crossedStart = cell.x !== gesture.start.x || cell.y !== gesture.start.y;
        if (!gesture.moved && crossedStart) {
          gesture.moved = true;
          onCellDrag?.(gesture.start);
          gesture.last = gesture.start;
        }
        if (gesture.moved && (cell.x !== gesture.last?.x || cell.y !== gesture.last?.y)) {
          onCellDrag?.(cell);
          gesture.last = cell;
        }
      }}
      onPointerDown={(ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        const cell = cellAt(ev.point);
        gestureRef.current = { start: cell, last: cell, moved: false };
        if (cell) onCellDown?.(cell);
        capture(ev);
      }}
      onPointerUp={(ev) => {
        ev.stopPropagation();
        finish(ev, false);
      }}
      onPointerCancel={(ev) => {
        finish(ev, true);
      }}
      onPointerLeave={() => onHover?.(null)}
    >
      <planeGeometry args={[dims.width, dims.height]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}
