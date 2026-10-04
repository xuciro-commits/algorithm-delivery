#!/usr/bin/env node
/**
 * WASM 冒烟测试：真实加载 dist/warehouse_engine.wasm，跑三个算法域的**小规模**问题，
 * 并断言与 native CLI 同一份内核的关键结论（状态、完成数、独立核验）。
 *
 *   node scripts/smoke_wasm.mjs [wasm 路径] [mock 目录]
 *
 * 这里刻意只跑 tiny/small 规模（浏览器档位 wasm-light 的常规用法），
 * 大规模求解交给 native CLI 与 bench（`docs/BENCHMARKS.md`）。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createEngine, spawnSolver } from '../web/warehouse-worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..'); // warehouse/rust
const warehouse = path.resolve(root, '..'); // warehouse
const wasmPath = process.argv[2] ?? path.join(root, 'dist', 'warehouse_engine.wasm');
const mockDir = process.argv[3] ?? path.join(warehouse, 'mock');

const wasmBytes = await readFile(wasmPath);

// 覆盖三条装载路径：字节（Uint8Array）、预编译 Module、以及 URL 分支（可选）
const engines = [];
engines.push(['bytes', await createEngine(wasmBytes)]);
engines.push(['module', await createEngine(new WebAssembly.Module(wasmBytes))]);
for (const [kind, eng] of engines) {
  if (eng.version !== engines[0][1].version) {
    console.error(`✗ 装载路径 ${kind} 的版本不一致`);
    process.exit(1);
  }
}
console.log(`装载路径: ${engines.map(([k]) => k).join(', ')}`);
const engine = engines[1][1];
console.log(`wasm 版本: ${engine.version} / ABI ${engine.abiVersion}`);
console.log(`可选导出: ${engine.hasAnalysis ? '全部可用' : JSON.stringify(engine.analysisExports)}`);

const failures = [];
const expect = (ok, message) => {
  if (!ok) failures.push(message);
};

// ---- 能力声明与场景清单（实验室的选择器直接用它） ----
let capabilities = null;
let scenarios = 0;
try {
  capabilities = engine.capabilities();
  const tier = (capabilities.tiers ?? []).find((item) => item.name === capabilities.profile) ?? (capabilities.tiers ?? [])[0] ?? {};
  console.log(
    `档位: ${capabilities.profile} / 引擎 ${capabilities.engineVersion} / ` +
      `规模上限 SKU ${tier.maxSkus ?? '?'} · 库位 ${tier.maxLocations ?? '?'} · 任务 ${tier.maxTasks ?? '?'}`,
  );
} catch (err) {
  failures.push(`capabilities 调用失败：${err.message}`);
}
try {
  const catalog = engine.scenarios();
  scenarios = catalog?.count ?? 0;
  const flat = (catalog?.families ?? []).flatMap((family) => family.scenarios ?? []);
  console.log(`标准场景: ${scenarios} 个（展开 ${flat.length} 条）`);
  expect(scenarios >= 80, `场景数应≥80，实际 ${scenarios}`);
  expect(flat.length === scenarios, `场景清单展开条数应等于 count（${flat.length} != ${scenarios}）`);
} catch (err) {
  failures.push(`scenarios 调用失败：${err.message}`);
}

/**
 * 核验文档的形状（与 `src/verify.rs` 的文档定位一致；sync-warehouse.mjs 与
 * 实验室面板的 `buildVerifyDocument` 用的是同一套形状）：
 *   slotting → {kind, problem, solution}；asrs → {kind, problem, timeline}；
 *   joint    → {kind, slotting, asrs, timeline, solution}
 */
function verifyDocument(problemDocument, envelope) {
  if (problemDocument.kind === 'slotting') {
    return { kind: 'slotting', problem: problemDocument.problem, solution: envelope.result };
  }
  if (problemDocument.kind === 'asrs') {
    return { kind: 'asrs', problem: problemDocument.problem, timeline: envelope.timeline };
  }
  const assignment = envelope.result?.slottingAssignment;
  return {
    kind: 'joint',
    slotting: problemDocument.slotting,
    asrs: problemDocument.asrs,
    timeline: envelope.timeline,
    solution: { assignment: Array.isArray(assignment) ? assignment : [] },
  };
}

