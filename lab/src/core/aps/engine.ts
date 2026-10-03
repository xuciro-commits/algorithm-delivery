/**
 * APS 引擎适配层：把 `aps/rust/web/aps-worker.js`（WASM 胶水）包装成实验室可用的运行器。
 *
 * 生命周期（对应需求“正确处理求解中断和 Worker 生命周期”）：
 *  - wasm 求解是**同步**的，Worker 在求解期间不处理消息，因此“取消”= `terminate()`；
 *  - 取消/异常后 Worker 由 `spawnSolver` 自动重建，下次求解无需刷新页面；
 *  - 组件卸载时 `dispose()` 释放 Worker；
 *  - 主线程只预编译一次 wasm（`WebAssembly.Module`），重建 Worker 时直接复用，避免重复下载/编译。
 *
 * 本文件不依赖 DOM 之外的东西：在 Node 测试里通过 `spawn` 注入 worker_threads 适配器即可跑同一份逻辑。
 */

import type {
  CapabilitiesReport,
  FingerprintReport,
  PlanProblemLike,
  PlanSolutionLike,
  VerifyReport,
} from '../types';
import { buildVisualization } from './transform';
import type { RunRecord, RunMetrics } from './records';
import { paramsToOptions, type SolveParams } from './params';

export interface SolveOutcome {
  status: string;
  statusCode: number;
  solution: PlanSolutionLike | null;
  raw: string;
  peakMemoryBytes: number;
  error?: string;
}

/** 与 `spawnSolver()` 返回的控制器同形（便于 Node 测试注入）。 */
export interface EngineHandle {
  solve(problemText: string, options?: Record<string, unknown>): Promise<SolveOutcome>;
  verify(
    problemText: string,
    solutionText: string,
    opts?: { strict?: boolean },
  ): Promise<{ code: number; report: VerifyReport }>;
  fingerprint(solutionText: string): Promise<{ code: number; report: FingerprintReport }>;
  capabilities(): Promise<{ report: CapabilitiesReport }>;
  cancel(): boolean;
  dispose(): void;
  readonly busy: boolean;
  readonly restarted: boolean;
}

