/**
 * React 侧引擎生命周期封装。
 *
 * 关键点（对应需求“正确处理求解中断和 Worker 生命周期”）：
 *  - 首次进入实验室时：读 `engine-manifest.json` → 下载 wasm → 主线程预编译 →
 *    启动 Worker 并握手（拿 `aps_version()` 与能力声明）；
 *  - `cancel()` 立即终止 Worker（同步 wasm 无法被消息打断），下一次求解自动重建；
 *  - 卸载时 `dispose()`，避免留下僵尸 Worker；
 *  - 任何阶段的失败都不让页面白屏：状态里带 `error`，界面显示可操作提示。
 *
 * 路径全部基于 `import.meta.env.BASE_URL`，因此 GitHub Pages 子路径（/algorithm-delivery/）
 * 与本地根路径部署都能正确加载 wasm 与 Worker。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CapabilitiesReport, EngineManifest } from '../types';
import { createEngineHandle, createRunner, type EngineHandle, type Runner } from './engine';

export type EngineStatus = 'loading' | 'ready' | 'error';

export interface EngineState {
  status: EngineStatus;
  error: string | null;
  manifest: EngineManifest | null;
  capabilities: CapabilitiesReport | null;
  version: string;
  runner: Runner | null;
  busy: boolean;
  /** 上一次求解是否因取消而终止过 Worker（重建后自动恢复） */
  lastRunCancelled: boolean;
}

const BASE = import.meta.env.BASE_URL || '/';

function assetUrl(path: string): string {
  const base = BASE.endsWith('/') ? BASE : `${BASE}/`;
  return `${base}${path.replace(/^\/+/, '')}`;
}

export function useApsEngine(): EngineState & {
  cancel: () => boolean;
  refresh: () => void;
  assetUrl: (path: string) => string;
} {
  const [state, setState] = useState<{
    status: EngineStatus;
    error: string | null;
    manifest: EngineManifest | null;
    capabilities: CapabilitiesReport | null;
    version: string;
    runner: Runner | null;
    busy: boolean;
    lastRunCancelled: boolean;
  }>({
    status: 'loading',
    error: null,
    manifest: null,
    capabilities: null,
    version: 'unknown',
    runner: null,
    busy: false,
    lastRunCancelled: false,
  });
  const [nonce, setNonce] = useState(0);
  const handleRef = useRef<EngineHandle | null>(null);

  useEffect(() => {
    let disposed = false;
    let handle: EngineHandle | null = null;

    (async () => {
      try {
        const manifestRes = await fetch(assetUrl('engine-manifest.json'), { cache: 'no-cache' });
        if (!manifestRes.ok) throw new Error(`读取 engine-manifest.json 失败：HTTP ${manifestRes.status}`);
        const manifest = (await manifestRes.json()) as EngineManifest;

        const wasmRes = await fetch(assetUrl(manifest.wasm.file), { cache: 'no-cache' });
        if (!wasmRes.ok) throw new Error(`下载 wasm 失败：HTTP ${wasmRes.status}（${manifest.wasm.file}）`);
        const bytes = await wasmRes.arrayBuffer();
        const wasm = await WebAssembly.compile(bytes);

        const boot = await createEngineHandle({
          workerUrl: assetUrl(manifest.worker.file),
          wasm,
        });
        handle = boot.handle;
        if (disposed) {
          handle.dispose();
          return;
        }
        handleRef.current = handle;
        setState({
          status: 'ready',
          error: null,
          manifest,
          capabilities: boot.capabilities,
          version: boot.version,
          runner: createRunner(handle, { version: boot.version, capabilities: boot.capabilities }),
          busy: false,
          lastRunCancelled: false,
        });
      } catch (err) {
        if (disposed) return;
        setState({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          manifest: null,
          capabilities: null,
          version: 'unknown',
          runner: null,
          busy: false,
          lastRunCancelled: false,
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
    if (!h) return false;
    const did = h.cancel();
    setState((s) => ({ ...s, lastRunCancelled: true }));
    return did;
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return useMemo(
    () => ({
      ...state,
      cancel,
      refresh,
      assetUrl,
    }),
    [state, cancel, refresh],
  );
}

export { assetUrl };
