/**
 * agv-dispatch-engine 的 WASM 胶水（Web Worker / Node 通用，无第三方依赖）。
 *
 * 与 `mapf/rust/web/mapf-worker.js` 同一方法论（手写 C ABI 绑定，对应
 * `agv/rust/src/wasm_api.rs`）：
 *  - 宿主必须提供 `env.aps_now_ms()`（用 performance.now / Date.now；本 crate 复用
 *    aps 的时钟层，因此导入名保持 `aps_now_ms`，同时提供 `agv_now_ms` 别名）；
 *  - wasm 内存可能增长：所有 TypedArray 视图在每次调用后重新获取；
 *  - 求解全程同步执行——浏览器里必须放在 Web Worker 中；取消 = terminate + 重建。
 *
 * 用法（Worker 入口）：
 *   import { installWorker } from './agv-worker.js';
 *   installWorker(new URL('./agv_engine.wasm', import.meta.url));
 *
 * 用法（Node / 任意 JS）：
 *   import { createEngine } from './agv-worker.js';
 *   const engine = await createEngine(new URL('./agv_engine.wasm', import.meta.url));
 *   const out = engine.solve(problemJsonText);   // {status, solution, raw, ...}
 */

/** 求解必需的导出（缺任何一个都不可能是本引擎的 wasm）。 */
const REQUIRED_ABI = {
  alloc: 'agv_alloc',
  free: 'agv_free',
  solve: 'agv_solve',
  cancel: 'agv_cancel',
  resultPtr: 'agv_result_ptr',
  resultLen: 'agv_result_len',
  version: 'agv_version',
  peakMemory: 'agv_peak_memory_bytes',
};

/** 分析类导出（verify / fingerprint / capabilities / 参数覆盖求解），可选装载。 */
const OPTIONAL_ABI = {
  verify: 'agv_verify',
  fingerprint: 'agv_fingerprint',
  capabilities: 'agv_capabilities',
  solveWithOptions: 'agv_solve_with_options',
};