export type WorkerLike = {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export interface SpawnSolverLike {
  (workerSource: unknown, opts: unknown): EngineHandle;
}

export interface EngineBootOptions {
  /** Worker 入口 URL（浏览器里由 Vite 生成，Node 测试里传文件 URL） */
  workerUrl: string | URL;
  /** wasm URL（与 worker 之间以消息传递，因此用绝对 URL 更稳） */
  wasmUrl?: string | URL;
  /** 预编译模块（推荐：主线程编译一次，取消重建时复用） */
  wasm?: WebAssembly.Module;
  /** `spawnSolver` 实现（默认从 vendored 胶水导入；测试可注入） */
  spawnSolver?: SpawnSolverLike;
  /** Worker 工厂（Node 测试注入 worker_threads 适配器） */
  spawn?: () => WorkerLike;
  /** Worker 首次握手的超时；避免资产缺失时页面永久停留在 loading */
  handshakeTimeoutMs?: number;
}

/**
 * 创建引擎句柄：一次性预编译 wasm（可选）+ 常驻 Worker。
 * 返回的 `EngineHandle` 在 `dispose()` 之前可反复使用。
 */
export async function createEngineHandle(opts: EngineBootOptions): Promise<{
  handle: EngineHandle;
  version: string;
  capabilities: CapabilitiesReport | null;
}> {
  let spawnSolver: SpawnSolverLike;
  if (opts.spawnSolver) {
    spawnSolver = opts.spawnSolver;
  } else {
    // vendored 胶水（由 scripts/sync-engine.mjs 从 aps/rust/web/aps-worker.js 复制）
    const glue = await import('../../vendor/aps-worker.js');
    spawnSolver = glue.spawnSolver as unknown as SpawnSolverLike;
  }
  const workerSource = opts.spawn ?? String(opts.workerUrl);
  const handle = spawnSolver(workerSource, {
    wasmUrl: opts.wasm ? undefined : opts.wasmUrl ? String(opts.wasmUrl) : undefined,
    wasm: opts.wasm,
  });

  // 先握手：拿到 wasm 版本（`aps_version()`）并读能力声明
  let capabilities: CapabilitiesReport | null = null;
  let version = 'unknown';
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 8_000;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const caps = await Promise.race([
      handle.capabilities(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`APS Worker 握手超时（${Math.round(handshakeTimeoutMs / 1000)} 秒）`));
        }, handshakeTimeoutMs);
      }),
    ]);
    capabilities = caps.report ?? null;
    version = capabilities?.version ?? 'unknown';
  } catch (err) {
    if (timedOut) {
      handle.dispose();
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    const legacyWithoutCapabilities = message.includes('aps_capabilities') && /不含|缺少|missing/i.test(message);
    if (!legacyWithoutCapabilities) {
      handle.dispose();
      throw new Error(`APS Worker 初始化失败：${message}`);
    }
    // 老 wasm 没有 caps 导出：退回未知版本（求解接口仍可能可用）。
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return { handle, version, capabilities };
}

export interface RunOptions {
  problem: PlanProblemLike;
  problemName: string;
  params: SolveParams;
  /** 是否在求解后跑独立核验（默认 true） */
  verify?: boolean;
  /** 严格核验：要求 tenant_id / problem_hash 绑定（默认 false） */
  strict?: boolean;
  onPhase?: (phase: 'solving' | 'verifying' | 'fingerprinting' | 'done', detail?: string) => void;
  /** 取消信号：返回 true 时本运行标记为 cancelled */
  isCancelled?: () => boolean;
  now?: () => number;
}

function pickNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 执行一次完整运行：求解 → 独立核验 → 指纹 → 可视化模型。 */
export async function runOnce(engine: EngineHandle, opts: RunOptions): Promise<RunRecord> {
  const now = opts.now ?? (() => Date.now());
  const problemText = JSON.stringify(opts.problem);
  const started = now();
  opts.onPhase?.('solving', 'Worker 内执行 WASM 求解');

  let outcome: SolveOutcome;
  try {
    outcome = await engine.solve(problemText, paramsToOptions(opts.params));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cancelled = opts.isCancelled?.() ?? false;
    return emptyRecord(opts, now() - started, {
      status: cancelled ? 'CANCELLED' : 'UNKNOWN',
      statusCode: cancelled ? 8 : 4,
      error: message,
      cancelled,
    });
  }
  const wallMs = now() - started;

  const solution = outcome.solution;
  const cancelled = opts.isCancelled?.() ?? false;
  const metrics: RunMetrics = {
    firstFeasibleMs: pickNumber(solution?.metrics?.first_feasible_ms),
    totalMs: pickNumber(solution?.metrics?.total_ms),
    compileMs: pickNumber(solution?.metrics?.compile_ms),
    solveMs: pickNumber(solution?.metrics?.solve_ms),
    verifyMs: pickNumber(solution?.metrics?.verify_ms),
    peakMemoryBytes: pickNumber(solution?.metrics?.peak_memory_bytes) ?? outcome.peakMemoryBytes ?? null,
    wallMs,
  };

  const record: RunRecord = {
    ...emptyRecord(opts, wallMs, {
      status: outcome.status,
      statusCode: outcome.statusCode,
      error: outcome.error,
      cancelled,
    }),
    solution,
    raw: outcome.raw,
    metrics,
    problemHash: solution?.problem_hash ?? null,
    snapshotId: solution?.snapshot_id ?? null,
    engineVersion: solution?.engine_version ?? null,
  };

  if (solution && (outcome.status === 'FEASIBLE' || outcome.status === 'OPTIMAL')) {
    const visual = buildVisualization(opts.problem, solution);
    record.gantt = visual.model;
    record.resources = visual.resources;
    record.timelines = visual.timelines;
  }

  if (opts.verify !== false && solution && outcome.raw) {
    opts.onPhase?.('verifying', opts.strict ? '严格模式（要求租户/问题哈希绑定）' : '宽松模式');
    try {
      const { report } = await engine.verify(problemText, outcome.raw, { strict: opts.strict });
      record.verify = report;
    } catch (err) {
      record.verify = {
        ok: false,
        parsed: false,
        issues: [
          {
            code: 'VERIFY_UNAVAILABLE',
            severity: 'warning',
            path: '$',
            message: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }
  }

  if (solution && outcome.raw) {
    opts.onPhase?.('fingerprinting');
    try {
      const { report } = await engine.fingerprint(outcome.raw);
      record.fingerprintReport = report;
      record.fingerprint = report?.fingerprint ?? null;
    } catch {
      record.fingerprint = null;
    }
  }

  opts.onPhase?.('done');
  return record;
}

function emptyRecord(
  opts: RunOptions,
  wallMs: number,
  patch: { status: string; statusCode: number; error?: string; cancelled?: boolean },
): RunRecord {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    label: '',
    createdAt: Date.now(),
    params: opts.params,
    problemName: opts.problemName,
    problemHash: null,
    snapshotId: opts.problem.meta?.snapshot_id ?? null,
    status: patch.status,
    statusCode: patch.statusCode,
    solution: null,
    raw: '',
    fingerprint: null,
    fingerprintReport: null,
    verify: null,
    metrics: {
      firstFeasibleMs: null,
      totalMs: null,
      compileMs: null,
      solveMs: null,
      verifyMs: null,
      peakMemoryBytes: null,
      wallMs,
    },
    gantt: {
      rows: [],
      minMs: 0,
      maxMs: 0,
      dataMinMs: 0,
      dataMaxMs: 0,
      skills: [],
      operationCount: 0,
    },
    resources: [],
    timelines: [],
    engineVersion: null,
    error: patch.error,
    cancelled: patch.cancelled,
  };
}

/** 运行器：串联引擎生命周期与运行记录（UI 只依赖它）。 */
export interface Runner {
  run(opts: RunOptions): Promise<RunRecord>;
  cancel(): boolean;
  dispose(): void;
  readonly busy: boolean;
  readonly workerRestarted: boolean;
  readonly capabilities: CapabilitiesReport | null;
  readonly version: string;
}

export function createRunner(
  engine: EngineHandle,
  meta: { version: string; capabilities: CapabilitiesReport | null },
): Runner {
  let cancelled = false;
  return {
    async run(opts: RunOptions): Promise<RunRecord> {
      cancelled = false;
      const restartedBefore = engine.restarted;
      const record = await runOnce(engine, { ...opts, isCancelled: () => cancelled });
      record.workerRestarted = engine.restarted && !restartedBefore;
      return record;
    },
    cancel(): boolean {
      cancelled = true;
      return engine.cancel();
    },
    dispose(): void {
      engine.dispose();
    },
    get busy(): boolean {
      return engine.busy;
    },
    get workerRestarted(): boolean {
      return engine.restarted;
    },
    capabilities: meta.capabilities,
    version: meta.version,
  };
}
