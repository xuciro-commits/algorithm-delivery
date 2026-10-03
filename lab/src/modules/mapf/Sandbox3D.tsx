/**
 * MAPF 空间与路径实验室 · 3D 沙盘装配（V2 §五-01 / COMPONENT-DESIGN-V2 §3）。
 *
 * 把 SceneDoc（问题）+ MapfSolution（引擎解）+ 回放时钟投影到共享 3D 原语上：
 *   - 底板/障碍 = SceneDoc；轨迹/节点/机器人 = solution（前端零伪造）；
 *   - 机器人位置 = lerp(timeline[t], timeline[t+1], frac)（离散时间红线）；
 *   - 3D 与 2D 共用同一交互协议：onCellClick / onCellDrag / onHover(cell|null)。
 *
 * 本组件不含任何算法语义：路径只来自引擎输出，绝不在前端编造。
 */

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type * as THREE from 'three';
import type { Cell, GridDims } from '../../components/grid-map/types';
import {
  GlowNode,
  GlowPath,
  GroundPlate,
  IsoCamera,
  ObstacleField,
  RobotUnit,
  SandboxScene,
  SB,
  cellsToWorld,
  sbRobotColor,
  stepInterp,
} from '../../components/sandbox';
import { cellFromWorld } from '../../components/sandbox/picking';
import type { MapfSolution } from '../../core/mapf/types';
import type { SceneDoc } from './scene/SceneDoc';
import { phaseAt } from './playback/clock';
import type { PlaybackClock } from './playback/clock';

export interface MapfSandbox3DProps {
  doc: SceneDoc;
  solution: MapfSolution | null;
  /** 旧方案幽灵（动态重规划前），暗色低透明度呈现。 */
  ghost: MapfSolution | null;
  /** 当前离散步（整数）。 */
  t: number;
  primary: string | null;
  selected: string[];
  layers: { goals: boolean; paths: boolean; executed: boolean; robots: boolean; conflicts: boolean; events: boolean };
  hover: Cell | null;
  invalidCells: Cell[];
  conflictCells: Array<{ cell: Cell; at: number }>;
  eventMarks: Array<{ cell: Cell; at: number; kind: string }>;
  view: 'iso' | 'top';
  /** 指针工具是否正在编辑（编辑时锁定相机旋转，避免与笔刷冲突）。 */
  painting: boolean;
  /** 回放时钟：帧内插值系数 frac 的唯一来源（离散时间红线）。 */
  clock: PlaybackClock | null;
  /** 时钟是否在播放（播放=frameloop always；静止=demand 零 GPU 负载）。 */
  playing: boolean;
  onCellClick?: (cell: Cell, mods: { shift: boolean; meta: boolean }) => void;
  onCellDrag?: (cell: Cell) => void;
  onCellDown?: (cell: Cell) => void;
  onCellUp?: (cell: Cell) => void;
  onHover?: (cell: Cell | null) => void;
}

const PATH_Y = 0.22;
const NODE_Y = 0.05;

