/**
 * AGV 引擎适配层：把 vendored 的 `agv-worker.js` 胶水包装成实验室句柄。
 * 生命周期约定与 APS/MAPF 完全一致（同步求解、terminate 取消、重建复用模块）。
 */

export interface AgvSolveOutcome {
  status: string;
  statusCode: number;
  error?: string;
  peakMemoryBytes?: number;
  solution: unknown;
  raw: string;
  hasAnalysis?: boolean;
}

export interface AgvEngineHandle {
  solve(problemText: string, options?: Record<string, unknown>): Promise<AgvSolveOutcome>;
  verify(
    problemText: string,
    solutionText: string,
    opts?: { strict?: boolean },
  ): Promise<{ code: number; report: { status?: string; checks?: Array<{ group?: string; name: string; ok: boolean }>; violations?: unknown[] } }>;
  fingerprint(solutionText: string): Promise<{ code: number; report: { fingerprint: string } }>;
  capabilities(): Promise<{ report: Record<string, unknown> }>;
  cancel(): boolean;
  dispose(): void;
  readonly busy: boolean;
  readonly restarted: boolean;
}

export interface AgvBootOptions {
  workerUrl: string | URL;
  wasm?: WebAssembly.Module;
  wasmUrl?: string | URL;
  handshakeTimeoutMs?: number;
}

export async function createAgvHandle(opts: AgvBootOptions): Promise<{
  handle: AgvEngineHandle;
  version: string;
  capabilities: Record<string, unknown> | null;
}> {
  const glue = (await import('../../vendor/agv-worker.js')) as unknown as {
    spawnSolver: (source: unknown, o: unknown) => AgvEngineHandle;
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
          reject(new Error(`AGV Worker 握手超时（${Math.round((opts.handshakeTimeoutMs ?? 8000) / 1000)} 秒）：可能缺少 wasm 产物或 Worker 入口`));
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
    if (!/不含|缺少|missing/i.test(message)) {
      handle.dispose();
      throw new Error(`AGV Worker 初始化失败：${message}`);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return { handle, version, capabilities };
}

export class AgvCancelledError extends Error {
  constructor() {
    super('求解已取消（Worker 已终止）');
    this.name = 'AgvCancelledError';
  }
}

export function isAgvCancelError(err: unknown): boolean {
  return (
    err instanceof AgvCancelledError ||
    (err instanceof Error && /取消|cancel/i.test(err.message) && err.name.includes('Cancelled'))
  );
}
