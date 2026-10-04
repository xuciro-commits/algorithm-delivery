/**
 * 订单流与物理任务编译（SRS §2.3 / §8）。
 *
 * 这里把"业务订单"与"设备任务"分开处理，并保留两者之间的**真实映射**：
 *   - 订单：客户视角（行、数量、释放时刻、交付期限、优先级、渠道、预约窗口）；
 *   - 任务：设备视角（取哪个货物单元、从哪个库位、到哪里、什么期限、依赖谁）。
 *
 * 一条订单可能对应多个任务（多 SKU / 多货物单元），也可能与另一条订单共用一次循环
 * （双指令：出库 + 入库合并），但**绝不会**出现"一百万订单 = 一百万提升机任务"的伪规模。
 */

import type {
  CustomerOrder,
  DemandProfile,
  InventoryUnit,
  OrderLine,
  SkuSpec,
  TaskKind,
  WarehouseTask,
} from '../contract/types.ts';
import { makeRng, round, seedFrom, type Rng } from '../contract/util.ts';

export interface OrderGenParams {
  orders: number;
  skus: SkuSpec[];
  demand: DemandProfile;
  seed: number;
  /** 历史窗口（天）：仅用于统计关联度与周转率。 */
  historyDays: number;
  /** 未来窗口（天）：用于调度与联合优化。 */
  futureDays: number;
  /** 订单到达从何时开始（秒）。 */
  start_s: number;
  /** 突发峰值：额外的一段时间窗口与倍数（E 组 / J07）。 */
  burst?: { fromDay: number; toDay: number; factor: number } | null;
  /** 高优先级订单比例（加急 / 当日达）。 */
  priorityShare: number;
  /** 交付时限（小时）：普通订单与加急订单。 */
  slaHours: { standard: number; express: number };
  /** 是否生成预约出库窗口。 */
  appointments: boolean;
}

export interface OrderGenResult {
  orders: CustomerOrder[];
  stats: {
    orders: number;
    lines: number;
    multiLineShare: number;
    expressShare: number;
    peakHourOrders: number;
    avgLinesPerOrder: number;
    skusTouched: number;
  };
}

