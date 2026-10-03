/**
 * 运行历史与方案对比的**公共骨架**（APS / MAPF / AGV 共用，纯 TS，无 React/DOM）。
 *
 * 三个算法各有自己的指标集与面板，但下面这些规则是同一套：
 *   - 会话内最多保留多少次运行（超出淘汰最旧）；
 *   - 哪些运行之间**允许比较**（同一个问题：problem_hash 相同且非空）；
 *   - 对比表的一行长什么样（旧值 / 新值 / 方向判定）；
 *   - 「越小越好」「越大越好」「相等才算相同」三种方向语义。
 *
 * 这里只放骨架，不放任何算法语义：各自的 RunRecord 与指标行仍留在自己模块里
 * （`modules/mapf/runs/runs.ts`、`modules/agv/runs.ts` 等）。
 */

/** 会话内保留的运行上限（超出后淘汰最旧的一次）。 */
export const MAX_RUNS = 20;

/** 对比行方向：better / worse 描述 B 列相对 A 列；`''` 表示无从比较或不做方向判定。 */
export type RunVerdict = '' | 'better' | 'worse' | 'same';

/** 对比表的一行。 */
export interface RunDiffRow {
  label: string;
  a: string;
  b: string;
  verdict: RunVerdict;
}

/** 两条记录是否来自同一个问题（都是 null 视为不可比）。 */
export function sameProblem(a: { problemHash: string | null }, b: { problemHash: string | null }): boolean {
  return Boolean(a.problemHash && a.problemHash === b.problemHash);
}

/** 宽松取数：非有限数字一律返回 null（避免 NaN / Infinity 混进对比表）。 */
export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 数字展示：null → `—`；digits > 0 时固定小数位。 */
export function fmtNum(value: number | null, digits = 0): string {
  if (value == null) return '—';
  return digits ? value.toFixed(digits) : String(value);
}

/** 字节 → MB（保留 1 位）。 */
export function fmtMB(bytes: number | null): string {
  return bytes == null ? '—' : (bytes / 1048576).toFixed(1);
}

/** 布尔展示：null → `—`。 */
export function fmtBool(value: boolean | null, on = '是', off = '否'): string {
  return value == null ? '—' : value ? on : off;
}

/** 核验结论展示：null → `—`。 */
export function fmtVerified(value: boolean | null): string {
  return value == null ? '—' : value ? '✓' : '✗';
}

/** 越小越好型指标：B 比 A 小 = better。 */
export function lowerBetter(a: number | null, b: number | null): RunVerdict {
  if (a == null || b == null) return '';
  if (a === b) return 'same';
  return b < a ? 'better' : 'worse';
}

/** 越大越好型指标：B 比 A 大 = better。 */
export function higherBetter(a: number | null, b: number | null): RunVerdict {
  if (a == null || b == null) return '';
  if (a === b) return 'same';
  return b > a ? 'better' : 'worse';
}

/** 状态类取值：相等才算相同，不判定好坏。 */
export function sameWhenEqual<T>(a: T, b: T): RunVerdict {
  return a === b ? 'same' : '';
}

/** 组装一行（缺省不做方向判定——例如耗时/内存这类受硬件噪声影响的指标）。 */
export function row(label: string, a: string, b: string, verdict: RunVerdict = ''): RunDiffRow {
  return { label, a, b, verdict };
}
