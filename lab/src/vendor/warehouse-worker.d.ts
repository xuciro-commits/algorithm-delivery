/**
 * 类型声明：`warehouse-worker.js` 由 `scripts/sync-warehouse.mjs` 从
 * `warehouse/rust/web/warehouse-worker.js` **自动复制**生成（单一来源，勿手改）。
 *
 * 这里只声明实验室用到的接口；完整 ABI 说明见 `warehouse/rust/src/wasm_api.rs`
 * （wasm 导出）与 `warehouse/rust/web/warehouse-worker.js`（Worker 消息协议：
 * `init | version | cancel | verify | capabilities | scenarios | generate | solve | solveSummary`）。
 *
 * 与 aps / mapf / agv 三份声明同一风格：只写形状，不写业务语义。
 * 注意：`src/core/warehouse/engine.ts` 会把这几个导出显式断言成它自己的句柄类型，
 * 因此这里的签名是"文档级"精度，真正的类型守卫在适配层里。
 */

export declare const STATUS: Record<number, string>;

export declare class SolveCancelledError extends Error {}

export interface WarehouseWasmEngine {
  version: string;
  abiVersion: number;
  peakMemoryBytes(): number;
  cancel(): void;
  /** 求解；输出是引擎信封（`warehouse-solve-result/1.0`）的字符串。 */
  solve(
    problemText: string,
    options?: Record<string, unknown>,
  ): {
    status: string;
    statusCode: number;
    envelope: unknown;
    raw: string;
    error?: string;
    peakMemoryBytes?: number;
  };
  /** 求解但只回指标+状态（不产出完整信封，供大规模快速评估）。 */
  solveSummary(
    problemText: string,
    options?: Record<string, unknown>,
  ): { status: string; statusCode: number; raw: string; error?: string };
  /** 独立核验：入参是"问题 + 方案/时间线"文档。 */
  verify(documentText: string): { status: string; report: unknown };
  capabilities(): unknown;
  /** 场景清单（catalog）：`{count, scales, families[]}`。 */
  scenarios(): unknown;
  generate(scenarioId: string, scale?: string, seed?: number): { status: string; document: unknown };
}

export declare function createEngine(
  source: URL | string | ArrayBuffer | Uint8Array | WebAssembly.Module,
): Promise<WarehouseWasmEngine>;

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
  ): Promise<Record<string, unknown>>;
  solveSummary(
    problemText: string,
    options?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  verify(documentText: string): Promise<Record<string, unknown>>;
  capabilities(): Promise<unknown>;
  scenarios(): Promise<unknown>;
  generate(scenarioId: string, scale?: string, seed?: number): Promise<Record<string, unknown>>;
  cancel(): boolean;
  dispose(): void;
  readonly busy: boolean;
  readonly restarted: boolean;
};
