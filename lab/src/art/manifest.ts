/**
 * 模型清单读取：`public/models/art-manifest.json`（由 lab/scripts/sync-assets.mjs 生成）。
 *
 * 红线：运行时**不从任何第三方站点**取模型；只读构建期同步进 `public/models/` 的本仓库资产。
 * URL 一律以 `import.meta.env.BASE_URL` 为前缀解析，保证 GitHub Pages 子路径可用。
 */

import { useEffect, useState } from 'react';

export type ArtModelRole = 'hero' | 'hall' | 'equipment' | 'vehicle';

export interface ArtModelPart {
  name: string;
  group: string;
  roles: string[];
  triangles: number;
  size?: number[] | null;
}

export interface ArtModelEntry {
  slug: string;
  role: ArtModelRole;
  /** 同一模型的所有用途（例如既是英雄对象又出现在产线上）；role 是主用途。 */
  roleTags?: ArtModelRole[];
  use: string;
  category: string;
  url: string;
  bytes: number;
  triangles: number;
  uniqueTriangles?: number;
  meshes: number;
  nodes: number;
  materials: string[];
  roles: Record<string, number>;
  groups: Record<string, number>;
  sizeMeters: number[] | null;
  boundsMin: number[] | null;
  boundsMax: number[] | null;
  glassShare: number;
  equipmentShare?: number;
  heroScore?: number;
  transparentCapable?: boolean;
  internalMechanism?: boolean;
  unknownMaterials?: string[];
  parts?: ArtModelPart[];
}

export interface ArtManifest {
  schemaVersion: number;
  generatedAt: string;
  source: string;
  selection: string;
  note: string;
  totals: {
    models: number;
    bytes: number;
    triangles: number;
    byRole: Array<{ role: ArtModelRole; models: number; bytes: number }>;
  };
  models: ArtModelEntry[];
}

const BASE = import.meta.env.BASE_URL || '/';

/** public/ 下的路径 → 带 BASE_URL 的运行时 URL（Pages 子路径安全）。 */
export function artAssetUrl(path: string): string {
  const base = BASE.endsWith('/') ? BASE : `${BASE}/`;
  return `${base}${path.replace(/^\/+/, '')}`;
}

export type ManifestStatus = 'loading' | 'ready' | 'missing' | 'error';

export interface ArtManifestState {
  status: ManifestStatus;
  manifest: ArtManifest | null;
  error: string | null;
}

/** 读取模型清单（缺失时给出可操作提示，而不是白屏）。 */
export function useArtManifest(): ArtManifestState {
  const [state, setState] = useState<ArtManifestState>({ status: 'loading', manifest: null, error: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const response = await fetch(artAssetUrl('models/art-manifest.json'), { cache: 'no-cache' });
        if (response.status === 404) {
          if (alive) setState({ status: 'missing', manifest: null, error: '未找到 models/art-manifest.json：请先运行 node lab/scripts/sync-assets.mjs' });
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const manifest = (await response.json()) as ArtManifest;
        if (alive) setState({ status: 'ready', manifest, error: null });
      } catch (err) {
        if (alive) setState({ status: 'error', manifest: null, error: (err as Error).message });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

export function modelsByRole(manifest: ArtManifest | null, role: ArtModelRole): ArtModelEntry[] {
  return manifest ? manifest.models.filter((m) => m.role === role) : [];
}

export function findModel(manifest: ArtManifest | null, slug: string | null): ArtModelEntry | null {
  if (!manifest || !slug) return null;
  return manifest.models.find((m) => m.slug === slug) ?? null;
}

/**
 * 英雄设备排序：结构越复杂、机械细节越多越靠前（与结构审查报告同一套评分口径）。
 */
export function heroModels(manifest: ArtManifest | null): ArtModelEntry[] {
  return modelsByRole(manifest, 'hero').slice().sort((a, b) => (b.heroScore ?? 0) - (a.heroScore ?? 0));
}
