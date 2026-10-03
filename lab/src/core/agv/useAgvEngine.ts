/**
 * AGV 引擎的 React 生命周期封装（与 useMapfEngine 同构）：
 * 读 agv-manifest.json → 下载 wasm → 主线程预编译 → 启动 Worker 握手。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgvManifest } from './types';
import { createAgvHandle, type AgvEngineHandle } from './engine';

export type AgvEngineStatus = 'loading' | 'ready' | 'error';

export interface AgvEngineState {
  status: AgvEngineStatus;
  error: string | null;
  manifest: AgvManifest | null;
  capabilities: Record<string, unknown> | null;
  version: string;
  handle: AgvEngineHandle | null;
  busy: boolean;
}

const BASE = import.meta.env.BASE_URL || '/';

export function agvAssetUrl(path: string): string {
  const base = BASE.endsWith('/') ? BASE : `${BASE}/`;
  return `${base}${path.replace(/^\/+/, '')}`;
}

const ASSET_TIMEOUT_MS = 12_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;

async function fetchAsset<T>(path: string, label: string, read: (r: Response) => Promise<T>): Promise<T> {
  const url = agvAssetUrl(path);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = fetch(url, { cache: 'no-cache', signal: controller.signal }).then(async (response) => {
    if (!response.ok) throw new Error(`${label}失败：HTTP ${response.status}（${path}）`);
    return read(response);
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label}超时：${path}。请先运行 lab/scripts/sync-agv.mjs 生成产物。`));
    }, ASSET_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function useAgvEngine(): AgvEngineState & {
  cancel: () => boolean;
  refresh: () => void;
  assetUrl: (path: string) => string;
  setBusy: (busy: boolean) => void;
} {
  const [state, setState] = useState<AgvEngineState>({
    status: 'loading',
    error: null,
    manifest: null,
    capabilities: null,
    version: 'unknown',
    handle: null,
    busy: false,
  });
  const [nonce, setNonce] = useState(0);
  const handleRef = useRef<AgvEngineHandle | null>(null);

  useEffect(() => {
    let disposed = false;
    let handle: AgvEngineHandle | null = null;
    setState({ status: 'loading', error: null, manifest: null, capabilities: null, version: 'unknown', handle: null, busy: false });

    (async () => {
      try {
        const manifest = await fetchAsset('agv-manifest.json', '读取 AGV 引擎清单', async (r) => (await r.json()) as AgvManifest);
        const bytes = await fetchAsset(manifest.wasm.file, '下载 AGV WebAssembly 引擎', (r) => r.arrayBuffer());
        const wasm = await WebAssembly.compile(bytes);
        const boot = await createAgvHandle({
          workerUrl: agvAssetUrl(manifest.worker.file),
          wasm,
          handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
        });
        handle = boot.handle;
        if (disposed) {
          handle.dispose();
          return;
        }
        handleRef.current = handle;
        setState({ status: 'ready', error: null, manifest, capabilities: boot.capabilities, version: boot.version, handle, busy: false });
      } catch (err) {
        if (disposed) return;
        setState({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          manifest: null,
          capabilities: null,
          version: 'unknown',
          handle: null,
          busy: false,
        });
      }
    })();

    return () => {
      disposed = true;
      handle?.dispose();
      handleRef.current = null;
    };
  }, [nonce]);

  const cancel = useCallback(() => {
    const h = handleRef.current;
    return h ? h.cancel() : false;
  }, []);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const setBusy = useCallback((busy: boolean) => setState((s) => ({ ...s, busy })), []);

  return useMemo(() => ({ ...state, cancel, refresh, setBusy, assetUrl: agvAssetUrl }), [state, cancel, refresh, setBusy]);
}