/** 生成订单流（历史 + 未来）。 */
export function generateOrders(params: OrderGenParams): OrderGenResult {
  const rng = makeRng(seedFrom('orders', params.seed, params.orders));
  const totalDays = params.historyDays + params.futureDays;
  const hourly = params.demand.hourlyFactor ?? new Array(24).fill(1);
  const skuWeights = demandWeights(params.skus, params.demand);
  const weightSum = skuWeights.reduce((a, b) => a + b, 0);

  // 按 (day, hour) 的到达强度铺订单，保证高峰非均匀（SRS §8 要求）
  const capacityPerDay = params.orders / Math.max(1, totalDays);
  const orders: CustomerOrder[] = [];
  let idSeq = 0;
  const peakByHour = new Map<number, number>();
  for (let day = 0; day < totalDays; day += 1) {
    const seasonFactor = 1 + (params.demand.promoWindows?.reduce((acc, w) => (day >= w.fromDay && day <= w.toDay ? Math.max(acc, w.factor) : acc), 1) ?? 1);
    const burstFactor = params.burst && day >= params.burst.fromDay && day <= params.burst.toDay ? params.burst.factor : 1;
    const dayTotal = capacityPerDay * seasonFactor * burstFactor;
    const hourWeights = hourly.map((f) => f * (0.85 + rng.next() * 0.3));
    const hourSum = hourWeights.reduce((a, b) => a + b, 0);
    for (let hour = 0; hour < 24; hour += 1) {
      const count = Math.max(0, Math.round((dayTotal * hourWeights[hour]) / hourSum));
      for (let k = 0; k < count; k += 1) {
        idSeq += 1;
        const express = rng.next() < params.priorityShare;
        const releaseDay = day;
        const release_s = round(params.start_s + releaseDay * 86400 + hour * 3600 + rng.next() * 3600, 1);
        const sla = (express ? params.slaHours.express : params.slaHours.standard) * 3600;
        const lines: OrderLine[] = [];
        const lineCount = sampleLines(rng, params.demand.linesPerOrder, params.demand.linesPerOrderCv);
        const used = new Set<string>();
        for (let l = 0; l < lineCount; l += 1) {
          const sku = pickSku(rng, params.skus, skuWeights, weightSum, used);
          if (!sku) continue;
          // 关联性：同簇 SKU 有较大概率一起出现在同一订单（关联库位优化的输入信号）
          used.add(sku.id);
          lines.push({ skuId: sku.id, quantity: Math.max(1, Math.round(1 + rng.next() * (sku.abc === 'A' ? 6 : 3))) });
          if (sku.affinityCluster && rng.next() < 0.45) {
            const mate = params.skus.find((s) => s.affinityCluster === sku.affinityCluster && !used.has(s.id));
            if (mate) {
              used.add(mate.id);
              lines.push({ skuId: mate.id, quantity: Math.max(1, Math.round(1 + rng.next() * 3)) });
            }
          }
        }
        if (lines.length === 0) continue;
        const appointment: [number, number] | null = params.appointments && rng.next() < 0.35
          ? [release_s + 3600, release_s + 3600 + (2 + rng.next() * 3) * 3600]
          : null;
        orders.push({
          id: `SO-${String(idSeq).padStart(7, '0')}`,
          release_s,
          due_s: round(release_s + sla, 1),
          priority: express ? 8 + Math.floor(rng.next() * 3) : Math.max(1, Math.round(4 + rng.normal() * 1.2)),
          channel: express ? 'express' : rng.next() < 0.2 ? 'store-replenish' : 'standard',
          lines,
          appointment,
          status: 'open',
        });
        const hourKey = day * 24 + hour;
        peakByHour.set(hourKey, (peakByHour.get(hourKey) ?? 0) + 1);
      }
    }
  }

  orders.sort((a, b) => (a.release_s !== b.release_s ? a.release_s - b.release_s : a.id < b.id ? -1 : 1));
  const lines = orders.reduce((sum, o) => sum + o.lines.length, 0);
  const multi = orders.filter((o) => o.lines.length > 1).length;
  const expressCount = orders.filter((o) => o.channel === 'express').length;
  const touched = new Set<string>();
  for (const order of orders) for (const line of order.lines) touched.add(line.skuId);

  return {
    orders,
    stats: {
      orders: orders.length,
      lines,
      multiLineShare: round(multi / Math.max(1, orders.length), 4),
      expressShare: round(expressCount / Math.max(1, orders.length), 4),
      peakHourOrders: Math.max(0, ...peakByHour.values()),
      avgLinesPerOrder: round(lines / Math.max(1, orders.length), 3),
      skusTouched: touched.size,
    },
  };
}

function sampleLines(rng: Rng, mean: number, cv: number): number {
  const value = Math.max(1, Math.round(mean + rng.normal() * mean * cv));
  return Math.min(12, value);
}

/** SKU 的订单抽样权重（ABC 与销量挂钩，A 类被显著高估）。 */
function demandWeights(skus: readonly SkuSpec[], demand: DemandProfile): number[] {
  return skus.map((sku, index) => {
    const rank = index + 1;
    const base = sku.meanDailyDemand > 0 ? sku.meanDailyDemand : 1;
    const shapeBoost = demand.shape === 'zipf' ? 1 / Math.pow(rank, 0.3) : 1;
    const abcBoost = sku.abc === 'A' ? 3.2 : sku.abc === 'B' ? 1.3 : 0.5;
    return base * shapeBoost * abcBoost;
  });
}

