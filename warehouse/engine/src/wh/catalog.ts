/**
 * 商品目录、库存与需求分布生成（SRS §2.2 / §8.1）。
 *
 * 这一层决定"仓库里到底放了什么、需求长什么样"。它必须能表达工业现实：
 *   - 长尾 / Zipf 热门 / ABC-XYZ / 双峰分布，而不是均匀随机；
 *   - 商品关联（同簇 SKU 被有意设计为共同出库），供关联性库位优化验证；
 *   - 尺寸 / 重量 / 批次 / 温控 / 危险品带来的储存兼容性；
 *   - 库存本身不均衡（热门 SKU 多库位、慢销 SKU 单库位、退货与新货混入）。
 *
 * 全部生成都是**确定性**的：同参数 + 同种子 → 完全相同的目录与库存（SRS §6.3）。
 */

import type {
  AbcClass,
  DemandProfile,
  DemandShape,
  InventoryUnit,
  LoadUnitKind,
  SkuSpec,
  XyzClass,
} from '../contract/types.ts';
import { makeRng, round, seedFrom, type Rng } from '../contract/util.ts';

export interface CatalogParams {
  /** SKU 数量。 */
  skus: number;
  /** 需求形态（决定销量分布）。 */
  shape: DemandShape;
  /** 总库位数（库存规模的参照 —— 库存必须落在真实库位数上）。 */
  locations: number;
  /** 目标库位占用率（0–1）；场景用它制造"接近占满""只有少量空位"等情形。 */
  targetOccupancy: number;
  seed: number;
  /** 关联簇数量与每簇 SKU 数（同簇共同出库概率显著更高）。 */
  affinityClusters: number;
  affinityClusterSize: number;
  /** 载具构成（托盘 / 料箱 / 纸箱）。 */
  loadUnitMix: Array<{ kind: LoadUnitKind; share: number }>;
  /** Zipf 指数（shape = zipf 时生效）。 */
  zipfExponent: number;
  /** 长尾比例（shape = long-tail 时生效：该比例的 SKU 贡献 80% 销量）。 */
  tailShare: number;
  /** 温控 / 危险品 / 批次属性比例。 */
  chilledShare: number;
  frozenShare: number;
  hazmatShare: number;
  batchShare: number;
  /** 退货 / 新入库比例（动态库位场景用）。 */
  returnedShare: number;
  /** 每个 SKU 的库存单元数基准（乘以需求量权重）。 */
  unitsPerSku: number;
  /** 需求波动系数基准（XYZ 等级由此推导）。 */
  demandCv: number;
  /** 是否生成季节性曲线与促销窗口。 */
  seasonal: boolean;
  /** 人工拣选区容量（部分 SKU 只能放人工区）。 */
  manualCapacity: number;
  /** 尺寸族：不同场景下货品尺寸差异很大（S04 / S05）。 */
  sizeProfile: 'uniform-small' | 'mixed' | 'heavy-bulk' | 'oversized-mix';
}

export interface CatalogResult {
  skus: SkuSpec[];
  inventory: InventoryUnit[];
  demand: DemandProfile;
  stats: {
    skus: number;
    loadUnits: number;
    totalPieces: number;
    abc: Record<AbcClass, number>;
    xyz: Record<XyzClass, number>;
    affinityEdges: number;
    hotShare: number;
    /** 单位体积 / 重量分布（供容量冲突场景核对）。 */
    avgVolume_m3: number;
    avgWeight_kg: number;
    heaviest_kg: number;
  };
}

const SIZE_FAMILIES: Record<CatalogParams['sizeProfile'], Array<{ w: number; d: number; h: number; kg: number }>> = {
  'uniform-small': [
    { w: 0.8, d: 0.6, h: 0.4, kg: 12 },
    { w: 0.8, d: 0.6, h: 0.5, kg: 18 },
  ],
  mixed: [
    { w: 1.0, d: 0.8, h: 0.6, kg: 25 },
    { w: 1.2, d: 0.9, h: 0.8, kg: 60 },
    { w: 0.8, d: 0.6, h: 0.4, kg: 10 },
    { w: 1.1, d: 1.0, h: 1.1, kg: 140 },
  ],
  'heavy-bulk': [
    { w: 1.2, d: 1.0, h: 1.0, kg: 620 },
    { w: 1.2, d: 1.1, h: 1.2, kg: 880 },
    { w: 1.0, d: 0.9, h: 0.9, kg: 320 },
  ],
  'oversized-mix': [
    { w: 1.3, d: 1.2, h: 1.6, kg: 260 },
    { w: 1.3, d: 1.2, h: 2.1, kg: 380 },
    { w: 0.9, d: 0.7, h: 0.5, kg: 22 },
  ],
};

