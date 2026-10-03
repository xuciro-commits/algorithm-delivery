#!/usr/bin/env node
/**
 * 实验室核心逻辑冒烟（Node，无需浏览器）：
 *
 *   1. 直接加载 `src/vendor/aps-worker.js`（与页面同一份胶水）跑 WASM 求解；
 *   2. 用 esbuild 就地打包 `src/core/**` 的纯逻辑（与页面同一份源码）验证：
 *      - 参数模型（默认值、校验、options 映射、预设）
 *      - 运行记录与可视化转换（甘特行/资源利用率/指标卡片）
 *      - 核验报告汇总、两次运行对比
 *      - 模块注册表（重复 id 必须报错；planned 模块不冒充 ready）
 *
 * 这层的意义：把“实验室能不能正确解释引擎输出”变成可断言的测试，
 * 而不是靠人工点页面。界面渲染本身由 `npm run build`（tsc + vite）保证类型与可构建性。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHarness } from './lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const repoRoot = resolve(labDir, '..');

const { check, finish, failures } = createHarness('实验室核心冒烟');

async function loadCore() {
  const tmp = join(labDir, 'node_modules', '.lab-smoke');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const outfile = join(tmp, 'core.mjs');
  const entry = join(tmp, 'entry.ts');
  writeFileSync(
    entry,
    `export * from ${JSON.stringify(join(labDir, 'src/core/aps/params.ts'))};
export * from ${JSON.stringify(join(labDir, 'src/core/aps/transform.ts'))};
export * from ${JSON.stringify(join(labDir, 'src/core/aps/mocks.ts'))};
export * from ${JSON.stringify(join(labDir, 'src/core/registry.ts'))};
`,
  );
  // 用 esbuild 的 JS API（node_modules/esbuild/bin 是原生可执行文件，不能用 node 直接跑）
  const { build } = await import('esbuild');
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile,
    logLevel: 'warning',
  });
  return import(pathToFileURL(outfile).href);
}

/** 把基线实例按“独立车间单元”复制放大（等价 aps/rust/src/benchgen.rs::build_separable），
 *  用于验证 wasm-light 的规模上限拒绝路径。 */
function scaleProblem(base, operations) {
  if (operations % 24 !== 0) throw new Error('operations 必须是 24 的倍数');
  const cells = operations / 24;
  const out = JSON.parse(JSON.stringify(base));
  const prefixOf = (c) => `CELL${String(c + 1).padStart(3, '0')}__`;
  const machines = [];
  const workers = [];
  const tools = [];
  const materials = [];
  const orders = [];
  for (let c = 0; c < cells; c += 1) {
    const p = prefixOf(c);
    for (const m of base.machines) machines.push({ ...m, id: p + m.id });
    for (const w of base.workers) workers.push({ ...w, id: p + w.id });
    for (const t of base.tools) tools.push({ ...t, id: p + t.id });
    for (const mt of base.materials) {
      materials.push({ ...mt, id: p + mt.id, receipts: (mt.receipts ?? []).map((r) => ({ ...r })) });
    }
    for (const o of base.orders) {
      orders.push({
        ...o,
        id: p + o.id,
        operations: o.operations.map((op) => ({
          ...op,
          id: p + op.id,
          predecessors: (op.predecessors ?? []).map((x) => p + x),
          alternatives: op.alternatives.map((a) => ({ ...a, machine_id: p + a.machine_id })),
          tools: (op.tools ?? []).map((x) => p + x),
          materials: Object.fromEntries(
            Object.entries(op.materials ?? {}).map(([k, v]) => [p + k, v]),
          ),
        })),
      });
    }
  }
  Object.assign(out, { machines, workers, tools, materials, orders });
  out.meta = { ...out.meta, snapshot_id: `lab-bench-${operations}-separable` };
  return out;
}

