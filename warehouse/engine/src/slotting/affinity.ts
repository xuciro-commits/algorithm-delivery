/**
 * 商品关联度（SRS §3.2A）。
 *
 * 关联性库位优化的输入信号来自**真实订单历史**，而不是人为设定的簇：
 *   - 共出库频次（同一订单同时出现）；
 *   - 时间衰减（近期订单权重更高，关联结构会随时间变化）；
 *   - 置信度修正（支持度低的高关联容易过拟合，需要按出现次数收缩）；
 *   - 订单聚类（把订单看成 SKU 集合，用 Jaccard 相似度构造簇，供解释与初始化）。
 *
 * 关联度本身不是目标：把关联商品全塞进一个巷道会制造拥堵，
 * 因此这里只产出**关联权重**，"集中/分散"的取舍交给优化器与成本模型（SRS §3.2A 的红线）。
 */

import type { CustomerOrder, SkuSpec } from '../contract/types.ts';
import { round } from '../contract/util.ts';
import type { AffinitySummary } from './model.ts';

export interface AffinityOptions {
  /** 时间衰减的半衰期（天）：近期订单权重更高。 */
  halfLifeDays: number;
  /** 参与统计的订单窗口（从最新往前）；0 = 全部。 */
  windowDays: number;
  /** 支持度收缩强度（出现次数越少，权重越向 0 收缩）。 */
  shrink: number;
  /** 关联簇数量（0 = 不聚类，仅统计成对关联）。 */
  clusters: number;
  /** 每条 SKU 保留的关联邻居上限（稀疏化，控制内存与计算）。 */
  maxNeighbors: number;
  /** 关联权重的下限（低于它的对直接丢弃）。 */
  minWeight: number;
}

export const DEFAULT_AFFINITY: AffinityOptions = {
  halfLifeDays: 21,
  windowDays: 0,
  shrink: 8,
  clusters: 0,
  maxNeighbors: 12,
  minWeight: 0.02,
};

export interface AffinityStats {
  pairs: number;
  /** 平均关联度（只统计非零对）。 */
  meanWeight: number;
  /** 最强关联对（用于面板解释"为什么要放一起"）。 */
  topPairs: Array<{ a: string; b: string; weight: number; coOccurrences: number }>;
  /** 订单聚类规模分布。 */
  clusterSizes: number[];
  /** 关联商品平均共出库概率（用于"关联分配效果"指标）。 */
  coOccurrenceRate: number;
}

export interface AffinityResult {
  summary: AffinitySummary;
  stats: AffinityStats;
}

/**
 * 从订单历史计算关联度。
 *
 * 复杂度：O(Σ_order lines² )，对 10^5 订单 × 平均 2.6 行是可接受的；
 * 大场景下用 maxNeighbors 稀疏化 + 只保留窗口内的订单。
 */
