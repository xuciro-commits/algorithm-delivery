/**
 * 多目标库位优化（NSGA-II）与不确定需求下的鲁棒优化（SRS §3.2C / §3.2D）。
 *
 * 两个必须守住的语义：
 *   1. **不输出一个不透明的综合分数**：这里返回的是**非支配解集**（Pareto 前沿），
 *      每个点都带各目标的原始值与单位；权重只用于搜索导向，不用于对外宣称"最优"；
 *   2. **不假设未来订单完全已知**：鲁棒优化在多个需求实现（场景）上评估方案，
 *      支持 mean / CVaR / minimax 三种风险度量，并给出"方案在不同需求下的稳定性"。
 */

import type { InventoryUnit, SkuSpec, ParetoPoint } from '../contract/types.ts';
import { cvar, makeRng, mean, round, seedFrom, stddev } from '../contract/util.ts';
import { canPlace, evaluateObjectives, SlottingState, type ObjectiveVector, type SlottingModel } from './model.ts';
import { runSearch, type SearchOptions } from './optimize.ts';

export interface ParetoObjective {
  id: string;
  direction: 'min' | 'max';
  unit: string;
}

/** NSGA-II 使用的核心目标集（与问题声明的 objectives 取交集，保证口径一致）。 */
export const CORE_PARETO_OBJECTIVES: ParetoObjective[] = [
  { id: 'expected-travel-time', direction: 'min', unit: '秒/天' },
  { id: 'space-utilization', direction: 'max', unit: '比例' },
  { id: 'relocation-cost', direction: 'min', unit: '设备秒' },
  { id: 'congestion', direction: 'min', unit: '秒/天' },
  { id: 'load-balance', direction: 'min', unit: '基尼' },
];

export interface MultiObjectiveOptions {
  populationSize: number;
  generations: number;
  seed: number;
  budgetMs: number;
  objectives: ParetoObjective[];
  /** 是否允许未分配（容量不足场景会用到）。 */
  allowUnassigned: boolean;
  isCancelled?: () => boolean;
}

export interface ParetoSolution {
  assignment: Int32Array;
  values: Record<string, number>;
  /** 拥挤度（越大越分散，用于在等价方案之间保留多样性）。 */
  crowding: number;
  rank: number;
  fingerprint: string;
  origin: string;
}

export interface MultiObjectiveResult {
  front: ParetoSolution[];
  points: ParetoPoint[];
  generations: number;
  evaluations: number;
  elapsedMs: number;
  cancelled: boolean;
  /** 极端点：每个目标单独最优（用于展示取舍区间）。 */
  extremes: Record<string, { value: number; fingerprint: string }>;
}

/** 目标向量（方向已统一为"越小越好"）。 */
function vectorOf(model: SlottingModel, state: SlottingState, objectives: readonly ParetoObjective[]): { raw: Record<string, number>; normalized: number[] } {
  const evaluated = evaluateObjectives(model, state);
  const raw: Record<string, number> = {};
  const normalized: number[] = [];
  for (const objective of objectives) {
    const value = evaluated.values[objective.id] ?? 0;
    raw[objective.id] = value;
    const scale = objectiveScale(objective.id);
    const signed = objective.direction === 'min' ? value / scale : -value / scale;
    normalized.push(signed);
  }
  return { raw, normalized };
}

function objectiveScale(id: string): number {
  switch (id) {
    case 'expected-travel-time':
      return 100000;
    case 'space-utilization':
      return 1;
    case 'relocation-cost':
      return 100000;
    case 'congestion':
      return 10000;
    case 'load-balance':
      return 0.5;
    case 'device-travel-distance':
      return 500000;
    case 'energy':
      return 2000;
    default:
      return 1;
  }
}

/** 支配关系：a dominates b（全部不劣，且至少一个更优）。 */
function dominates(a: number[], b: number[]): boolean {
  let better = false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] > b[i] + 1e-9) return false;
    if (a[i] < b[i] - 1e-9) better = true;
  }
  return better;
}

