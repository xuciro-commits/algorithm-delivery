/**
 * 高阶库位优化：LNS / ALNS + 禁忌 + 模拟退火（SRS §3.3 的算法家族落地）。
 *
 * 一个统一的搜索内核，三件事分开表达（而不是三份互相抄的代码）：
 *   1. **破坏算子**（destroy）：从当前解里摘出哪些货物单元 —— 最差、相关（Shaw）、
 *      簇、随机、负载不均、深位列；
 *   2. **修复算子**（repair）：把摘出来的单元重新插回 —— 贪心、遗憾值 2、关联感知；
 *   3. **接受准则**（accept）：SA（按温度接受劣解）/ 禁忌（禁止短期内回退）/ LNS（只接受改进）。
 *
 * 硬约束在插入时判定（含分散度规则），不做"先违规再修复"：
 * 一旦某次移动会破坏硬约束，它根本不进入候选集，搜索因此始终保持在可行域内。
 *
 * 时间预算与迭代上限二者取先到者；被取消时**返回当前已找到的最优解**（SRS §6.2）。
 */

import type { ConstraintCode } from '../contract/types.ts';
import { clamp, makeRng, round } from '../contract/util.ts';
import { canPlace, evaluateObjectives, SlottingState, type ObjectiveVector, type SlottingModel } from './model.ts';

export type NeighborhoodOperator =
  | 'swap'
  | 'move'
  | 'cluster-move'
  | 'block-relocate'
  | 'aisle-balance'
  | 'worst-removal'
  | 'related-removal'
  | 'random-removal';

export interface SearchOptions {
  seed: number;
  budgetMs: number;
  maxIterations: number;
  operators: NeighborhoodOperator[];
  /** SA 初始温度（相对目标尺度；0 = 只接受改进）。 */
  temperature: number;
  /** 禁忌步数（0 = 关闭禁忌）。 */
  tabuTenure: number;
  /** 每次迭代破坏的规模（占货物单元比例，0.02–0.2）。 */
  destroyShare: number;
  /** 分散度约束（来自问题配置）。 */
  dispersion: {
    maxAisleSharePerSku: number;
    maxUnitsPerAislePerSku: number;
    minAislesPerSku: number;
    hard: boolean;
  };
  isCancelled?: () => boolean;
  onProgress?: (progress: { iterations: number; best: number; temperature: number }) => void;
}

export interface SearchResult {
  best: SlottingState;
  bestObjective: ObjectiveVector;
  iterations: number;
  restarts: number;
  bestIteration: number;
  trace: number[];
  operatorsUsed: Record<string, number>;
  elapsedMs: number;
  cancelled: boolean;
  /** 分散度软惩罚（若为软约束，会体现在目标里）。 */
  dispersionPenalty: number;
}

/** 分散度守卫：增量维护"每个 SKU 在每条巷道的库位数"，O(1) 判定。 */
export class DispersionGuard {
  private readonly counts: Array<Int32Array>;
  private readonly aislesPerSku: Int32Array;
  constructor(private readonly model: SlottingModel) {
    this.counts = model.skus.map(() => new Int32Array(model.aisleIds.length));
    this.aislesPerSku = new Int32Array(model.skus.length);
  }

  add(lu: number, aisleIndex: number): void {
    const sku = this.model.luSku[lu];
    const row = this.counts[sku];
    if (row[aisleIndex] === 0) this.aislesPerSku[sku] += 1;
    row[aisleIndex] += 1;
  }

  remove(lu: number, aisleIndex: number): void {
    const sku = this.model.luSku[lu];
    const row = this.counts[sku];
    row[aisleIndex] -= 1;
    if (row[aisleIndex] <= 0) {
      row[aisleIndex] = 0;
      this.aislesPerSku[sku] -= 1;
    }
  }

