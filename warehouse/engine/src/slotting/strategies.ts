/**
 * 基础库位分配策略（SRS §3.1）。
 *
 * 这些策略是**有明确业务含义的对照基线**，不是"凑数的排序规则"：
 * 每一种都对应真实仓库里确实会被采用的做法，因此它们的差异可以被解释、也可以被复现。
 *
 * 共同约定：
 *   - 全部遵守硬约束（容量 / 分区 / 冻结 / 深位），不做"先违规再修复"；
 *   - 全部是确定性的（同输入同结果），便于与其他算法做可比对照；
 *   - 都不使用关联度（关联是 §3.2 的高阶能力），因此"关联分配效果"指标上应明显落后。
 */

import { makeRng, seedFrom } from '../contract/util.ts';
import { canPlace, SlottingState, type SlottingModel } from './model.ts';

export type BaselineStrategy =
  | 'random'
  | 'fixed'
  | 'nearest-available'
  | 'abc'
  | 'turnover'
  | 'coi'
  | 'capacity-class'
  | 'scatter';

export interface StrategyResult {
  strategy: BaselineStrategy;
  /** 货物单元 → 库位下标。 */
  assignment: Int32Array;
  /** 每个 SKU 使用的库位数量（分散度统计）。 */
  locationsPerSku: Int32Array;
  notes: string;
}

export const STRATEGY_LABEL: Record<BaselineStrategy, string> = {
  random: '随机储位（对照）',
  fixed: '固定储位（SKU 专区）',
  'nearest-available': '最近可用库位',
  abc: 'ABC 分类分区',
  turnover: '周转率优先（近出库口）',
  coi: 'COI（Cube-per-Order Index）',
  'capacity-class': '区域容量分类',
  scatter: '带分散规则的储位策略',
};

/** 每个 SKU 的"位置偏好分"（越小越优先）：基础策略的差别都在这里。 */
function preferenceScore(
  strategy: BaselineStrategy,
  model: SlottingModel,
  skuIdx: number,
  locIdx: number,
  skuOrderIndex: number,
): number {
  const cost = model.locationCost[locIdx];
  const sku = model.skus[skuIdx];
  const flow = model.skuDailyOut[skuIdx];
  const volume = model.skuVolume[skuIdx];
  const weight = model.skuWeight[skuIdx];
  const pick = cost.pickSeconds * model.costConfig.outboundShare + cost.putSeconds * (1 - model.costConfig.outboundShare);
  switch (strategy) {
    case 'random':
      return 0;
    case 'fixed':
      // 固定储位：按 SKU 编号哈希到固定的库位段（真实仓库里"每个 SKU 一个专区"的做法）
      return Math.abs(((skuOrderIndex * 2654435761) % model.placeableLocations.length) - (locIdx % model.placeableLocations.length));
    case 'nearest-available':
      return pick;
    case 'abc':
      // A 类占最优区域（按运行时间排序的前 20%），B 类 20–50%，C 类其余
      return rankTier(model, locIdx) * 1000 + (sku.abc === 'A' ? 0 : sku.abc === 'B' ? 1 : 2);
    case 'turnover':
      return pick - flow * 1.2;
    case 'coi':
      // COI = 体积 / 周转次数：单位流量占用的体积越小越应靠近出库口
      return pick + (volume / Math.max(0.0001, flow)) * 25;
    case 'capacity-class':
      // 区域容量分类：先按体积/重量匹配库位承载能力，再按运行时间
      return Math.abs(model.locMaxVolume[locIdx] - volume * 1.6) * 200 + Math.abs(model.locMaxWeight[locIdx] - weight * 1.4) * 0.4 + pick * 0.6;
    case 'scatter':
      // 分散策略：同类 SKU 尽量落在不同巷道（避免热点集中），再按运行时间
      return pick + (locIdx % Math.max(1, model.aisleIds.length)) * 3;
    default:
      return pick;
  }
}

/** 库位按运行时间的分档（0 = 最快，1 = 中，2 = 慢）。 */
function rankTier(model: SlottingModel, locIdx: number): number {
  const order = model.locationOrderByCost;
  const position = order.indexOf(locIdx);
  if (position < 0) return 3;
  const ratio = position / Math.max(1, order.length);
  return ratio < 0.2 ? 0 : ratio < 0.5 ? 1 : 2;
}