/** 与 src/wasm_api.rs（errors::Status::code）的状态码约定一一对应（0 = ABI/参数错误）。 */
export const STATUS = {
  1: 'FEASIBLE',
  2: 'PARTIAL',
  3: 'UNKNOWN',
  4: 'INFEASIBLE',
  5: 'INVALID_INPUT',
  6: 'UNSUPPORTED',
  7: 'CANCELLED',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/**
 * 装载 wasm 模块。
 * @param {URL|string|ArrayBuffer|Uint8Array|WebAssembly.Module} source
 */
export async function createEngine(source) {
  const now = () => (globalThis.performance?.now?.() ?? Date.now());
  const imports = {
    env: {
      // std::time 在 wasm32-unknown-unknown 上不可用，由宿主注入单调毫秒。
      aps_now_ms: now,
      agv_now_ms: now,
    },
  };
  let instance;
  if (source instanceof WebAssembly.Module) {
    instance = await WebAssembly.instantiate(source, imports);
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
  for (const [key, name] of Object.entries(REQUIRED_ABI)) {
    if (typeof ex[name] !== 'function') {
      throw new Error(`wasm 模块缺少导出 ${name}（${key}，请用 scripts/build_wasm.sh 重新构建）`);
    }
  }
  const analysis = {};
  for (const [key, name] of Object.entries(OPTIONAL_ABI)) {
    analysis[key] = typeof ex[name] === 'function' ? name : null;
  }
  const hasAnalysis = Object.values(analysis).every(Boolean);

  const mem = () => new Uint8Array(ex.memory.buffer);
  const version = () => {
    const ptr = ex.agv_version();
    const bytes = mem();
    let end = ptr;
    while (bytes[end] !== 0) end += 1;
    return decoder.decode(bytes.subarray(ptr, end));
  };

  /** 读取结果缓冲区（每次调用重新取视图：wasm 内存可能已增长）。 */
  const readResult = () => {
    const ptr = ex.agv_result_ptr();
    const len = Number(ex.agv_result_len());
    return decoder.decode(mem().subarray(ptr, ptr + len));
  };

  /** 把 `texts` 逐段写入 wasm 堆，调用 `fn(...ptrs, ...lens)`，最后释放。 */
  const withBuffers = (texts, fn) => {
    const bufs = texts.map((t) => encoder.encode(t));
    const ptrs = [];
    try {
      for (const b of bufs) {
        const ptr = ex.agv_alloc(b.length);
        if (ptr === 0) throw new Error('agv_alloc 失败（内存不足）');
        ptrs.push(ptr);
        mem().set(b, ptr);
      }
      return fn(ptrs, bufs.map((b) => b.length));
    } finally {
      ptrs.forEach((ptr, i) => ex.agv_free(ptr, bufs[i].length));
    }
  };

  const engine = {
    version: version(),
    hasAnalysis,
    analysisExports: analysis,
    peakMemoryBytes: () => Number(ex.agv_peak_memory_bytes()),
    /** 协作式取消标记（对下一次 solve 生效；在途同步 solve 请 terminate Worker）。 */
    cancel: () => ex.agv_cancel(),
    /**
     * 求解 AgvDispatchProblem JSON 文本（wasm 固定 wasm-light 档位 + 默认核验）。
     * `options` 为宿主级参数覆盖（time_limit_ms / seed / algorithm /
     * mapf_planner / mapf_suboptimality_factor / mapf_time_limit_ms / horizon /
     * verify / solution_id），走 `agv_solve_with_options`。
     * @returns {{status:string, statusCode:number, solution:object, raw:string, error?:string}}
     */
    solve(problemText, options) {
      const useOptions = Boolean(options && Object.keys(options).length > 0);
      if (useOptions && !analysis.solveWithOptions) {
        throw new Error('当前 wasm 产物不支持参数覆盖（agv_solve_with_options），请重新构建');
      }
      const texts = useOptions ? [problemText, JSON.stringify(options)] : [problemText];
      return withBuffers(texts, (ptrs, lens) => {
        const code = useOptions
          ? ex[analysis.solveWithOptions](ptrs[0], lens[0], ptrs[1], lens[1])
          : ex[REQUIRED_ABI.solve](ptrs[0], lens[0]);
        const raw = readResult();
        let solution;
        try {
          solution = JSON.parse(raw);
        } catch {
          solution = null;
        }
        if (code === 0) {
          return { status: 'ABI_ERROR', statusCode: 0, solution, raw, error: solution?.error ?? '参数错误' };
        }
        return { status: STATUS[code] ?? `CODE_${code}`, statusCode: code, solution, raw };
      });
    },
    /**
     * 独立核验（与求解器解耦的 verify.rs；动态问题会先展开再核验）。
     * @returns {{code:number, report:object}}
     */
    verify(problemText, solutionText, opts = {}) {
      const name = analysis.verify;
      if (!name) throw new Error('当前 wasm 产物不含 agv_verify（请重新构建以启用在线核验）');
      const strict = opts.strict ? 1 : 0;
      return withBuffers([problemText, solutionText], ([pp, sp], [pl, sl]) => {
        const code = ex[name](pp, pl, sp, sl, strict);
        return { code, report: JSON.parse(readResult()) };
      });
    },
    /** 方案指纹（与 CLI `agv fingerprint` 同源；结果文本在 result 缓冲区）。 */
    fingerprint(solutionText) {
      const name = analysis.fingerprint;
      if (!name) throw new Error('当前 wasm 产物不含 agv_fingerprint（请重新构建）');
      return withBuffers([solutionText], ([ptr], [len]) => {
        const code = ex[name](ptr, len);
        return { code, report: JSON.parse(readResult()) };
      });
    },
    /** 当前档位能力声明（wasm 固定为 wasm-light）。 */
    capabilities() {
      const name = analysis.capabilities;
      if (!name) throw new Error('当前 wasm 产物不含 agv_capabilities（请重新构建）');
      ex[name]();
      return JSON.parse(readResult());
    },
  };
  return engine;
}

/**
 * 把当前上下文变成 Worker：收到 `{id, type:'solve', problemText}` 就回 `solved`。
 *
 * 取消语义（与 aps/mapf 相同，勿误解）：`solve()` 在 Worker 内同步执行，运行期间
 * 收不到 `{type:'cancel'}` 消息；主线程唯一**即时**的取消手段是
 * `worker.terminate()`（见 `spawnSolver()`）。`{type:'cancel'}` 只对尚未开始的
 * 排队请求有效。
 */
export function installWorker(defaultWasmUrl) {
  const fallbackUrl =
    defaultWasmUrl ??
    (typeof import.meta !== 'undefined' && import.meta.url
      ? new URL('./agv_engine.wasm', import.meta.url)
      : undefined);

  let enginePromise = null;
  const engineFor = (src) => {
    if (!enginePromise) {
      const target = src ?? fallbackUrl;
      if (!target) throw new Error('未提供 WASM 模块或路径');
      enginePromise = createEngine(target);
    }
    return enginePromise;
  };
  self.onmessage = async (event) => {
    const { type, problemText, solutionText, strict, options, id, wasmUrl, wasm } = event.data ?? {};
    try {
      if (type === 'init' || type === 'version') {
        const engine = await engineFor(wasm ?? wasmUrl);
        self.postMessage({ id, type: 'ready', version: engine.version });
        return;
      }
      if (type === 'cancel') {
        const engine = engineFor();
        Promise.resolve(engine).then((e) => e.cancel()).catch(() => {});
        self.postMessage({ id, type: 'cancelled' });
        return;
      }
      const engine = await engineFor(wasm ?? wasmUrl);
      if (type === 'verify') {
        const { report } = engine.verify(problemText, solutionText, { strict: Boolean(strict) });
        self.postMessage({ id, type: 'verified', report });
        return;
      }
      if (type === 'fingerprint') {
        const { report } = engine.fingerprint(solutionText);
        self.postMessage({ id, type: 'fingerprinted', report });
        return;
      }
      if (type === 'capabilities') {
        self.postMessage({ id, type: 'capabilities', report: engine.capabilities() });
        return;
      }
      const result = engine.solve(problemText, options);
      self.postMessage({
        id,
        type: 'solved',
        status: result.status,
        statusCode: result.statusCode,
        error: result.error,
        peakMemoryBytes: engine.peakMemoryBytes(),
        solution: result.solution,
        // 原始输出文本：指纹 / 核验 / 展示都以它为准（不要在宿主侧重序列化）。
        raw: result.raw,
        hasAnalysis: engine.hasAnalysis,
      });
    } catch (err) {
      self.postMessage({ id, type: 'error', message: String(err?.message ?? err) });
    }
  };
}

/** 取消时抛出的错误：与“求解失败”区分，便于 UI 显示“已取消”。 */
export class SolveCancelledError extends Error {
  constructor(message = '求解已取消（Worker 已终止）') {
    super(message);
    this.name = 'SolveCancelledError';
  }
}

/**
 * 主线程侧求解控制器：取消 = 终止 Worker 并重建（浏览器里唯一能立即打断同步
 * WASM 求解的方式）。推荐主线程预编译模块（`wasm`），重建线程时无需重新取回/编译。
 */
export function spawnSolver(workerSource, opts = {}) {
  const { wasmUrl, wasm, workerOptions = { type: 'module' } } = opts;
  let worker = null;
  let inflight = null; // { id, resolve, reject }
  let seq = 0;
  let terminatedByUs = false;

  const spawn = () => {
    worker =
      typeof workerSource === 'function' ? workerSource() : new Worker(workerSource, workerOptions);
    worker.onmessage = (event) => {
      const msg = event.data ?? {};
      if (!inflight || msg.id !== inflight.id) return;
      const { resolve, reject } = inflight;
      inflight = null;
      if (msg.type === 'solved') resolve(msg);
      else if (msg.type === 'error') reject(new Error(msg.message));
      else resolve(msg);
    };
    worker.onerror = (err) => {
      const p = inflight;
      inflight = null;
      worker?.terminate();
      worker = null;
      const errorMsg =
        err?.message ||
        (err && typeof err === 'object' && 'filename' in err
          ? `${err.message || 'Worker 脚本加载或运行异常'} (${err.filename}:${err.lineno})`
          : String(err ?? 'Worker 未知错误'));
      if (p) p.reject(new Error(errorMsg));
    };
    if (wasm ?? wasmUrl) {
      worker.postMessage({ type: 'init', wasm: wasm ?? undefined, wasmUrl: wasm ? undefined : String(wasmUrl) });
    }
    return worker;
  };

  const hardStop = (reason) => {
    const p = inflight;
    inflight = null;
    if (worker) {
      terminatedByUs = true;
      worker.terminate();
      worker = null;
    }
    if (p) p.reject(reason);
    return Boolean(p);
  };

  const request = (payload) => {
    const w = worker ?? spawn();
    terminatedByUs = false;
    return new Promise((resolve, reject) => {
      const id = ++seq;
      inflight = { id, resolve, reject };
      w.postMessage({ ...payload, id });
    });
  };

  return {
    /** 求解一次；解析结果 `{status, statusCode, peakMemoryBytes, solution, raw, hasAnalysis}`。 */
    solve(problemText, options) {
      return request({ type: 'solve', problemText, options });
    },
    verify(problemText, solutionText, opts = {}) {
      return request({ type: 'verify', problemText, solutionText, strict: Boolean(opts.strict) });
    },
    fingerprint(solutionText) {
      return request({ type: 'fingerprint', solutionText });
    },
    capabilities() {
      return request({ type: 'capabilities' });
    },
    /** 立即取消在途求解（终止 Worker），下次 `solve()` 自动重建。 */
    cancel() {
      return hardStop(new SolveCancelledError());
    },
    dispose() {
      hardStop(new SolveCancelledError('求解器已释放'));
    },
    get busy() {
      return inflight !== null;
    },
    get restarted() {
      return terminatedByUs;
    },
  };
}

// 浏览器 Web Worker 环境（new Worker(url, { type: 'module' })）自动挂载监听器
if (
  typeof self !== 'undefined' &&
  typeof window === 'undefined' &&
  typeof document === 'undefined' &&
  typeof self.postMessage === 'function'
) {
  try {
    installWorker();
  } catch {
    // 忽略非 Worker 环境（如沙箱纯模块加载测试）
  }
}
