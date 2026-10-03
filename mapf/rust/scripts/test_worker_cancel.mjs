#!/usr/bin/env node
/**
 * Worker 取消语义测试（Node 版，无需浏览器；与 aps 侧同名脚本同构）：
 *  1. 取消必须**立即**生效（终止 Worker，而不是等一次同步求解自然结束）；
 *  2. 取消后按需重建工作线程，下一次求解仍然成功；
 *  3. 取消错误与普通失败可区分（SolveCancelledError）。
 *
 *   node scripts/test_worker_cancel.mjs
 *
 * 依赖 dist/mapf_engine.wasm（scripts/build_wasm.sh 产物）。
 * 用 M09（拥挤瓶颈 24 台）+ 120s 预算 + w=1.0 迫使取消落在求解途中。
 */
import { Worker } from 'node:worker_threads';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSolver, SolveCancelledError } from '../web/mapf-worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');            // mapf/rust
const mapf = path.resolve(root, '..');           // mapf
const wasmPath = path.join(root, 'dist', 'mapf_engine.wasm');

// Node 的 Worker 没有 onmessage/postMessage 协议，用薄适配器对齐 Web Worker 接口
class NodeWorkerAdapter {
  constructor(entryPath) {
    this.inner = new Worker(entryPath, { type: 'module' });
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

async function main() {
  // 生成临时入口：把 Node 的 parentPort 适配成 worker 里的 self.onmessage/postMessage
  const dir = await mkdtemp(path.join(tmpdir(), 'mapf-worker-test-'));
  const entry = path.join(dir, 'entry.mjs');
  const workerUrl = pathToFileURL(path.join(root, 'web', 'mapf-worker.js')).href;
  await writeFile(
    entry,
    `
import { parentPort } from 'node:worker_threads';
import { installWorker } from ${JSON.stringify(workerUrl)};
globalThis.self = {
  onmessage: null,
  postMessage: (m) => parentPort.postMessage(m),
};
parentPort.on('message', (data) => self.onmessage?.({ data }));
installWorker();
`,
    'utf8'
  );

  // 主线程预编译（浏览器里等价于 fetch + WebAssembly.compile），重建线程时复用
  const wasmModule = new WebAssembly.Module(await readFile(wasmPath));
  const solver = spawnSolver(() => new NodeWorkerAdapter(entry), { wasm: wasmModule });

  const m09 = JSON.parse(await readFile(path.join(mapf, 'mock', 'm09-crowded-bottleneck.json'), 'utf8'));
  const big = JSON.parse(JSON.stringify(m09));
  big.time_model = { ...(big.time_model ?? {}), horizon: "auto" };
  big.solver = { ...(big.solver ?? {}), time_limit_ms: 120000, suboptimality_factor: 1.0 };
  const m05 = JSON.parse(await readFile(path.join(mapf, 'mock', 'm05-cycle.json'), 'utf8'));

  // ---- 1) 取消立即生效 ----
  const t0 = Date.now();
  const inflight = solver.solve(JSON.stringify(big));
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
    checks.push([name, ok]);
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  check('取消时有在途求解', hadInflight);
  check('cancel() 返回 true（确实有待取消请求）', didCancel === true);
  check('取消产生 SolveCancelledError', cancelled instanceof SolveCancelledError, String(cancelled));
  check('取消后不再忙', solver.busy === false);
  check('取消立即生效（远早于 120s 预算）', rejectedAt > 0 && cancelLatency < 5000, `${cancelLatency} ms`);

  // ---- 2) 取消后自动重建，下一次求解成功 ----
  const result = await solver.solve(JSON.stringify(m05));
  check('取消后再次求解成功（Worker 已重建）', result.status === 'OPTIMAL' || result.status === 'FEASIBLE', result.status);
  check('结果完整（4 台机器人）', (result.solution?.robots ?? []).length === 4, `${result.solution?.robots?.length} 台`);
  check('内嵌核验通过', result.solution?.verified === true);

  // ---- 3) 指纹经 Worker 通道可用（raw 文本参与，不重序列化） ----
  if (result.report === undefined && result.solution) {
    const fp = await solver.fingerprint(result.raw);
    check('指纹报告可取回', typeof fp.report?.fingerprint === 'string' && fp.report.fingerprint.startsWith('sha256:'), fp.report?.fingerprint?.slice(0, 16));
  }

  solver.dispose();
  check('dispose() 后不忙', solver.busy === false);

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n汇总: ${checks.length - failed.length} 通过 / ${failed.length} 失败`);
  process.exit(failed.length ? 1 : 0);
}

await main();
