/**
 * APS 数据目录：内置 PlanProblem、标准 JSSP/FJSP benchmark 转换结果，以及浏览器本地导入数据。
 *
 * 四个小型内置场景直接从 `aps/mock/` 导入，初次渲染不依赖引擎 manifest 或静态资源请求；
 * 引擎清单只负责补充构建期生成的规模基准。用户导入的数据仅保存在浏览器本地。
 */

import baseline from '../../../../aps/mock/baseline.json';
import machineBreakdown from '../../../../aps/mock/machine-breakdown.json';
import materialDelay from '../../../../aps/mock/material-delay.json';
import infeasibleNoWelder from '../../../../aps/mock/infeasible-no-welder.json';
import type { EngineManifest, MockCatalogEntry, PlanProblemLike } from '../types';
import { importStandardBenchmarks } from './benchmarkImport';

export type ProblemKind = MockCatalogEntry['kind'] | 'custom' | 'imported' | 'standard-benchmark';

export interface ProblemEntry {
  id: string;
  name: string;
  description: string;
  kind: ProblemKind;
  expect?: string;
  source?: string;
  operations: number;
  orders: number;
  machines: number;
  /** manifest 中生成的资源 URL；内置与导入数据优先使用 inline */
  url?: string;
  /** 内置或用户导入的 PlanProblem 内容 */
  inline?: PlanProblemLike;
  importedAt?: number;
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

function builtInEntry(
  file: string,
  name: string,
  description: string,
  problem: PlanProblemLike,
  expect: string,
  kind: MockCatalogEntry['kind'],
): ProblemEntry {
  return {
    id: `mock/${file}`,
    name,
    description,
    kind,
    expect,
    ...countProblem(problem),
    inline: problem,
  };
}

/** Stable order: the baseline is always first, even while engine assets are unavailable. */
const BUILT_IN_PROBLEMS: ProblemEntry[] = [
  builtInEntry(
    'baseline.json',
    '基础车间（baseline）',
    '基础完整车间：8 订单 / 24 工序 / 5 机器 / 8 人员',
    baseline as unknown as PlanProblemLike,
    '可证明最优（makespan = 下界）',
    'baseline',
  ),
  builtInEntry(
    'machine-breakdown.json',
    '设备故障（machine-breakdown）',
    '设备故障：WELD-02 在 10-05 下午停机，验证排程避开停机窗口',
    machineBreakdown as unknown as PlanProblemLike,
    '避开停机区间并给出相对基线的变更',
    'scenario',
  ),
  builtInEntry(
    'material-delay.json',
    '到货延迟（material-delay）',
    '到货延迟：物料到货推迟，验证事件序账本非负',
    materialDelay as unknown as PlanProblemLike,
    '物料账本全程非负（H07）',
    'scenario',
  ),
  builtInEntry(
    'infeasible-no-welder.json',
    '无解（infeasible-no-welder）',
    '无解场景：缺少具备焊接技能的资源',
    infeasibleNoWelder as unknown as PlanProblemLike,
    'INFEASIBLE + NO_ELIGIBLE_WORKER 证书',
    'scenario',
  ),
];

export function entriesFromManifest(manifest: EngineManifest | null): ProblemEntry[] {
  const manifestEntries = manifest?.mocks ?? [];
  const byFile = new Map(manifestEntries.map((entry) => [entry.file, entry]));
  const builtInFiles = new Set(BUILT_IN_PROBLEMS.map((entry) => entry.id));

  const builtIns = BUILT_IN_PROBLEMS.map((entry) => {
    const manifestEntry = byFile.get(entry.id);
    if (!manifestEntry) return entry;
    // Keep the statically bundled PlanProblem as the authoritative fallback. The
    // manifest contributes build-time details but never replaces that content.
    return {
      ...entry,
      name: manifestEntry.name || entry.name,
      description: manifestEntry.description || entry.description,
      expect: manifestEntry.expect ?? entry.expect,
      operations: manifestEntry.operations,
      orders: manifestEntry.orders,
      machines: manifestEntry.machines,
    };
  });

  const generated = manifestEntries
    .filter((entry) => !builtInFiles.has(entry.file))
    .map((entry) => ({
      id: entry.file,
      name: entry.name,
      description: entry.description,
      kind: entry.kind,
      expect: entry.expect,
      operations: entry.operations,
      orders: entry.orders,
      machines: entry.machines,
      url: entry.file,
    }));

  return [...builtIns, ...generated];
}

export interface ImportResult {
  ok: boolean;
  /** First entry, preserved for callers that import one problem. */
  entry?: ProblemEntry;
  /** One file can contain a benchmark collection, e.g. OR-Library jobshop1. */
  entries?: ProblemEntry[];
  error?: string;
}

const MAX_IMPORT_CHARS = 2 * 1024 * 1024;

/**
 * Import either an APS PlanProblem JSON or a recognized standard shop benchmark.
 * Standard instances are explicitly converted to the smaller PlanProblem scope; see
 * `benchmarkImport.ts` and the entry description for assumptions.
 */
export function importProblem(text: string, fileName: string): ImportResult {
  const content = text.replace(/^\uFEFF/, '');
  if (content.length > MAX_IMPORT_CHARS) {
    return { ok: false, error: '单个文件超过 2 MiB，请拆分后再导入。' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const standard = importStandardBenchmarks(content, fileName);
    if (!standard.handled) {
      return {
        ok: false,
        error: `不是合法 PlanProblem JSON。标准排程数据请使用 FJSP .fjs/.fjsp/.txt 或 OR-Library JSP .jsp/.jssp/.txt 格式。`,
      };
    }
    if (standard.error) return { ok: false, error: standard.error };
    const entries = (standard.entries ?? []).map<ProblemEntry>((benchmark) => ({
      id: benchmark.id,
      name: benchmark.name,
      description: benchmark.description,
      kind: 'standard-benchmark',
      source: benchmark.source,
      expect: benchmark.expect,
      operations: benchmark.operations,
      orders: benchmark.orders,
      machines: benchmark.machines,
      inline: benchmark.problem,
      importedAt: Date.now(),
    }));
    if (entries.length === 0) return { ok: false, error: '没有找到可导入的标准基准实例。' };
    return { ok: true, entry: entries[0], entries };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: '顶层必须是 PlanProblem JSON 对象' };
  }
  const problem = parsed as PlanProblemLike;
  if (!Array.isArray(problem.orders)) return { ok: false, error: '缺少 orders 数组（PlanProblem v1 要求）' };
  if (!Array.isArray(problem.machines)) return { ok: false, error: '缺少 machines 数组（PlanProblem v1 要求）' };
  if (!problem.meta) {
    return {
      ok: false,
      error: '缺少 meta 块（PlanProblem v1 要求）。标准基准 JSON 尚未适配；请使用对应的 FJSP/JSP 文本文件。',
    };
  }

  const counts = countProblem(problem);
  const id = `imported:${fileName}`;
  const entry: ProblemEntry = {
    id,
    name: `${fileName}（导入）`,
    description: 'PlanProblem JSON：数据只在浏览器内处理，不会上传',
    kind: 'imported',
    ...counts,
    inline: problem,
    importedAt: Date.now(),
  };
  return { ok: true, entry, entries: [entry] };
}

const STORAGE_KEY = 'algorithm-lab:imported-problems:v1';
const MAX_KEEP = 5;

interface StoredProblem {
  id: string;
  name: string;
  description: string;
  kind?: ProblemKind;
  source?: string;
  expect?: string;
  operations: number;
  orders: number;
  machines: number;
  importedAt: number;
  problem: PlanProblemLike;
}

/** Keep the most recent imported cases in localStorage; never send them to a server. */
export function persistImports(entries: ProblemEntry[]): boolean {
  try {
    const mine = entries.filter((entry) => entry.inline).slice(0, MAX_KEEP);
    const payload: StoredProblem[] = mine.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      kind: entry.kind,
      source: entry.source,
      expect: entry.expect,
      operations: entry.operations,
      orders: entry.orders,
      machines: entry.machines,
      importedAt: entry.importedAt ?? Date.now(),
      problem: entry.inline as PlanProblemLike,
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    // Quota/blocked storage: the current page session still works.
    return false;
  }
}

export function loadPersistedImports(): ProblemEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredProblem[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((problem) => ({
      id: problem.id,
      name: problem.name,
      description: problem.description,
      kind: problem.kind ?? 'imported',
      source: problem.source,
      expect: problem.expect,
      operations: problem.operations,
      orders: problem.orders,
      machines: problem.machines,
      inline: problem.problem,
      importedAt: problem.importedAt,
    }));
  } catch {
    return [];
  }
}

export function clearPersistedImports(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Storage is optional (e.g. browser privacy mode). */
  }
}

/** Read a problem: bundled/imported cases are synchronous; generated cases use a URL. */
export async function loadProblem(entry: ProblemEntry, assetUrl: (path: string) => string): Promise<PlanProblemLike> {
  if (entry.inline) return entry.inline;
  if (!entry.url) throw new Error(`数据条目 ${entry.id} 没有内容`);

  const controller = new AbortController();
  const timeoutMs = 10_000;
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(assetUrl(entry.url), { cache: 'no-cache', signal: controller.signal });
    if (!res.ok) throw new Error(`读取 ${entry.url} 失败：HTTP ${res.status}`);
    return (await res.json()) as PlanProblemLike;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`读取 ${entry.url} 超时（${timeoutMs / 1000} 秒），请确认构建产物已部署后重试。`);
    }
    throw err;
  } finally {
    globalThis.clearTimeout(timer);
  }
}
