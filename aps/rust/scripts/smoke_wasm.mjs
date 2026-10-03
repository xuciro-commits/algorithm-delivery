#!/usr/bin/env node
/**
 * WASM 冒烟测试：真实加载 dist/aps_engine.wasm，求解 mock/baseline.json，
 * 并断言状态、工序数、目标值与原生 CLI 一致（同一份源码）。
 *
 *   node scripts/smoke_wasm.mjs
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createEngine } from '../web/aps-worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');          // aps/rust
const aps = path.resolve(root, '..');           // aps
const wasmPath = process.argv[2] ?? path.join(root, 'dist', 'aps_engine.wasm');
const problemPath = process.argv[3] ?? path.join(aps, 'mock', 'baseline.json');

const wasmBytes = await readFile(wasmPath);
const rawProblem = JSON.parse(await readFile(problemPath, 'utf8'));
// 冒烟测试把预算压到 1 秒（契约里 baseline 的 objective.time_limit_ms = 30000）
const budgetMs = Number(process.env.APS_TIME_LIMIT_MS ?? 1000);
rawProblem.objective = { ...(rawProblem.objective ?? {}), time_limit_ms: budgetMs };
const problemText = JSON.stringify(rawProblem);

// 覆盖三条装载路径：字节（Uint8Array）、预编译 Module、以及 HTTP URL 分支（见 build_wasm.sh 的 file:// 用法）
const engines = [];
engines.push(['bytes', await createEngine(wasmBytes)]);
engines.push(['module', await createEngine(new WebAssembly.Module(wasmBytes))]);
if (process.env.APS_SMOKE_URL) {
  engines.push([`url(${process.env.APS_SMOKE_URL})`, await createEngine(process.env.APS_SMOKE_URL)]);
}
for (const [kind, eng] of engines) {
  if (eng.version !== engines[0][1].version) {
    console.error(`✗ 装载路径 ${kind} 的版本不一致`);
    process.exit(1);
  }
}
console.log(`装载路径: ${engines.map(([k]) => k).join(', ')}`);
const engine = engines[1][1]; // 用预编译 Module 路径做后续功能断言（此前该路径有缺陷）
console.log(`wasm 版本: ${engine.version}`);

const t0 = performance.now();
const { status, solution, statusCode } = engine.solve(problemText);
const ms = performance.now() - t0;

const ops = solution.operations ?? [];
console.log(`状态: ${status}（code=${statusCode}） / 工序数 ${ops.length} / ${ms.toFixed(1)} ms`);
console.log(`目标: 加权延期 ${solution.objective?.weighted_tardiness_minutes} 分钟, makespan ${solution.objective?.makespan_minutes} 分钟`);
console.log(`峰值内存: ${(engine.peakMemoryBytes() / 1048576).toFixed(2)} MB`);

const failures = [];
if (status !== 'FEASIBLE' && status !== 'OPTIMAL') failures.push(`状态应为 FEASIBLE/OPTIMAL，实际 ${status}`);
if (ops.length !== 24) failures.push(`工序数应为 24，实际 ${ops.length}`);
if (solution.verified !== true) failures.push('verified 应为 true');
if ((solution.violations ?? []).length !== 0) failures.push('不应有 violations');
if ((solution.objective?.weighted_tardiness_minutes ?? null) !== 0) failures.push('加权延期应为 0');

// ---- 分析类导出：核验 / 指纹 / 能力声明（实验室依赖它们，故纳入冒烟） ----
let capabilityReport = null;
if (engine.hasAnalysis) {
  capabilityReport = engine.capabilities();
  const caps = capabilityReport;
  if (caps.engine !== 'rust-heuristic') failures.push(`capabilities.engine 应为 rust-heuristic，实际 ${caps.engine}`);
  if (caps.version !== engine.version) failures.push(`capabilities.version 与 aps_version() 不一致：${caps.version} vs ${engine.version}`);
  if (caps.can_prove_optimal !== false) failures.push('wasm-light 不得声称可证明最优');
  if (caps.max_operations !== 600) failures.push(`max_operations 应为 600，实际 ${caps.max_operations}`);

  // 指纹：同一方案两次求解应一致，且忽略 metrics
  const fp1 = engine.fingerprint(engine.solve(problemText).raw).report.fingerprint;
  const fp2 = engine.fingerprint(engine.solve(problemText).raw).report.fingerprint;
  if (fp1 !== fp2) failures.push(`同输入两次求解的指纹不一致：${fp1} vs ${fp2}`);
  const withoutMetrics = JSON.parse(JSON.stringify(solution));
  withoutMetrics.metrics = { compile_ms: 12345, total_ms: 999999 };
  const fp3 = engine.fingerprint(JSON.stringify(withoutMetrics)).report.fingerprint;
  if (fp3 !== fp1) failures.push('指纹必须忽略运行期 metrics');

  // 核验：正常方案应 ok；篡改时间后应报违约；严格模式下缺绑定应报错
  const ok = engine.verify(problemText, JSON.stringify(solution)).report;
  if (ok.ok !== true) failures.push(`合法方案核验应通过，实际 ${JSON.stringify(ok.counts)}`);
  const tampered = JSON.parse(JSON.stringify(solution));
  tampered.operations[0].start_at = '2026-10-10T08:00:00-07:00';
  tampered.operations[0].end_at = '2026-10-10T08:15:00-07:00';
  const bad = engine.verify(problemText, JSON.stringify(tampered)).report;
  if (bad.ok !== false || bad.counts.errors === 0) failures.push('篡改后的方案必须被核验器检出');
  const strict = engine.verify(
    problemText,
    JSON.stringify({ ...solution, tenant_id: undefined, problem_hash: undefined }),
    { strict: true }
  ).report;
  if (strict.ok !== false) failures.push('严格模式下缺少 tenant_id/problem_hash 必须失败');
  console.log(
    `核验: 合法方案 ok=${ok.ok} / 篡改检出 ${bad.counts.violations} 条 / 严格模式 ok=${strict.ok}`
  );
  console.log(`指纹: ${fp1.slice(0, 32)}…（同输入一致、忽略 metrics）`);
  console.log(`能力声明: ${caps.engine} v${caps.version}, max_operations=${caps.max_operations}`);
} else {
  failures.push('wasm 缺少分析类导出（aps_verify/aps_fingerprint/aps_capabilities）');
}

if (failures.length) {
  console.error('✗ WASM 冒烟失败:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('✓ WASM 冒烟通过（求解 + 核验 + 指纹 + 能力声明，24 工序零违约）');