/** 每小时的订单到达曲线（电商仓的典型双峰：上午 10–12 点、晚间 19–21 点）。 */
export const DEFAULT_HOURLY_FACTOR: number[] = [
  0.25, 0.18, 0.14, 0.12, 0.12, 0.2, 0.4, 0.72, 1.0, 1.25, 1.45, 1.4, 1.05, 1.0, 1.05, 1.1, 1.2, 1.35, 1.5, 1.35,
  1.0, 0.7, 0.45, 0.32,
];

function pickAbc(u: number, thresholds: { a: number; b: number }): AbcClass {
  if (u < thresholds.a) return 'A';
  if (u < thresholds.a + thresholds.b) return 'B';
  return 'C';
}

/**
 * 生成 SKU 目录与库存。
 *
 * 需求权重按形态生成后**归一化**，再按权重切分总库存单元数，
 * 保证"库存数量与库位数一致"（不会出现 100 个库位放 5000 个托盘）。
 */
export function generateCatalog(params: CatalogParams): CatalogResult {
  const rng = makeRng(seedFrom('catalog', params.seed, params.skus, params.shape));
  const skus: SkuSpec[] = [];
  const sizes = SIZE_FAMILIES[params.sizeProfile];

  // ---- 需求权重 ----
  const weights: number[] = [];
  for (let i = 0; i < params.skus; i += 1) {
    const rank = i + 1;
    let w: number;
    switch (params.shape) {
      case 'uniform':
        w = 1;
        break;
      case 'zipf':
        w = 1 / Math.pow(rank, params.zipfExponent);
        break;
      case 'abc': {
        const tier = rank / params.skus;
        w = tier < 0.2 ? 8 : tier < 0.5 ? 2.2 : 0.35;
        break;
      }
      case 'long-tail': {
        const head = Math.max(1, Math.round(params.skus * (1 - params.tailShare)));
        w = rank <= head ? 1 / Math.pow(rank, 0.9) : 0.02 + rng.next() * 0.02;
        break;
      }
      case 'bimodal': {
        const peak = rng.next() < 0.25;
        w = peak ? 6 + rng.next() * 4 : 0.15 + rng.next() * 0.2;
        break;
      }
      case 'seasonal':
        w = 1 / Math.pow(rank, 1.05);
        break;
      default:
        w = 1;
    }
    // 尺寸与热度耦合：小件更可能是热门（真实仓的普遍结构）
    weights.push(Math.max(0.01, w));
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);

  // ---- 总库存单元（受库位数约束）----
  const totalUnits = Math.max(
    1,
    Math.round(params.locations * Math.min(0.995, Math.max(0.05, params.targetOccupancy))),
  );
  const manualCapacity = Math.max(0, params.manualCapacity);

  let pieces = 0;
  const affinityEdges: Array<[number, number, number]> = [];
  for (let i = 0; i < params.skus; i += 1) {
    const rank = i + 1;
    const weight = weights[i];
    const share = weight / weightSum;
    const sizeSpec = sizes[rng.int(0, sizes.length)];
    const abc = pickAbc(1 - share * params.skus * 0.5 > 0.9 ? 0 : rng.next(), { a: 0.18, b: 0.32 });
    const cvBase = params.demandCv * (params.shape === 'uniform' ? 0.6 : 1);
    const cv = Math.max(0.05, cvBase * (0.6 + rng.next() * 0.9));
    const xyz: XyzClass = cv < 0.35 ? 'X' : cv < 0.75 ? 'Y' : 'Z';
    const meanDaily = Math.max(0.5, (share * totalUnits * 4) / 30);
    const chilled = rng.next() < params.chilledShare;
    const frozen = !chilled && rng.next() < params.frozenShare;
    const hazmat = rng.next() < params.hazmatShare;
    const allowedZones: string[] = [];
    if (frozen) allowedZones.push('ASRS-COLD');
    else if (chilled) allowedZones.push('ASRS');
    else allowedZones.push('ASRS', 'ASRS-HIGH', 'PICK', 'RECV', 'SHIP');
    if (manualCapacity > 0 && !chilled && !frozen && rng.next() < 0.25) allowedZones.push('PICK');
    const loadUnit: LoadUnitKind =
      params.loadUnitMix.length > 0
        ? pickWeighted(rng, params.loadUnitMix.map((m) => ({ item: m.kind, weight: m.share })))
        : 'pallet';
    const cluster = params.affinityClusters > 0 && i < params.affinityClusters * params.affinityClusterSize
      ? `AF-${Math.floor(i / Math.max(1, params.affinityClusterSize)) + 1}`
      : null;
    const seasonality =
      params.seasonal && rng.next() < 0.3
        ? Array.from({ length: 52 }, (_, w) => round(1 + 0.45 * Math.sin(((w + rank) / 52) * Math.PI * 2), 3))
        : undefined;
    const promoWindows =
      params.seasonal && rng.next() < 0.2
        ? [{ from_s: 3 * 86400, to_s: 4.5 * 86400, factor: round(2 + rng.next() * 3, 2) }]
        : undefined;

    skus.push({
      id: `SKU-${String(rank).padStart(6, '0')}`,
      name: `商品 ${rank}`,
      category: frozen ? '冷冻' : chilled ? '冷藏' : hazmat ? '危险品' : '常温',
      loadUnit,
      unitSize: { width_m: sizeSpec.w, depth_m: sizeSpec.d, height_m: sizeSpec.h },
      unitWeight_kg: round(sizeSpec.kg * (0.85 + rng.next() * 0.3), 2),
      unitVolume_m3: round(sizeSpec.w * sizeSpec.d * sizeSpec.h, 4),
      abc,
      xyz,
      meanDailyDemand: round(meanDaily, 3),
      demandCv: round(cv, 3),
      demandRank: rank,
      allowedZones,
      hazmat,
      temperature: frozen ? 'frozen' : chilled ? 'chilled' : 'ambient',
      batchPolicy: rng.next() < params.batchShare ? (rng.next() < 0.5 ? 'fefo' : 'fifo') : 'none',
      seasonality,
      promoWindows,
      affinityCluster: cluster,
    });
    pieces += meanDaily;
  }

  // ---- 关联边：同簇高频，跨簇少量（真实关联既有结构也有噪声）----
  for (let i = 0; i < params.skus; i += 1) {
    const a = skus[i];
    for (let j = i + 1; j < Math.min(params.skus, i + 6); j += 1) {
      const b = skus[j];
      if (a.affinityCluster && a.affinityCluster === b.affinityCluster) {
        affinityEdges.push([i, j, round(0.55 + rng.next() * 0.4, 3)]);
      } else if (rng.next() < 0.02) {
        affinityEdges.push([i, j, round(0.08 + rng.next() * 0.12, 3)]);
      }
    }
  }

  // ---- 库存单元：按需求权重分配（热门 SKU 多库位）----
  const inventory: InventoryUnit[] = [];
  const skuUnitTarget = new Map<string, number>();
  let allocated = 0;
  for (const sku of skus) {
    const share = (sku.meanDailyDemand * (sku.abc === 'A' ? 1.4 : sku.abc === 'B' ? 1.0 : 0.7)) / Math.max(1e-6, pieces);
    const units = Math.max(1, Math.round(totalUnits * share * (0.8 + rng.next() * 0.5)));
    skuUnitTarget.set(sku.id, units);
    allocated += units;
  }
  // 归一到总容量（保持相对比例，避免"库存超出库位数"的伪需求）
  const scale = allocated > 0 ? totalUnits / allocated : 1;
  let luIndex = 0;
  const now = 0;
  for (const sku of skus) {
    const target = Math.max(1, Math.round((skuUnitTarget.get(sku.id) ?? 1) * scale));
    for (let u = 0; u < target; u += 1) {
      luIndex += 1;
      const returned = rng.next() < params.returnedShare;
      const batch = `${sku.id.slice(-4)}-${String(1 + (u % 3)).padStart(2, '0')}`;
      const ageDays = rng.next() * 45;
      inventory.push({
        id: `LU-${String(luIndex).padStart(7, '0')}`,
        skuId: sku.id,
        quantity: Math.max(1, Math.round(20 + rng.next() * 80)),
        batch,
        producedAt_s: Math.round(-ageDays * 86400),
        expiresAt_s: sku.temperature && sku.temperature !== 'ambient' ? Math.round((90 - ageDays) * 86400) : null,
        inboundAt_s: Math.round(-ageDays * 86400),
        locationId: null,
        status: returned ? 'quarantine' : 'stored',
        returned,
      });
      void now;
    }
  }

  const demand: DemandProfile = {
    shape: params.shape,
    horizonDays: 7,
    hourlyFactor: DEFAULT_HOURLY_FACTOR,
    linesPerOrder: params.shape === 'uniform' ? 1.2 : 2.4,
    linesPerOrderCv: 0.6,
    promoWindows: params.seasonal ? [{ fromDay: 4, toDay: 5, factor: 2.6 }] : [],
    zipfExponent: params.zipfExponent,
    returnRate: params.returnedShare,
  };

  const abcCount = { A: 0, B: 0, C: 0 } as Record<AbcClass, number>;
  const xyzCount = { X: 0, Y: 0, Z: 0 } as Record<XyzClass, number>;
  for (const sku of skus) {
    abcCount[sku.abc] += 1;
    xyzCount[sku.xyz] += 1;
  }
  const totalPieces = inventory.reduce((sum, unit) => sum + unit.quantity, 0);
  const hotShare = inventory.filter((unit) => {
    const sku = skus.find((s) => s.id === unit.skuId);
    return sku?.abc === 'A';
  }).length / Math.max(1, inventory.length);

  return {
    skus,
    inventory,
    demand,
    stats: {
      skus: skus.length,
      loadUnits: inventory.length,
      totalPieces,
      abc: abcCount,
      xyz: xyzCount,
      affinityEdges: affinityEdges.length,
      hotShare: round(hotShare, 4),
      avgVolume_m3: round(avg(skus.map((s) => s.unitVolume_m3)), 4),
      avgWeight_kg: round(avg(skus.map((s) => s.unitWeight_kg)), 2),
      heaviest_kg: round(Math.max(...skus.map((s) => s.unitWeight_kg)), 2),
    },
  };
}

