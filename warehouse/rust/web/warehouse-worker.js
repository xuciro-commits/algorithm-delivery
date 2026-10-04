/**
 * rust-warehouse（仓储优化套件）的 WASM 胶水（Web Worker / Node 通用，无第三方依赖）。
 *
 * 与 `aps/rust/web/aps-worker.js`、`agv/rust/web/agv-worker.js` 同一方法论
 * （手写 C ABI 绑定，对应 `warehouse/rust/src/wasm_api.rs`）：
 *  - 宿主必须提供 `env.aps_now_ms()`（用 performance.now / Date.now；本 crate 复用
 *    aps 的时钟层，因此导入名保持 `aps_now_ms`）；
 *  - wasm 内存可能增长：所有 TypedArray 视图在每次调用后重新获取；
 *  - 求解全程同步执行——浏览器里必须放在 Web Worker 中；取消 = terminate + 重建。
 *
 * 三个入口对应三类问题（与 CLI `warehouse solve` 的分派一致）：
 *   slotting（库位优化） / asrs（密集立库调度） / joint（联合优化）。
 *
 * 用法（Worker 入口）：
 *   import { installWorker } from './warehouse-worker.js';
 *   installWorker(new URL('./warehouse_engine.wasm', import.meta.url));
 *
 * 用法（Node / 任意 JS）：
 *   import { createEngine } from './warehouse-worker.js';
 *   const engine = await createEngine(new URL('./warehouse_engine.wasm', import.meta.url));
 *   const out = engine.solve(problemJsonText);   // {status, envelope, raw, ...}
 */

/** 求解必需的导出（缺任何一个都不可能是本引擎的 wasm）。 */
const REQUIRED_ABI = {
  alloc: 'wh_alloc',
  free: 'wh_free',
  solve: 'wh_solve',
  cancel: 'wh_cancel',
  resultPtr: 'wh_result_ptr',
  resultLen: 'wh_result_len',
  freeResult: 'wh_free_result',
  version: 'wh_version',
  peakMemory: 'wh_peak_memory_bytes',
};

/** 分析 / 生成类导出（verify / capabilities / scenarios / generate / 参数覆盖），可选装载。 */
const OPTIONAL_ABI = {
  verify: 'wh_verify',
  capabilities: 'wh_capabilities',
  scenarios: 'wh_scenarios',
  generate: 'wh_generate',
  solveWithOptions: 'wh_solve_with_options',
  solveSummary: 'wh_solve_summary',
  abiVersion: 'wh_abi_version',
};

/**
 * 状态码 → 状态名。与 `src/errors.rs::Status::code()` 一一对应；
 * `0` 表示参数 / ABI 错误（不是求解状态）。
 */
