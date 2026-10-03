#!/usr/bin/env node
/**
 * 实验室运行器（`src/core/aps/engine.ts` 的 Runner）生命周期测试，Node 下用
 * worker_threads 跑**同一份** Worker 胶水：
 *
 *  1. `runOnce` 产出的运行记录完整：状态/指标/甘特/资源/核验/指纹/引擎版本；
 *  2. 求解途中 `cancel()` → 记录标记为已取消，Worker 被终止并**自动重建**；
 *  3. 取消后的下一次求解仍然成功（页面无需刷新，对应需求“正确处理求解中断与 Worker 生命周期”）；
 *  4. `dispose()` 释放 Worker，再调用不会被卡住。
 *
 * 浏览器里 `spawnSolver` 用的是 `new Worker(url, {type:'module'})`，Node 里换成薄适配器，
 * 两边跑的是同一份胶水与同一个 wasm 产物。
 */

import { readFileSync } from 'node:fs';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const repoRoot = resolve(labDir, '..');

const { check, finish, failures } = createHarness('运行器生命周期测试');

// Node 的 Worker 协议与 Web Worker 不同，用适配器对齐
class NodeWorkerAdapter {
  constructor(entryPath, workerData) {
    this.inner = new Worker(entryPath, { type: 'module', workerData });
    this.inner.on('message', (data) => this.onmessage?.({ data }));
    this.inner.on('error', (err) => this.onerror?.(err));
  }
  postMessage(msg) {
    this.inner.postMessage(msg);
  }
  terminate() {
    return this.inner.terminate();
  }
}

/** 与 smoke-lab.mjs 同款：按车间单元复制放大，构造“求解足够慢”的实例。 */
function scaleProblem(base, operations) {
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
          materials: Object.fromEntries(Object.entries(op.materials ?? {}).map(([k, v]) => [p + k, v])),
        })),
      });
    }
  }
  Object.assign(out, { machines, workers, tools, materials, orders });
  return out;
}

async function loadLabCore() {
  const tmp = join(labDir, 'node_modules', '.lab-runner-test');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const entry = join(tmp, 'entry.ts');
  const outfile = join(tmp, 'core.mjs');
  writeFileSync(
    entry,
    `export { createEngineHandle, createRunner, runOnce } from ${JSON.stringify(join(labDir, 'src/core/aps/engine.ts'))};
export * from ${JSON.stringify(join(labDir, 'src/core/aps/params.ts'))};
`,
  );
  const { build } = await import('esbuild');
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile,
    logLevel: 'warning',
    external: ['*/vendor/aps-worker.js'],
  });
  return import(pathToFileURL(outfile).href);
}

// ---------------- 准备 ----------------
const wasmPath = process.env.LAB_WASM ?? join(repoRoot, 'aps/rust/dist/aps_engine.wasm');
const workerPath = join(repoRoot, 'aps/rust/web/aps-worker.js');
const { spawnSolver, SolveCancelledError } = await import(`${pathToFileURL(workerPath).href}?t=${Date.now()}`);
const glueSha = createHash('sha256').update(readFileSync(workerPath)).digest('hex');
const core = await loadLabCore();

const baseline = JSON.parse(readFileSync(join(repoRoot, 'aps/mock/baseline.json'), 'utf8'));
const big = scaleProblem(baseline, 480); // 20 个车间单元：足以让取消发生在求解过程中

// Node 下的 Worker 入口 shim：把 parentPort 适配成 worker 里的 self.onmessage/postMessage，
// 并调用同一份 installWorker（浏览器里则直接 new Worker(url, {type:'module'})）。
const shimDir = join(labDir, 'node_modules', '.lab-runner-test');
mkdirSync(shimDir, { recursive: true });
const shimPath = join(shimDir, 'worker-entry.mjs');
writeFileSync(
  shimPath,
  `
import { parentPort, workerData } from 'node:worker_threads';
import { installWorker } from ${JSON.stringify(pathToFileURL(workerPath).href)};
import { createHarness } from './lib/harness.mjs';
globalThis.self = {
  onmessage: null,
  postMessage: (m) => parentPort.postMessage(m),
};
parentPort.on('message', (data) => self.onmessage?.({ data }));
installWorker(workerData?.wasmUrl);
`,
);

const wasmModule = new WebAssembly.Module(readFileSync(wasmPath));
const { handle, version, capabilities } = await core.createEngineHandle({
  workerUrl: workerPath,
  wasm: wasmModule,
  spawnSolver,
  spawn: () => new NodeWorkerAdapter(shimPath, {}),
});
const runner = core.createRunner(handle, { version, capabilities });