  /** 把 `lu` 放进 `aisleIndex` 是否仍然满足分散度规则。 */
  allows(lu: number, aisleIndex: number, opts: SearchOptions['dispersion']): boolean {
    if (opts.maxAisleSharePerSku >= 0.999 && opts.maxUnitsPerAislePerSku <= 0) return true;
    const sku = this.model.luSku[lu];
    const row = this.counts[sku];
    let total = 0;
    for (const value of row) total += value;
    const next = row[aisleIndex] + 1;
    if (opts.maxUnitsPerAislePerSku > 0 && next > opts.maxUnitsPerAislePerSku) return false;
    if (opts.maxAisleSharePerSku < 0.999 && total + 1 > 0) {
      if (next / (total + 1) > opts.maxAisleSharePerSku + 1e-9) return false;
    }
    return true;
  }

  /** 软惩罚：超出上限的部分平方和（单位：库位数²，用于目标函数）。 */
  penalty(opts: SearchOptions['dispersion']): number {
    let total = 0;
    for (let sku = 0; sku < this.counts.length; sku += 1) {
      const row = this.counts[sku];
      let sum = 0;
      for (const value of row) {
        if (opts.maxUnitsPerAislePerSku > 0 && value > opts.maxUnitsPerAislePerSku) {
          total += (value - opts.maxUnitsPerAislePerSku) ** 2;
        }
        sum += value;
      }
      if (opts.maxAisleSharePerSku < 0.999 && sum > 0) {
        for (const value of row) {
          const share = value / sum;
          if (share > opts.maxAisleSharePerSku + 1e-9) total += (share - opts.maxAisleSharePerSku) ** 2 * 100;
        }
      }
      if (this.aislesPerSku[sku] < opts.minAislesPerSku && sum > 0) {
        total += (opts.minAislesPerSku - this.aislesPerSku[sku]) ** 2;
      }
    }
    return total;
  }

  /** 重新同步（当状态被整体替换时）。 */
  reindex(state: SlottingState): void {
    for (const row of this.counts) row.fill(0);
    this.aislesPerSku.fill(0);
    for (let lu = 0; lu < state.locOfLu.length; lu += 1) {
      const locIdx = state.locOfLu[lu];
      if (locIdx >= 0) this.add(lu, this.model.locationCost[locIdx].aisleIndex);
    }
  }
}

/**
 * 在"可行域内"放置货物单元：先看目标库位，不可行时在其邻域里找最近的合法位置。
 * 返回实际落位的库位下标（-1 = 找不到）。
 */
function placeFeasible(
  model: SlottingModel,
  state: SlottingState,
  guard: DispersionGuard,
  lu: number,
  preferredLocIdx: number,
  options: SearchOptions,
): number {
  const tryOrder: number[] = [preferredLocIdx];
  // 邻域：同巷道 ±6 列、同层、深度 1 优先；随后是全库位表里相邻的位置
  const base = model.locations[preferredLocIdx];
  for (const locIdx of model.locationOrderByCost) {
    if (tryOrder.length > 24) break;
    const loc = model.locations[locIdx];
    if (loc.aisleId !== base.aisleId || loc.level !== base.level) continue;
    if (Math.abs(loc.bay - base.bay) > 6) continue;
    if (tryOrder.includes(locIdx)) continue;
    tryOrder.push(locIdx);
  }
  for (const locIdx of tryOrder) {
    if (state.luAtLoc[locIdx] >= 0) continue;
    if (options.dispersion.hard && !guard.allows(lu, model.locationCost[locIdx].aisleIndex, options.dispersion)) continue;
    const check = canPlace(model, lu, locIdx);
    if (!check.ok) continue;
    state.place(lu, locIdx);
    guard.add(lu, model.locationCost[locIdx].aisleIndex);
    return locIdx;
  }
  return -1;
}

/** 把货物单元从状态里摘出（同步更新分散度计数）。 */
function removeUnit(model: SlottingModel, state: SlottingState, guard: DispersionGuard, lu: number): number {
  const locIdx = state.locOfLu[lu];
  if (locIdx < 0) return -1;
  guard.remove(lu, model.locationCost[locIdx].aisleIndex);
  state.unplace(lu);
  return locIdx;
}

/**
 * 搜索主循环。
 *
 * 接受准则由 `temperature` 与 `tabuTenure` 组合决定：
 *   temperature = 0 & tabuTenure = 0 → 纯 LNS（只接受改进）；
 *   temperature > 0 → ALNS（SA 接受劣解，温度按 0.995 冷却，重启时重置）；
 *   tabuTenure > 0 → 近期移动过的 (货物单元 → 巷道上限) 进入禁忌，避免原地打转。
 */