export function computeAffinity(
  orders: readonly CustomerOrder[],
  skus: readonly SkuSpec[],
  skuIndex: Map<string, number>,
  options: AffinityOptions = DEFAULT_AFFINITY,
): AffinityResult {
  const n = skus.length;
  const pairKey = (a: number, b: number): number => (a < b ? a * n + b : b * n + a);
  const counts = new Map<number, { count: number; weighted: number }>();
  const skuCount = new Float64Array(n);
  const totalCount = new Float64Array(n);

  // 时间窗口：按最新订单的释放时刻向前推
  let latest = 0;
  for (const order of orders) latest = Math.max(latest, order.release_s);
  const windowSeconds = options.windowDays > 0 ? options.windowDays * 86400 : Number.POSITIVE_INFINITY;
  const cutoff = latest - windowSeconds;

  for (const order of orders) {
    if (order.release_s < cutoff) continue;
    const ageDays = Math.max(0, (latest - order.release_s) / 86400);
    const decay = Math.pow(0.5, ageDays / Math.max(1e-6, options.halfLifeDays));
    const unique = [...new Set(order.lines.map((line) => line.skuId))]
      .map((id) => skuIndex.get(id))
      .filter((idx): idx is number => idx !== undefined);
    for (const s of unique) {
      skuCount[s] += 1;
      totalCount[s] += decay;
    }
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const key = pairKey(unique[i], unique[j]);
        const entry = counts.get(key) ?? { count: 0, weighted: 0 };
        entry.count += 1;
        entry.weighted += decay;
        counts.set(key, entry);
      }
    }
  }

  // 归一化 + 支持度收缩：weight = weighted / (min(countA,countB) + shrink)
  const pairs = new Map<number, Array<{ sku: number; weight: number; count: number }>>();
  const stats: AffinityStats = {
    pairs: 0,
    meanWeight: 0,
    topPairs: [],
    clusterSizes: [],
    coOccurrenceRate: 0,
  };
  let weightSum = 0;
  let weightCount = 0;
  const allPairs: Array<{ a: number; b: number; weight: number; count: number }> = [];
  for (const [key, entry] of counts) {
    const a = Math.floor(key / n);
    const b = key % n;
    const support = Math.min(totalCount[a], totalCount[b]);
    const weight = entry.weighted / (support + options.shrink);
    if (!Number.isFinite(weight) || weight < options.minWeight) continue;
    allPairs.push({ a, b, weight, count: entry.count });
    weightSum += weight;
    weightCount += 1;
  }
  allPairs.sort((x, y) => (y.weight !== x.weight ? y.weight - x.weight : x.a - y.a || x.b - y.b));
  for (const pair of allPairs) {
    const listA = pairs.get(pair.a) ?? [];
    if (listA.length < options.maxNeighbors) listA.push({ sku: pair.b, weight: pair.weight, count: pair.count });
    if (listA.length <= options.maxNeighbors) pairs.set(pair.a, listA);
    const listB = pairs.get(pair.b) ?? [];
    if (listB.length < options.maxNeighbors) listB.push({ sku: pair.a, weight: pair.weight, count: pair.count });
    if (listB.length <= options.maxNeighbors) pairs.set(pair.b, listB);
  }
  for (const list of pairs.values()) list.sort((x, y) => y.weight - x.weight);
  stats.pairs = weightCount;
  stats.meanWeight = weightCount > 0 ? round(weightSum / weightCount, 4) : 0;
  stats.topPairs = allPairs.slice(0, 8).map((pair) => ({
    a: skus[pair.a].id,
    b: skus[pair.b].id,
    weight: round(pair.weight, 4),
    coOccurrences: pair.count,
  }));
  let orderLines = 0;
  for (const order of orders) orderLines += order.lines.length;
  stats.coOccurrenceRate = round(weightCount / Math.max(1, orderLines), 4);

  // ---- 关联簇（可选）：仅作为初始化与解释，不直接当作目标 ----
  const clusterOf = new Int32Array(n).fill(-1);
  let clusters = 0;
  if (options.clusters > 0) {
    // 确定性贪心：按关联权重从高到低合并，直到达到簇数或无法继续
    const parent = new Int32Array(n).map((_, i) => i);
    const find = (x: number): number => {
      let cur = x;
      while (parent[cur] !== cur) cur = parent[cur];
      return cur;
    };
    const union = (a: number, b: number): boolean => {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return false;
      parent[rb] = ra;
      return true;
    };
    let comps = n;
    for (const pair of allPairs) {
      if (comps <= options.clusters) break;
      if (union(pair.a, pair.b)) comps -= 1;
    }
    const labelMap = new Map<number, number>();
    for (let i = 0; i < n; i += 1) {
      const root = find(i);
      if (!labelMap.has(root)) labelMap.set(root, labelMap.size);
      clusterOf[i] = labelMap.get(root) as number;
    }
    clusters = labelMap.size;
    const sizes = new Array(clusters).fill(0);
    for (let i = 0; i < n; i += 1) sizes[clusterOf[i]] += 1;
    stats.clusterSizes = sizes;
  }

  return { summary: { pairs, clusterOf, clusters }, stats };
}

/**
 * 关联分配效果：**同一巷道内**关联商品的接近程度（越小越好）。
 *
 * 只统计有关联的对；没有关联对的场景返回 0 并在面板上标注"无关联数据"，
 * 不做任何填充式美化。
 */
export function affinityCoherence(
  summary: AffinitySummary,
  aisleOfSku: Int32Array,
  bayOfSku: Int32Array,
): number {
  let total = 0;
  let weightSum = 0;
  for (const [sku, list] of summary.pairs) {
    for (const pair of list) {
      if (pair.sku < sku) continue; // 每对只算一次
      const sameAisle = aisleOfSku[sku] === aisleOfSku[pair.sku];
      const distance = sameAisle ? Math.abs(bayOfSku[sku] - bayOfSku[pair.sku]) : 40; // 跨巷道按等效 40 列惩罚
      total += pair.weight * distance;
      weightSum += pair.weight;
    }
  }
  return weightSum > 0 ? round(total / weightSum, 4) : 0;
}