export function MapfSandbox3D(props: MapfSandbox3DProps) {
  const { doc, solution, ghost, t, primary, selected, layers, view, painting, clock, playing, eventMarks, conflictCells } = props;
  const width = doc.map.cells[0]?.length ?? 0;
  const height = doc.map.cells.length;
  const dims: GridDims = { width, height };

  const blocked = useMemo(() => {
    const out: Array<[number, number]> = [];
    doc.map.cells.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = row[x];
        if (c === '#' || c === 'T' || c === 'S') out.push([x, y]);
      }
    });
    return out;
  }, [doc.map.cells]);

  const robots = useMemo(() => {
    if (solution?.robots?.length) {
      return solution.robots.map((r, i) => ({
        id: r.id,
        index: i,
        color: sbRobotColor(i),
        path: r.path ?? [],
        arrival: r.arrival ?? null,
        start: r.start,
        goal: r.goal,
      }));
    }
    return doc.robots.map((r, i) => ({
      id: r.id,
      index: i,
      color: sbRobotColor(i),
      path: [r.start] as Array<[number, number]>,
      arrival: null as number | null,
      start: r.start,
      goal: r.goal,
    }));
  }, [solution, doc.robots]);

  const span = Math.max(width, height, 8);

  return (
    <SandboxScene width={width} height={height} className="sandbox-stage" active={playing}>
      <IsoCamera span={span} view={view} rotatable={!painting} />

      {/* 空间底板 + 工程网格 */}
      <GroundPlate width={width} height={height} />

      {/* 障碍：低矮立体结构（实例化） */}
      <ObstacleField cells={blocked} variant="wall" height={0.42} />

      {/* 旧方案幽灵（重规划前）：暗色半透明，不与新轨迹抢焦点 */}
      {ghost?.robots?.length && layers.paths && (
        <group>
          {ghost.robots.map((r) => {
            const pts = cellsToWorld(r.path ?? [], PATH_Y * 0.8);
            if (pts.length < 2) return null;
            return (
              <GlowPath
                key={`ghost-${r.id}`}
                points={pts}
                color={SB.inactive}
                executedTo={null}
                glow={0.5}
                dimmed
              />
            );
          })}
        </group>
      )}

      {/* 发光轨迹：执行段亮实线 / 未执行段半透明虚线 */}
      {layers.paths &&
        robots.map((r) => {
          if (r.path.length < 2) return null;
          const dim = primary != null && primary !== r.id && !selected.includes(r.id);
          return (
            <GlowPath
              key={`path-${r.id}`}
              points={cellsToWorld(r.path, PATH_Y)}
              color={r.color}
              executedTo={layers.executed ? Math.min(t, r.path.length - 1) : null}
              selected={primary === r.id || selected.includes(r.id)}
              flowOffset={t * 0.34}
              dimmed={dim}
            />
          );
        })}

      {/* 起终点节点（取货/送达语义的空间标记） */}
      {layers.goals &&
        robots.map((r) => (
          <group key={`goal-${r.id}`}>
            <GlowNode x={r.goal[0] + 0.5} z={r.goal[1] + 0.5} y={NODE_Y} color={r.color} radius={0.3} dimmed={primary != null && primary !== r.id && !selected.includes(r.id)} />
          </group>
        ))}

      {/* 动态事件节点 */}
      {layers.events &&
        eventMarks.map((e, i) => (
          <GlowNode
            key={`ev-${i}`}
            x={e.cell.x + 0.5}
            z={e.cell.y + 0.5}
            y={NODE_Y}
            color={e.kind.includes('obstacle') ? SB.coral : SB.amber}
            radius={0.36}
            pulse
          />
        ))}

      {/* 核验冲突（珊瑚红脉冲） */}
      {layers.conflicts &&
        conflictCells.map((c, i) => (
          <GlowNode key={`cf-${i}`} x={c.cell.x + 0.5} z={c.cell.y + 0.5} y={NODE_Y} color={SB.coral} radius={0.34} pulse />
        ))}

      {/* 编辑期非法格（珊瑚红薄片） */}
      {props.invalidCells.map((c) => (
        <mesh key={`inv-${c.x}-${c.y}`} rotation={[-Math.PI / 2, 0, 0]} position={[c.x + 0.5, 0.014, c.y + 0.5]}>
          <planeGeometry args={[0.96, 0.96]} />
          <meshBasicMaterial color={SB.coral} transparent opacity={0.22} depthWrite={false} />
        </mesh>
      ))}

      {/* 悬停格（冰蓝细框） */}
      {props.hover && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[props.hover.x + 0.5, 0.016, props.hover.y + 0.5]}>
          <planeGeometry args={[0.98, 0.98]} />
          <meshBasicMaterial color={SB.ice} transparent opacity={0.16} depthWrite={false} />
        </mesh>
      )}

      {/* 机器人（位置由帧监听按离散步插值驱动） */}
      {layers.robots &&
        robots.map((r) => (
          <MapfRobot
            key={`robot-${r.id}`}
            path={r.path}
            color={r.color}
            selected={primary === r.id || selected.includes(r.id)}
            dimmed={primary != null && primary !== r.id && !selected.includes(r.id)}
            t={t}
            arrival={r.arrival}
            clock={clock}
          />
        ))}

      {/* 拾取平面（透明，不渲染但参与射线检测） */}
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

/** 机器人：静止时落在第 t 步，播放时按 frac 在相邻两步间插值（红线）。 */
function MapfRobot({
  path,
  color,
  selected,
  dimmed,
  t,
  arrival,
  clock,
}: {
  path: Array<[number, number]>;
  color: string;
  selected: boolean;
  dimmed: boolean;
  t: number;
  arrival: number | null;
  clock: PlaybackClock | null;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const still = stepInterp(path, t) ?? { x: 0.5, z: 0.5, heading: 0 };
  const phase = path.length ? phaseAt({ path, arrival }, t) : 'waiting';
  const status = phase === 'waiting' ? 'idle' : phase === 'arrived' || phase === 'staying' ? 'service' : 'run';

  useFrame(({ invalidate }) => {
    const g = groupRef.current;
    if (!g) return;
    // 帧内插值：t 来自时钟当前步，frac ∈ [0,1) 只在该步与下一步之间插值
    const tf = clock ? clock.t + clock.frac : t;
    const pos = stepInterp(path, tf);
    if (pos) {
      g.position.set(pos.x, 0, pos.z);
      g.rotation.y = -pos.heading;
    }
    invalidate();
  });

  return (
    <group ref={groupRef} position={[still.x, 0, still.z]} rotation={[0, -still.heading, 0]}>
      <RobotUnit x={0} z={0} heading={0} color={color} selected={selected} status={status} />
      {dimmed && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
          <ringGeometry args={[0.62, 0.68, 24]} />
          <meshBasicMaterial color={SB.inactive} transparent opacity={0.3} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}

/**
 * 拾取平面：透明网格覆盖底板，把指针交点换算成格坐标。
 * 与 2D MapStage 同一回调协议；笔画拖动天然去重（同一格只报一次）。
 */
function PickPlane({
  dims,
  onCellClick,
  onCellDrag,
  onCellDown,
  onCellUp,
  onHover,
}: {
  dims: GridDims;
  onCellClick?: (cell: Cell, mods: { shift: boolean; meta: boolean }) => void;
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
          onCellDrag?.(cell); // 落笔即生效（与 2D 一致）
        }
      }}
      onPointerUp={(ev) => {
        if (!ev.point) return;
        const cell = cellFromWorld(ev.point.x, ev.point.z, dims.width, dims.height);
        if (cell && downRef.current && cell.x === downRef.current.x && cell.y === downRef.current.y) {
          onCellClick?.(cell, { shift: ev.shiftKey, meta: ev.metaKey || ev.ctrlKey });
        }
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
