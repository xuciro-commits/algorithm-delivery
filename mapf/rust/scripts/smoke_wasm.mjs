#!/usr/bin/env node
/**
 * WASM 冒烟测试：真实加载 dist/mapf_engine.wasm，求解 mapf/mock/m01 与 m05，
 * 并断言状态/目标值/核验/指纹/能力声明与原生 CLI 同源一致。
 *
 *   node scripts/smoke_wasm.mjs [wasm路径] [problem路径]
 *
 * CI（mapf.yml wasm job）在构建产物后立即执行本脚本；失败即产物不可用。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createEngine } from '../web/mapf-worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');            // mapf/rust
const mapf = path.resolve(root, '..');           // mapf
const wasmPath = process.argv[2] ?? path.join(root, 'dist', 'mapf_engine.wasm');

const wasmBytes = await readFile(wasmPath);
const failures = [];

// 覆盖装载路径：字节（Uint8Array）与预编译 Module（APS 侧该路径曾有缺陷，一并验证）
const engines = [];
engines.push(['bytes', await createEngine(wasmBytes)]);
engines.push(['module', await createEngine(new WebAssembly.Module(wasmBytes))]);
if (process.env.MAPF_SMOKE_URL) {
  engines.push([`url(${process.env.MAPF_SMOKE_URL})`, await createEngine(process.env.MAPF_SMOKE_URL)]);
}
for (const [kind, eng] of engines) {
  if (eng.version !== engines[0][1].version) failures.push(`装载路径 ${kind} 的版本不一致`);
}
const engine = engines[1][1];
console.log(`装载路径: ${engines.map(([k]) => k).join(', ')} / wasm 版本: ${engine.version}`);

const problemText = await readFile(process.argv[3] ?? path.join(mapf, 'mock', 'm01-single-basic.json'), 'utf8');
const t0 = performance.now();
const { status, statusCode, solution, raw } = engine.solve(problemText);
const ms = performance.now() - t0;
console.log(`M01: ${status}（code=${statusCode}）soc=${solution?.soc} / ${ms.toFixed(1)} ms / 峰值内存 ${(engine.peakMemoryBytes() / 1048576).toFixed(2)} MB`);

if (status !== 'OPTIMAL') failures.push(`M01 应为 OPTIMAL，实际 ${status}`);
if (solution?.soc !== 6) failures.push(`M01 soc 应为 6，实际 ${solution?.soc}`);
if (solution?.verified !== true) failures.push('M01 verified 应为 true');
if ((solution?.robots?.length ?? 0) !== 1) failures.push(`M01 机器人数应为 1，实际 ${solution?.robots?.length}`);

// 环让路（多机器人 + wait 语义）
const m05Text = await readFile(path.join(mapf, 'mock', 'm05-cycle.json'), 'utf8');
const m05 = engine.solve(m05Text);
if (m05.status !== 'OPTIMAL' || m05.solution?.verified !== true) {
  failures.push(`M05 应 OPTIMAL+verified，实际 ${m05.status}`);
}
console.log(`M05: ${m05.status} soc=${m05.solution?.soc}（${m05.solution?.robots?.length} 台机器人含等待）`);

// 确定性与指纹
const again = engine.solve(problemText);
// raw 含运行期计时（metrics.total_ms 等），必然逐次不同；确定性断言看**语义**：
const semA = JSON.stringify({ status: solution.status, soc: solution.soc, robots: solution.robots });
const semB = JSON.stringify({ status: again.solution?.status, soc: again.solution?.soc, robots: again.solution?.robots });
if (semA !== semB) failures.push('同输入两次求解的语义结果不一致（确定性破坏）');

if (!engine.hasAnalysis) {
  failures.push('wasm 缺少分析类导出（mapf_verify / mapf_fingerprint / mapf_capabilities）');
} else {
  const fp1 = engine.fingerprint(raw).report.fingerprint;
  const fp2 = engine.fingerprint(again.raw).report.fingerprint;
  if (fp1 !== fp2) failures.push('两次求解的指纹不一致');
  const withoutMetrics = JSON.parse(JSON.stringify(solution));
  delete withoutMetrics.metrics;
  withoutMetrics.engine = { ...withoutMetrics.engine, compiler: 'different-toolchain' };
  const fp3 = engine.fingerprint(JSON.stringify(withoutMetrics)).report.fingerprint;
  if (fp3 !== fp1) failures.push('指纹不应受 metrics/编译器标注影响（语义指纹定义被破坏）');
  if (!String(fp1).startsWith('sha256:')) failures.push(`指纹格式应为 sha256:<hex>，实际 ${fp1}`);

  // 核验：合法方案 ok；破坏一步路径必须检出
  const ok = engine.verify(problemText, raw).report;
  if (ok.ok !== true) failures.push(`合法方案核验应通过，实际 ${JSON.stringify(ok.counts ?? ok)}`);
  const bad = JSON.parse(JSON.stringify(solution));
  const robot = bad.robots[0];
  // 把第 2 步替换成远处格子：单步跳变必然违反 4 邻接（若撞墙则再加一条 E-WALL-ENTRY）
  robot.path[1] = [robot.path[0][0] + 3, robot.path[0][1] + 2];
  const badRep = engine.verify(problemText, JSON.stringify(bad)).report;
  if (badRep.ok !== false || (badRep.counts?.violations ?? 0) === 0) {
    failures.push('破坏后的方案必须被核验器检出');
  }
  console.log(`核验: 合法 ok=${ok.ok} / 破坏检出 ${badRep.counts?.violations ?? '?'} 条；指纹 ${String(fp1).slice(0, 24)}…（同输入一致）`);

  const caps = engine.capabilities();
  if (caps.engine !== 'rust-ecbs-cbs') failures.push(`capabilities.engine 应为 rust-ecbs-cbs，实际 ${caps.engine}`);
  if (caps.version !== engine.version) failures.push(`capabilities.version 与 mapf_version() 不一致`);
  if (caps.profile !== 'wasm-light') failures.push(`wasm 档位应声明 wasm-light，实际 ${caps.profile}`);
  if (caps.limits?.max_agents !== 120) failures.push(`wasm-light max_agents 应为 120，实际 ${caps.limits?.max_agents}`);
  console.log(`能力声明: ${caps.engine} v${caps.version} / wasm-light（agents≤${caps.limits.max_agents}, cells≤${caps.limits.max_cells}）`);
}

if (failures.length) {
  console.error('✗ WASM 冒烟失败:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('✓ WASM 冒烟通过（M01/M05 求解 + 确定性 + 核验 + 指纹 + 能力声明）');