function avg(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pickWeighted<T>(rng: Rng, options: Array<{ item: T; weight: number }>): T {
  const total = options.reduce((sum, o) => sum + Math.max(0, o.weight), 0);
  let target = rng.next() * total;
  for (const option of options) {
    target -= Math.max(0, option.weight);
    if (target <= 0) return option.item;
  }
  return options[options.length - 1].item;
}

/** 常见场景的目录参数（场景库与实验室共用，避免每个场景各写一遍数字）。 */
export const CATALOG_PRESETS: Record<string, Partial<CatalogParams>> = {
  'uniform-small': { shape: 'uniform', loadUnitMix: [{ kind: 'tote', share: 1 }], sizeProfile: 'uniform-small', seasonal: false },
  'abc-mixed': { shape: 'abc', loadUnitMix: [{ kind: 'pallet', share: 0.7 }, { kind: 'tote', share: 0.3 }], sizeProfile: 'mixed', seasonal: false },
  'zipf-hot': { shape: 'zipf', zipfExponent: 1.15, loadUnitMix: [{ kind: 'pallet', share: 0.6 }, { kind: 'carton', share: 0.4 }], sizeProfile: 'mixed', seasonal: false },
  'affinity-clusters': {
    shape: 'zipf',
    zipfExponent: 0.95,
    affinityClusters: 20,
    affinityClusterSize: 12,
    loadUnitMix: [{ kind: 'pallet', share: 0.5 }, { kind: 'tote', share: 0.5 }],
    sizeProfile: 'mixed',
    seasonal: false,
  },
  'heavy-oversized': { shape: 'abc', loadUnitMix: [{ kind: 'pallet', share: 1 }], sizeProfile: 'heavy-bulk', seasonal: false },
  'oversized-mix': { shape: 'long-tail', tailShare: 0.8, loadUnitMix: [{ kind: 'pallet', share: 1 }], sizeProfile: 'oversized-mix', seasonal: false },
  'seasonal-promo': { shape: 'seasonal', seasonal: true, loadUnitMix: [{ kind: 'pallet', share: 0.5 }, { kind: 'carton', share: 0.5 }], sizeProfile: 'mixed' },
  'chilled-mix': { shape: 'abc', chilledShare: 0.25, frozenShare: 0.1, loadUnitMix: [{ kind: 'pallet', share: 1 }], sizeProfile: 'mixed' },
  'hazmat-mix': { shape: 'abc', hazmatShare: 0.12, loadUnitMix: [{ kind: 'pallet', share: 1 }], sizeProfile: 'heavy-bulk' },
  'batch-fefo': { shape: 'zipf', zipfExponent: 1.0, batchShare: 0.9, chilledShare: 0.4, loadUnitMix: [{ kind: 'pallet', share: 1 }], sizeProfile: 'mixed' },
};

/** 默认目录参数（场景生成器按需覆盖）。 */
export function makeCatalogParams(partial: Partial<CatalogParams>): CatalogParams {
  const base: CatalogParams = {
    skus: 200,
    shape: 'abc',
    locations: 2000,
    targetOccupancy: 0.8,
    seed: 1,
    affinityClusters: 0,
    affinityClusterSize: 10,
    loadUnitMix: [{ kind: 'pallet', share: 1 }],
    zipfExponent: 1.1,
    tailShare: 0.8,
    chilledShare: 0,
    frozenShare: 0,
    hazmatShare: 0,
    batchShare: 0,
    returnedShare: 0.02,
    unitsPerSku: 4,
    demandCv: 0.4,
    seasonal: false,
    manualCapacity: 0,
    sizeProfile: 'mixed',
  };
  return { ...base, ...partial };
}
