/**
 * MAPF 引擎的 React 生命周期封装（与 useApsEngine 同构）：
 * 读 `mapf-manifest.json` → 下载 wasm → 主线程预编译 → 启动 Worker 并握手拿版本与能力；
 * 任何一步失败都只进 `error` 状态，不白屏。路径基于 BASE_URL（Pages 子路径可加载）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MapfManifest } from './types';
import { createMapfHandle, type MapfEngineHandle } from './engine';

export type MapfEngineStatus = 'loading' | 'ready' | 'error';

export interface MapfEngineState {
  status: MapfEngineStatus;
  error: string | null;
  manifest: MapfManifest | null;
  capabilities: Record<string, unknown> | null;
  version: string;
  handle: MapfEngineHandle | null;
  busy: boolean;
}

const BASE = import.meta.env.BASE_URL || '/';

export function mapfAssetUrl(path: string): string {
  const base = BASE.endsWith('/') ? BASE : `${BASE}/`;
  return `${base}${path.replace(/^\/+/, '')}`;
}

const ASSET_TIMEOUT_MS = 12_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;

async function fetchAsset<T>(path: string, label: string, read: (r: Response) => Promise<T>): Promise<T> {
  const url = mapfAssetUrl(path);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = fetch(url, { cache: 'no-cache', signal: controller.signal }).then(async (response) => {
    if (!response.ok) throw new Error(`${label}失败：HTTP ${response.status}（${path}）`);
    return read(response);
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label}超时：${path}。请先运行 lab/scripts/sync-mapf.mjs 生成产物。`));
    }, ASSET_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function useMapfEngine(): MapfEngineState & {
  cancel: () => boolean;
  refresh: () => void;
  assetUrl: (path: string) => string;
  setBusy: (busy: boolean) => void;
} {
  const [state, setState] = useState<MapfEngineState>({
    status: 'loading',
    error: null,
    manifest: null,
    capabilities: null,
    version: 'unknown',
    handle: null,
    busy: false,
  });
  const [nonce, setNonce] = useState(0);
  const handleRef = useRef<MapfEngineHandle | null>(null);

  useEffect(() => {
    let disposed = false;
    let handle: MapfEngineHandle | null = null;
    setState({ status: 'loading', error: null, manifest: null, capabilities: null, version: 'unknown', handle: null, busy: false });

    (async () => {
      try {
        const manifest = await fetchAsset('mapf-manifest.json', '读取 MAPF 引擎清单', async (r) => (await r.json()) as MapfManifest);
        const bytes = await fetchAsset(manifest.wasm.file, '下载 MAPF WebAssembly 引擎', (r) => r.arrayBuffer());
        const wasm = await WebAssembly.compile(bytes);
        const boot = await createMapfHandle({
          workerUrl: mapfAssetUrl(manifest.worker.file),
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

  return useMemo(() => ({ ...state, cancel, refresh, setBusy, assetUrl: mapfAssetUrl }), [state, cancel, refresh, setBusy]);
}
