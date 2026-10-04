/**
 * 确定性工具：散列 / 随机数 / 运动学 / 统计。
 *
 * 为什么自己写而不是引依赖：引擎要在**浏览器 Worker** 与 **Node CLI** 两处跑，
 * 结果必须逐位可复现（SRS §6.3）。任何依赖都可能在不同平台引入浮点或排序差异，
 * 因此这里只使用整数运算与 IEEE-754 明确规定的运算，并对浮点做定点化散列。
 */

import type { MotionProfile } from './types.ts';

/* ------------------------------------------------------------------ *
 * 1. 散列与规范化
 * ------------------------------------------------------------------ */

/** FNV-1a 32 位（用于稳定 id / 指纹的一部分）。 */
export function fnv1a(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 稳定指纹（16 位十六进制）。用于"同输入同配置 → 同指纹"的确定性断言。
 *
 * 浮点数先做 1e-6 定点化再散列，避免 0.1+0.2 这类表示差异造成"同方案不同指纹"。
 */
export function fingerprint(value: unknown): string {
  const text = canonicalJson(value, 6);
  const a = fnv1a(text);
  const b = fnv1a(text, 0x9e3779b9);
  const c = fnv1a(text, 0x85ebca6b);
  const d = fnv1a(text, 0xc2b2ae35);
  return [a, b, c, d].map((n) => n.toString(16).padStart(8, '0')).join('');
}

/** 规范化 JSON：键排序、数值定点、剔除 undefined，保证跨平台一致。 */
export function canonicalJson(value: unknown, digits = 6): string {
  const norm = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return String(v);
      const f = 10 ** digits;
      return Math.round(v * f) / f;
    }
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.map(norm);
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        if (obj[key] === undefined) continue;
        out[key] = norm(obj[key]);
      }
      return out;
    }
    return String(v);
  };
  return JSON.stringify(norm(value));
}

/* ------------------------------------------------------------------ *
 * 2. 确定性随机数（sfc32 + splitmix 初始化）
 * ------------------------------------------------------------------ */

export interface Rng {
  /** [0,1) 均匀分布。 */
  next(): number;
  /** [min,max) 均匀整数。 */
  int(min: number, max: number): number;
  /** 标准正态（Box–Muller，确定性）。 */
  normal(): number;
  /** 对数正态（长尾需求生成）。 */
  logNormal(mu: number, sigma: number): number;
  /** 由当前状态派生的子随机源（并行分区时不破坏主序列）。 */
  fork(salt: number): Rng;
  /** 当前内部状态（用于序列化与重放）。 */
  state(): number;
}