/** 快速非支配排序（返回每个个体所在的层级）。 */
function nonDominatedSort(vectors: number[][]): { ranks: number[]; fronts: number[][] } {
  const n = vectors.length;
  const ranks = new Array(n).fill(0);
  const dominationCount = new Array(n).fill(0);
  const dominated: number[][] = Array.from({ length: n }, () => []);
  const fronts: number[][] = [[]];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (dominates(vectors[i], vectors[j])) {
        dominated[i].push(j);
        dominationCount[j] += 1;
      } else if (dominates(vectors[j], vectors[i])) {
        dominated[j].push(i);
        dominationCount[i] += 1;
      }
    }
    if (dominationCount[i] === 0) {
      ranks[i] = 0;
      fronts[0].push(i);
    }
  }
  let index = 0;
  while (fronts[index] && fronts[index].length > 0) {
    const next: number[] = [];
    for (const i of fronts[index]) {
      for (const j of dominated[i]) {
        dominationCount[j] -= 1;
        if (dominationCount[j] === 0) {
          ranks[j] = index + 1;
          next.push(j);
        }
      }
    }
    index += 1;
    if (next.length > 0) fronts.push(next);
  }
  return { ranks, fronts };
}

/** 拥挤度距离（同一前沿内按每个目标排序后累加）。 */
function crowdingDistance(front: number[], vectors: number[][]): Map<number, number> {
  const distances = new Map<number, number>();
  for (const i of front) distances.set(i, 0);
  if (front.length === 0) return distances;
  const dims = vectors[front[0]].length;
  for (let d = 0; d < dims; d += 1) {
    const sorted = [...front].sort((a, b) => vectors[a][d] - vectors[b][d]);
    distances.set(sorted[0], Number.POSITIVE_INFINITY);
    distances.set(sorted[sorted.length - 1], Number.POSITIVE_INFINITY);
    const span = vectors[sorted[sorted.length - 1]][d] - vectors[sorted[0]][d];
    if (span <= 1e-12) continue;
    for (let k = 1; k < sorted.length - 1; k += 1) {
      const value = (distances.get(sorted[k]) ?? 0) + (vectors[sorted[k + 1]][d] - vectors[sorted[k - 1]][d]) / span;
      distances.set(sorted[k], value);
    }
  }
  return distances;
}

/** 交叉：按库位归属从两个父代各取一部分（保持"每个库位一个货物单元"的结构）。 */
function crossover(model: SlottingModel, a: Int32Array, b: Int32Array, rngSeed: number): Int32Array {
  const rng = makeRng(seedFrom('crossover', rngSeed));
  const child = new Int32Array(model.loadUnits.length).fill(-1);
  const occupancy = new Uint8Array(model.locations.length);
  for (let lu = 0; lu < a.length; lu += 1) {
    const preferA = rng.next() < 0.5;
    const first = preferA ? a[lu] : b[lu];
    const second = preferA ? b[lu] : a[lu];
    for (const candidate of [first, second]) {
      if (candidate < 0 || occupancy[candidate] === 1) continue;
      if (!canPlace(model, lu, candidate).ok) continue;
      child[lu] = candidate;
      occupancy[candidate] = 1;
      break;
    }
  }
  return child;
}

/** 变异：对若干货物单元做随机重定位（可行域内）。 */
function mutate(model: SlottingModel, assignment: Int32Array, rngSeed: number, strength: number): Int32Array {
  const rng = makeRng(seedFrom('mutate', rngSeed));
  const next = Int32Array.from(assignment);
  const occupancy = new Uint8Array(model.locations.length);
  for (let lu = 0; lu < next.length; lu += 1) if (next[lu] >= 0) occupancy[next[lu]] = 1;
  const mutations = Math.max(1, Math.round(next.length * strength));
  for (let k = 0; k < mutations; k += 1) {
    const lu = rng.int(0, next.length);
    const locIdx = model.locationOrderByCost[rng.int(0, model.locationOrderByCost.length)];
    if (occupancy[locIdx] === 1) continue;
    if (!canPlace(model, lu, locIdx).ok) continue;
    if (next[lu] >= 0) occupancy[next[lu]] = 0;
    next[lu] = locIdx;
    occupancy[locIdx] = 1;
  }
  return next;
}

