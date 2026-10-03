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

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type * as THREE from 'three';
import type { Cell, GridDims } from '../../components/grid-map/types';
import {
  AgvUnit,
  GlowNode,
  GlowPath,
  GroundPlate,
  IsoCamera,
  ObstacleField,
  SandboxScene,
  SB,
  SB_PHASE_COLOR,
  StationPad,
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
  painting: boolean;
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
  const { scene, solution, t, primary, layers, view, painting, clock, playing } = props;
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
      <IsoCamera span={span} view={view} rotatable={!painting} />
      <GroundPlate width={width} height={height} />

      {/* 货架 / 设备底座（冷灰蓝变体） */}
      <ObstacleField cells={blocked} variant="cold" height={0.55} />

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
}: {
  timeline: Array<[number, number]>;
  color: string;
  selected: boolean;
  dimmed: boolean;
  t: number;
  solution: AgvSolution | null;
  index: number;
  clock: PlaybackClock | null;
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
    invalidate();
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
  const downRef = useRef<Cell | null>(null);
  const lastRef = useRef<Cell | null>(null);
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[dims.width / 2, 0.02, dims.height / 2]}
      onPointerMove={(ev) => {
        if (!ev.point) return;
        const cell = cellFromWorld(ev.point.x, ev.point.z, dims.width, dims.height);
        onHover?.(cell);
        if (downRef.current && cell && (cell.x !== lastRef.current?.x || cell.y !== lastRef.current?.y)) {
          lastRef.current = cell;
          onCellDrag?.(cell);
        }
      }}
      onPointerDown={(ev) => {
        if (!ev.point) return;
        const cell = cellFromWorld(ev.point.x, ev.point.z, dims.width, dims.height);
        downRef.current = cell;
        lastRef.current = cell;
        if (cell) {
          onCellDown?.(cell);
          onCellDrag?.(cell);
        }
      }}
      onPointerUp={(ev) => {
        if (!ev.point) return;
        const cell = cellFromWorld(ev.point.x, ev.point.z, dims.width, dims.height);
        if (cell && downRef.current && cell.x === downRef.current.x && cell.y === downRef.current.y) onCellClick?.(cell);
        if (cell) onCellUp?.(cell);
        downRef.current = null;
        lastRef.current = null;
      }}
      onPointerLeave={() => {
        downRef.current = null;
        lastRef.current = null;
        onHover?.(null);
      }}
    >
      <planeGeometry args={[dims.width, dims.height]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}
