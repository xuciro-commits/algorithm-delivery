/**
 * 求解参数模型：实验室里可调的旋钮，与 CLI 的 `--seed/--time-limit-ms/--strategy/
 * --rule/--no-repair/--max-iterations` 一一对应。
 *
 * 这些参数通过 `aps_solve_with_options`（宿主级覆盖）传给 WASM，
 * **不写进 PlanProblem 文件** —— 问题定义与求解器旋钮分开，
 * 同一问题在多次运行里的 `problem_hash` 保持不变，才谈得上“同问题对比”。
 */

export type Strategy = 'lexicographic' | 'makespan';

export const RULES = [
  'auto',
  'priority-edd',
  'wspt',
  'spt',
  'min-end',
  'most-slack',
  'random',
] as const;
export type Rule = (typeof RULES)[number];

export const RULE_LABELS: Record<Rule, string> = {
  auto: 'auto（自动择优）',
  'priority-edd': 'priority-edd（优先级 + 交期）',
  wspt: 'wspt（加权最短加工时间）',
  spt: 'spt（最短加工时间）',
  'min-end': 'min-end（最早完工）',
  'most-slack': 'most-slack（最松弛）',
  random: 'random（随机，对照用）',
};

export interface SolveParams {
  seed: number;
  timeLimitMs: number;
  strategy: Strategy;
  rule: Rule;
  repair: boolean;
  maxIterations: number;
}

export const DEFAULT_PARAMS: SolveParams = {
  seed: 42,
  timeLimitMs: 2000,
  strategy: 'lexicographic',
  rule: 'auto',
  repair: true,
  maxIterations: 100000,
};

export interface ParamPreset {
  id: string;
  name: string;
  note: string;
  params: SolveParams;
}

/** 常用档位：让“每次算法迭代后直接在实验室对比”有一个固定口径。 */
export const PARAM_PRESETS: ParamPreset[] = [
  {
    id: 'quick',
    name: '快速预览',
    note: '0.5 s 预算，先看方案形状',
    params: { ...DEFAULT_PARAMS, timeLimitMs: 500 },
  },
  {
    id: 'standard',
    name: '标准对比',
    note: '2 s 预算 + 自动规则，日常回归用',
    params: { ...DEFAULT_PARAMS },
  },
  {
    id: 'deep',
    name: '深度搜索',
    note: '10 s 预算，尽量榨干启发式',
    params: { ...DEFAULT_PARAMS, timeLimitMs: 10_000 },
  },
  {
    id: 'norule',
    name: '单规则基线',
    note: '关闭修复、固定 priority-edd，做算法改动前后的对照',
    params: {
      ...DEFAULT_PARAMS,
      timeLimitMs: 500,
      rule: 'priority-edd',
      repair: false,
      maxIterations: 1,
    },
  },
];

export function validateParams(p: SolveParams): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(p.seed) || p.seed < 0) errors.push('种子必须是不小于 0 的整数');
  if (!Number.isFinite(p.timeLimitMs) || p.timeLimitMs <= 0) errors.push('时间预算必须大于 0 ms');
  if (p.timeLimitMs > 600_000) errors.push('时间预算上限 600000 ms（避免页面长时间无响应）');
  if (!Number.isInteger(p.maxIterations) || p.maxIterations < 0)
    errors.push('迭代上限必须是不小于 0 的整数');
  if (!RULES.includes(p.rule)) errors.push(`未知搜索规则：${p.rule}`);
  if (p.strategy !== 'lexicographic' && p.strategy !== 'makespan')
    errors.push(`未知优化目标：${p.strategy}`);
  return errors;
}

/** 转成 WASM 的覆盖对象（字段名与 Rust 侧 `apply_overrides` 对齐）。 */
export function paramsToOptions(p: SolveParams): Record<string, unknown> {
  const options: Record<string, unknown> = {
    seed: p.seed,
    time_limit_ms: p.timeLimitMs,
    strategy: p.strategy,
    rule: p.rule,
    repair: p.repair,
  };
  // maxIterations = 0 表示“不限制”，此时不覆盖引擎默认值，避免意外把搜索锁死
  if (p.maxIterations > 0) options.max_iterations = p.maxIterations;
  else options.max_iterations = 0;
  return options;
}

export function paramsLabel(p: SolveParams): string {
  return `seed=${p.seed} · ${p.timeLimitMs}ms · ${p.strategy} · ${p.rule} · ${
    p.repair ? 'repair' : 'no-repair'
  }`;
}
