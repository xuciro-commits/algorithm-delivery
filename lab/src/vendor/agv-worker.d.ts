/**
 * 类型声明：`agv-worker.js` 由 `scripts/sync-agv.mjs` 从
 * `agv/rust/web/agv-worker.js` **自动复制**生成（单一来源，勿手改）。
 *
 * 这里只声明实验室用到的接口；完整 ABI 说明见 `agv/rust/src/wasm_api.rs`。
 */

export declare const STATUS: Record<number, string>;

export declare class SolveCancelledError extends Error {}

export interface AgvWasmEngine {
  version: string;
  hasAnalysis: boolean;
  analysisExports: Record<string, string | null>;
  peakMemoryBytes(): number;
  cancel(): void;
  solve(
    problemText: string,
    options?: Record<string, unknown>,
  ): {
    status: string;
    statusCode: number;
    solution: unknown;
    raw: string;
    error?: string;
  };
  verify(
    problemText: string,
    solutionText: string,
    opts?: { strict?: boolean },
  ): { code: number; report: unknown };
  fingerprint(solutionText: string): { code: number; report: unknown };
  capabilities(): unknown;
}

export declare function createEngine(
  source: URL | string | ArrayBuffer | Uint8Array | WebAssembly.Module,
): Promise<AgvWasmEngine>;

export declare function installWorker(defaultWasmUrl?: URL | string): void;

export declare function spawnSolver(
  workerSource: URL | string | (() => unknown),
  opts?: {
    wasmUrl?: URL | string;
    wasm?: WebAssembly.Module | Uint8Array;
    workerOptions?: object;
  },
): {
  solve(
    problemText: string,
    options?: Record<string, unknown>,
  ): Promise<{
    status?: string;
    statusCode?: number;
    solution?: unknown;
    error?: string;
    peakMemoryBytes?: number;
    raw?: string;
    hasAnalysis?: boolean;
  }>;
  verify(
    problemText: string,
    solutionText: string,
    opts?: { strict?: boolean },
  ): Promise<{ code: number; report: unknown }>;
  fingerprint(solutionText: string): Promise<{ code: number; report: unknown }>;
  capabilities(): Promise<{ report: unknown }>;
  cancel(): boolean;
  dispose(): void;
  readonly busy: boolean;
  readonly restarted: boolean;
};
