/**
 * aps-engine 的 WASM 胶水（Web Worker / Node 通用，无第三方依赖）。
 *
 * 设计要点：
 *  - 手写 C ABI 绑定（对应 src/wasm_api.rs），不需要 wasm-bindgen；
 *  - 宿主必须提供 `env.aps_now_ms()`（用 performance.now / Date.now），否则模块实例化会失败；
 *  - wasm 内存可能增长：所有 TypedArray 视图在每次调用后重新获取，避免“detached buffer”错误；
 *  - 全程同步执行，浏览器里建议放在 Web Worker 中，避免阻塞 UI 线程。
 *
 * 用法（Worker）：
 *   import { installWorker } from './aps-worker.js';
 *   installWorker(new URL('./aps_engine.wasm', import.meta.url));
 *
 * 用法（Node / 任意 JS）：
 *   import { createEngine } from './aps-worker.js';
 *   const engine = await createEngine(new URL('./aps_engine.wasm', import.meta.url));
 *   const solution = engine.solve(problemJsonText);   // 返回已解析的 PlanSolution 对象
 */

const ABI = {
  alloc: 'aps_alloc',
  free: 'aps_free',
  solve: 'aps_solve',
  cancel: 'aps_cancel',
  resultPtr: 'aps_result_ptr',
  resultLen: 'aps_result_len',
  version: 'aps_version',
  peakMemory: 'aps_peak_memory_bytes',
};

/** 与 src/errors.rs 的 Status 枚举一一对应 */
export const STATUS = {
  0: 'ABI_ERROR',
  1: 'OPTIMAL',
  2: 'FEASIBLE',
  3: 'INFEASIBLE',
  4: 'UNKNOWN',
  5: 'MODEL_INVALID',
  6: 'NO_SOLUTION_FOUND',
  7: 'UNSUPPORTED_CONSTRAINT',
  8: 'CANCELLED',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/**
 * 装载 wasm 模块。
 * @param {URL|string|ArrayBuffer|WebAssembly.Module} source
 */
export async function createEngine(source) {
  const imports = {
    env: {
      // std::time 在 wasm32-unknown-unknown 上不可用，由宿主注入单调毫秒
      aps_now_ms: () => (globalThis.performance?.now?.() ?? Date.now()),
    },
  };
  let instance;
  if (source instanceof WebAssembly.Module) {
    ({ instance } = await WebAssembly.instantiate(source, imports));
  } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    ({ instance } = await WebAssembly.instantiate(source, imports));
  } else {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`下载 wasm 失败：HTTP ${res.status}`);
    if (WebAssembly.instantiateStreaming && res.headers.get('content-type')?.includes('wasm')) {
      ({ instance } = await WebAssembly.instantiateStreaming(res, imports));
    } else {
      ({ instance } = await WebAssembly.instantiate(await res.arrayBuffer(), imports));
    }
  }
  const ex = instance.exports;
  for (const name of Object.values(ABI)) {
    if (typeof ex[name] !== 'function') {
      throw new Error(`wasm 模块缺少导出 ${name}（请用 scripts/build_wasm.sh 重新构建）`);
    }
  }

  const mem = () => new Uint8Array(ex.memory.buffer);
  const version = () => {
    const ptr = ex.aps_version();
    const bytes = mem();
    let end = ptr;
    while (bytes[end] !== 0) end += 1;
    return decoder.decode(bytes.subarray(ptr, end));
  };

  return {
    version: version(),
    /** 峰值内存（字节） */
    peakMemoryBytes: () => Number(ex.aps_peak_memory_bytes()),
    /** 请求取消（协作式）；也可直接 terminate 所在 Worker */
    cancel: () => ex.aps_cancel(),
    /**
     * 求解 PlanProblem JSON 文本。
     * @param {string} problemText
     * @returns {{status:string, statusCode:number, solution:object, raw:string}}
     */
    solve(problemText) {
      const bytes = encoder.encode(problemText);
      const ptr = ex.aps_alloc(bytes.length);
      if (ptr === 0) throw new Error('aps_alloc 失败（内存不足）');
      try {
        mem().set(bytes, ptr);
        const code = ex.aps_solve(ptr, bytes.length);
        const len = Number(ex.aps_result_len());
        const raw = decoder.decode(mem().subarray(ex.aps_result_ptr(), ex.aps_result_ptr() + len));
        return { status: STATUS[code] ?? `CODE_${code}`, statusCode: code, solution: JSON.parse(raw), raw };
      } finally {
        ex.aps_free(ptr, bytes.length);
      }
    },
  };
}

/**
 * 一行把当前上下文变成 Worker：收到 {problemText} 就回 {status, solution}。
 * @param {URL|string} wasmUrl
 */
export function installWorker(wasmUrl) {
  let enginePromise = createEngine(wasmUrl);
  self.onmessage = async (event) => {
    const { type, problemText, id } = event.data ?? {};
    try {
      const engine = await enginePromise;
      if (type === 'cancel') {
        engine.cancel();
        self.postMessage({ id, type: 'cancelled' });
        return;
      }
      if (type === 'version') {
        self.postMessage({ id, type: 'version', version: engine.version });
        return;
      }
      const result = engine.solve(problemText);
      self.postMessage({
        id,
        type: 'solved',
        status: result.status,
        peakMemoryBytes: engine.peakMemoryBytes(),
        solution: result.solution,
      });
    } catch (err) {
      self.postMessage({ id, type: 'error', message: String(err?.message ?? err) });
    }
  };
}
