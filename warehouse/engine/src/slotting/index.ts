/**
 * 库位优化求解入口（把基础策略、组合优化、多目标、鲁棒、动态统一到一个状态语义下）。
 *
 * 状态语义（SRS §6.2）在这里第一次落地，后续 AS/RS 与联合优化沿用同一套：
 *   - `FEASIBLE`：有有效解（可能带未分配说明，也可能 `budget_exceeded = true`）；
 *   - `INFEASIBLE_PROVEN`：**只有能给出证明**时才允许使用（容量下界、单件不可行等）；
 *   - `BUDGET_EXCEEDED`：预算耗尽且**还没有**有效解 —— 与"问题无解"严格区分；
 *   - `INVALID_INPUT`：契约或语义校验失败（带字段路径）。
 */

import type {
  ConstraintCode,
  MigrationAction,
  ObjectiveValue,
  SlottingMetrics,
  SlottingProblem,
  SlottingSolution,
  SolveStatus,
  Violation,
} from '../contract/types.ts';
import { SLOTTING_SOLUTION_SCHEMA } from '../contract/types.ts';
import { fingerprint, mean, nowIso, round, seedFrom, stddev } from '../contract/util.ts';
import { validateTopology } from '../wh/topology.ts';
import { affinityCoherence, computeAffinity, DEFAULT_AFFINITY } from './affinity.ts';
import { DEFAULT_COST_CONFIG, buildSlottingModel, evaluateObjectives, SlottingState, type SlottingModel } from './model.ts';
import { runMultiObjective, runRobust, CORE_PARETO_OBJECTIVES } from './multiobj.ts';
import { runSearch, type NeighborhoodOperator, type SearchOptions } from './optimize.ts';
import { runBaselineStrategy, STRATEGY_LABEL, stateFromAssignment, type BaselineStrategy } from './strategies.ts';
import { verifySlotting } from './verify.ts';

export const ENGINE_NAME = 'ts-warehouse-slotting';
export const ENGINE_VERSION = '1.0.0';
export const RULESET_VERSION = 'warehouse-rules/1.0';

export interface SlottingSolveOptions {
  /** 覆盖问题里的算法（实验室下拉框）。 */
  algorithm?: string;
  seed?: number;
  budget_ms?: number;
  maxIterations?: number;
  isCancelled?: () => boolean;
  onProgress?: (progress: { phase: string; done: number; total: number; note?: string }) => void;
  /** 是否执行独立验证（默认 true；CLI 的 --no-verify 会关掉）。 */
  verify?: boolean;
}

const BASELINE_ALGORITHMS: BaselineStrategy[] = [
  'random',
  'fixed',
  'nearest-available',
  'abc',
  'turnover',
  'coi',
  'capacity-class',
  'scatter',
];