/**
 * NSGA-II 主循环。
 *
 * 初始种群不只用随机解：每种基础策略各给一个个体，再加上若干 ALNS 短跑解，
 * 这样前沿的**下界**有对照、**上界**有真实优化能力（而不是"全是随机解在比较"）。
 */
export function runMultiObjective(
  model: SlottingModel,
  seedAssignments: Array<{ assignment: Int32Array; origin: string }>,
  options: MultiObjectiveOptions,
): MultiObjectiveResult {
  const startedAt = Date.now();
  const rng = makeRng(seedFrom('nsga2', options.seed));
  const objectives = options.objectives.length > 0 ? options.objectives : CORE_PARETO_OBJECTIVES;
  let evaluations = 0;
  const evaluateAssignment = (assignment: Int32Array): { raw: Record<string, number>; normalized: number[] } => {
    const state = SlottingState.rebuild(model, assignment);
    evaluations += 1;
    const vector = vectorOf(model, state, objectives);
    // 未分配惩罚（容量不足场景允许，但必须在目标里体现）
    if (!options.allowUnassigned && state.unassigned > 0) {
      vector.normalized = vector.normalized.map((v) => v + state.unassigned * 0.5);
      vector.raw['unassigned'] = state.unassigned;
    }
    return vector;
  };

  interface Individual {
    assignment: Int32Array;
    raw: Record<string, number>;
    normalized: number[];
    origin: string;
    rank: number;
    crowding: number;
  }

  const population: Individual[] = [];
  const push = (assignment: Int32Array, origin: string) => {
    const vector = evaluateAssignment(assignment);
    population.push({ assignment, raw: vector.raw, normalized: vector.normalized, origin, rank: 0, crowding: 0 });
  };
  for (const seedEntry of seedAssignments.slice(0, Math.max(1, options.populationSize))) {
    push(seedEntry.assignment, seedEntry.origin);
  }
  while (population.length < Math.max(4, options.populationSize)) {
    // 随机解：按偏好分带抖动地放置
    const assignment = new Int32Array(model.loadUnits.length).fill(-1);
    const occupancy = new Uint8Array(model.locations.length);
    for (let lu = 0; lu < assignment.length; lu += 1) {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const window = Math.min(model.locationOrderByCost.length, 64 + attempt * 256);
        const locIdx = model.locationOrderByCost[rng.int(0, Math.max(1, window))];
        if (locIdx === undefined || occupancy[locIdx] === 1) continue;
        if (!canPlace(model, lu, locIdx).ok) continue;
        assignment[lu] = locIdx;
        occupancy[locIdx] = 1;
        break;
      }
    }
    push(assignment, 'random-seed');
  }

  let generations = 0;
  let cancelled = false;
  for (let gen = 0; gen < options.generations; gen += 1) {
    if (options.isCancelled?.() || Date.now() - startedAt > options.budgetMs) {
      cancelled = options.isCancelled?.() ?? false;
      break;
    }
    generations += 1;
    const vectors = population.map((individual) => individual.normalized);
    const { ranks, fronts } = nonDominatedSort(vectors);
    for (let i = 0; i < population.length; i += 1) population[i].rank = ranks[i];
    for (const front of fronts) {
      const distances = crowdingDistance(front, vectors);
      for (const index of front) population[index].crowding = distances.get(index) ?? 0;
    }
    // 选择（锦标赛：rank 优先，其次拥挤度）
    const pick = (): Individual => {
      const a = population[rng.int(0, population.length)];
      const b = population[rng.int(0, population.length)];
      if (a.rank !== b.rank) return a.rank < b.rank ? a : b;
      return (a.crowding ?? 0) >= (b.crowding ?? 0) ? a : b;
    };
    const offspring: Individual[] = [];
    while (offspring.length < options.populationSize) {
      const parentA = pick().assignment;
      const parentB = pick().assignment;
      const child = crossover(model, parentA, parentB, rng.int(0, 1e9));
      const mutated = mutate(model, child, rng.int(0, 1e9), 0.05);
      const vector = evaluateAssignment(mutated);
      offspring.push({ assignment: mutated, raw: vector.raw, normalized: vector.normalized, origin: 'nsga2-offspring', rank: 0, crowding: 0 });
    }
    const combined = [...population, ...offspring];
    const combinedVectors = combined.map((individual) => individual.normalized);
    const sorted = nonDominatedSort(combinedVectors);
    const next: Individual[] = [];
    for (const front of sorted.fronts) {
      if (next.length + front.length <= options.populationSize) {
        for (const index of front) next.push(combined[index]);
      } else {
        const distances = crowdingDistance(front, combinedVectors);
        const sortedFront = [...front].sort((a, b) => (distances.get(b) ?? 0) - (distances.get(a) ?? 0));
        for (const index of sortedFront) {
          if (next.length >= options.populationSize) break;
          next.push(combined[index]);
        }
        break;
      }
    }
    population.length = 0;
    population.push(...next);
  }

  // 前沿：rank = 0 的非支配解
  const finalVectors = population.map((individual) => individual.normalized);
  const finalSorted = nonDominatedSort(finalVectors);
  const frontIndices = finalSorted.fronts[0] ?? [];
  const distinct = new Map<string, ParetoSolution>();
  for (const index of frontIndices) {
    const individual = population[index];
    const fingerprint = fingerprintOf(individual.raw);
    if (distinct.has(fingerprint)) continue;
    distinct.set(fingerprint, {
      assignment: individual.assignment,
      values: individual.raw,
      crowding: individual.crowding,
      rank: individual.rank,
      fingerprint,
      origin: individual.origin,
    });
  }
  const front = [...distinct.values()].sort((a, b) => (b.crowding ?? 0) - (a.crowding ?? 0));
  const extremes: Record<string, { value: number; fingerprint: string }> = {};
  for (const objective of objectives) {
    let bestId: string | null = null;
    let bestValue = objective.direction === 'min' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    for (const solution of front) {
      const value = solution.values[objective.id] ?? 0;
      const better = objective.direction === 'min' ? value < bestValue : value > bestValue;
      if (better) {
        bestValue = value;
        bestId = solution.fingerprint;
      }
    }
    if (bestId) extremes[objective.id] = { value: round(bestValue, 4), fingerprint: bestId };
  }

  return {
    front,
    points: front.map((solution) => ({
      id: solution.fingerprint.slice(0, 12),
      values: solution.values,
      fingerprint: solution.fingerprint,
      algorithm: solution.origin,
    })),
    generations,
    evaluations,
    elapsedMs: Date.now() - startedAt,
    cancelled,
    extremes,
  };
}

