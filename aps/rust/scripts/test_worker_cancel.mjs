#!/usr/bin/env node
/**
 * Worker 取消语义测试（Node 版，无需浏览器）：
 *  1. 取消必须**立即**生效（底层是 Worker 终止，而不是排队等同步求解结束）；
 *  2. 取消后按需重建工作线程，下一次求解仍然成功；
 *  3. 取消错误与普通失败可区分（SolveCancelledError）。
 *
 *   node scripts/test_worker_cancel.mjs
 */
import { Worker } from 'node:worker_threads';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSolver, SolveCancelledError } from '../web/aps-worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const aps = path.resolve(root, '..');
const wasmPath = path.join(root, 'dist', 'aps_engine.wasm');

// Node 的 Worker 没有 onmessage/postMessage 属性协议，用一个薄适配器对齐 Web Worker 接口
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

/// 把基线实例按“车间单元”复制放大（等价于 Rust 侧 benchgen::build_separable），
/// 用于构造一个**足够耗时**的求解：取消要在求解途中发生，而不是等它自然结束。
function scaleProblem(base, operations) {
  if (operations % 24 !== 0) throw new Error('operations 必须是 24 的倍数');
  const cells = operations / 24;
  const out = JSON.parse(JSON.stringify(base));
  const machines = [], workers = [], tools = [], materials = [], orders = [];
  for (let c = 0; c < cells; c++) {
    const p = `CELL${String(c + 1).padStart(3, '0')}__`;
    for (const m of base.machines) machines.push({ ...m, id: p + m.id });
    for (const w of base.workers) workers.push({ ...w, id: p + w.id });
    for (const t of base.tools) tools.push({ ...t, id: p + t.id });
    for (const mt of base.materials) {
      materials.push({
        ...mt,
        id: p + mt.id,
        receipts: (mt.receipts || []).map((r) => ({ ...r })),
      });
    }
    for (const o of base.orders) {
      orders.push({
        ...o,
        id: p + o.id,
        operations: o.operations.map((op) => ({
          ...op,
          id: p + op.id,
          predecessors: (op.predecessors || []).map((x) => p + x),
          alternatives: op.alternatives.map((a) => ({
            ...a,
            machine_id: p + a.machine_id,
          })),
          tools: (op.tools || []).map((x) => p + x),
          materials: Object.fromEntries(
            Object.entries(op.materials || {}).map(([k, v]) => [p + k, v])
          ),
        })),
      });
    }
  }
  Object.assign(out, { machines, workers, tools, materials, orders });
  out.meta.snapshot_id = `benchmark-${operations}-separable-seed42`;
  return out;
}

async function main() {
  // 生成一个临时入口：把 Node 的 parentPort 适配成 worker 里的 self.onmessage/postMessage
  const dir = await mkdtemp(path.join(tmpdir(), 'aps-worker-test-'));
  const entry = path.join(dir, 'entry.mjs');
  const workerUrl = pathToFileURL(path.join(root, 'web', 'aps-worker.js')).href;
  await writeFile(
    entry,
    `
import { parentPort, workerData } from 'node:worker_threads';
import { installWorker } from ${JSON.stringify(workerUrl)};
globalThis.self = {
  onmessage: null,
  postMessage: (m) => parentPort.postMessage(m),
};
parentPort.on('message', (data) => self.onmessage?.({ data }));
installWorker(workerData.wasmUrl);
`,
    'utf8'
  );

  // 主线程预编译（浏览器里等价于 fetch + WebAssembly.compile；Node 下避免 file:// fetch 限制）
  const wasmModule = new WebAssembly.Module(await readFile(wasmPath));
  const solver = spawnSolver(() => new NodeWorkerAdapter(entry, {}), { wasm: wasmModule });

  const base = JSON.parse(await readFile(path.join(aps, 'mock', 'baseline.json'), 'utf8'));
  // 首个求解必须足够久：24 工序实例现在能在数十毫秒内解完（甚至证明最优），
  // 取消窗口会落空，因此改用 480 工序（仍在 wasm-light 的 600 工序上限内）。
  const big = scaleProblem(base, 480);
  big.objective.time_limit_ms = 30000; // 故意给足预算：靠取消而不是超时结束
  const problemText = JSON.stringify(big);
  const problem = JSON.parse(JSON.stringify(base));

  // ---- 1) 取消立即生效 ----
  const t0 = Date.now();
  const inflight = solver.solve(problemText);
  let cancelled = null;
  let rejectedAt = 0;
  inflight.catch((err) => {
    cancelled = err;
    rejectedAt = Date.now();
  });
  await new Promise((r) => setTimeout(r, 800));
  const hadInflight = solver.busy;
  const didCancel = solver.cancel();
  await new Promise((r) => setTimeout(r, 100));
  const cancelLatency = rejectedAt - t0;

  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push([name, ok, detail]);
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  check('取消时有在途求解', hadInflight);
  check('cancel() 返回 true（确实有待取消请求）', didCancel === true);
  check('取消产生 SolveCancelledError', cancelled instanceof SolveCancelledError, String(cancelled));
  check('取消后不再忙', solver.busy === false);
  check(
    '取消立即生效（远早于 30s 预算）',
    rejectedAt > 0 && cancelLatency < 5000,
    `${cancelLatency} ms`
  );

  // ---- 2) 取消后自动重建，下一次求解成功 ----
  problem.objective.time_limit_ms = 500;
  const t1 = Date.now();
  const result = await solver.solve(JSON.stringify(problem));
  const ops = result.solution?.operations ?? [];
  check('取消后再次求解成功（Worker 已重建）', result.status === 'FEASIBLE' || result.status === 'OPTIMAL', result.status);
  check('结果完整（24 道工序）', ops.length === 24, `${ops.length} 道，用时 ${Date.now() - t1} ms`);
  check('结果零违约', (result.solution?.violations ?? []).length === 0);

  solver.dispose();
  check('dispose() 后不忙', solver.busy === false);

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n汇总: ${checks.length - failed.length} 通过 / ${failed.length} 失败`);
  process.exit(failed.length ? 1 : 0);
}

await main();