export function makeRng(seed: number): Rng {
  // splitmix64 的 32 位简化版：把任意种子扩展成 sfc32 的四个状态字。
  let s = seed >>> 0;
  const nextSeed = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s ^ (s >>> 16);
    z = Math.imul(z, 0x21f0aaad) >>> 0;
    z ^= z >>> 15;
    z = Math.imul(z, 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
  let a = nextSeed();
  let b = nextSeed();
  let c = nextSeed();
  let d = nextSeed();
  const next = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) >>> 0;
    t = (t + d) >>> 0;
    c = (c + t) >>> 0;
    return (t >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => {
    if (max <= min) return min;
    return min + Math.floor(next() * (max - min));
  };
  const normal = () => {
    // 不使用缓存：同一序列在任何平台上长度一致。
    const u1 = Math.max(next(), 1e-12);
    const u2 = next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  return {
    next,
    int,
    normal,
    logNormal: (mu, sigma) => Math.exp(mu + sigma * normal()),
    fork: (salt) => makeRng((fnv1a(`fork:${salt}`, a ^ b ^ c ^ d) ^ seed) >>> 0),
    state: () => a ^ b ^ c ^ d,
  };
}

/** 由字符串构造稳定种子（场景 → 问题生成）。 */
export function seedFrom(...parts: Array<string | number>): number {
  return fnv1a(parts.map((p) => String(p)).join('|'));
}

/* ------------------------------------------------------------------ *
 * 3. 运动学：梯形速度曲线（设备运行时间是调度成本的核心，不能只用"距离/速度"）
 * ------------------------------------------------------------------ */

/**
 * 走完 `distance` 米所需时间（秒），梯形速度曲线，两端各有加速 / 减速段。
 * 距离较短（达不到最高速）时退化为三角曲线 2·sqrt(d/a)。
 */
export function travelTime(distance: number, speed_mps: number, accel_mps2: number): number {
  const d = Math.max(0, distance);
  if (d === 0) return 0;
  const v = Math.max(0.05, speed_mps);
  const a = Math.max(0.05, accel_mps2);
  const dAccel = (v * v) / a; // 加速段 + 减速段总距离
  if (d <= dAccel) return 2 * Math.sqrt(d / a);
  return d / v + v / a;
}

/** 一次任务的设备时间（含取放与交接）。 */
export function moveTime(
  distance_m: number,
  motion: MotionProfile,
  opts: { loaded?: boolean; vertical?: boolean } = {},
): number {
  const loaded = opts.loaded ?? false;
  const factor = loaded ? (motion.loaded_speed_factor ?? 1) : 1;
  const base = travelTime(distance_m, motion.speed_mps * factor, motion.accel_mps2);
  return base * (opts.vertical ? 1.15 : 1); // 竖直运动按 1.15 折算为等效水平时间（工程经验值，显式标注）
}

/* ------------------------------------------------------------------ *
 * 4. 统计（指标计算与"是否均衡"判定）
 * ------------------------------------------------------------------ */

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const round = (v: number, digits = 3): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function stddev(values: readonly number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return Math.sqrt(acc / (values.length - 1));
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const idx = clamp(Math.round((p / 100) * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}

/** 基尼系数（0 = 完全均衡，1 = 极不均衡）；用于巷道 / 设备负载均衡度。 */
export function gini(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  let acc = 0;
  for (let i = 0; i < n; i += 1) acc += (i + 1) * sorted[i];
  return (2 * acc) / (n * total) - (n + 1) / n;
}

/** 条件风险价值（最差 α 比例的平均）；鲁棒优化的风险度量。 */
export function cvar(values: readonly number[], alpha = 0.2): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => b - a);
  const k = Math.max(1, Math.ceil(alpha * sorted.length));
  return mean(sorted.slice(0, k));
}

/** 归一化到 0–1（min→0, max→1）；全等时返回 0.5（不假装有区分度）。 */
export function normalize(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0.5;
  if (max - min < 1e-9) return 0.5;
  return clamp((value - min) / (max - min), 0, 1);
}

/* ------------------------------------------------------------------ *
 * 5. 时间与格式化
 * ------------------------------------------------------------------ */

export const nowIso = (): string => new Date().toISOString();

/** 秒 → `HH:MM:SS`（实验室时间轴显示；跨天显示 `d+N`）。 */
export function formatSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const day = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return day > 0 ? `d${day} ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

/** 秒 → 人类可读时长（"1.5 h" / "12.3 min"）。 */
export function humanDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${round(seconds, 1)} s`;
  if (seconds < 3600) return `${round(seconds / 60, 1)} min`;
  return `${round(seconds / 3600, 2)} h`;
}

/* ------------------------------------------------------------------ *
 * 6. 整数索引与集合（避免浮点键；提高散列稳定性）
 * ------------------------------------------------------------------ */

/** 二维索引打包成整数（拓扑内 bay/depth 等）。 */
export const pack2 = (a: number, b: number, width: number): number => a * width + b;
export const unpack2 = (packed: number, width: number): [number, number] => [
  Math.floor(packed / width),
  packed % width,
];

/** 确定性排序：先按 key，再按 id，避免 V8 引擎之间的排序差异。 */
export function sortByKey<T>(items: readonly T[], key: (item: T) => number, id: (item: T) => string): T[] {
  return [...items].sort((x, y) => {
    const kx = key(x);
    const ky = key(y);
    if (kx !== ky) return kx - ky;
    const ix = id(x);
    const iy = id(y);
    return ix < iy ? -1 : ix > iy ? 1 : 0;
  });
}

/** 记忆化：同一纯函数的重复调用（拓扑派生库位、距离矩阵）只算一次。 */
export function memoize<A extends string | number, R>(fn: (arg: A) => R): (arg: A) => R {
  const cache = new Map<A, R>();
  return (arg: A) => {
    const hit = cache.get(arg);
    if (hit !== undefined) return hit;
    const value = fn(arg);
    cache.set(arg, value);
    return value;
  };
}

/** 数组分块（大场景分区计算，SRS §8）。 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}
