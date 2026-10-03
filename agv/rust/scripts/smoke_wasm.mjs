#!/usr/bin/env node
/**
 * WASM 冒烟测试：真实加载 dist/agv_engine.wasm，求解 agv/mock 的 a01 / a07 /
 * a10（动态），并断言状态/核验/指纹/能力声明与原生 CLI 同源一致。
 *
 *   node scripts/smoke_wasm.mjs [wasm路径] [problem路径]
 *
 * CI（agv-rust.yml wasm job）在构建产物后立即执行本脚本；失败即产物不可用。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createEngine } from '../web/agv-worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');            // agv/rust
const agv = path.resolve(root, '..');            // agv
const wasmPath = process.argv[2] ?? path.join(root, 'dist', 'agv_engine.wasm');

const wasmBytes = await readFile(wasmPath);
const failures = [];

// 覆盖装载路径：字节（Uint8Array）与预编译 Module
const engines = [];
engines.push(['bytes', await createEngine(wasmBytes)]);
engines.push(['module', await createEngine(new WebAssembly.Module(wasmBytes))]);
if (process.env.AGV_SMOKE_URL) {
  engines.push([`url(${process.env.AGV_SMOKE_URL})`, await createEngine(process.env.AGV_SMOKE_URL)]);
}
for (const [kind, eng] of engines) {
  if (eng.version !== engines[0][1].version) failures.push(`装载路径 ${kind} 的版本不一致`);
}
const engine = engines[1][1];
console.log(`装载路径: ${engines.map(([k]) => k).join(', ')} / wasm 版本: ${engine.version}`);

// A01：单车单任务（含服务时刻断言）
const a01Text = await readFile(process.argv[3] ?? path.join(agv, 'mock', 'a01-single-task.json'), 'utf8');
const t0 = performance.now();
const { status, statusCode, solution, raw } = engine.solve(a01Text);
const ms = performance.now() - t0;
console.log(
  `A01: ${status}（code=${statusCode}）` +
    ` pickup_done=${solution?.plan?.tasks?.[0]?.pickup_done} dropoff_done=${solution?.plan?.tasks?.[0]?.dropoff_done}` +
    ` / ${ms.toFixed(1)} ms / 峰值内存 ${(engine.peakMemoryBytes() / 1048576).toFixed(2)} MB`,
);
if (status !== 'FEASIBLE') failures.push(`A01 应为 FEASIBLE，实际 ${status}`);
if (solution?.plan?.tasks?.[0]?.pickup_done !== 5) failures.push('A01 pickup_done 应为 5');
if (solution?.plan?.tasks?.[0]?.dropoff_done !== 11) failures.push('A01 dropoff_done 应为 11');
if (solution?.verified !== true) failures.push('A01 verified 应为 true');
if (solution?.plan?.vehicles?.length !== 1) failures.push(`A01 车辆数应为 1，实际 ${solution?.plan?.vehicles?.length}`);

// A07：工作站容量
const a07 = engine.solve(await readFile(path.join(agv, 'mock', 'a07-station-capacity.json'), 'utf8'));
if (a07.status !== 'FEASIBLE' || a07.solution?.verified !== true) {
  failures.push(`A07 应 FEASIBLE+verified，实际 ${a07.status}`);
}
console.log(`A07: ${a07.status}（站容量串行通过核验）`);

// A10：动态重调度（task_add）+ 汇总块
const a10 = engine.solve(await readFile(path.join(agv, 'mock', 'a10-dynamic-task-add.json'), 'utf8'));
if (a10.status !== 'FEASIBLE' || a10.solution?.verified !== true) {
  failures.push(`A10 应 FEASIBLE+verified，实际 ${a10.status}`);
}
const dyn = a10.solution?.dynamic;
if (!dyn) failures.push('A10 动态解缺少 dynamic 汇总块');
else {
  if (dyn.snapshot_time !== 3) failures.push(`A10 snapshot_time 应为 3，实际 ${dyn.snapshot_time}`);
  if (dyn.events?.task_add !== 1 || dyn.tasks_added?.[0] !== 'T3-new') failures.push('A10 汇总块事件统计不符');
  if (!String(dyn.semantic_digest ?? '').startsWith('sha256:')) failures.push('A10 semantic_digest 缺失');
  if (dyn.completed_at_snapshot?.length !== 0) failures.push('A10 快照时刻不应有已完成任务');
}
const nCompleted = a10.solution?.metrics?.completed_tasks;
if (nCompleted !== 3) failures.push(`A10 含新增任务共 3 个应全部完成，实际 ${nCompleted}`);
console.log(`A10: ${a10.status}（动态展开 + 汇总块 + 语义指纹）`);

// 确定性与指纹
const again = engine.solve(a01Text);
// raw 含运行期计时（metrics.total_ms 等），必然逐次不同；确定性断言看**语义**：
const semA = JSON.stringify({ status: solution.status, plan: solution.plan, search: solution.search });
const semB = JSON.stringify({ status: again.solution?.status, plan: again.solution?.plan, search: again.solution?.search });
if (semA !== semB) failures.push('同输入两次求解的语义结果不一致（确定性破坏）');

if (!engine.hasAnalysis) {
  failures.push('wasm 缺少分析类导出（agv_verify / agv_fingerprint / agv_capabilities）');
} else {
  const fp1 = engine.fingerprint(raw).report.fingerprint;
  const fp2 = engine.fingerprint(again.raw).report.fingerprint;
  if (fp1 !== fp2) failures.push('两次求解的指纹不一致');
  if (!fp1?.startsWith('sha256:')) failures.push(`指纹格式异常：${fp1}`);

  // 参数覆盖求解：算法与预算
  const opt = engine.solve(a01Text, { algorithm: 'baseline', time_limit_ms: 5000 });
  if (opt.status !== 'FEASIBLE') failures.push(`参数覆盖求解失败：${opt.status}`);

  // 独立核验：干净解通过；篡改任务完成状态必拒
  const clean = engine.verify(a01Text, raw, { strict: true });
  if (clean.report?.ok !== true) failures.push('干净解的严格核验应通过（agv-verification/1.0: ok=true）');
  const tampered = JSON.parse(raw);
  tampered.plan.tasks[0].dropoff_done = 3;
  const bad = engine.verify(a01Text, JSON.stringify(tampered), { strict: false });
  if (bad.report?.ok !== false || !Array.isArray(bad.report?.violations) || bad.report.violations.length === 0) failures.push('篡改解（dropoff_done 提前）必须被核验拒绝且 violations 非空');

  const caps = engine.capabilities();
  if (caps.profile !== 'wasm-light') failures.push(`wasm 能力档位应为 wasm-light，实际 ${caps.profile}`);
  if (!Array.isArray(caps.algorithms) || !caps.algorithms.includes('insertion-ls')) {
    failures.push('能力声明应包含 insertion-ls 算法');
  }
  console.log(`分析导出: verify/fingerprint/capabilities/with-options 全部可用（档位 ${caps.profile}）`);
}

if (failures.length) {
  console.error(`\n✗ 冒烟失败（${failures.length} 项）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✓ agv wasm 冒烟通过');