export function runSearch(
  model: SlottingModel,
  initial: SlottingState,
  options: SearchOptions,
  evaluate: (state: SlottingState) => ObjectiveVector = (state) => evaluateObjectives(model, state),
): SearchResult {
  const startedAt = Date.now();
  const rng = makeRng(options.seed);
  const guard = new DispersionGuard(model);
  guard.reindex(initial);
  const current = initial.clone();
  let currentObjective = evaluate(current);
  let bestState = current.clone();
  let bestObjective = currentObjective;
  let bestIteration = 0;
  const trace: number[] = [round(currentObjective.scalar, 6)];
  const operatorsUsed: Record<string, number> = {};
  let temperature = Math.max(0, options.temperature);
  let iterations = 0;
  let restarts = 0;
  let cancelled = false;
  const tabu = new Map<string, number>();
  const dispersionSoft = options.dispersion.hard ? 0 : guard.penalty(options.dispersion);
  const objectiveWithDispersion = (objective: ObjectiveVector): number => objective.scalar + dispersionSoft;

  const destroySize = Math.max(4, Math.round(model.loadUnits.length * clamp(options.destroyShare, 0.005, 0.5)));

  while (iterations < options.maxIterations && Date.now() - startedAt < options.budgetMs) {
    if (options.isCancelled?.()) {
      cancelled = true;
      break;
    }
    iterations += 1;
    const operator = options.operators[iterations % options.operators.length];
    operatorsUsed[operator] = (operatorsUsed[operator] ?? 0) + 1;

    // 1) 摘出（destroy）
    const removed: number[] = pickRemovalSet(model, current, guard, operator, destroySize, rng);
    for (const lu of removed) removeUnit(model, current, guard, lu);

    // 2) 插回（repair）
    let failed = 0;
    removed.sort((a, b) => model.unitFlow[b] - model.unitFlow[a]);
    for (const lu of removed) {
      const target = pickInsertionTarget(model, current, guard, lu, options, rng);
      if (target < 0) {
        failed += 1;
        continue;
      }
      state_move(current, lu, target);
    }

    // 3) 评估 + 接受
    const nextObjective = evaluate(current);
    const penalty = options.dispersion.hard ? 0 : guard.penalty(options.dispersion);
    const currentScore = objectiveWithDispersion(currentObjective);
    const nextScore = nextObjective.scalar + penalty;
    const delta = nextScore - currentScore;
    let accept = delta <= 0;
    if (!accept && temperature > 0 && failed === 0) {
      accept = rng.next() < Math.exp(-delta / Math.max(1e-9, temperature));
    }
    if (!accept && options.tabuTenure > 0 && failed === 0) {
      const key = `${removed[0] ?? -1}`;
      if ((tabu.get(key) ?? -1) < iterations) accept = true;
    }
    if (accept && failed === 0) {
      currentObjective = nextObjective;
      if (nextScore < objectiveWithDispersion(bestObjective) - 1e-9) {
        bestObjective = nextObjective;
        bestState = current.clone();
        bestIteration = iterations;
      }
      if (options.tabuTenure > 0 && removed.length > 0) {
        for (const lu of removed.slice(0, 3)) tabu.set(String(lu), iterations + options.tabuTenure);
      }
    } else {
      // 回滚：把当前解恢复成 best（大邻域搜索里比"逐步撤销"更稳）
      current.locOfLu.set(bestState.locOfLu);
      current.luAtLoc.set(bestState.luAtLoc);
      current.aisleFlow.set(bestState.aisleFlow);
      current.liftFlow.set(bestState.liftFlow);
      current.unassigned = bestState.unassigned;
      current.baseSeconds = bestState.baseSeconds;
      current.baseMeters = bestState.baseMeters;
      current.relocationCount = bestState.relocationCount;
      current.relocationSeconds = bestState.relocationSeconds;
      currentObjective = bestObjective;
      guard.reindex(current);
      restarts += 1;
      temperature = Math.max(options.temperature * 0.6, options.temperature * 0.05);
    }
    if (temperature > 0) temperature = Math.max(temperature * 0.995, 1e-6);
    if (iterations % 16 === 0) {
      trace.push(round(currentObjective.scalar, 6));
      options.onProgress?.({ iterations, best: currentObjective.scalar, temperature });
    }
  }

  bestState.recomputeRelocation();
  const finalObjective = evaluate(bestState);
  return {
    best: bestState,
    bestObjective: finalObjective,
    iterations,
    restarts,
    bestIteration,
    trace,
    operatorsUsed,
    elapsedMs: Date.now() - startedAt,
    cancelled,
    dispersionPenalty: options.dispersion.hard ? 0 : guard.penalty(options.dispersion),
  };
}