check(
  '握手拿到版本与档位能力声明',
  typeof version === 'string' &&
    capabilities?.max_operations === 600 &&
    capabilities?.can_prove_optimal === false &&
    capabilities?.can_prove_infeasible === false,
  `${version} / max_operations=${capabilities?.max_operations}`,
);
check(
  '能力声明严格符合契约（7 字段，无多余键）',
  Object.keys(capabilities ?? {}).length === 7,
  Object.keys(capabilities ?? {}).join(','),
);

// ---------------- 1) 正常运行 ----------------
const rec = await runner.run({
  problem: baseline,
  problemName: 'baseline',
  params: { ...core.DEFAULT_PARAMS, timeLimitMs: 800 },
  verify: true,
  strict: false,
});
check('运行记录：状态可接受', rec.status === 'FEASIBLE' || rec.status === 'OPTIMAL', rec.status);
check('运行记录：指标齐全（首解/总耗时/内存/墙钟）',
  rec.metrics.firstFeasibleMs !== null && rec.metrics.totalMs !== null &&
    rec.metrics.peakMemoryBytes !== null && rec.metrics.wallMs >= 0,
  `first=${rec.metrics.firstFeasibleMs}ms total=${rec.metrics.totalMs}ms mem=${rec.metrics.peakMemoryBytes}B wall=${rec.metrics.wallMs}ms`);
check('运行记录：甘特/资源/时间线已构建',
  rec.gantt.operationCount === 24 && rec.resources.length === 13 && rec.timelines.length === 13);
check('运行记录：独立核验通过', rec.verify?.ok === true, `mode=${rec.verify?.mode}`);
check('运行记录：方案指纹取自引擎', typeof rec.fingerprint === 'string' && rec.fingerprint.startsWith('sha256:'), rec.fingerprint?.slice(0, 20) + '…');
check('运行记录：引擎版本回填', rec.engineVersion === version || rec.engineVersion === null, String(rec.engineVersion));
check('胶水文件与实验室 vendor 副本一致（单一来源）',
  createHash('sha256').update(readFileSync(join(labDir, 'src/vendor/aps-worker.js'))).digest('hex') === glueSha);

// ---------------- 2) 中途取消 ----------------
const phases = [];
const cancelledRun = runner.run({
  problem: big,
  problemName: 'bench-480',
  params: { ...core.DEFAULT_PARAMS, timeLimitMs: 30_000 },
  onPhase: (p) => phases.push(p),
});
await new Promise((r) => setTimeout(r, 250)); // 确保已进入求解
const started = Date.now();
const didCancel = runner.cancel();
const cancelLatency = Date.now() - started;
const cancelledRec = await cancelledRun;

check('取消立即生效（终止 Worker，而非等求解结束）', didCancel === true && cancelLatency < 50, `${cancelLatency} ms`);
check('被取消的运行标记为 CANCELLED', cancelledRec.cancelled === true && cancelledRec.status === 'CANCELLED', cancelledRec.status);
check('记录里带得出“Worker 曾重建”的诊断位', cancelledRec.workerRestarted === true);
check('取消记录了阶段轨迹', phases.includes('solving'), phases.join('→'));

// ---------------- 3) 取消后仍可继续使用 ----------------
const afterCancel = await runner.run({
  problem: baseline,
  problemName: 'baseline-after-cancel',
  params: { ...core.DEFAULT_PARAMS, timeLimitMs: 800 },
  verify: true,
});
check('取消之后无需刷新即可再次求解', afterCancel.status === 'FEASIBLE' || afterCancel.status === 'OPTIMAL', afterCancel.status);
check('重建后的结果与取消前一致（确定性）', afterCancel.fingerprint === rec.fingerprint);
check('重建本身不再被标记为“取消”', afterCancel.cancelled !== true);

// ---------------- 4) 释放 ----------------
runner.dispose();
check('dispose 后底层句柄不再忙碌', runner.busy === false);
await new Promise((r) => setTimeout(r, 50));

// 取消错误的类型约定（页面据此区分“用户取消”与“真实失败”）
check('取消错误类型可区分', new SolveCancelledError('x') instanceof Error);

// ---------------- 5) 参数校验在运行前拦截 ----------------
const badParams = core.validateParams({ ...core.DEFAULT_PARAMS, timeLimitMs: 0 });
check('非法参数在运行前被拦截（不进入引擎）', badParams.length > 0, badParams.join('；'));

finish('✓ 运行器生命周期测试全部通过');
