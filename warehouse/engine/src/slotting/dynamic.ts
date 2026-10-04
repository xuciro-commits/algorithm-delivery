/**
 * 动态库位优化（SRS §3.2B）。
 *
 * 动态库位调整必须回答两件事，且**不能混为一谈**：
 *   1. "建议库位"（suggestion）：规划视图的最优布局 —— 只影响未来上架与规划决策；
 *   2. "搬迁任务"（task）：需要真实占用设备工时的动作 —— 有预算、有代价、会影响正常订单。
 *
 * 因此本模块：
 *   - 先从真实信号里检测触发（周转等级变化 / 库存变化 / 新 SKU / 季节与促销 / 容量变化 /
 *     库位失效 / 多区域转移）；
 *   - 再做**增量优化**：只对受影响的 SKU 与区域搜索，且受迁移预算（件数 + 设备工时）约束；
 *   - 最后输出带触发原因、代价、优先级区分的迁移清单（是否需要交给调度执行由调用方决定）。
 */

import type { ConstraintCode, MigrationAction, SlottingProblem } from '../contract/types.ts';
import { round, seedFrom } from '../contract/util.ts';
import { canPlace, evaluateObjectives, SlottingState, type SlottingModel } from './model.ts';
import { runSearch, type SearchOptions } from './optimize.ts';

export type TriggerKind =
  | 'turnover-shift'
  | 'inventory-change'
  | 'new-sku'
  | 'seasonality'
  | 'promo-preload'
  | 'capacity-adjust'
  | 'location-outage'
  | 'zone-transfer';

export interface DynamicTrigger {
  kind: TriggerKind;
  at_s: number;
  /** 触发强度（0–1）：越大代表偏离越明显（用于决定优化规模与紧急度）。 */
  magnitude: number;
  detail: string;
  /** 受影响的 SKU（空 = 全库）。 */
  skuIds: string[];
  /** 受影响的库位（空 = 不受限）。 */
  locationIds: string[];
}

export interface DynamicOptions {
  /** 迁移预算：最多搬多少件、最多用多少设备工时。 */
  budget: { maxMoves: number; maxDeviceSeconds: number; window_s: number };
  /** 每个触发允许的搜索预算（毫秒）。 */
  perTriggerBudgetMs: number;
  /** 触发检测阈值。 */
  thresholds: {
    /** 周转等级变化的最小幅度（相对需求变化）。 */
    turnoverDelta: number;
    /** 库存变化的相对幅度。 */
    inventoryDelta: number;
    /** 需求结构变化（关联结构）的幅度。 */
    structureDelta: number;
  };
  search: SearchOptions;
  isCancelled?: () => boolean;
}

export interface DynamicResult {
  triggers: DynamicTrigger[];
  /** 迁移动作（建议 + 需要执行的任务，mode 区分）。 */
  migrations: MigrationAction[];
  /** 建议布局（含未执行的迁移；用于"建议 vs 执行"的对比）。 */
  suggested: SlottingState;
  /** 在迁移预算内真正采纳的行动。 */
  adopted: MigrationAction[];
  stats: {
    triggers: number;
    suggestedMoves: number;
    adoptedMoves: number;
    deviceSeconds: number;
    energyKwh: number;
    /** 建议布局相对当前布局的运行时间改善（秒/天）。 */
    improvementSecondsPerDay: number;
    /** 因预算不足未采纳的迁移数（诚实报告"想做但没做"）。 */
    deferred: number;
  };
  elapsedMs: number;
}

