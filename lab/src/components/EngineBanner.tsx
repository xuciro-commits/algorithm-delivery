/**
 * 顶部引擎状态条：显示**当前使用的算法引擎版本**（需求硬性要求）。
 *
 * 版本来源有两处，必须一致才显示“已核对”：
 *  1. 构建期清单 `engine-manifest.json`（CI 生成，含 wasm sha256 与来源标签）；
 *  2. 运行时 `aps_capabilities()`（直接读 wasm 内嵌的版本字符串）。
 */

import type { EngineManifest } from '../core/types';

export interface EngineBannerProps {
  status: 'loading' | 'ready' | 'error';
  manifest: EngineManifest | null;
  runtimeVersion: string;
  error: string | null;
  onRetry: () => void;
}

export function EngineBanner({ status, manifest, runtimeVersion, error, onRetry }: EngineBannerProps) {
  const declared = manifest?.version ?? '—';
  const match = status === 'ready' && runtimeVersion !== 'unknown' && declared === runtimeVersion;
  const tone = status === 'error' ? 'err' : status === 'loading' ? 'wait' : match ? 'ok' : 'warn';

  return (
    <div className={`engine-banner tone-${tone}`} role="status">
      <span className="dot" aria-hidden />
      {status === 'loading' && <span>正在加载引擎产物…</span>}
      {status === 'error' && (
        <>
          <span>引擎加载失败：{error}</span>
          <button type="button" onClick={onRetry}>
            重试
          </button>
        </>
      )}
      {status === 'ready' && manifest && (
        <>
          <span className="engine-name">
            {manifest.engine} <b>v{declared}</b>
          </span>
          <span className="sep">·</span>
          <span>档位 {manifest.profile}</span>
          <span className="sep">·</span>
          <span title={manifest.wasm.sha256}>
            wasm {Math.round(manifest.wasm.bytes / 1024)} KiB（sha256 {manifest.wasm.sha256.slice(0, 12)}…）
          </span>
          <span className="sep">·</span>
          <span>来源 {manifest.source}</span>
          {manifest.gitTag && (
            <>
              <span className="sep">·</span>
              <span>{manifest.gitTag}</span>
            </>
          )}
          <span className="sep">·</span>
          <span>
            运行时版本 {runtimeVersion}
            {match ? ' ✓ 与构建期一致' : ' ⚠ 与构建期不一致'}
          </span>
        </>
      )}
    </div>
  );
}