/**
 * 运行一个基础策略。
 *
 * 分配顺序很重要（这也是真实仓库的差异来源）：
 *   - 先按"热度"排 SKU（A 类先挑位置），再在候选库位里按偏好分选；
 *   - `scatter` 会限制同一 SKU 同一巷道的库位数（库存分散规则）。
 */
export function runBaselineStrategy(model: SlottingModel, strategy: BaselineStrategy, seed = 1): StrategyResult {
  const rng = makeRng(seedFrom('strategy', strategy, seed));
  const assignment = new Int32Array(model.loadUnits.length).fill(-1);
  const occupancy = new Uint8Array(model.locations.length);
  const locationsPerSku = new Int32Array(model.skus.length);
  const aisleUsePerSku = new Map<number, Map<number, number>>();

  // 候选库位：按偏好分预排序（每个 SKU 的顺序不同，因此逐个 SKU 计算）
  const placeable = model.placeableLocations;
  const skuOrder = Array.from({ length: model.skus.length }, (_, i) => i).sort((a, b) => {
    const fa = model.skuDailyOut[a];
    const fb = model.skuDailyOut[b];
    if (fa !== fb) return fb - fa;
    return model.skus[a].id < model.skus[b].id ? -1 : 1;
  });
  const luBySku = new Map<number, number[]>();
  for (let lu = 0; lu < model.loadUnits.length; lu += 1) {
    const list = luBySku.get(model.luSku[lu]) ?? [];
    list.push(lu);
    luBySku.set(model.luSku[lu], list);
  }

  for (let order = 0; order < skuOrder.length; order += 1) {
    const skuIdx = skuOrder[order];
    const units = luBySku.get(skuIdx) ?? [];
    if (units.length === 0) continue;
    const scatterLimit = strategy === 'scatter' ? Math.max(2, Math.ceil(model.aisleIds.length / 2)) : Number.POSITIVE_INFINITY;
    const aisleCounts = new Map<number, number>();
    for (const lu of units) {
      // 计算候选（该 SKU 的可行库位），取偏好分最优的前 K 个再随机/确定性挑选
      let bestIdx = -1;
      let bestScore = Number.POSITIVE_INFINITY;
      let evaluated = 0;
      const step = Math.max(1, Math.floor(placeable.length / 4000)); // 大场景下按步长抽样评估，保持确定性
      for (let i = 0; i < placeable.length; i += step) {
        const locIdx = placeable[i];
        if (occupancy[locIdx] === 1) continue;
        if (strategy === 'scatter') {
          const aisle = model.locationCost[locIdx].aisleIndex;
          if ((aisleCounts.get(aisle) ?? 0) >= scatterLimit) continue;
        }
        const check = canPlace(model, lu, locIdx);
        if (!check.ok) continue;
        evaluated += 1;
        const score = preferenceScore(strategy, model, skuIdx, locIdx, order);
        if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) < 1e-9 && rng.next() < 0.5)) {
          bestScore = score;
          bestIdx = locIdx;
        }
        if (evaluated > 400) break; // 每个货物单元最多评估 400 个候选（预算可控且确定性）
      }
      if (bestIdx >= 0) {
        assignment[lu] = bestIdx;
        occupancy[bestIdx] = 1;
        locationsPerSku[skuIdx] += 1;
        const aisle = model.locationCost[bestIdx].aisleIndex;
        aisleCounts.set(aisle, (aisleCounts.get(aisle) ?? 0) + 1);
      }
    }
    void aisleUsePerSku;
  }

  return {
    strategy,
    assignment,
    locationsPerSku,
    notes: `${STRATEGY_LABEL[strategy]}：按热度顺序分配，硬约束在分配时逐个判定`,
  };
}

/**
 * 由策略结果构造状态：统一走 SlottingState.rebuild（全量建状态 + 迁移代价）。
 *
 * 之所以不在这里重复实现增量填充：状态维护只有一处实现，
 * 避免"策略里的账"和"搜索里的账"两套算法（两套算法必然漂移）。
 */
export function stateFromAssignment(model: SlottingModel, assignment: Int32Array, recomputeRelocation = true): SlottingState {
  const state = SlottingState.rebuild(model, assignment);
  if (recomputeRelocation) state.recomputeRelocation();
  return state;
}