function pickSku(
  rng: Rng,
  skus: readonly SkuSpec[],
  weights: readonly number[],
  weightSum: number,
  used: Set<string>,
): SkuSpec | null {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let target = rng.next() * weightSum;
    for (let i = 0; i < skus.length; i += 1) {
      target -= weights[i];
      if (target <= 0) {
        if (used.has(skus[i].id)) break;
        return skus[i];
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 订单 → 物理任务
 * ------------------------------------------------------------------ */

export interface CompileTaskOptions {
  /** 批次策略解析：FIFO 按入库时间、FEFO 按到期时间；'none' 则任选。 */
  batchPolicy?: 'fifo' | 'fefo' | 'none';
  /** 任务释放时刻（秒）：订单可能在预约窗口前释放。 */
  releaseOffset_s?: number;
  /** 一次任务搬运的货物单元上限（大订单拆成多个任务）。 */
  maxUnitsPerTask?: number;
  /** 站台 id（出库点）。 */
  outboundStationId: string;
  /** 站台节点 id。 */
  outboundNodeId: string;
  /** 入库站台。 */
  inboundStationId: string;
  inboundNodeId: string;
  /** 是否把订单合并成波次（减少任务数，符合真实仓的批量作业）。 */
  waveSize?: number;
  /** 优先级映射：渠道 → 基础优先级。 */
  priorityFromOrder?: (order: CustomerOrder) => number;
}

export interface CompileResult {
  tasks: WarehouseTask[];
  /** 未满足的行（库存不足 / 无存放位置的货物单元），用于"无解 / 部分满足"状态语义。 */
  unfulfilled: Array<{ orderId: string; skuId: string; quantity: number; reason: string }>;
  stats: {
    orders: number;
    tasks: number;
    inbound: number;
    outbound: number;
    relocation: number;
    avgUnitsPerTask: number;
    /** 双指令可配对比例（同巷道同时段可配对的任务占比）。 */
    dualEligibleShare: number;
  };
}

/**
 * 把订单编译成设备任务。
 *
 * 关键点：
 *   - 订单行 → 具体货物单元（遵守 FIFO / FEFO 与批次），这一步决定了"任务真实映射"；
 *   - 波次合并：同一波次内同 SKU 的需求合并到一次搬运（降低任务数，但不改变总量）；
 *   - 未分配到库位的货物单元 → 入库任务；已被占用的库位 → 出库任务；
 *   - 任务 release 时刻取自订单释放时刻（预约出库则取窗口起点）。
 */
export function compileTasks(
  orders: readonly CustomerOrder[],
  inventory: readonly InventoryUnit[],
  opts: CompileTaskOptions,
): CompileResult {
  const bySku = new Map<string, InventoryUnit[]>();
  for (const unit of inventory) {
    const list = bySku.get(unit.skuId) ?? [];
    list.push(unit);
    bySku.set(unit.skuId, list);
  }
  const policy = opts.batchPolicy ?? 'fifo';
  for (const list of bySku.values()) {
    if (policy === 'fefo') {
      list.sort((a, b) => (a.expiresAt_s ?? Number.MAX_SAFE_INTEGER) - (b.expiresAt_s ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : 1));
    } else if (policy === 'fifo') {
      list.sort((a, b) => (a.inboundAt_s ?? 0) - (b.inboundAt_s ?? 0) || (a.id < b.id ? -1 : 1));
    }
  }

  const tasks: WarehouseTask[] = [];
  const unfulfilled: CompileResult['unfulfilled'] = [];
  const claimed = new Set<string>();
  let taskSeq = 0;
  let unitsPerTask = 0;
  let taskCount = 0;
  let inboundCount = 0;
  let outboundCount = 0;
  const waveSize = Math.max(1, opts.waveSize ?? 1);

  // 波次：按 release 排序后每 waveSize 条订单一批（相同 SKU 的货物单元可以在一个波次里连续取）
  const sorted = [...orders].sort((a, b) => (a.release_s !== b.release_s ? a.release_s - b.release_s : a.id < b.id ? -1 : 1));
  for (let w = 0; w < sorted.length; w += waveSize) {
    const wave = sorted.slice(w, w + waveSize);
    const waveStart = Math.min(...wave.map((o) => o.release_s));
    for (const order of wave) {
      const orderPriority = opts.priorityFromOrder ? opts.priorityFromOrder(order) : order.priority;
      const release_s = order.appointment ? Math.max(order.release_s, order.appointment[0]) : order.release_s;
      for (const line of order.lines) {
        let remaining = line.quantity;
        const candidates = (bySku.get(line.skuId) ?? []).filter((unit) => !claimed.has(unit.id) && unit.status !== 'damaged');
        if (candidates.length === 0) {
          unfulfilled.push({ orderId: order.id, skuId: line.skuId, quantity: line.quantity, reason: '库存中无可用的货物单元' });
          continue;
        }
        let perUnitIndex = 0;
        while (remaining > 0 && perUnitIndex < candidates.length) {
          const unit = candidates[perUnitIndex];
          perUnitIndex += 1;
          if (claimed.has(unit.id)) continue;
          claimed.add(unit.id);
          remaining -= unit.quantity;
          taskSeq += 1;
          taskCount += 1;
          unitsPerTask += 1;
          outboundCount += 1;
          tasks.push({
            id: `T-OUT-${String(taskSeq).padStart(7, '0')}`,
            kind: 'outbound',
            priority: orderPriority,
            release_s: round(release_s + (opts.releaseOffset_s ?? 0), 1),
            deadline_s: Math.round(order.due_s),
            fromLocationId: unit.locationId,
            fromNodeId: unit.locationId ? null : null,
            toLocationId: null,
            toNodeId: opts.outboundNodeId,
            loadUnitId: unit.id,
            skuId: unit.skuId,
            dependsOn: [],
            orderId: order.id,
            dualCommandEligible: true,
            cancellable: order.channel !== 'express',
          });
        }
        if (remaining > 0) {
          unfulfilled.push({
            orderId: order.id,
            skuId: line.skuId,
            quantity: remaining,
            reason: '库存货物单元不足（可用单元已全部被占用）',
          });
        }
      }
    }
    void waveStart;
  }

  // 入库任务：尚未上架的货物单元（收货区 → 库位）
  for (const unit of inventory) {
    if (claimed.has(unit.id)) continue;
    if (unit.locationId !== null) continue;
    taskSeq += 1;
    taskCount += 1;
    inboundCount += 1;
    unitsPerTask += 1;
    tasks.push({
      id: `T-IN-${String(taskSeq).padStart(7, '0')}`,
      kind: 'inbound',
      priority: unit.returned ? 3 : 5,
      release_s: Math.round(Math.max(0, unit.inboundAt_s ?? 0)),
      deadline_s: null,
      fromLocationId: null,
      fromNodeId: opts.inboundNodeId,
      toLocationId: null,
      toNodeId: null,
      loadUnitId: unit.id,
      skuId: unit.skuId,
      dependsOn: [],
      orderId: null,
      dualCommandEligible: true,
      cancellable: true,
    });
    claimed.add(unit.id);
  }

  const dualEligible = tasks.filter((t) => t.dualCommandEligible).length;
  return {
    tasks,
    unfulfilled,
    stats: {
      orders: orders.length,
      tasks: taskCount,
      inbound: inboundCount,
      outbound: outboundCount,
      relocation: 0,
      avgUnitsPerTask: round(unitsPerTask / Math.max(1, taskCount), 3),
      dualEligibleShare: round(dualEligible / Math.max(1, tasks.length), 4),
    },
  };
}

/** 生成移库任务（多深位取货的重定位 / 动态库位调整落地）。 */
export function relocationTask(
  seq: number,
  kind: TaskKind,
  loadUnitId: string,
  skuId: string,
  fromLocationId: string,
  toLocationId: string,
  at_s: number,
  reason: string,
  priority = 4,
): WarehouseTask {
  return {
    id: `T-${kind === 'restack' ? 'RS' : 'MV'}-${String(seq).padStart(7, '0')}`,
    kind,
    priority,
    release_s: round(at_s, 1),
    deadline_s: null,
    fromLocationId,
    fromNodeId: null,
    toLocationId,
    toNodeId: null,
    loadUnitId,
    skuId,
    dependsOn: [],
    orderId: null,
    dualCommandEligible: false,
    cancellable: true,
  };
  void reason;
}