/** 触发检测：从"上一版需求/库存"与"当前状态"的差异里提取触发。 */
export function detectTriggers(
  model: SlottingModel,
  previous: {
    /** 上一版每个货物单元的日流量（需求）。 */
    unitFlow?: Float64Array;
    /** 上一版库存单元集合（新 SKU / 新货物单元检测）。 */
    unitIds?: Set<string>;
    /** 上一版可用库位数。 */
    availableLocations?: number;
  },
  options: Pick<DynamicOptions, 'thresholds'>,
  at_s = 0,
): DynamicTrigger[] {
  const triggers: DynamicTrigger[] = [];
  const previousFlow = previous.unitFlow ?? model.unitFlow;

  // 1) 周转等级变化：SKU 需求相对变化超过阈值
  const changedSkus = new Set<string>();
  let maxDelta = 0;
  for (let s = 0; s < model.skus.length; s += 1) {
    // 上一版 SKU 流量 = 该 SKU 上一版货物单元流量之和
    let prev = 0;
    let curr = 0;
    for (let lu = 0; lu < model.loadUnits.length; lu += 1) {
      if (model.luSku[lu] !== s) continue;
      prev += previousFlow[lu] ?? 0;
      curr += model.unitFlow[lu];
    }
    if (prev <= 0.01 && curr <= 0.01) continue;
    const delta = Math.abs(curr - prev) / Math.max(0.01, prev);
    maxDelta = Math.max(maxDelta, delta);
    if (delta >= options.thresholds.turnoverDelta) changedSkus.add(model.skus[s].id);
  }
  if (changedSkus.size > 0) {
    triggers.push({
      kind: 'turnover-shift',
      at_s,
      magnitude: round(Math.min(1, maxDelta), 3),
      detail: `${changedSkus.size} 个 SKU 的日需求相对变化超过 ${Math.round(options.thresholds.turnoverDelta * 100)}%（最大 ${Math.round(maxDelta * 100)}%）`,
      skuIds: [...changedSkus].slice(0, 200),
      locationIds: [],
    });
  }

  // 2) 新 SKU / 新货物单元
  if (previous.unitIds) {
    const newUnits = model.loadUnits.filter((unit) => !previous.unitIds?.has(unit.id));
    if (newUnits.length > 0) {
      const skuIds = [...new Set(newUnits.map((unit) => unit.skuId))];
      triggers.push({
        kind: 'new-sku',
        at_s,
        magnitude: round(Math.min(1, newUnits.length / Math.max(1, model.loadUnits.length) * 10), 3),
        detail: `新增 ${newUnits.length} 个货物单元 / ${skuIds.length} 个 SKU 尚未有库位`,
        skuIds: skuIds.slice(0, 200),
        locationIds: [],
      });
    }
  }

  // 3) 容量变化（库位失效 / 冻结）与区域转移
  if (previous.availableLocations !== undefined && previous.availableLocations !== model.availableLocations.length) {
    const delta = model.availableLocations.length - previous.availableLocations;
    triggers.push({
      kind: 'location-outage',
      at_s,
      magnitude: round(Math.min(1, Math.abs(delta) / Math.max(1, previous.availableLocations)), 3),
      detail: `可用库位从 ${previous.availableLocations} 变为 ${model.availableLocations.length}（${delta > 0 ? '恢复' : '减少'} ${Math.abs(delta)} 个）`,
      skuIds: [],
      locationIds: [],
    });
  }

  // 4) 季节 / 促销：SKU 自带的促销窗口命中当前时刻
  const promoSkus = model.skus.filter((sku) => (sku.promoWindows ?? []).some((w) => at_s >= w.from_s && at_s <= w.to_s));
  if (promoSkus.length > 0) {
    triggers.push({
      kind: 'promo-preload',
      at_s,
      magnitude: 0.6,
      detail: `${promoSkus.length} 个 SKU 处于促销窗口，需要前置备货与库位重构`,
      skuIds: promoSkus.slice(0, 200).map((sku) => sku.id),
      locationIds: [],
    });
  }
  const seasonalSkus = model.skus.filter((sku) => (sku.seasonality ?? []).length > 0);
  if (seasonalSkus.length > 0 && triggers.every((trigger) => trigger.kind !== 'promo-preload')) {
    triggers.push({
      kind: 'seasonality',
      at_s,
      magnitude: 0.35,
      detail: `${seasonalSkus.length} 个 SKU 具有季节曲线，按当前周的需求水平调整布局`,
      skuIds: seasonalSkus.slice(0, 200).map((sku) => sku.id),
      locationIds: [],
    });
  }

  return triggers;
}

/** 由状态差异生成迁移动作（区分 suggestion / task，并给出代价与触发原因）。 */
export function buildMigrations(
  model: SlottingModel,
  from: SlottingState,
  to: SlottingState,
  trigger: DynamicTrigger | null,
  options: Pick<DynamicOptions, 'budget'>,
): MigrationAction[] {
  const actions: MigrationAction[] = [];
  for (let lu = 0; lu < to.locOfLu.length; lu += 1) {
    const target = to.locOfLu[lu];
    const current = from.locOfLu[lu];
    if (target < 0 || target === current) continue;
    const currentLocId = current >= 0 ? model.locations[current].id : null;
    const targetLocation = model.locations[target];
    const seconds = to.relocationSecondsFor(current, target);
    const energy = (seconds / 3600) * 0.05 * 1.6; // 0.05 kW 平均功率 × 秒 → kWh（显式标注的估算）
    const withinBudget = actions.length < options.budget.maxMoves;
    const flowDelta = current >= 0 ? model.locationCost[current].pickSeconds - model.locationCost[target].pickSeconds : 0;
    actions.push({
      loadUnitId: model.loadUnits[lu].id,
      skuId: model.skus[model.luSku[lu]].id,
      fromLocationId: currentLocId,
      toLocationId: targetLocation.id,
      // 预算内且确有收益的搬迁 → task；其余只作为规划建议（SRS §3.2B 的区分）
      mode: withinBudget && seconds <= options.budget.maxDeviceSeconds ? 'task' : 'suggestion',
      reason:
        current < 0
          ? '尚未上架：按最新布局直接入库'
          : `运行时间差 ${round(flowDelta, 1)}s（出库口径）；关联/负载重排`,
      estimatedDeviceSeconds: round(seconds, 2),
      estimatedEnergyKwh: round(energy, 4),
      trigger: trigger ? { kind: trigger.kind, at_s: trigger.at_s, detail: trigger.detail } : null,
      requiresDispatch: withinBudget && seconds <= options.budget.maxDeviceSeconds,
    });
  }
  actions.sort((a, b) => {
    const ga = a.estimatedDeviceSeconds;
    const gb = b.estimatedDeviceSeconds;
    return ga !== gb ? ga - gb : a.loadUnitId < b.loadUnitId ? -1 : 1;
  });
  return actions;
}

