/**
 * APS 排程沙盘 · 3D 装配（V2 §五-03 / COMPONENT-DESIGN-V2 §2）。
 *
 * 把排程解投影成等距产线：
 *   - 设备（机器）按索引铺成产线网格， MachineUnit 呈现机身/主轴/状态灯/进度条；
 *   - 工件只在「引擎给出的工序区间 [start,end]」内出现在对应设备上，并按区间内
 *     时刻线性显示进度（插值，不虚构任何加工过程）；
 *   - 同一订单的工序顺序用细发光线连接（真实先后关系，非路径）；
 *   - 当前在制设备高亮，点选设备可选中其工序。
 * 前端零伪造：工序区间、设备归属、先后顺序全部来自引擎输出。
 */

import { useCallback, useMemo } from 'react';
import { GlowPath, GroundPlate, IsoCamera, MachineUnit, SandboxScene, SB, sbRobotColor } from '../../components/sandbox';

export interface ApsSandbox3DProps {
  /** 资源（机器）id，按数组顺序铺产线。 */
  machines: string[];
  /** 引擎排程工序（绝对毫秒时间）。 */
  ops: Array<{ opId: string; orderId: string; machineId: string; startMs: number; endMs: number }>;
  minMs: number;
  maxMs: number;
  /** 回放步（整数，量程 steps）。 */
  step: number;
  steps: number;
  playing: boolean;
  selectedOp: string | null;
  onSelectOp?: (opId: string | null) => void;
}

/** 产线网格间距（世界单位）。 */
const PITCH = 2.6;
/** 工件/状态光高度（贴设备台面）。 */
const PATH_Y = 0.02;

export function ApsSandbox3D({ machines, ops, minMs, maxMs, step, steps, playing, selectedOp, onSelectOp }: ApsSandbox3DProps) {
  // 回放时刻 = 整数步线性映射到引擎毫秒区间（不插值加工过程，只定位工序区间）
  const now = minMs + ((maxMs - minMs) * Math.max(0, Math.min(steps, step))) / Math.max(1, steps);
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, machines.length))));
  const rows = Math.max(1, Math.ceil(Math.max(1, machines.length) / cols));
  const width = Math.max(4, cols * PITCH);
  const height = Math.max(4, rows * PITCH);

  const layout = useMemo(() => {
    const byId = new Map<string, { x: number; z: number }>();
    machines.forEach((id, i) => {
      const cx = i % cols;
      const cy = Math.floor(i / cols);
      // 以产线中心为原点
      const x = (cx - (cols - 1) / 2) * PITCH;
      const z = (cy - (rows - 1) / 2) * PITCH;
      byId.set(id, { x, z });
    });
    return byId;
  }, [machines, cols, rows]);

  const orderColors = useMemo(() => {
    const ids = [...new Set(ops.map((o) => o.orderId))].sort();
    const m = new Map<string, string>();
    ids.forEach((id, i) => m.set(id, sbRobotColor(i)));
    return m;
  }, [ops]);

  /** 订单工序先后（按开始时间排序）= 真实流转关系。 */
  const flows = useMemo(() => {
    const byOrder = new Map<string, typeof ops>();
    for (const op of ops) {
      const list = byOrder.get(op.orderId) ?? [];
      list.push(op);
      byOrder.set(op.orderId, list);
    }
    const out: Array<{ orderId: string; color: string; points: Array<[number, number, number]> }> = [];
    for (const [orderId, list] of byOrder) {
      const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
      const pts: Array<[number, number, number]> = [];
      for (const op of sorted) {
        const p = layout.get(op.machineId);
        if (!p) continue;
        pts.push([p.x, PATH_Y, p.z]);
      }
      if (pts.length >= 2) out.push({ orderId, color: orderColors.get(orderId) ?? SB.ice, points: pts });
    }
    return out;
  }, [ops, layout, orderColors]);

  /** 当前时刻每台设备上的在制工序（引擎区间包含 now 的那一道）。 */
  const active = useMemo(() => {
    const m = new Map<string, { op: (typeof ops)[number]; progress: number }>();
    for (const op of ops) {
      if (now < op.startMs || now > op.endMs) continue;
      const span = Math.max(1, op.endMs - op.startMs);
      const prev = m.get(op.machineId);
      if (!prev || op.startMs > prev.op.startMs) m.set(op.machineId, { op, progress: Math.max(0, Math.min(1, (now - op.startMs) / span)) });
    }
    return m;
  }, [ops, now]);

  const handlePick = useCallback(
    (machineId: string) => {
      const cur = active.get(machineId);
      if (cur) {
        onSelectOp?.(cur.op.opId);
        return;
      }
      const next = ops
        .filter((o) => o.machineId === machineId && o.startMs >= now)
        .sort((a, b) => a.startMs - b.startMs)[0];
      onSelectOp?.(next?.opId ?? null);
    },
    [active, ops, now, onSelectOp],
  );

  const span = Math.max(width, height, 8);

  return (
    <SandboxScene width={width} height={height} className="sandbox-stage" active={playing}>
      <IsoCamera span={span} view="iso" />
      <GroundPlate width={width} height={height} />

      {/* 产线网格地面线（细发光线，标识设备位） */}
      {machines.map((id) => {
        const p = layout.get(id)!;
        return (
          <mesh key={`pad-${id}`} rotation={[-Math.PI / 2, 0, 0]} position={[p.x, 0.008, p.z]}>
            <ringGeometry args={[1.05, 1.12, 36]} />
            <meshBasicMaterial
              color={active.has(id) ? SB.ice : SB.plateLine}
              transparent
              opacity={active.has(id) ? 0.85 : 0.5}
              depthWrite={false}
            />
          </mesh>
        );
      })}

      {/* 订单流转细线（真实工序先后） */}
      {flows.map((f) => (
        <GlowPath
          key={`flow-${f.orderId}`}
          points={f.points}
          color={f.color}
          dimmed={selectedOp != null && !ops.some((o) => o.opId === selectedOp && o.orderId === f.orderId)}
          glow={0.5}
        />
      ))}

      {/* 设备 */}
      {machines.map((id, i) => {
        const p = layout.get(id)!;
        const cur = active.get(id);
        const color = cur ? (orderColors.get(cur.op.orderId) ?? sbRobotColor(i)) : sbRobotColor(i);
        const isSelected = selectedOp != null && cur?.op.opId === selectedOp;
        return (
          <group key={`m-${id}`}>
            <MachineUnit
              x={p.x}
              z={p.z}
              color={color}
              state={cur ? 'working' : 'idle'}
              progress={cur?.progress ?? 0}
              workpiece={Boolean(cur)}
              selected={isSelected}
              dimmed={selectedOp != null && !isSelected}
            />
            {/* 点选热区（覆盖机身轮廓的透明盒） */}
            <mesh
              position={[p.x, 0.6, p.z]}
              onClick={(e) => {
                e.stopPropagation();
                handlePick(id);
              }}
            >
              <boxGeometry args={[1.6, 1.3, 1.4]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
          </group>
        );
      })}
    </SandboxScene>
  );
}
