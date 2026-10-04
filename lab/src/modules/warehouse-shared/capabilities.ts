/**
 * 参数/选项控件的数据源（契约驱动）。
 *
 * 可选项**来自引擎快照**（`public/warehouse-capabilities.json`，由 sync 脚本从引擎导出），
 * 而不是前端硬编码——保证面板能选的算法一定是引擎认识的算法；引擎升级后选项自动跟上。
 */

import { useEffect, useMemo, useState } from 'react';
import type { WarehouseCapabilities, WarehouseDomainCapability } from '../../core/warehouse/types';

let cache: WarehouseCapabilities | null = null;
let inflight: Promise<WarehouseCapabilities | null> | null = null;

/** 读取引擎能力快照（唯一来源；失败返回 null，面板隐藏高级选项）。 */
export function loadCapabilities(baseUrl: string): Promise<WarehouseCapabilities | null> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch(`${baseUrl.replace(/\/$/, '')}/warehouse-capabilities.json`, { cache: 'no-cache' })
      .then((response) => (response.ok ? (response.json() as Promise<WarehouseCapabilities>) : null))
      .then((value) => {
        cache = value;
        return value;
      })
      .catch(() => null)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function useCapabilities(baseUrl: string): WarehouseCapabilities | null {
  const [value, setValue] = useState<WarehouseCapabilities | null>(cache);
  useEffect(() => {
    let alive = true;
    void loadCapabilities(baseUrl).then((caps) => {
      if (alive && caps) setValue(caps);
    });
    return () => {
      alive = false;
    };
  }, [baseUrl]);
  return value;
}

export interface DomainOption {
  id: string;
  label: string;
  kind: string;
  kindLabel: string;
  boundKind?: string;
  canProveOptimal?: boolean;
}

const KIND_LABEL: Record<string, string> = {
  baseline: '基线',
  basic: '基础策略',
  metaheuristic: '元启发式',
  hybrid: '混合',
  robust: '鲁棒',
  multiobjective: '多目标',
  dynamic: '动态',
  dispatch: '调度策略',
};

/** 域 → 算法清单（含分组标签）。 */
export function useDomainAlgorithms(domain: string, capabilities: WarehouseCapabilities | null) {
  return useMemo(() => {
    const entry: WarehouseDomainCapability | undefined = capabilities?.domains?.find((item) => item.id === domain);
    const list = entry?.algorithms ?? [];
    return {
      domain: entry ?? null,
      algorithms: list.map((item) => ({
        id: item.id,
        label: item.label ?? item.id,
        kind: item.kind ?? 'unknown',
        kindLabel: KIND_LABEL[item.kind ?? ''] ?? item.kind ?? '算法',
        boundKind: item.boundKind,
        canProveOptimal: item.canProveOptimal,
      })) as DomainOption[],
      objectives: entry?.objectives ?? [],
      supports: entry?.supports ?? [],
      notes: entry?.notes ?? '',
    };
  }, [domain, capabilities]);
}
