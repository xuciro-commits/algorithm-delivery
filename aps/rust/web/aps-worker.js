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

/** 求解必需的导出（缺任何一个都不可能是本引擎的 wasm）。 */
const REQUIRED_ABI = {
  alloc: 'aps_alloc',
  free: 'aps_free',
  solve: 'aps_solve',
  cancel: 'aps_cancel',
  resultPtr: 'aps_result_ptr',
  resultLen: 'aps_result_len',
  version: 'aps_version',
  peakMemory: 'aps_peak_memory_bytes',
};

/**
 * 分析类导出（verify / fingerprint / capabilities）。**可选**：
 * 老版本 wasm（1.0.0 之前）没有它们，实验室会显示“该产物不支持在线核验”，
 * 而不是整个模块装载失败。重新构建（scripts/build_wasm.sh）即可获得。
 */
const OPTIONAL_ABI = {
  verify: 'aps_verify',
  fingerprint: 'aps_fingerprint',
  capabilities: 'aps_capabilities',
  solveWithOptions: 'aps_solve_with_options',
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
    // 注意：instantiate(Module, imports) 直接返回 Instance（不是 {module, instance}）。
    // 只有传入字节时才返回 {module, instance}。两者不可混用。
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
    const ptr = ex.aps_version();
    const bytes = mem();
    let end = ptr;
    while (bytes[end] !== 0) end += 1;
    return decoder.decode(bytes.subarray(ptr, end));
  };

  /** 读取结果缓冲区（每次调用都重新取视图：wasm 内存可能已增长）。 */
  const readResult = () => {
    const ptr = ex.aps_result_ptr();
    const len = Number(ex.aps_result_len());
    return decoder.decode(mem().subarray(ptr, ptr + len));
  };

  /** 把 `texts` 逐段写入 wasm 堆，调用 `fn(...ptrs, ...lens)`，最后释放。 */
  const withBuffers = (texts, fn) => {
    const bufs = texts.map((t) => encoder.encode(t));
    const ptrs = [];
    try {
      for (const b of bufs) {
        const ptr = ex.aps_alloc(b.length);
        if (ptr === 0) throw new Error('aps_alloc 失败（内存不足）');
        ptrs.push(ptr);
        mem().set(b, ptr);
      }
      return fn(ptrs, bufs.map((b) => b.length));
    } finally {
      ptrs.forEach((ptr, i) => ex.aps_free(ptr, bufs[i].length));
    }
  };

  const engine = {
    version: version(),
    /** 分析类导出是否齐全（verify / fingerprint / capabilities） */
    hasAnalysis,
    analysisExports: analysis,
    /** 峰值内存（字节） */
    peakMemoryBytes: () => Number(ex.aps_peak_memory_bytes()),
    /** 请求取消（协作式）；浏览器里推荐直接 terminate 所在 Worker（见 spawnSolver） */
    cancel: () => ex.aps_cancel(),
    /**
     * 求解 PlanProblem JSON 文本。
     *
     * `options` 为**宿主级参数覆盖**（seed / time_limit_ms / strategy / rule / repair /
     * max_iterations），走 `aps_solve_with_options`；不传则用问题自带的 `objective` 块。
     * @param {string} problemText
     * @param {object} [options]
     * @returns {{status:string, statusCode:number, solution:object, raw:string}}
     */
    solve(problemText, options) {
      const useOptions = Boolean(options && Object.keys(options).length > 0);
      if (useOptions && !analysis.solveWithOptions) {
        throw new Error('当前 wasm 产物不支持参数覆盖（aps_solve_with_options），请重新构建');
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
        // 0 = ABI/参数错误：结果缓冲区里带 {error}
        if (code === 0) {
          return {
            status: 'ABI_ERROR',
            statusCode: 0,
            solution,
            raw,
            error: solution?.error ?? '参数错误',
          };
        }
        return {
          status: STATUS[code] ?? `CODE_${code}`,
          statusCode: code,
          solution,
          raw,
        };
      });
    },
    /**
     * 独立核验（与求解器解耦的 verifier，见 src/verify.rs）。
     * @param {string} problemText PlanProblem JSON
     * @param {string} solutionText PlanSolution JSON
     * @param {{strict?: boolean}} [opts] strict=true 时要求 tenant_id / problem_hash 绑定
     * @returns {{mode:string, ok:boolean, parsed:boolean, counts:object, violations:Array, issues:Array}}
     */
    verify(problemText, solutionText, opts = {}) {
      const name = analysis.verify;
      if (!name) throw new Error('当前 wasm 产物不含 aps_verify（请重新构建以启用在线核验）');
      const strict = opts.strict ? 1 : 0;
      return withBuffers([problemText, solutionText], ([pp, sp], [pl, sl]) => {
        const code = ex[name](pp, pl, sp, sl, strict);
        return { code, report: JSON.parse(readResult()) };
      });
    },
    /** 方案指纹：规范化 JSON 去除运行期 metrics 后的 sha256（与 CLI `aps fingerprint` 同源）。 */
    fingerprint(solutionText) {
      const name = analysis.fingerprint;
      if (!name) throw new Error('当前 wasm 产物不含 aps_fingerprint（请重新构建）');
      return withBuffers([solutionText], ([ptr], [len]) => {
        const code = ex[name](ptr, len);
        return { code, report: JSON.parse(readResult()) };
      });
    },
    /** 当前档位能力声明（wasm-light；严格符合 solver-capabilities.schema.json）。 */
    capabilities() {
      const name = analysis.capabilities;
      if (!name) throw new Error('当前 wasm 产物不含 aps_capabilities（请重新构建）');
      ex[name]();
      return JSON.parse(readResult());
    },
  };
  return engine;
}

