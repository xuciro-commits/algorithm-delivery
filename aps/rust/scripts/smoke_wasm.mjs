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

const engine = await createEngine(wasmBytes);
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

if (failures.length) {
  console.error('✗ WASM 冒烟失败:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('✓ WASM 冒烟通过（与 native 同源的 24 工序可行解，零违约）');
