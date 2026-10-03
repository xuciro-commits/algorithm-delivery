/**
 * MAPF 引擎适配层：把 vendored 的 `mapf-worker.js` 胶水包装成实验室可用的句柄。
 *
 * 生命周期与 APS 侧完全一致（同一套约定）：
 *  - wasm 求解是**同步**的，“取消”= terminate Worker，下一次求解自动重建；
 *  - 主线程预编译一次 wasm，重建 Worker 时复用同一 `WebAssembly.Module`；
 *  - `dispose()` 释放 Worker；初始化失败不抛白屏，状态里带 `error`。
 */

export interface MapfSolveOutcome {
  status: string;
  statusCode: number;
  error?: string;
  peakMemoryBytes?: number;
  solution: unknown;
  raw: string;
  hasAnalysis?: boolean;
}

export interface MapfEngineHandle {
  solve(problemText: string, options?: Record<string, unknown>): Promise<MapfSolveOutcome>;
  verify(problemText: string, solutionText: string, opts?: { strict?: boolean }): Promise<{ code: number; report: { ok: boolean; counts?: Record<string, number>; violations?: unknown[] } }>;
  fingerprint(solutionText: string): Promise<{ code: number; report: { fingerprint: string } }>;
  capabilities(): Promise<{ report: Record<string, unknown> }>;
  cancel(): boolean;
  dispose(): void;
  readonly busy: boolean;
  readonly restarted: boolean;
}

export interface MapfBootOptions {
  workerUrl: string | URL;
  /** 主线程预编译好的模块（推荐） */
  wasm?: WebAssembly.Module;
  wasmUrl?: string | URL;
  handshakeTimeoutMs?: number;
}

export async function createMapfHandle(opts: MapfBootOptions): Promise<{
  handle: MapfEngineHandle;
  version: string;
  capabilities: Record<string, unknown> | null;
}> {
  // vendored 胶水（由 scripts/sync-mapf.mjs 从 mapf/rust/web/mapf-worker.js 复制）
  const glue = (await import('../../vendor/mapf-worker.js')) as unknown as {
    spawnSolver: (source: unknown, o: unknown) => MapfEngineHandle;
  };
  const handle = glue.spawnSolver(String(opts.workerUrl), {
    wasmUrl: opts.wasm ? undefined : opts.wasmUrl ? String(opts.wasmUrl) : undefined,
    wasm: opts.wasm,
  });

  let capabilities: Record<string, unknown> | null = null;
  let version = 'unknown';
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const caps = await Promise.race([
      handle.capabilities(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`MAPF Worker 握手超时（${Math.round((opts.handshakeTimeoutMs ?? 8000) / 1000)} 秒）：可能缺少 wasm 产物或 Worker 入口`));
        }, opts.handshakeTimeoutMs ?? 8000);
      }),
    ]);
    capabilities = caps.report ?? null;
    version = (capabilities?.version as string) ?? 'unknown';
  } catch (err) {
    if (timedOut) {
      handle.dispose();
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    // 旧产物没有 mapf_capabilities：降级为“未知版本”，求解接口仍可用
    if (!/不含|缺少|missing/i.test(message)) {
      handle.dispose();
      throw new Error(`MAPF Worker 初始化失败：${message}`);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return { handle, version, capabilities };
}

export class MapfCancelledError extends Error {
  constructor() {
    super('求解已取消（Worker 已终止）');
    this.name = 'MapfCancelledError';
  }
}

export function isMapfCancelError(err: unknown): boolean {
  return (
    err instanceof MapfCancelledError ||
    (err instanceof Error && /取消|cancel/i.test(err.message) && err.name.includes('Cancelled'))
  );
}
