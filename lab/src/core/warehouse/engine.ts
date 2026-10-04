/**
 * Warehouse 引擎适配层：把 vendored 的 `warehouse-worker.js` 胶水包装成实验室句柄。
 * 生命周期约定与 APS / MAPF / AGV 完全一致（同步求解、terminate 取消、重建复用模块）。
 */

import type {
  WarehouseCapabilities,
  WarehouseEnvelope,
  WarehouseScenarioCatalog,
  WarehouseVerification,
} from './types';

export interface WarehouseSolveOutcome {
  status: string;
  statusCode: number;
  error?: string;
  peakMemoryBytes?: number;
  envelope: WarehouseEnvelope | null;
  raw: string;
  hasAnalysis?: boolean;
}

export interface WarehouseEngineHandle {
  solve(problemText: string, options?: Record<string, unknown>): Promise<WarehouseSolveOutcome>;
  solveSummary(problemText: string, options?: Record<string, unknown>): Promise<WarehouseSolveOutcome>;
  /** 独立核验：入参是"问题 + 方案"文档（见 `buildVerifyDocument`）。 */
  verify(documentText: string): Promise<{ status: string; report: WarehouseVerification | null }>;
  capabilities(): Promise<WarehouseCapabilities>;
  /**
   * 场景清单（**catalog**，不是拉平的数组）：`{count, scales, families[{family,label,scenarios[]}]}`。
   * 引擎的 `scenarios` 消息原样透传引擎输出，实验室不做重排。
   */
  scenarios(): Promise<WarehouseScenarioCatalog>;
  generate(
    scenarioId: string,
    scale?: string,
    seed?: number,
  ): Promise<{ status: string; document: unknown; raw: string }>;
  cancel(): boolean;
  dispose(): void;
  readonly busy: boolean;
  readonly restarted: boolean;
}

export interface WarehouseBootOptions {
  workerUrl: string | URL;
  wasm?: WebAssembly.Module;
  wasmUrl?: string | URL;
  handshakeTimeoutMs?: number;
}

export async function createWarehouseHandle(opts: WarehouseBootOptions): Promise<{
  handle: WarehouseEngineHandle;
  version: string;
  capabilities: WarehouseCapabilities | null;
}> {
  const glue = (await import('../../vendor/warehouse-worker.js')) as unknown as {
    spawnSolver: (source: unknown, o: unknown) => WarehouseEngineHandle;
  };
  const handle = glue.spawnSolver(String(opts.workerUrl), {
    wasmUrl: opts.wasm ? undefined : opts.wasmUrl ? String(opts.wasmUrl) : undefined,
    wasm: opts.wasm,
  });

  let capabilities: WarehouseCapabilities | null = null;
  let version = 'unknown';
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const caps = await Promise.race([
      Promise.resolve(handle.capabilities()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            new Error(
              `Warehouse Worker 握手超时（${Math.round((opts.handshakeTimeoutMs ?? 8000) / 1000)} 秒）：可能缺少 wasm 产物或 Worker 入口`,
            ),
          );
        }, opts.handshakeTimeoutMs ?? 8000);
      }),
    ]);
    capabilities = caps ?? null;
    version = capabilities?.engineVersion ?? 'unknown';
  } catch (err) {
    if (timedOut) {
      handle.dispose();
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (!/不含|缺少|missing/i.test(message)) {
      handle.dispose();
      throw new Error(`Warehouse Worker 初始化失败：${message}`);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return { handle, version, capabilities };
}

export class WarehouseCancelledError extends Error {
  constructor() {
    super('求解已取消（Worker 已终止）');
    this.name = 'WarehouseCancelledError';
  }
}

export function isWarehouseCancelError(err: unknown): boolean {
  return (
    err instanceof WarehouseCancelledError ||
    (err instanceof Error && /取消|cancel/i.test(err.message) && err.name.includes('Cancelled'))
  );
}

/**
 * 组装 `wh_verify` 需要的文档：问题 + 方案/时间线。
 *
 * 为什么要这一步：验证器只吃契约，不接受"求解信封"（信封里没有原始问题），
 * 所以必须把提交给引擎的问题文档与引擎输出的方案/时间线**原样**拼在一起。
 * 面板与 sync 脚本共用这一处实现，避免两边口径不一致。
 */
export function buildVerifyDocument(
  problemDocument: Record<string, unknown>,
  envelope: WarehouseEnvelope,
): Record<string, unknown> | null {
  const kind = String(problemDocument.kind ?? 'slotting');
  if (kind === 'slotting') {
    return { kind: 'slotting', problem: problemDocument.problem, solution: envelope.result };
  }
  if (kind === 'asrs' || kind === 'dense-asrs') {
    return { kind: 'asrs', problem: problemDocument.problem, timeline: envelope.timeline };
  }
  // 联合：两段问题分别交给各自的独立验证器（与 `src/verify.rs` 的文档定位一致）。
  // 没有时间线（无解/预算耗尽）时不提交核验——验证器需要可重放的时间线才能复核。
  if (!envelope.timeline) return null;
  const assignment = (envelope.result as { slottingAssignment?: unknown }).slottingAssignment;
  return {
    kind: 'joint',
    slotting: problemDocument.slotting,
    asrs: problemDocument.asrs,
    timeline: envelope.timeline,
    solution: { assignment: Array.isArray(assignment) ? assignment : [] },
  };
}