function fingerprintOf(values: Record<string, number>): string {
  return Object.keys(values)
    .sort()
    .map((key) => `${key}=${round(values[key], 4)}`)
    .join('|');
}

/* ------------------------------------------------------------------ *
 * 鲁棒优化（不确定需求）
 * ------------------------------------------------------------------ */

export interface RobustOptions {
  scenarios: number;
  measure: 'mean' | 'cvar' | 'minimax';
  cvarAlpha: number;
  /** 需求波动强度（相对 SKU 日需求的标准差倍数）。 */
  volatility: number;
  /** 需求结构突变的场景比例（例如促销后结构变化）。 */
  shiftShare: number;
  seed: number;
  budgetMs: number;
  search: SearchOptions;
  isCancelled?: () => boolean;
}

export interface RobustResult {
  best: SlottingState;
  /** 每个场景下的目标值（秒/天）。 */
  scenarioValues: number[];
  mean: number;
  worst: number;
  cvarValue: number;
  /** 方案稳定性：场景间标准差 / 均值（越小越稳）。 */
  stability: number;
  search: ReturnType<typeof runSearch>;
  scenarios: Array<{ id: string; skuWeights: Float64Array; note: string }>;
}

/**
 * 构造需求实现（场景）。
 *
 * 每个场景只改变**流量权重**（需求大小与结构），不改变仓库几何 —— 这正是真实的不确定性：
 * 我们不知道未来会卖多少，但库位结构是确定的。
 */