// ---- 三个域的求解 + 独立核验 ----
const cases = [
  { file: 'slotting-small.json', kind: 'slotting', label: '库位优化' },
  { file: 'asrs-small.json', kind: 'asrs', label: '密集立库调度' },
  { file: 'joint-small.json', kind: 'joint', label: '联合优化' },
];
for (const item of cases) {
  const problemPath = path.join(mockDir, item.file);
  let text;
  try {
    text = await readFile(problemPath, 'utf8');
  } catch {
    console.log(`- ${item.label}: 缺少 ${item.file}，跳过`);
    continue;
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch (err) {
    failures.push(`${item.file} 不是合法 JSON：${err.message}`);
    continue;
  }
  const t0 = performance.now();
  // 联合解先按"不带时间线"求解：这时的核验**必须如实报不通过**（调度段无法独立重放），
  // 否则就成了"没验证也算过"。紧接着再用带时间线的联合解验证"两段都能通过"。
  const result = engine.solve(text, { includeTimeline: item.kind !== 'joint' });
  const ms = performance.now() - t0;
  const envelope = result.envelope ?? {};
  const metrics = envelope.metrics ?? {};
  console.log(
    `- ${item.label}: ${result.status} / ${ms.toFixed(0)} ms / ` +
      `tasks ${metrics.tasksDone ?? '—'}/${metrics.tasksTotal ?? '—'} / ` +
      `verified ${envelope.verification?.ok ?? '—'}`,
  );
  expect(
    ['FEASIBLE', 'FEASIBLE_WITH_BOUND', 'OPTIMAL_PROVEN'].includes(result.status),
    `${item.label} 状态应为可行族，实际 ${result.status}（${result.error ?? ''}）`,
  );
  expect(Boolean(envelope.status), `${item.label} 结果缺少 status 字段`);
  expect(Boolean(envelope.fingerprint), `${item.label} 结果缺少 fingerprint（可复现性）`);

  // 独立核验走 wh_verify：输入是「问题 + 方案」文档（验证器自己重放约束、重算指标），
  // 而不是求解信封 —— 信封里没有原始问题，验证器不会拿求解器的中间状态当输入。
  if (engine.hasAnalysis) {
    const verify = engine.verify(JSON.stringify(verifyDocument(document, envelope)));
    const ok = verify.report?.ok;
    const violations = verify.report?.violations ?? [];
    console.log(`  独立核验: ok=${ok} violations=${violations.length}`);
    if (item.kind === 'joint') {
      // 没有时间线就没有可独立重放的调度段：结论必须是不通过，而且必须给出原因
      // （`ok=false` + 空 violations 是没法诊断的，验证器现在会把缺失写成显式违规）。
      expect(ok === false, '联合方案缺少时间线时不应通过核验（否则等于"没验证也算过"）');
      expect(violations.length > 0, '缺少时间线时必须给出显式违规条目（不能 ok=false 却 violations=[]）');
      const full = engine.solve(text, { includeTimeline: true });
      const fullVerify = engine.verify(JSON.stringify(verifyDocument(document, full.envelope ?? {})));
      const fullViolations = fullVerify.report?.violations ?? [];
      console.log(
        `  独立核验（带时间线 · 库位+调度两段）: ok=${fullVerify.report?.ok} violations=${fullViolations.length}`,
      );
      expect(
        fullVerify.report?.ok === true,
        `联合方案两段核验未通过：${JSON.stringify(fullViolations).slice(0, 200)}`,
      );
      // 对抗：篡改联合时间线（压缩一步时长）必须被拦下
      const tampered = JSON.parse(full.raw);
      const device = (tampered.timeline?.devices ?? []).find((entry) => (entry.steps ?? []).length > 0);
      if (device) {
        const step = device.steps[0];
        step.end_s = Math.max(0, Number(step.start_s ?? 0) + 0.01);
        const tamperedReport = engine.verify(JSON.stringify(verifyDocument(document, tampered)));
        console.log(`  对抗（联合 · 压缩一步时长）: ok=${tamperedReport.report?.ok}`);
        expect(tamperedReport.report?.ok === false, '被篡改的联合时间线居然通过了核验');
      }
    } else {
      expect(ok === true, `${item.label} 独立核验未通过：${JSON.stringify(violations).slice(0, 200)}`);
    }
  }

  // 对抗：篡改时间线（把某步压缩到 0.01s）必须被验证器拦下 —— 防止"验证器永远说 OK"
  if (engine.hasAnalysis && item.kind === 'asrs') {
    const tampered = JSON.parse(result.raw);
    const device = (tampered.timeline?.devices ?? []).find((entry) => (entry.steps ?? []).length > 0);
    if (device) {
      const step = device.steps[0];
      step.end_s = Math.max(0, Number(step.start_s ?? 0) + 0.01);
      const verify = engine.verify(JSON.stringify(verifyDocument(document, tampered)));
      console.log(`  对抗（压缩一步时长）: ok=${verify.report?.ok}`);
      expect(verify.report?.ok === false, `${item.label} 被篡改的时间线居然通过了核验`);
    }
  }
}

// ---- Worker 路径（浏览器真实用法）：首次求解 + 取消后重建 ----
// Node 里没有 DOM 的 Worker 全局对象；这段只在浏览器/有 Worker 的环境跑，
// Node 侧由实验室的 `npm run test:core` 等脚本覆盖（同一份 glue、同一份 wasm）。
if (typeof Worker === 'undefined') {
  console.log('- Worker 路径: 当前环境没有 Worker 全局（Node），跳过；浏览器侧由 lab 的 sync 自检与 test:core 覆盖');
} else {
  try {
    const solver = spawnSolver(new URL('../web/warehouse-worker.js', import.meta.url), {
      wasm: new WebAssembly.Module(wasmBytes),
    });
    const problemText = await readFile(path.join(mockDir, 'slotting-small.json'), 'utf8');
    const solved = await solver.solve(problemText, { includeTimeline: false });
    console.log(`Worker 求解: ${solved.status} / 峰值内存 ${(solved.peakMemoryBytes / 1048576).toFixed(1)} MB`);
    expect(
      ['FEASIBLE', 'FEASIBLE_WITH_BOUND', 'OPTIMAL_PROVEN'].includes(solved.status),
      `Worker 状态异常：${solved.status}`,
    );
    solver.dispose();
  } catch (err) {
    failures.push(`Worker 路径失败：${err.message}`);
  }
}

// ---- 对抗样例：坏 JSON 必须给出 INVALID_INPUT（不是崩溃） ----
try {
  const bad = engine.solve('{ not json');
  console.log(`坏输入: ${bad.status}（应 INVALID_INPUT）`);
  expect(bad.status === 'INVALID_INPUT', `坏 JSON 应报 INVALID_INPUT，实际 ${bad.status}`);
} catch (err) {
  failures.push(`坏 JSON 不应抛异常：${err.message}`);
}

if (failures.length > 0) {
  console.error('\n✗ WASM 冒烟失败：');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('\n✓ WASM 冒烟通过（三域求解 + 独立核验 + Worker 路径 + 坏输入）');
