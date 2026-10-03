/**
 * 数据目录：内置 Mock / 基准 + 用户导入的自定义 PlanProblem。
 *
 * 目录来自构建期清单（`engine-manifest.json` 的 `mocks` 字段），
 * 由 `scripts/sync-engine.mjs` 扫描 `aps/mock/` 并在需要时调用 CLI 生成基准。
 * 导入的文件只保存在浏览器内存与 localStorage（不上传任何数据）。
 */

import type { EngineManifest, MockCatalogEntry, PlanProblemLike } from '../types';

export interface ProblemEntry {
  id: string;
  name: string;
  description: string;
  kind: MockCatalogEntry['kind'] | 'imported';
  expect?: string;
  operations: number;
  orders: number;
  machines: number;
  /** 内置数据的 URL（导入数据为 undefined） */
  url?: string;
  /** 直接持有的内容（导入数据） */
  inline?: PlanProblemLike;
  importedAt?: number;
}

export function entriesFromManifest(manifest: EngineManifest | null): ProblemEntry[] {
  if (!manifest?.mocks) return [];
  return manifest.mocks.map((m) => ({
    id: m.file,
    name: m.name,
    description: m.description,
    kind: m.kind,
    expect: m.expect,
    operations: m.operations,
    orders: m.orders,
    machines: m.machines,
    url: m.file,
  }));
}

export function countProblem(problem: PlanProblemLike): {
  operations: number;
  orders: number;
  machines: number;
} {
  let operations = 0;
  for (const order of problem.orders ?? []) operations += (order.operations ?? []).length;
  return {
    operations,
    orders: (problem.orders ?? []).length,
    machines: (problem.machines ?? []).length,
  };
}

export interface ImportResult {
  ok: boolean;
  entry?: ProblemEntry;
  error?: string;
}

/** 解析用户导入的 PlanProblem：只做“能不能被引擎读懂”的轻校验，不复制引擎的语义校验。 */
export function importProblem(text: string, fileName: string): ImportResult {
  let parsed: PlanProblemLike;
  try {
    parsed = JSON.parse(text) as PlanProblemLike;
  } catch (err) {
    return { ok: false, error: `不是合法 JSON：${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, error: '顶层必须是 JSON 对象' };
  if (!Array.isArray(parsed.orders)) return { ok: false, error: '缺少 orders 数组（PlanProblem v1 要求）' };
  if (!Array.isArray(parsed.machines)) return { ok: false, error: '缺少 machines 数组（PlanProblem v1 要求）' };
  if (!parsed.meta) return { ok: false, error: '缺少 meta 块（PlanProblem v1 要求）' };
  const counts = countProblem(parsed);
  const id = `imported:${fileName}`;
  return {
    ok: true,
    entry: {
      id,
      name: `${fileName}（导入）`,
      description: '用户导入的 PlanProblem：数据只在浏览器内处理，不会上传',
      kind: 'imported',
      operations: counts.operations,
      orders: counts.orders,
      machines: counts.machines,
      inline: parsed,
      importedAt: Date.now(),
    },
  };
}

const STORAGE_KEY = 'algorithm-lab:imported-problems:v1';
const MAX_KEEP = 5;

interface StoredProblem {
  id: string;
  name: string;
  description: string;
  operations: number;
  orders: number;
  machines: number;
  importedAt: number;
  problem: PlanProblemLike;
}

/** 最近导入的数据落到 localStorage，刷新页面不丢（仅浏览器本地）。 */
export function persistImports(entries: ProblemEntry[]): void {
  try {
    const mine = entries.filter((e) => e.inline).slice(0, MAX_KEEP);
    const payload: StoredProblem[] = mine.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      operations: e.operations,
      orders: e.orders,
      machines: e.machines,
      importedAt: e.importedAt ?? Date.now(),
      problem: e.inline as PlanProblemLike,
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 配额/隐私模式：静默降级（不影响本次使用）
  }
}

export function loadPersistedImports(): ProblemEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredProblem[];
    return parsed.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      kind: 'imported' as const,
      operations: p.operations,
      orders: p.orders,
      machines: p.machines,
      inline: p.problem,
      importedAt: p.importedAt,
    }));
  } catch {
    return [];
  }
}

export function clearPersistedImports(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 读取某个数据条目的 PlanProblem（内置走 URL，导入走内存）。 */
export async function loadProblem(entry: ProblemEntry, assetUrl: (p: string) => string): Promise<PlanProblemLike> {
  if (entry.inline) return entry.inline;
  if (!entry.url) throw new Error(`数据条目 ${entry.id} 没有内容`);
  const res = await fetch(assetUrl(entry.url), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`读取 ${entry.url} 失败：HTTP ${res.status}`);
  return (await res.json()) as PlanProblemLike;
}
