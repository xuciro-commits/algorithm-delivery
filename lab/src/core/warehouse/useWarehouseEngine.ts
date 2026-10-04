/**
 * Warehouse 引擎的 React 生命周期封装（与 useAgvEngine 同构）：
 * 读 warehouse-manifest.json → 下载 wasm → 主线程预编译 → 启动 Worker 握手。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  flattenScenarios,
  type WarehouseCapabilities,
  type WarehouseManifest,
  type WarehouseScenario,
  type WarehouseScenarioCatalog,
} from './types';
import { createWarehouseHandle, type WarehouseEngineHandle } from './engine';

export type WarehouseEngineStatus = 'loading' | 'ready' | 'error';

export interface WarehouseEngineState {
  status: WarehouseEngineStatus;
  error: string | null;
  manifest: WarehouseManifest | null;
  capabilities: WarehouseCapabilities | null;
  scenarios: WarehouseScenario[];
  /** 原始场景清单（按族分组，面板用它做分族下拉；与 `scenarios` 同源）。 */
  scenarioCatalog: WarehouseScenarioCatalog | null;
  version: string;
  handle: WarehouseEngineHandle | null;
  busy: boolean;
}

/** 规模档位（来自引擎的场景清单，面板用它限制生成规模）。 */
export interface WarehouseScaleOption {
  key: string;
  skus: number;
  tasks: number;
  locations?: number;
}

const BASE = import.meta.env.BASE_URL || '/';

export function warehouseAssetUrl(path: string): string {
  const base = BASE.endsWith('/') ? BASE : `${BASE}/`;
  return `${base}${path.replace(/^\/+/, '')}`;
}

const ASSET_TIMEOUT_MS = 12_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;

async function fetchJson<T>(path: string, label: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASSET_TIMEOUT_MS);
  try {
    const response = await fetch(warehouseAssetUrl(path), { cache: 'no-cache', signal: controller.signal });
    if (!response.ok) throw new Error(`${label}失败：HTTP ${response.status}（${path}）`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function useWarehouseEngine(): WarehouseEngineState & {
  /** 规模档位（来自引擎场景清单；未握手完成时为空数组，面板据此不放出"假档位"）。 */
  scales: WarehouseScaleOption[];
  cancel: () => boolean;
  refresh: () => void;
  assetUrl: (path: string) => string;
  setBusy: (busy: boolean) => void;
} {
  const [state, setState] = useState<WarehouseEngineState>({
    status: 'loading',
    error: null,
    manifest: null,
    capabilities: null,
    scenarios: [],
    scenarioCatalog: null,
    version: 'unknown',
    handle: null,
    busy: false,
  });
  const [nonce, setNonce] = useState(0);
  // 档位单独存：它从 `scenarios` 消息里取，和 `scenarioCatalog` 同源，但不塞回 state（避免两份真相）
  const [scales, setScales] = useState<WarehouseScaleOption[]>([]);
  const handleRef = useRef<WarehouseEngineHandle | null>(null);

  useEffect(() => {
    let disposed = false;
    let localHandle: WarehouseEngineHandle | null = null;
    (async () => {
      try {
        const manifest = await fetchJson<WarehouseManifest>('warehouse-manifest.json', '读取引擎清单');
        if (disposed) return;
        const wasmUrl = warehouseAssetUrl(manifest.wasm.file);
        const response = await fetch(wasmUrl, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`下载 wasm 失败：HTTP ${response.status}（${wasmUrl}）`);
        const bytes = await response.arrayBuffer();
        const module = await WebAssembly.compile(bytes);
        if (disposed) return;
        const booted = await createWarehouseHandle({
          workerUrl: warehouseAssetUrl('wasm/warehouse-worker.js'),
          wasm: module,
          handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
        });
        localHandle = booted.handle;
        handleRef.current = booted.handle;
        if (disposed) {
          booted.handle.dispose();
          return;
        }
        // 场景清单来自引擎（与 CLI 同源）；失败不阻塞模块可用性，但会明确留空
        // ——面板不会用前端硬编码的场景表冒充引擎能力。
        let scenarios: WarehouseScenario[] = [];
        let scenarioCatalog: WarehouseScenarioCatalog | null = null;
        try {
          const listed = await booted.handle.scenarios();
          scenarioCatalog = listed;
          scenarios = flattenScenarios(listed);
          if (listed.scales) setScales(listed.scales);
        } catch {
          scenarios = [];
          scenarioCatalog = null;
        }
        setState({
          status: 'ready',
          error: null,
          manifest,
          capabilities: booted.capabilities ?? manifest.capabilities ?? null,
          scenarios,
          scenarioCatalog,
          version: booted.version,
          handle: booted.handle,
          busy: false,
        });
      } catch (err) {
        if (disposed) return;
        const message = err instanceof Error ? err.message : String(err);
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: `${message}。请先运行 lab/scripts/sync-warehouse.mjs 生成产物（需要 warehouse/rust/dist/warehouse_engine.wasm）。`,
        }));
      }
    })();
    return () => {
      disposed = true;
      handleRef.current = null;
      localHandle?.dispose();
    };
  }, [nonce]);

  const cancel = useCallback(() => {
    const handle = handleRef.current;
    if (!handle) return false;
    return handle.cancel();
  }, []);

  const setBusy = useCallback((busy: boolean) => {
    setState((prev) => (prev.busy === busy ? prev : { ...prev, busy }));
  }, []);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  const assetUrl = useCallback((path: string) => warehouseAssetUrl(path), []);

  return useMemo(
    () => ({ ...state, scales, cancel, refresh, assetUrl, setBusy }),
    [state, scales, cancel, refresh, assetUrl, setBusy],
  );
}