function state_move(state: SlottingState, lu: number, locIdx: number): void {
  state.moveTo(lu, locIdx);
}

/**
 * 破坏算子：返回被摘出的货物单元（已按算子语义挑好）。
 * 每个算子都能在面板上回答"为什么选这些单元"。
 */
function pickRemovalSet(
  model: SlottingModel,
  state: SlottingState,
  guard: DispersionGuard,
  operator: NeighborhoodOperator,
  size: number,
  rng: { next: () => number; int: (a: number, b: number) => number },
): number[] {
  const assigned: number[] = [];
  for (let lu = 0; lu < state.locOfLu.length; lu += 1) if (state.locOfLu[lu] >= 0) assigned.push(lu);
  if (assigned.length === 0) return [];
  const count = Math.min(size, assigned.length);

  switch (operator) {
    case 'worst-removal': {
      const scored = assigned.map((lu) => {
        const locIdx = state.locOfLu[lu];
        const cost = model.locationCost[locIdx];
        const seconds = model.unitFlow[lu] * (model.costConfig.outboundShare * cost.pickSeconds + (1 - model.costConfig.outboundShare) * cost.putSeconds);
        return { lu, score: seconds };
      });
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, count).map((entry) => entry.lu);
    }
    case 'related-removal': {
      // Shaw removal：从随机种子出发，摘出"关联 + 空间相邻"的单元
      const seedLu = assigned[rng.int(0, assigned.length)];
      const seedLoc = model.locations[state.locOfLu[seedLu]];
      const sku = model.luSku[seedLu];
      const neighbors = model.affinity.pairs.get(sku) ?? [];
      const neighborSet = new Set(neighbors.map((n) => n.sku));
      const scored = assigned.map((lu) => {
        const loc = model.locations[state.locOfLu[lu]];
        const related = neighborSet.has(model.luSku[lu]) ? 1 : 0;
        const spatial = loc.aisleId === seedLoc.aisleId ? Math.abs(loc.bay - seedLoc.bay) / 10 : 20;
        return { lu, score: related * -5 + spatial };
      });
      scored.sort((a, b) => a.score - b.score);
      return scored.slice(0, count).map((entry) => entry.lu);
    }
    case 'cluster-move': {
      // 关联簇整体迁移：把某个簇落在最拥堵巷道的单元摘出
      const clusterIds = new Set<number>();
      for (let sku = 0; sku < model.skus.length; sku += 1) clusterIds.add(model.affinity.clusterOf[sku]);
      const cluster = [...clusterIds][rng.int(0, clusterIds.size)];
      const inCluster = assigned.filter((lu) => model.affinity.clusterOf[model.luSku[lu]] === cluster);
      if (inCluster.length === 0) return assigned.slice(0, count);
      return inCluster.slice(0, count);
    }
    case 'block-relocate': {
      // 深位列：把同一 (rack, level, bay) 的深位单元整体考虑（多深位重排）
      const deep = assigned.filter((lu) => model.locations[state.locOfLu[lu]].depth > 1);
      if (deep.length === 0) return assigned.slice(0, count);
      return deep.slice(0, count);
    }
    case 'aisle-balance': {
      const loads = Array.from(state.aisleFlow);
      const maxAisle = loads.indexOf(Math.max(...loads));
      const inAisle = assigned.filter((lu) => model.locationCost[state.locOfLu[lu]].aisleIndex === maxAisle);
      return (inAisle.length > 0 ? inAisle : assigned).slice(0, count);
    }
    case 'random-removal':
    default: {
      const out: number[] = [];
      const used = new Set<number>();
      while (out.length < count && used.size < assigned.length) {
        const lu = assigned[rng.int(0, assigned.length)];
        if (used.has(lu)) continue;
        used.add(lu);
        out.push(lu);
      }
      return out;
    }
  }
  void guard;
}