async function main() {
  // ---------------- 1) WASM + 胶水（与页面同源） ----------------
  const wasmPath = process.env.LAB_WASM ?? join(repoRoot, 'aps/rust/dist/aps_engine.wasm');
  const workerPath = join(labDir, 'src/vendor/aps-worker.js');
  if (!existsSync(wasmPath)) {
    console.error(`✗ 找不到 wasm 产物：${wasmPath}（先运行 cd aps/rust && bash scripts/build_wasm.sh）`);
    process.exit(2);
  }
  const { createEngine } = await import(`${pathToFileURL(workerPath).href}?t=${Date.now()}`);
  const engine = await createEngine(new Uint8Array(readFileSync(wasmPath)));
  check('wasm 装载（与页面同一份胶水）', typeof engine.version === 'string', `v${engine.version}`);
  check('分析类导出齐全（核验/指纹/能力声明/参数覆盖）', engine.hasAnalysis === true);

  const baselineText = readFileSync(join(repoRoot, 'aps/mock/baseline.json'), 'utf8');
  const params = { seed: 42, time_limit_ms: 800, strategy: 'lexicographic', rule: 'auto', repair: true };

  const t0 = Date.now();
  const solved = engine.solve(baselineText, params);
  const wall = Date.now() - t0;
  check(
    '求解 baseline（带参数覆盖）',
    solved.status === 'FEASIBLE' || solved.status === 'OPTIMAL',
    `${solved.status} · ${(solved.solution?.operations ?? []).length} 工序 · ${wall} ms`,
  );
  check('参数覆盖生效（写入方案 options）', solved.solution?.options?.seed === 42 && solved.solution?.options?.rule === 'auto');
  check(
    '指标字段完整（首解/总耗时/内存）',
    typeof solved.solution?.metrics?.first_feasible_ms === 'number' &&
      typeof solved.solution?.metrics?.total_ms === 'number' &&
      typeof solved.solution?.metrics?.peak_memory_bytes === 'number',
  );

  // 同参数两次运行 → 指纹一致（实验室“多次运行对比”的前提）
  const again = engine.solve(baselineText, params);
  const fp1 = engine.fingerprint(solved.raw).report.fingerprint;
  const fp2 = engine.fingerprint(again.raw).report.fingerprint;
  check('同参数两次运行指纹一致', fp1 === fp2, fp1?.slice(0, 24) + '…');

  // 不同规则 → 方案可以不同（实验室要能看出差异）
  const alt = engine.solve(baselineText, { ...params, rule: 'random', seed: 7 });
  check('切换规则仍可求解', alt.status === 'FEASIBLE' || alt.status === 'OPTIMAL', alt.status);

  // 核验（严格 vs 宽松）
  const lax = engine.verify(baselineText, solved.raw, { strict: false }).report;
  check('独立核验（宽松）通过', lax.ok === true, `violations=${lax.counts?.violations ?? 0}`);
  const strict = engine.verify(baselineText, solved.raw, { strict: true }).report;
  check('独立核验（严格）也通过（引擎自带绑定字段）', strict.ok === true, strict.mode);
  const broken = JSON.parse(solved.raw);
  broken.problem_hash = 'sha256:0000';
  const tampered = engine.verify(baselineText, JSON.stringify(broken), { strict: true }).report;
  check('篡改 problem_hash 被检出', tampered.ok === false && tampered.counts?.errors > 0);

  // 超规模 → 显式拒绝（wasm-light 600 工序上限）
  const big = scaleProblem(JSON.parse(baselineText), 648); // 27 个车间单元 × 24 工序
  const over = engine.solve(JSON.stringify(big), { time_limit_ms: 100 });
  check(
    '超出 wasm-light 上限时显式拒绝',
    over.status === 'UNSUPPORTED_CONSTRAINT' || over.status === 'MODEL_INVALID',
    over.status,
  );

  // ---------------- 2) 纯逻辑（与页面同源） ----------------
  const core = await loadCore();

  const defaults = core.DEFAULT_PARAMS;
  check('默认参数可用', core.validateParams(defaults).length === 0, core.paramsLabel(defaults));
  check('非法参数被拦截（负种子/零预算/未知规则）',
    core.validateParams({ ...defaults, seed: -1 }).length > 0 &&
      core.validateParams({ ...defaults, timeLimitMs: 0 }).length > 0 &&
      core.validateParams({ ...defaults, rule: 'nope' }).length > 0);
  const opts = core.paramsToOptions(defaults);
  check('参数 → WASM 覆盖对象字段正确',
    opts.seed === 42 && opts.time_limit_ms === 2000 && opts.rule === 'auto' && opts.repair === true);
  check('预设档位齐备', core.PARAM_PRESETS.length >= 4);

  const problem = JSON.parse(baselineText);
  const solution = solved.solution;
  const visual = core.buildVisualization(problem, solution);
  check('甘特模型：24 道工序 / 8 个订单',
    visual.model.operationCount === 24 && visual.model.rows.length === 8,
    `bars=${visual.model.operationCount}`);
  const machineSkill = visual.model.rows.every((row) =>
    row.bars.every((b) => b.skill !== 'unknown'),
  );
  check('甘特条能回填技能（用于着色）', machineSkill);
  check('资源利用率在 0..1 且机器数正确',
    visual.resources.filter((r) => r.kind === 'machine').length === 5 &&
      visual.resources.every((r) => r.utilization >= 0 && r.utilization <= 1),
    visual.resources.map((r) => `${r.id}:${(r.utilization * 100).toFixed(0)}%`).join(' '));
  check('资源时间线覆盖机器+人员', visual.timelines.length === 13);

  const cards = core.metricCards(solution, wall);
  const cardKeys = cards.map((c) => c.key);
  check('指标卡片包含首解/总耗时/内存/目标',
    ['first', 'total', 'memory', 'wt', 'makespan', 'bound', 'late'].every((k) => cardKeys.includes(k)),
    cardKeys.join(','));

  const digest = core.digestVerify(lax);
  check('核验汇总：通过且无 error', digest.ok && digest.errors === 0);
  const digestBad = core.digestVerify(tampered);
  check('核验汇总：篡改后能报出代码与计数',
    !digestBad.ok && digestBad.byCode.some((c) => c.code === 'PROBLEM_HASH_MISMATCH'));

  // 运行记录对比（同问题、不同规则）
  const mkRecord = (rawSolution, raw, name) => ({
    id: name,
    label: name,
    createdAt: Date.now(),
    params: defaults,
    problemName: 'baseline',
    problemHash: rawSolution.problem_hash ?? null,
    snapshotId: rawSolution.snapshot_id ?? null,
    status: rawSolution.status,
    statusCode: 2,
    solution: rawSolution,
    raw,
    fingerprint: engine.fingerprint(raw).report.fingerprint,
    fingerprintReport: null,
    verify: null,
    metrics: {
      firstFeasibleMs: rawSolution.metrics?.first_feasible_ms ?? null,
      totalMs: rawSolution.metrics?.total_ms ?? null,
      compileMs: null,
      solveMs: null,
      verifyMs: null,
      peakMemoryBytes: rawSolution.metrics?.peak_memory_bytes ?? null,
      wallMs: wall,
    },
    gantt: visual.model,
    resources: visual.resources,
    timelines: visual.timelines,
    engineVersion: rawSolution.engine_version ?? null,
  });
  const recA = mkRecord(solved.solution, solved.raw, 'A');
  const recB = mkRecord(alt.solution, alt.raw, 'B');
  const cmp = core.compareRuns(recA, recB);
  check('方案对比：能给出变更工序数与指标差',
    cmp.comparedOperations === 24 && cmp.changedOperations >= 0 && 'makespan' in cmp.deltas,
    `changed=${cmp.changedOperations}`);
  const cmpSelf = core.compareRuns(recA, recA);
  check('同一运行自比：零变更 + 指纹相同', cmpSelf.changedOperations === 0 && cmpSelf.sameFingerprint === true);

  // 导入校验
  check('导入：合法 PlanProblem 通过', core.importProblem(baselineText, 'x.json').ok === true);
  check('导入：缺 orders 被拒', core.importProblem('{"meta":{}}', 'x.json').ok === false);
  check('导入：非 JSON 被拒', core.importProblem('nope', 'x.json').ok === false);

  // 模块注册表
  const before = core.listModules().length;
  core.registerModule({ id: 'tmp-a', name: 'A', tagline: '', category: 'X', status: 'ready' });
  check('注册表：可注册新算法模块', core.listModules().length === before + 1);
  let dup = false;
  try {
    core.registerModule({ id: 'tmp-a', name: 'A2', tagline: '', category: 'X', status: 'ready' });
  } catch {
    dup = true;
  }
  check('注册表：重复 id 报错（避免模块互覆盖）', dup);
  core.__resetRegistry();

finish('✓ 实验室核心冒烟全部通过');
}

await main().catch((err) => {
  // 异常也走统一出口：退出码与非零判定由 harness 负责
  failures.push(`冒烟异常：${err?.stack ?? err}`);
  finish('实验室核心冒烟');
});
