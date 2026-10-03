/**
 * 视觉资产清单：运行时读取 `public/models/manifest.json`
 * （由 `scripts/sync-visual-assets.mjs` 从 lab/design/assets **原样复制**生成）。
 *
 * 页面从不直接引用 lab/design/assets 的源文件，也不做任何网络下载：
 * 清单里的 sizeMeters / sha256 / triangles 全部来自仓库内既有资产目录，
 * 用于把模型归一到米制并做验收核对。
 */

import { useEffect, useState } from 'react';

export interface VisualAsset {
  id: string;
  key: string;
  file: string;
  source: string;
  category: string;
  title: string;
  summary: string;
  license: string;
  bytes: number;
  sha256: string;
  sizeMeters: number[] | null;
  triangles: number | null;
  materials: number | null;
  animations: string[];
}

export interface VisualManifest {
  version: string;
  generatedAt: string;
  source: string;
  total: number;
  bytes: number;
  assets: VisualAsset[];
}

export type ManifestState =
  | { status: 'loading' }
  | { status: 'ready'; manifest: VisualManifest }
  | { status: 'error'; error: string };

/** 资产目录前缀（Pages 子路径安全）。 */
export function visualBaseUrl(): string {
  return import.meta.env.BASE_URL ?? '/';
}

export function visualModelUrl(baseUrl: string, file: string): string {
  return `${baseUrl}models/${file}`;
}

export async function loadVisualManifest(baseUrl = visualBaseUrl()): Promise<VisualManifest> {
  const response = await fetch(`${baseUrl}models/manifest.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`视觉资产清单不可用（HTTP ${response.status}）`);
  const manifest = (await response.json()) as VisualManifest;
  if (!manifest?.assets?.length) throw new Error('视觉资产清单为空：请先运行 npm run sync:visual');
  return manifest;
}

export function useVisualManifest(): ManifestState {
  const [state, setState] = useState<ManifestState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    loadVisualManifest()
      .then((manifest) => {
        if (alive) setState({ status: 'ready', manifest });
      })
      .catch((error: unknown) => {
        if (alive) setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

/** 舞台主角模型（阶段一实验对象：结构最复杂、机械细节最丰富的加工设备）。 */
export const HERO_MODEL_KEY = 'cnc-machining-centre-with-sliding-door';

export function findAsset(manifest: VisualManifest | null, key: string): VisualAsset | null {
  return manifest?.assets.find((asset) => asset.key === key) ?? null;
}