/**
 * 一行把当前上下文变成 Worker：收到 {problemText} 就回 {status, solution}。
 * @param {URL|string} wasmUrl
 */
/**
 * 把当前上下文变成 Worker：收到 `{id, type:'solve', problemText}` 就回 `solved`。
 *
 * 取消语义（重要，勿误解）：
 *  `solve()` 在 Worker 内是**同步**执行的（整个求解过程占用 Worker 线程），
 *  因此运行期间 Worker 既收不到 `{type:'cancel'}` 消息，`aps_cancel()` 也无法被调用。
 *  主线程唯一的**即时**取消手段是 `worker.terminate()` —— 见下方的 `spawnSolver()`。
 *  `{type:'cancel'}` 只对“排队中但尚未开始”的请求有效（此处直接回执 cancelled）。
 *
 * @param {URL|string} defaultWasmUrl
 */
export function installWorker(defaultWasmUrl) {
  const fallbackUrl =
    defaultWasmUrl ??
    (typeof import.meta !== 'undefined' && import.meta.url
      ? new URL('./aps_engine.wasm', import.meta.url)
      : undefined);

  let enginePromise = null;
  // `wasm` 可以是 URL、Uint8Array 或（可在主线程预编译后 postMessage 过来的）WebAssembly.Module；
  // 取消/重建工作线程时复用同一份预编译模块，避免重复取回与编译。
  const engineFor = (src) => {
    if (!enginePromise) {
      const target = src ?? fallbackUrl;
      if (!target) {
        throw new Error('未提供 WASM 模块或路径');
      }
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
        // 同步求解期间本消息不会被处理：能走到这里说明当前没有在跑的求解。
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
        // 引擎的原始输出文本：指纹 / 核验 / 展示都以它为准，
        // 不要在宿主侧重新序列化（浮点格式与键序可能改变指纹）。
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
 * 主线程侧求解控制器：把“取消”实现为**终止 Worker 并重建**，
 * 这是浏览器里唯一能立即打断同步 WASM 求解的方式（见 `installWorker` 的说明）。
 *
 * ```js
 * const solver = spawnSolver(new URL('./aps-worker.js', import.meta.url), {
 *   wasmUrl: new URL('./aps_engine.wasm', import.meta.url),
 * });
 * const p = solver.solve(problemText);
 * setTimeout(() => solver.cancel(), 5000);   // 5 秒还没算完就取消
 * ```
 *
 * 推荐在主线程把 wasm 编译一次再传进来（`wasm`）：取消重建工作线程时无需重新下载/编译。
 *
 * ```js
 * const bytes = await (await fetch(wasmUrl)).arrayBuffer();
 * const solver = spawnSolver(workerUrl, { wasm: new WebAssembly.Module(bytes) });
 * ```
 *
 * @param {URL|string|Function} workerSource Worker 构造来源（URL 或返回 Worker 的工厂函数）
 * @param {{wasmUrl?: URL|string, wasm?: WebAssembly.Module|Uint8Array, workerOptions?: object}} [opts]
 */
export function spawnSolver(workerSource, opts = {}) {
  const { wasmUrl, wasm, workerOptions = { type: 'module' } } = opts;
  let worker = null;
  let inflight = null; // { id, resolve, reject }
  let seq = 0;
  let terminatedByUs = false;

  const spawn = () => {
    worker =
      typeof workerSource === 'function'
        ? workerSource()
        : new Worker(workerSource, workerOptions);
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
      // WebAssembly.Module 可结构化克隆，重启用同一个预编译模块即可（无需重新取回/编译）
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

  /** 通用请求：Worker 按需启动，取消后按需重建。 */
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
    /**
     * 求解一次；Worker 按需启动、取消后按需重建。
     *
     * 解析结果（Promise 值）：
     *   `{ status, statusCode, error?, peakMemoryBytes, solution, raw, hasAnalysis }`
     * 其中 `raw` 是引擎输出的原始 JSON 文本，**指纹与核验必须用它**，
     * 不要在宿主侧对 `solution` 重新序列化（浮点格式/键序变化会改变指纹）。
     *
     * @param {string} problemText
     * @param {object} [options] 宿主级参数覆盖（见 createEngine().solve）
     */
    solve(problemText, options) {
      return request({ type: 'solve', problemText, options });
    },
    /** 独立核验（在同一 Worker 内串行执行；需要 wasm 含 aps_verify）。 */
    verify(problemText, solutionText, opts = {}) {
      return request({
        type: 'verify',
        problemText,
        solutionText,
        strict: Boolean(opts.strict),
      });
    },
    /** 方案指纹（需要 wasm 含 aps_fingerprint）。 */
    fingerprint(solutionText) {
      return request({ type: 'fingerprint', solutionText });
    },
    /** 档位能力声明（需要 wasm 含 aps_capabilities）。 */
    capabilities() {
      return request({ type: 'capabilities' });
    },
    /** 立即取消在途求解（终止 Worker），下次 `solve()` 自动重建工作线程。 */
    cancel() {
      return hardStop(new SolveCancelledError());
    },
    /** 释放工作线程（组件卸载时调用）。 */
    dispose() {
      hardStop(new SolveCancelledError('求解器已释放'));
    },
    get busy() {
      return inflight !== null;
    },
    /** 是否因为取消/释放而终止过 Worker（用于诊断，不参与业务判断）。 */
    get restarted() {
      return terminatedByUs;
    },
  };
}

// 浏览器 Web Worker 环境下作为独立入口运行（new Worker(url, { type: 'module' })）时自动挂载监听器
if (
  typeof self !== 'undefined' &&
  typeof window === 'undefined' &&
  typeof document === 'undefined' &&
  typeof self.postMessage === 'function'
) {
  try {
    installWorker();
  } catch (err) {
    // 忽略非 Worker 环境或沙箱测试中的环境限制
  }
}