export const STATUS = {
  1: 'OPTIMAL_PROVEN',
  2: 'FEASIBLE_WITH_BOUND',
  3: 'FEASIBLE',
  4: 'BUDGET_EXCEEDED',
  5: 'NO_SOLUTION_FOUND',
  6: 'INFEASIBLE_PROVEN',
  7: 'CANCELLED',
  8: 'INVALID_INPUT',
  9: 'UNSUPPORTED',
  10: 'INTERNAL_ERROR',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/**
 * 装载 wasm 模块。
 * @param {URL|string|ArrayBuffer|Uint8Array|WebAssembly.Module} source
 */
export async function createEngine(source) {
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const imports = {
    env: {
      // std::time 在 wasm32-unknown-unknown 上不可用，由宿主注入单调毫秒。
      aps_now_ms: now,
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

  /** 读取结果缓冲区（每次调用重新取视图：wasm 内存可能已增长）。 */
  const readResult = () => {
    const ptr = ex[REQUIRED_ABI.resultPtr]();
    const len = Number(ex[REQUIRED_ABI.resultLen]());
    return decoder.decode(mem().subarray(ptr, ptr + len));
  };

  /**
   * 版本字符串：`wh_version` 把 `engine/version` 写进**结果缓冲区**并返回长度
   * （与 agv 返回 NUL 结尾指针的做法不同），因此这里必须显式读缓冲区 ——
   * 直接把返回值当指针用会读出空串（真 bug，已由 wasm 冒烟测试抓出）。
   */
  const version = () => {
    ex[REQUIRED_ABI.version]();
    return readResult();
  };

  /** 把 `texts` 逐段写入 wasm 堆，调用 `fn(...ptrs, ...lens)`，最后释放。 */
  const withBuffers = (texts, fn) => {
    const bufs = texts.map((t) => encoder.encode(t));
    const ptrs = [];
    try {
      for (const b of bufs) {
        const ptr = ex[REQUIRED_ABI.alloc](b.length);
        if (ptr === 0) throw new Error('wh_alloc 失败（内存不足）');
        ptrs.push(ptr);
        mem().set(b, ptr);
      }
      return fn(ptrs, bufs.map((b) => b.length));
    } finally {
      ptrs.forEach((ptr, i) => ex[REQUIRED_ABI.free](ptr, bufs[i].length));
    }
  };

  /** 统一出口：状态码 → 状态名；结果文本 → JSON（解析失败时保留 raw）。 */
  const finish = (code, extra = {}) => {
    const raw = readResult();
    let envelope = null;
    try {
      envelope = JSON.parse(raw);
    } catch {
      envelope = null;
    }
    if (code === 0) {
      return { status: 'ABI_ERROR', statusCode: 0, envelope, raw, error: '参数或 ABI 错误', ...extra };
    }
    return { status: STATUS[code] ?? `CODE_${code}`, statusCode: code, envelope, raw, ...extra };
  };

  const engine = {
    version: version(),
    abiVersion: analysis.abiVersion ? Number(ex[analysis.abiVersion]()) : null,
    hasAnalysis,
    analysisExports: analysis,
    peakMemoryBytes: () => Number(ex[REQUIRED_ABI.peakMemory]()),
    /** 协作式取消标记（对下一次 solve 生效；在途同步 solve 请 terminate Worker）。 */
    cancel: () => ex[REQUIRED_ABI.cancel](),
    /**
     * 求解一份问题文档（`kind` 决定是 slotting / asrs / joint）。
     * `options` 为覆盖参数（algorithm / seed / budgetMs / dualCommand / includeTimeline /
     * verify / maxTasks …），走 `wh_solve_with_options`。
     * @returns {{status:string, statusCode:number, envelope:object, raw:string}}
     */
    solve(problemText, options) {
      const useOptions = Boolean(options && Object.keys(options).length > 0);
      if (useOptions && !analysis.solveWithOptions) {
        throw new Error('当前 wasm 产物不支持参数覆盖（wh_solve_with_options），请重新构建');
      }
      const texts = useOptions ? [problemText, JSON.stringify(options)] : [problemText];
      return withBuffers(texts, (ptrs, lens) => {
        const code = useOptions
          ? ex[analysis.solveWithOptions](ptrs[0], lens[0], ptrs[1], lens[1])
          : ex[REQUIRED_ABI.solve](ptrs[0], lens[0]);
        return finish(code, { peakMemoryBytes: engine.peakMemoryBytes() });
      });
    },
    /** 求解并附加 `summary`（面板标题栏用；与 solve 同一份内核）。 */
    solveSummary(problemText, options) {
      if (!analysis.solveSummary) throw new Error('当前 wasm 产物不含 wh_solve_summary（请重新构建）');
      const useOptions = Boolean(options && Object.keys(options).length > 0);
      if (useOptions && !analysis.solveWithOptions) {
        throw new Error('当前 wasm 产物不支持参数覆盖（wh_solve_with_options），请重新构建');
      }
      const texts = useOptions ? [problemText, JSON.stringify(options)] : [problemText];
      return withBuffers(texts, (ptrs, lens) => {
        const code = useOptions
          ? ex[analysis.solveWithOptions](ptrs[0], lens[0], ptrs[1], lens[1])
          : ex[analysis.solveSummary](ptrs[0], lens[0]);
        return finish(code, { peakMemoryBytes: engine.peakMemoryBytes() });
      });
    },
    /**
     * 独立核验：输入是**求解信封**（solve 的输出文本），验证器自行重放约束并重算指标。
     * 与求解器解耦：篡改方案后必须报出具体违规（X12 场景守的就是这条）。
     */
    verify(envelopeText) {
      const name = analysis.verify;
      if (!name) throw new Error('当前 wasm 产物不含 wh_verify（请重新构建以启用在线核验）');
      return withBuffers([envelopeText], ([ptr], [len]) => {
        const code = ex[name](ptr, len);
        const raw = readResult();
        let report = null;
        try {
          report = JSON.parse(raw);
        } catch {
          report = null;
        }
        return { code, status: STATUS[code] ?? `CODE_${code}`, report, raw };
      });
    },
    /** 当前档位能力声明（wasm 固定 wasm-light）。 */
    capabilities() {
      const name = analysis.capabilities;
      if (!name) throw new Error('当前 wasm 产物不含 wh_capabilities（请重新构建）');
      ex[name]();
      return JSON.parse(readResult());
    },
    /** 86 个标准场景清单（面板的场景选择器直接用引擎的清单，不在前端硬编码）。 */
    scenarios() {
      const name = analysis.scenarios;
      if (!name) throw new Error('当前 wasm 产物不含 wh_scenarios（请重新构建）');
      ex[name]();
      return JSON.parse(readResult());
    },
    /** 按场景 id + 规模档位生成问题文档（与 CLI `warehouse generate` 同源）。 */
    generate(request) {
      const name = analysis.generate;
      if (!name) throw new Error('当前 wasm 产物不含 wh_generate（请重新构建）');
      return withBuffers([JSON.stringify(request)], ([ptr], [len]) => {
        const code = ex[name](ptr, len);
        const raw = readResult();
        let document = null;
        try {
          document = JSON.parse(raw);
        } catch {
          document = null;
        }
        return { code, status: STATUS[code] ?? `CODE_${code}`, document, raw };
      });
    },
  };
  return engine;
}

/**
 * 把当前上下文变成 Worker：收到 `{id, type:'solve', problemText}` 就回 `solved`。
 *
 * 取消语义（与 aps/mapf/agv 相同，勿误解）：`solve()` 在 Worker 内同步执行，运行期间
 * 收不到 `{type:'cancel'}` 消息；主线程唯一**即时**的取消手段是
 * `worker.terminate()`（见 `spawnSolver()`）。`{type:'cancel'}` 只对尚未开始的
 * 排队请求有效。
 */
export function installWorker(defaultWasmUrl) {
  const fallbackUrl =
    defaultWasmUrl ??
    (typeof import.meta !== 'undefined' && import.meta.url
      ? new URL('./warehouse_engine.wasm', import.meta.url)
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
    const { type, problemText, envelopeText, options, request, id, wasmUrl, wasm } = event.data ?? {};
    try {
      if (type === 'init' || type === 'version') {
        const engine = await engineFor(wasm ?? wasmUrl);
        self.postMessage({ id, type: 'ready', version: engine.version, abiVersion: engine.abiVersion });
        return;
      }
      if (type === 'cancel') {
        engineFor()
          .then((e) => e.cancel())
          .catch(() => {});
        self.postMessage({ id, type: 'cancelled' });
        return;
      }
      const engine = await engineFor(wasm ?? wasmUrl);
      if (type === 'verify') {
        const { report, status } = engine.verify(envelopeText);
        self.postMessage({ id, type: 'verified', report, status });
        return;
      }
      if (type === 'capabilities') {
        self.postMessage({ id, type: 'capabilities', report: engine.capabilities() });
        return;
      }
      if (type === 'scenarios') {
        self.postMessage({ id, type: 'scenarios', report: engine.scenarios() });
        return;
      }
      if (type === 'generate') {
        const out = engine.generate(request ?? {});
        self.postMessage({ id, type: 'generated', status: out.status, document: out.document, raw: out.raw });
        return;
      }
      const summarize = type === 'solveSummary';
      const result = summarize ? engine.solveSummary(problemText, options) : engine.solve(problemText, options);
      self.postMessage({
        id,
        type: 'solved',
        status: result.status,
        statusCode: result.statusCode,
        error: result.error,
        peakMemoryBytes: result.peakMemoryBytes ?? engine.peakMemoryBytes(),
        envelope: result.envelope,
        // 原始输出文本：核验 / 展示都以它为准（不要在宿主侧重序列化）。
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
    /** 求解一次；解析 `{status, statusCode, peakMemoryBytes, envelope, raw, hasAnalysis}`。 */
    solve(problemText, options) {
      return request({ type: 'solve', problemText, options });
    },
    solveSummary(problemText, options) {
      return request({ type: 'solveSummary', problemText, options });
    },
    verify(envelopeText) {
      return request({ type: 'verify', envelopeText });
    },
    capabilities() {
      return request({ type: 'capabilities' });
    },
    scenarios() {
      return request({ type: 'scenarios' });
    },
    generate(scenarioId, scale, seed) {
      return request({ type: 'generate', request: { scenarioId, scale, seed } });
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
