/**
 * APS 3D 产线投影（V2 §五-03）：把运行结果（甘特模型 + 资源清单）投影成
 * 产线 3D 所需的「设备网格 + 工序区间」。
 *
 * 纯函数、零伪造：opId / orderId / machineId / startMs / endMs 全部来自引擎输出，
 * 不做任何插值、补齐或重排；设备顺序 = 工序中出现顺序，其后补资源清单里未排产的设备。
 */

import type { GanttBar, GanttModel, ResourceUsage } from '../../core/aps/records';

export interface ApsLineOp {
  opId: string;
  orderId: string;
  machineId: string;
  startMs: number;
  endMs: number;
}

export interface ApsLineProjection {
  machines: string[];
  ops: ApsLineOp[];
  minMs: number;
  maxMs: number;
}

export function projectApsLine(gantt: GanttModel | null, resources: ResourceUsage[]): ApsLineProjection {
  if (!gantt) return { machines: [], ops: [], minMs: 0, maxMs: 1 };
  const ops: ApsLineOp[] = [];
  const machines: string[] = [];
  for (const row of gantt.rows) {
    for (const bar of row.bars as GanttBar[]) {
      ops.push({
        opId: bar.opId,
        orderId: bar.orderId,
        machineId: bar.machineId,
        startMs: bar.startMs,
        endMs: bar.endMs,
      });
      if (bar.machineId && !machines.includes(bar.machineId)) machines.push(bar.machineId);
    }
  }
  for (const r of resources) {
    if (r.kind === 'machine' && r.id && !machines.includes(r.id)) machines.push(r.id);
  }
  return { machines, ops, minMs: gantt.minMs, maxMs: gantt.maxMs };
}

/** 当前时刻在制工序（引擎区间 [start,end] 闭区间包含 now；区间为空的工序不视为在制）。 */
export function opsBusyAt(ops: ApsLineOp[], nowMs: number): ApsLineOp[] {
  return ops.filter((o) => o.startMs <= nowMs && o.endMs >= nowMs && o.endMs > o.startMs);
}