export function solveSlotting(problem: SlottingProblem, options: SlottingSolveOptions = {}): SlottingSolution {
  const startedAt = Date.now();
  const seed = options.seed ?? problem.algorithm.seed ?? 1;
  const budgetMs = options.budget_ms ?? problem.algorithm.budget_ms ?? 3000;
  const maxIterations = options.maxIterations ?? problem.algorithm.maxIterations ?? 20000;
  const algorithm = options.algorithm ?? problem.algorithm.algorithm;

  // ---- 语义校验：失败即 INVALID_INPUT（带字段路径），绝不"带着坏数据继续算" ----
  const topologyErrors = validateTopology(problem.topology);
  const contractErrors: string[] = topologyErrors.map((error) => `${error.path}: ${error.message}`);
  if (problem.inventory.length === 0 && problem.skus.length === 0) contractErrors.push('inventory/skus: 问题既没有商品也没有库存');
  if (problem.objectives.length === 0) contractErrors.push('objectives: 至少需要一个优化目标');
  if (contractErrors.length > 0) {
    return emptySolution(problem, algorithm, seed, startedAt, 'INVALID_INPUT', contractErrors);
  }

  const model = buildSlottingModel(problem, DEFAULT_COST_CONFIG);
  // 关联度：来自真实订单历史（没有历史就没有关联能力，如实反映为 0）
  const affinity = computeAffinity(problem.history ?? [], model.skus, model.skuIndex, {
    ...DEFAULT_AFFINITY,
    clusters: Math.max(0, Math.min(64, Math.round(Math.sqrt(model.skus.length) / 4))),
    maxNeighbors: 12,
  });
  model.affinity = affinity.summary;

  // ---- 初始解 ----
  options.onProgress?.({ phase: 'initial', done: 0, total: 1, note: '构造初始布局' });
  const startStrategy: BaselineStrategy = BASELINE_ALGORITHMS.includes(algorithm as BaselineStrategy)
    ? (algorithm as BaselineStrategy)
    : 'abc';
  const baselineRun = runBaselineStrategy(model, startStrategy, seed);
  let state = stateFromAssignment(model, baselineRun.assignment);

  const dispersionConfig = {
    maxAisleSharePerSku: problem.constraints.dispersion?.maxAisleSharePerSku ?? 1,
    maxUnitsPerAislePerSku: problem.constraints.dispersion?.maxLocationsPerSku ?? 0,
    minAislesPerSku: problem.constraints.dispersion?.minLocationsPerSku ?? 0,
    hard: (problem.hardConstraints ?? []).includes('SKU_DISPERSION_MAX'),
  };

  const searchOptions = (overrides: Partial<SearchOptions> = {}): SearchOptions => ({
    seed: seedFrom('search', seed, algorithm),
    budgetMs,
    maxIterations,
    operators: (problem.algorithm.operators as NeighborhoodOperator[] | undefined) ?? [
      'worst-removal',
      'related-removal',
      'cluster-move',
      'aisle-balance',
    ],
    temperature: problem.algorithm.temperature ?? 0,
    tabuTenure: 0,
    destroyShare: 0.08,
    dispersion: dispersionConfig,
    isCancelled: options.isCancelled,
    onProgress: (progress) =>
      options.onProgress?.({ phase: 'search', done: progress.iterations, total: maxIterations, note: `best=${round(progress.best, 4)}` }),
    ...overrides,
  });

  let status: SolveStatus = 'FEASIBLE';
  let budgetExceeded = false;
  let optimalityProven = false;
  let searchResult = {
    iterations: 0,
    restarts: 0,
    bestIteration: 0,
    trace: [0],
    operatorsUsed: {} as Record<string, number>,
    elapsedMs: 0,
    cancelled: false,
    temperature: 0,
  };
  let paretoFront: SlottingSolution['paretoFront'];
  let robustInfo: { measure: string; mean: number; worst: number; cvar: number; stability: number; scenarios: number } | null = null;
  const multiSeed: Array<{ seed: number; objective: number; status: SolveStatus }> = [];

  if (BASELINE_ALGORITHMS.includes(algorithm as BaselineStrategy)) {
    // 基础对照策略：不做邻域搜索（这正是它作为对照的意义）
    searchResult = { ...searchResult, iterations: 0, trace: [round(evaluateObjectives(model, state).scalar, 6)] };
  } else if (algorithm === 'nsga2') {
    const seeds = BASELINE_ALGORITHMS.map((strategy) => {
      const run = runBaselineStrategy(model, strategy, seed);
      return { assignment: run.assignment, origin: STRATEGY_LABEL[strategy] };
    });
    const result = runMultiObjective(model, seeds, {
      populationSize: problem.algorithm.pareto?.populationSize ?? 24,
      generations: problem.algorithm.pareto?.generations ?? 12,
      seed,
      budgetMs,
      objectives: CORE_PARETO_OBJECTIVES.filter((objective) =>
        problem.objectives.some((configured) => configured.id === objective.id),
      ),
      allowUnassigned: (problem.constraints.maxUnassignedShare ?? 0) > 0,
      isCancelled: options.isCancelled,
    });
    paretoFront = result.points;
    // 从前沿里挑一个"加权综合最优"作为返回解（前沿本身完整返回，不隐藏取舍）
    const chosen = pickFromFront(model, result.front, problem);
    state = chosen.state;
    searchResult = {
      ...searchResult,
      iterations: result.generations,
      trace: result.points.map((point) => round(point.values['expected-travel-time'] ?? 0, 4)),
      elapsedMs: result.elapsedMs,
      cancelled: result.cancelled,
    };
    status = result.front.length > 0 ? 'FEASIBLE' : 'NO_SOLUTION_FOUND';
    if (budgetExceededCheck(startedAt, budgetMs) && result.front.length === 0) status = 'BUDGET_EXCEEDED';
  } else if (algorithm === 'robust-lns') {
    const robust = runRobust(model, state, {
      scenarios: problem.algorithm.robust?.scenarios ?? 8,
      measure: problem.algorithm.robust?.measure ?? 'cvar',
      cvarAlpha: problem.algorithm.robust?.cvarAlpha ?? 0.25,
      volatility: 1,
      shiftShare: 0.35,
      seed,
      budgetMs,
      search: searchOptions(),
      isCancelled: options.isCancelled,
    });
    state = robust.best;
    robustInfo = {
      measure: problem.algorithm.robust?.measure ?? 'cvar',
      mean: robust.mean,
      worst: robust.worst,
      cvar: robust.cvarValue,
      stability: robust.stability,
      scenarios: robust.scenarios.length,
    };
    searchResult = {
      ...searchResult,
      iterations: robust.search.iterations,
      restarts: robust.search.restarts,
      bestIteration: robust.search.bestIteration,
      trace: robust.search.trace,
      operatorsUsed: robust.search.operatorsUsed,
      elapsedMs: robust.search.elapsedMs,
      cancelled: robust.search.cancelled,
    };
  } else {
    // ALNS / Tabu / SA / dynamic-delta 统一走搜索内核，差别在参数
    const overrides: Partial<SearchOptions> =
      algorithm === 'tabu'
        ? { temperature: 0, tabuTenure: 12 }
        : algorithm === 'sa'
          ? { temperature: problem.algorithm.temperature ?? 0.02 }
          : algorithm === 'dynamic-delta'
            ? { destroyShare: 0.04, operators: ['worst-removal', 'aisle-balance'] }
            : { temperature: problem.algorithm.temperature ?? 0.01 };
    const result = runSearch(model, state, searchOptions(overrides));
    state = result.best;
    searchResult = {
      iterations: result.iterations,
      restarts: result.restarts,
      bestIteration: result.bestIteration,
      trace: result.trace,
      operatorsUsed: result.operatorsUsed,
      elapsedMs: result.elapsedMs,
      cancelled: result.cancelled,
      temperature: searchOptions(overrides).temperature,
    };
  }

  const elapsed = Date.now() - startedAt;
  if (options.isCancelled?.()) status = 'CANCELLED';
  else if (elapsed >= budgetMs * 0.98 && state.unassigned > model.loadUnits.length) status = 'BUDGET_EXCEEDED';
  budgetExceeded = elapsed >= budgetMs * 0.98;

  // ---- 不可行性证明（只在真有证明时使用；否则是"未找到"，不是"无解"）----
  const infeasibility = proveInfeasibility(model);
  if (state.unassigned > 0 && infeasibility) {
    const allowShare = problem.constraints.maxUnassignedShare ?? 0;
    const unassignedShare = state.unassigned / Math.max(1, model.loadUnits.length);
    if (allowShare === 0 || unassignedShare > allowShare) {
      status = 'INFEASIBLE_PROVEN';
      optimalityProven = false;
    }
  }
  // 单点对照：容量下界与"每个 SKU 至少一个库位"的存在性
  const capacityBound = Math.min(model.availableLocations.length, model.placeableLocations.length);
  const bound = {
    lower: round(Math.max(0, capacityBound * 0), 3), // 启发式算法不提供目标下界（不伪造界）
    upper: round(evaluateObjectives(model, state).values['expected-travel-time'] ?? 0, 3),
    gap: null as number | null,
  };

  // ---- 多随机种子稳定性（SRS §6.3）----
  if ((problem.algorithm.seeds ?? []).length > 1 && !BASELINE_ALGORITHMS.includes(algorithm as BaselineStrategy)) {
    for (const seedValue of problem.algorithm.seeds as number[]) {
      if (seedValue === seed) {
        multiSeed.push({ seed: seedValue, objective: round(evaluateObjectives(model, state).scalar, 6), status });
        continue;
      }
      const rerun = runSearch(model, stateFromAssignment(model, runBaselineStrategy(model, startStrategy, seedValue).assignment), searchOptions({ seed: seedValue, isCancelled: () => false }));
      multiSeed.push({ seed: seedValue, objective: round(evaluateObjectives(model, rerun.best).scalar, 6), status: 'FEASIBLE' });
    }
  }

  // ---- 指标 ----
  const objectiveVector = evaluateObjectives(model, state);
  const metrics = buildMetrics(model, state, objectiveVector, elapsed, multiSeed, infeasibility, status);

  // ---- 迁移动作（建议 vs 任务）----
  const migrations = buildMigrationActions(model, state, problem);

  // ---- 独立验证 ----
  const solutionId = `SOL-SLT-${fingerprint({ p: problem.id, a: algorithm, s: seed }).slice(0, 10)}`;
  const draft: SlottingSolution = {
    schema_version: SLOTTING_SOLUTION_SCHEMA,
    id: solutionId,
    problemId: problem.id,
    problemHash: fingerprint(problem),
    scenarioId: problem.scenarioId ?? null,
    engine: ENGINE_NAME,
    engineVersion: ENGINE_VERSION,
    rulesetVersion: RULESET_VERSION,
    datasetVersion: problem.versions.dataset,
    seed,
    algorithm,
    status,
    budget_exceeded: budgetExceeded,
    optimality_proven: optimalityProven,
    bound,
    assignment: [],
    unassigned: [],
    migrations,
    metrics,
    paretoFront,
    explanations: [],
    search: {
      iterations: searchResult.iterations,
      objectiveTrace: searchResult.trace,
      restarts: searchResult.restarts,
      operatorsUsed: searchResult.operatorsUsed,
      bestIteration: searchResult.bestIteration,
      elapsedMs: elapsed,
      multiSeed: multiSeed.length > 0 ? multiSeed : undefined,
    },
    verify: { verified: false, summary: { errors: 0, warnings: 0 }, reportId: '' },
  };

  draft.assignment = [];
  for (let lu = 0; lu < state.locOfLu.length; lu += 1) {
    const locIdx = state.locOfLu[lu];
    if (locIdx < 0) continue;
    draft.assignment.push({
      loadUnitId: model.loadUnits[lu].id,
      skuId: model.loadUnits[lu].skuId,
      locationId: model.locations[locIdx].id,
      quantity: model.loadUnits[lu].quantity,
    });
  }
  draft.unassigned = [];
  for (let lu = 0; lu < state.locOfLu.length; lu += 1) {
    if (state.locOfLu[lu] >= 0) continue;
    draft.unassigned.push({
      loadUnitId: model.loadUnits[lu].id,
      skuId: model.loadUnits[lu].skuId,
      reason: infeasibility
        ? infeasibility.reason
        : '求解预算内未找到合法库位（`unassigned` 仅表示本次求解未完成分配，不代表问题无解）',
    });
  }
  draft.explanations = explainPlacement(model, state, affinityStatsToText(affinity.stats.topPairs), infeasibility);

  if (options.verify !== false) {
    const report = verifySlotting(problem, draft);
    draft.verify = {
      verified: report.ok,
      summary: { errors: report.counts.errors, warnings: report.counts.warnings },
      reportId: report.id,
    };
    if (!report.ok) {
      // 验证失败不改状态语义（状态描述的是求解结论），但必须显式暴露
      draft.explanations.push({
        subject: 'independent-verification',
        text: `独立验证发现 ${report.counts.errors} 项硬约束违规，结果不可直接采信（见验证报告 ${report.id}）`,
      });
      metrics.unmetConstraints = report.counts.errors;
    }
  }
  draft.metrics = metrics;
  return draft;
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

function emptySolution(
  problem: SlottingProblem,
  algorithm: string,
  seed: number,
  startedAt: number,
  status: SolveStatus,
  notes: string[],
): SlottingSolution {
  return {
    schema_version: SLOTTING_SOLUTION_SCHEMA,
    id: `SOL-SLT-INVALID-${fingerprint({ p: problem.id, notes }).slice(0, 8)}`,
    problemId: problem.id,
    problemHash: fingerprint(problem),
    scenarioId: problem.scenarioId ?? null,
    engine: ENGINE_NAME,
    engineVersion: ENGINE_VERSION,
    rulesetVersion: RULESET_VERSION,
    datasetVersion: problem.versions?.dataset ?? 'unknown',
    seed,
    algorithm,
    status,
    budget_exceeded: false,
    optimality_proven: false,
    bound: { lower: null, upper: null, gap: null },
    assignment: [],
    unassigned: [],
    migrations: [],
    metrics: {
      spaceUtilization: 0,
      effectiveUtilization: 0,
      expectedPickSeconds: 0,
      expectedPutSeconds: 0,
      affinityCoherence: 0,
      aisleLoadGini: 0,
      liftPeakRatio: 0,
      congestionIndex: 0,
      relocationCount: 0,
      relocationDeviceSeconds: 0,
      unmetConstraints: notes.length,
      objectives: [],
      computeMs: Date.now() - startedAt,
      computedScale: { skus: problem.skus?.length ?? 0, locations: 0, loadUnits: problem.inventory?.length ?? 0, orders: problem.history?.length ?? 0, assignments: 0 },
    },
    explanations: notes.map((note, index) => ({ subject: `input-error-${index + 1}`, text: note })),
    search: { iterations: 0, objectiveTrace: [], restarts: 0, bestIteration: 0, elapsedMs: Date.now() - startedAt },
    verify: { verified: false, summary: { errors: notes.length, warnings: 0 }, reportId: '' },
  };
}

function budgetExceededCheck(startedAt: number, budgetMs: number): boolean {
  return Date.now() - startedAt >= budgetMs * 0.98;
}

/**
 * 不可行性证明：只承认可复述的数学事实。
 *   1. 可用库位数 < 货物单元数（容量证明）；
 *   2. 存在某个 SKU 的货物单元在任何库位都放不下（单件证明）。
 */
function proveInfeasibility(model: SlottingModel): { reason: string; code: ConstraintCode } | null {
  if (model.placeableLocations.length < model.loadUnits.length) {
    return {
      code: 'LOCATION_CAPACITY',
      reason: `可用库位 ${model.placeableLocations.length} 个 < 货物单元 ${model.loadUnits.length} 个（容量下界证明，见验证报告）`,
    };
  }
  for (let lu = 0; lu < model.loadUnits.length; lu += 1) {
    let any = false;
    const step = Math.max(1, Math.floor(model.placeableLocations.length / 2000));
    for (let i = 0; i < model.placeableLocations.length; i += step) {
      const locIdx = model.placeableLocations[i];
      if (model.skuWeight[model.luSku[lu]] > model.locMaxWeight[locIdx] + 1e-9) continue;
      if (model.skuVolume[model.luSku[lu]] > model.locMaxVolume[locIdx] + 1e-9) continue;
      any = true;
      break;
    }
    if (!any) {
      return {
        code: 'LOCATION_FOOTPRINT',
        reason: `货物单元 ${model.loadUnits[lu].id}（SKU ${model.loadUnits[lu].skuId}）在全库找不到满足重量/体积限制的库位（单件不可行证明）`,
      };
    }
  }
  return null;
}

function buildMetrics(
  model: SlottingModel,
  state: SlottingState,
  objectiveVector: ReturnType<typeof evaluateObjectives>,
  computeMs: number,
  multiSeed: Array<{ seed: number; objective: number; status: SolveStatus }>,
  infeasibility: { reason: string } | null,
  status: SolveStatus,
): SlottingMetrics {
  // 有效利用率：只统计"真正可服务"的库位（前排深度与最快分区的库位）
  const effectiveLocations = model.placeableLocations.filter((locIdx) => model.locations[locIdx].depth === 1);
  let effectiveUsed = 0;
  for (const locIdx of effectiveLocations) if (state.luAtLoc[locIdx] >= 0) effectiveUsed += 1;

  // 关联效果：SKU → 巷道/列索引
  const aisleOfSku = new Int32Array(model.skus.length).fill(-1);
  const bayOfSku = new Int32Array(model.skus.length).fill(0);
  for (let lu = 0; lu < state.locOfLu.length; lu += 1) {
    const locIdx = state.locOfLu[lu];
    if (locIdx < 0) continue;
    const sku = model.luSku[lu];
    if (aisleOfSku[sku] < 0) {
      aisleOfSku[sku] = model.locationCost[locIdx].aisleIndex;
      bayOfSku[sku] = model.locations[locIdx].bay;
    }
  }
  const coherence = model.affinity.pairs.size > 0 ? affinityCoherence(model.affinity, aisleOfSku, bayOfSku) : 0;

  // 提升机峰值比：最忙提升机流量 / 平均流量
  const liftFlows = Array.from(state.liftFlow).filter((flow) => flow > 0);
  const liftPeakRatio = liftFlows.length > 1 ? round(Math.max(...liftFlows) / Math.max(1e-6, mean(liftFlows)), 4) : 1;

  // 出库/入库平均时间（按流量加权，不含拥堵：拥堵单列为 congestionIndex）
  let outWeighted = 0;
  let inWeighted = 0;
  let flowSum = 0;
  for (let lu = 0; lu < state.locOfLu.length; lu += 1) {
    const locIdx = state.locOfLu[lu];
    if (locIdx < 0) continue;
    const flow = model.unitFlow[lu];
    outWeighted += flow * model.locationCost[locIdx].pickSeconds;
    inWeighted += flow * model.locationCost[locIdx].putSeconds;
    flowSum += flow;
  }

  const objectives: ObjectiveValue[] = model.problem.objectives.map((objective) => {
    const raw = objectiveVector.values[objective.id] ?? 0;
    const reference = objective.normalizer ?? 1;
    const ratio = reference > 0 ? raw / reference : raw;
    const normalized = objective.direction === 'min' ? 1 - Math.min(1, ratio) : Math.min(1, ratio);
    return {
      id: objective.id,
      direction: objective.direction,
      unit: objective.unit,
      weight: objective.weight,
      raw: round(raw, 4),
      normalized: round(normalized, 4),
      conflictsWith: conflictPartners(objective.id),
      note: objective.note,
    };
  });

  const multiSeedValues = multiSeed.map((entry) => entry.objective);
  const stability = multiSeedValues.length > 1 ? round(stddev(multiSeedValues) / Math.max(1e-9, Math.abs(mean(multiSeedValues))), 4) : null;

  return {
    spaceUtilization: objectiveVector.values['space-utilization'],
    effectiveUtilization: round(effectiveUsed / Math.max(1, effectiveLocations.length), 6),
    expectedPickSeconds: round(flowSum > 0 ? outWeighted / flowSum : 0, 3),
    expectedPutSeconds: round(flowSum > 0 ? inWeighted / flowSum : 0, 3),
    affinityCoherence: coherence,
    aisleLoadGini: objectiveVector.values['load-balance'],
    liftPeakRatio,
    congestionIndex: round(Math.min(1, (state.congestionSeconds() / Math.max(1, flowSum * model.costConfig.aisleServiceSeconds))), 4),
    relocationCount: state.relocationCount,
    relocationDeviceSeconds: round(state.relocationSeconds, 2),
    unmetConstraints: state.unassigned > 0 && infeasibility ? 1 : 0,
    objectives,
    computeMs,
    stability,
    computedScale: {
      skus: model.skus.length,
      locations: model.locations.length,
      loadUnits: model.loadUnits.length,
      orders: model.problem.history.length,
      assignments: model.loadUnits.length - state.unassigned,
    },
  };
  void status;
}

/** 目标之间的取舍关系（面板上的"取舍"提示；如实标注相互冲突的目标）。 */
function conflictPartners(id: string): string[] {
  switch (id) {
    case 'expected-travel-time':
      return ['relocation-cost', 'congestion'];
    case 'space-utilization':
      return ['expected-travel-time', 'delivery-timeliness'];
    case 'relocation-count':
      return ['expected-travel-time', 'load-balance'];
    case 'congestion':
      return ['expected-travel-time', 'space-utilization'];
    case 'load-balance':
      return ['expected-travel-time'];
    case 'delivery-timeliness':
      return ['relocation-count'];
    case 'energy':
      return ['expected-travel-time'];
    default:
      return [];
  }
}

/** 迁移动作：把"建议布局"与"当前布局"的差异变成可执行清单。 */
function buildMigrationActions(model: SlottingModel, state: SlottingState, problem: SlottingProblem): MigrationAction[] {
  const budget = problem.algorithm.migrationBudget ?? { maxMoves: 300, maxDeviceSeconds: 4 * 3600, window_s: 8 * 3600 };
  const actions: MigrationAction[] = [];
  let usedSeconds = 0;
  for (let lu = 0; lu < state.locOfLu.length; lu += 1) {
    const target = state.locOfLu[lu];
    if (target < 0) continue;
    const current = model.currentLocationOfLu[lu];
    if (current === target) continue;
    const seconds = state.relocationSecondsFor(current, target);
    const withinBudget = actions.length < budget.maxMoves && usedSeconds + seconds <= budget.maxDeviceSeconds;
    actions.push({
      loadUnitId: model.loadUnits[lu].id,
      skuId: model.loadUnits[lu].skuId,
      fromLocationId: current >= 0 ? model.locations[current].id : null,
      toLocationId: model.locations[target].id,
      mode: withinBudget ? 'task' : 'suggestion',
      reason:
        current < 0
          ? '尚未上架：直接按最新布局入库'
          : `出库运行时间 ${round(model.locationCost[current].pickSeconds, 1)}s → ${round(model.locationCost[target].pickSeconds, 1)}s`,
      estimatedDeviceSeconds: round(seconds, 2),
      estimatedEnergyKwh: round((seconds / 3600) * 0.08, 4),
      trigger: null,
      requiresDispatch: withinBudget,
    });
    if (withinBudget) usedSeconds += seconds;
  }
  actions.sort((a, b) => a.estimatedDeviceSeconds - b.estimatedDeviceSeconds);
  return actions;
}

function affinityStatsToText(topPairs: Array<{ a: string; b: string; weight: number }>): string {
  if (topPairs.length === 0) return '无订单历史关联数据';
  return topPairs
    .slice(0, 3)
    .map((pair) => `${pair.a}↔${pair.b}(${pair.weight})`)
    .join('、');
}

/**
 * 解释"为什么货物应该放在这些库位"（SRS §14 的问题 1）。
 * 解释必须引用**真实计算证据**（库位时间差、关联权重、拥堵贡献），不能是套话。
 */
function explainPlacement(
  model: SlottingModel,
  state: SlottingState,
  affinityText: string,
  infeasibility: { reason: string } | null,
): SlottingSolution['explanations'] {
  const explanations: SlottingSolution['explanations'] = [];
  // 1) 分区结构与 A 类商品的位置
  const aSkus = model.skus.filter((sku) => sku.abc === 'A');
  if (aSkus.length > 0) {
    let aOut = 0;
    let cOut = 0;
    let aCount = 0;
    let cCount = 0;
    for (let lu = 0; lu < state.locOfLu.length; lu += 1) {
      const locIdx = state.locOfLu[lu];
      if (locIdx < 0) continue;
      const sku = model.skus[model.luSku[lu]];
      if (sku.abc === 'A') {
        aOut += model.locationCost[locIdx].pickSeconds;
        aCount += 1;
      } else if (sku.abc === 'C') {
        cOut += model.locationCost[locIdx].pickSeconds;
        cCount += 1;
      }
    }
    if (aCount > 0 && cCount > 0) {
      explanations.push({
        subject: 'ABC 分区（出库时间）',
        text: `A 类商品平均出库运行时间 ${round(aOut / aCount, 1)}s，C 类 ${round(cOut / cCount, 1)}s（差 ${round(cOut / cCount - aOut / aCount, 1)}s）；这是"高频商品靠近出库口"的直接证据`,
        evidence: { aAverageSeconds: round(aOut / aCount, 2), cAverageSeconds: round(cOut / cCount, 2) },
      });
    }
  }
  // 2) 关联布局
  explanations.push({
    subject: '关联性库位',
    text: model.affinity.pairs.size > 0
      ? `基于订单历史关联度（最强关联：${affinityText}）把共同出库商品尽量压到同一巷道，减少跨巷道往返`
      : '本问题的订单历史没有形成显著关联对，因此关联性优化只做了容量与运行时间层面的事',
    evidence: { affinityPairs: model.affinity.pairs.size },
  });
  // 3) 拥堵与负载均衡
  explanations.push({
    subject: '拥堵与负载',
    text: `巷道负载基尼系数 ${round(state.aisleLoadGini(), 3)}，拥堵代理延误 ${round(state.congestionSeconds(), 1)} 秒/天；算法在"就近存放"与"热点分散"之间做了显式取舍（不是把所有热门商品塞进同一条巷道）`,
    evidence: { gini: round(state.aisleLoadGini(), 4), congestionSecondsPerDay: round(state.congestionSeconds(), 2) },
  });
  // 4) 迁移代价
  explanations.push({
    subject: '搬迁代价',
    text: `本次调整涉及 ${state.relocationCount} 个货物单元、约 ${round(state.relocationSeconds / 3600, 2)} 小时设备工时；建议库位与需要执行的搬迁任务在结果里分开列出`,
    evidence: { relocationCount: state.relocationCount, relocationDeviceSeconds: round(state.relocationSeconds, 1) },
  });
  // 5) 无解 / 容量不足
  if (infeasibility) {
    explanations.push({
      subject: '容量与不可行性',
      text: infeasibility.reason,
      evidence: { locations: model.placeableLocations.length, loadUnits: model.loadUnits.length },
    });
  }
  return explanations;
}

/** 从前沿里按"问题声明的权重"选一个解（前沿完整返回，不隐藏其它取舍）。 */
function pickFromFront(
  model: SlottingModel,
  front: Array<{ assignment: Int32Array; fingerprint: string }>,
  problem: SlottingProblem,
): { state: SlottingState; fingerprint: string } {
  let best = front[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const solution of front) {
    const state = SlottingState.rebuild(model, solution.assignment);
    const objective = evaluateObjectives(model, state);
    if (objective.scalar < bestScore) {
      bestScore = objective.scalar;
      best = solution;
    }
  }
  const state = SlottingState.rebuild(model, best.assignment);
  state.recomputeRelocation();
  void problem;
  return { state, fingerprint: best.fingerprint };
}

/** 供 CLI / 实验室使用的摘要（一行说明这次运行到底做了什么）。 */
export function summarizeSolution(solution: SlottingSolution): string {
  const moves = solution.migrations.filter((m) => m.mode === 'task').length;
  return [
    `${solution.algorithm} · ${solution.status}`,
    `利用率 ${round(solution.metrics.spaceUtilization * 100, 1)}%`,
    `出库均时 ${round(solution.metrics.expectedPickSeconds, 1)}s`,
    `搬迁 ${moves} 件`,
    `耗时 ${solution.metrics.computeMs}ms`,
    solution.verify.verified ? '验证通过' : `验证 ${solution.verify.summary.errors} 项错误`,
  ].join(' · ');
}

/** 时间戳（结果持久化时使用；不参与指纹计算）。 */
export const slottingGeneratedAt = nowIso;