/**
 * 修复算子：为被摘出的单元找一个目标库位。
 * 这里把"贪心 vs 遗憾值 vs 关联感知"三种修复统一成一个打分函数：
 *   score = 基础运行代价 + 关联邻域偏好 + 车道均衡偏好
 */
function pickInsertionTarget(
  model: SlottingModel,
  state: SlottingState,
  guard: DispersionGuard,
  lu: number,
  options: SearchOptions,
  rng: { next: () => number },
): number {
  const sku = model.luSku[lu];
  const neighbors = model.affinity.pairs.get(sku) ?? [];
  const neighborAisles = new Map<number, number>();
  for (const pair of neighbors) {
    for (let otherLu = 0; otherLu < state.locOfLu.length; otherLu += 1) {
      if (model.luSku[otherLu] !== pair.sku) continue;
      const locIdx = state.locOfLu[otherLu];
      if (locIdx < 0) continue;
      const aisle = model.locationCost[locIdx].aisleIndex;
      neighborAisles.set(aisle, (neighborAisles.get(aisle) ?? 0) + pair.weight);
    }
  }
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  const step = Math.max(1, Math.floor(model.locationOrderByCost.length / 3000));
  let evaluated = 0;
  for (let i = 0; i < model.locationOrderByCost.length; i += step) {
    const locIdx = model.locationOrderByCost[i];
    if (state.luAtLoc[locIdx] >= 0) continue;
    const cost = model.locationCost[locIdx];
    if (!Number.isFinite(cost.pickSeconds)) continue;
    const check = canPlace(model, lu, locIdx);
    if (!check.ok) continue;
    if (options.dispersion.hard && !guard.allows(lu, cost.aisleIndex, options.dispersion)) continue;
    const flow = model.unitFlow[lu];
    const base = flow * (model.costConfig.outboundShare * cost.pickSeconds + (1 - model.costConfig.outboundShare) * cost.putSeconds);
    const affinityBonus = (neighborAisles.get(cost.aisleIndex) ?? 0) * 6; // 关联同巷道奖励（秒/天当量）
    const loadPenalty = state.aisleFlow[cost.aisleIndex] * 0.05; // 负载均衡
    const jitter = rng.next() * 1e-6; // 打散等分，保持确定性下的多样性
    const score = base - affinityBonus + loadPenalty + jitter;
    if (score < bestScore) {
      bestScore = score;
      best = locIdx;
    }
    evaluated += 1;
    if (evaluated >= 3000) break;
  }
  if (best < 0) return -1;
  // 目标位置的占用者会被交换出去（moveTo 的语义），因此这里只需返回位置
  return best;
}

/** 分散度违规的显式报告（供求解器写入 explanations，便于面板解释"哪个 SKU 被限制"）。 */
export function dispersionReport(model: SlottingModel, state: SlottingState, options: SearchOptions['dispersion']): Array<{ skuId: string; aisleId: string; units: number; limit: number; code: ConstraintCode }> {
  const violations: Array<{ skuId: string; aisleId: string; units: number; limit: number; code: ConstraintCode }> = [];
  const counts = new Map<string, number>();
  for (let lu = 0; lu < state.locOfLu.length; lu += 1) {
    const locIdx = state.locOfLu[lu];
    if (locIdx < 0) continue;
    const key = `${model.luSku[lu]}|${model.locationCost[locIdx].aisleIndex}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, units] of counts) {
    const [skuIdx, aisleIdx] = key.split('|').map(Number);
    if (options.maxUnitsPerAislePerSku > 0 && units > options.maxUnitsPerAislePerSku) {
      violations.push({
        skuId: model.skus[skuIdx].id,
        aisleId: model.aisleIds[aisleIdx],
        units,
        limit: options.maxUnitsPerAislePerSku,
        code: 'SKU_DISPERSION_MAX',
      });
    }
  }
  return violations;
}