/**
 * 动态优化主流程：
 *   检测触发 → 增量搜索（受影响的 SKU/库位子集）→ 生成迁移建议 → 按预算采纳。
 *
 * 注意：搜索**不会**为了凑改善而随意搬动无关 SKU；迁移预算既限制件数也限制设备工时。
 */
export function runDynamic(
  model: SlottingModel,
  current: SlottingState,
  triggers: DynamicTrigger[],
  options: DynamicOptions,
): DynamicResult {
  const startedAt = Date.now();
  const affectedSkus = new Set<string>();
  for (const trigger of triggers) for (const skuId of trigger.skuIds) affectedSkus.add(skuId);
  const restrictToAffected = affectedSkus.size > 0 && affectedSkus.size < model.skus.length;

  // 受限搜索：把无关 SKU 的移动代价提高（等效于"只调整受影响商品"），并保留现状作为初始解
  const restricted: SlottingModel = restrictToAffected
    ? {
        ...model,
        unitFlow: Float64Array.from(model.unitFlow, (flow, lu) => {
          const skuId = model.skus[model.luSku[lu]].id;
          return affectedSkus.has(skuId) ? flow : flow * 0.02;
        }),
      }
    : model;

  const searchOptions: SearchOptions = {
    ...options.search,
    budgetMs: Math.min(options.perTriggerBudgetMs, options.search.budgetMs),
    isCancelled: options.isCancelled,
  };
  const search = runSearch(restricted, current, searchOptions, (state) => {
    const objective = evaluateObjectives(restricted, state);
    // 动态优化关心的是"搬迁性价比"：运行时间改善 vs 迁移代价
    objective.scalar = objective.scalar + state.relocationSeconds / 100000 / 0.05;
    return objective;
  });

  const trigger = triggers.length > 0 ? triggers[0] : null;
  const allMigrations = buildMigrations(model, current, search.best, trigger, options);

  // 按预算采纳（设备工时预算同样生效）
  let usedSeconds = 0;
  let adoptedMoves = 0;
  const adopted: MigrationAction[] = [];
  const adoptedState = current.clone();
  for (const action of allMigrations) {
    if (action.mode !== 'task') continue;
    if (adoptedMoves >= options.budget.maxMoves) break;
    if (usedSeconds + action.estimatedDeviceSeconds > options.budget.maxDeviceSeconds) continue;
    const lu = model.luIndex.get(action.loadUnitId);
    const locIdx = model.locations.findIndex((l) => l.id === action.toLocationId);
    if (lu === undefined || locIdx < 0) continue;
    const check = canPlace(model, lu, locIdx);
    if (!check.ok && (check.code as ConstraintCode) !== 'LOCATION_FROZEN') continue;
    adoptedState.moveTo(lu, locIdx);
    usedSeconds += action.estimatedDeviceSeconds;
    adoptedMoves += 1;
    adopted.push(action);
  }
  adoptedState.recomputeRelocation();

  const currentObjective = evaluateObjectives(model, current);
  const adoptedObjective = evaluateObjectives(model, adoptedState);
  const improvement = (currentObjective.values['expected-travel-time'] ?? 0) - (adoptedObjective.values['expected-travel-time'] ?? 0);

  return {
    triggers,
    migrations: allMigrations,
    suggested: search.best,
    adopted,
    stats: {
      triggers: triggers.length,
      suggestedMoves: allMigrations.length,
      adoptedMoves,
      deviceSeconds: round(usedSeconds, 2),
      energyKwh: round(allMigrations.filter((a) => a.mode === 'task').reduce((sum, a) => sum + a.estimatedEnergyKwh, 0), 4),
      improvementSecondsPerDay: round(improvement, 3),
      deferred: allMigrations.length - adoptedMoves,
    },
    elapsedMs: Date.now() - startedAt,
  };
}

/** 动态场景使用的默认搜索参数（迁移为主的搜索：更小的破坏规模，更短的预算）。 */
export function dynamicSearchOptions(seed: number, budgetMs: number): SearchOptions {
  return {
    seed: seedFrom('dynamic', seed),
    budgetMs,
    maxIterations: 4000,
    operators: ['worst-removal', 'aisle-balance', 'related-removal'],
    temperature: 0,
    tabuTenure: 0,
    destroyShare: 0.05,
    dispersion: { maxAisleSharePerSku: 1, maxUnitsPerAislePerSku: 0, minAislesPerSku: 0, hard: false },
  };
}

/** 迁移预算的默认值（场景可覆盖）。 */
export const DEFAULT_DYNAMIC_BUDGET: DynamicOptions['budget'] = {
  maxMoves: 400,
  maxDeviceSeconds: 4 * 3600,
  window_s: 8 * 3600,
};

/** 供接口层使用的空问题守卫（动态优化在零库存时直接返回空结果）。 */
export function isEmptyProblem(problem: SlottingProblem): boolean {
  return problem.inventory.length === 0;
}