export function buildDemandScenarios(
  skus: readonly SkuSpec[],
  inventory: readonly InventoryUnit[],
  baseUnitFlow: Float64Array,
  options: Pick<RobustOptions, 'scenarios' | 'volatility' | 'shiftShare' | 'seed'>,
): RobustResult['scenarios'] {
  const rng = makeRng(seedFrom('robust-scenarios', options.seed, options.scenarios));
  const scenarios: RobustResult['scenarios'] = [];
  const skuIndex = new Map(skus.map((s, i) => [s.id, i]));
  for (let s = 0; s < Math.max(1, options.scenarios); s += 1) {
    const weights = Float64Array.from(baseUnitFlow);
    const shift = rng.next() < options.shiftShare;
    for (let lu = 0; lu < inventory.length; lu += 1) {
      const skuIdx = skuIndex.get(inventory[lu].skuId) ?? 0;
      const sku = skus[skuIdx];
      const sigma = options.volatility * Math.max(0.05, sku.demandCv);
      let factor = Math.max(0.05, 1 + rng.normal() * sigma);
      if (shift) {
        // 结构突变：热门商品的需求被"重新排序"（例如促销期间换品）
        const reshuffle = 1 + 0.9 * Math.sin((skuIdx + s) * 0.7);
        factor *= Math.max(0.2, reshuffle);
      }
      weights[lu] = baseUnitFlow[lu] * factor;
    }
    scenarios.push({
      id: `SC-${String(s + 1).padStart(2, '0')}`,
      skuWeights: weights,
      note: shift ? '需求结构突变（促销 / 换品）' : '需求水平波动',
    });
  }
  return scenarios;
}

/** 在给定场景权重下评估某个解的总运行时间（秒/天）。 */
function scenarioSeconds(model: SlottingModel, state: SlottingState, weights: Float64Array): number {
  let total = 0;
  for (let lu = 0; lu < state.locOfLu.length; lu += 1) {
    const locIdx = state.locOfLu[lu];
    if (locIdx < 0) continue;
    const cost = model.locationCost[locIdx];
    total += weights[lu] * (model.costConfig.outboundShare * cost.pickSeconds + (1 - model.costConfig.outboundShare) * cost.putSeconds);
  }
  return total;
}

/**
 * 鲁棒优化：在多个需求实现上优化风险度量。
 *
 * 搜索用 ALNS 内核，但评估函数替换为"场景集的 mean / CVaR / minimax"，
 * 因此得到的是**对需求不确定性稳健**的库位方案，而不是对单一预测最优的方案。
 */
export function runRobust(model: SlottingModel, initial: SlottingState, options: RobustOptions): RobustResult {
  const scenarios = buildDemandScenarios(model.skus, model.loadUnits, model.unitFlow, options);
  const evaluate = (state: SlottingState): ObjectiveVector => {
    const values = scenarios.map((scenario) => scenarioSeconds(model, state, scenario.skuWeights));
    const m = mean(values);
    const worst = Math.max(...values);
    const risk = options.measure === 'cvar' ? cvar(values, options.cvarAlpha) : options.measure === 'minimax' ? worst : m;
    const base = evaluateObjectives(model, state);
    // 把风险值写进目标（单位仍然是秒/天，可解释）
    base.values['robust-risk'] = round(risk, 3);
    base.values['robust-mean'] = round(m, 3);
    base.values['robust-worst'] = round(worst, 3);
    base.scalar = risk / 100000 + state.unassigned * 1e3 + base.values['relocation-cost'] / 100000 * 0.15 + base.values.congestion / 10000 * 0.1;
    return base;
  };
  const search = runSearch(model, initial, options.search, evaluate);
  const values = scenarios.map((scenario) => scenarioSeconds(model, search.best, scenario.skuWeights));
  const m = mean(values);
  return {
    best: search.best,
    scenarioValues: values.map((v) => round(v, 3)),
    mean: round(m, 3),
    worst: round(Math.max(...values), 3),
    cvarValue: round(cvar(values, options.cvarAlpha), 3),
    stability: round(m > 0 ? stddev(values) / m : 0, 4),
    search,
    scenarios: scenarios.map((scenario) => ({ id: scenario.id, skuWeights: scenario.skuWeights, note: scenario.note })),
  };
}
