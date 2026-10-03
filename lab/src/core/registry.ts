/**
 * 算法模块注册表。
 *
 * 需求：实验室支持**按算法模块扩展**，但各算法保留自己的问题结构、计算引擎与可视化方式。
 * 因此这里只登记元数据 + 挂载组件，不规定任何统一模型。
 *
 * 新增算法的最小步骤（见 `lab/README.md` §5）：
 *   1. 新建 `src/modules/<id>/index.ts`，实现 `AlgorithmModule`；
 *   2. 在 `src/modules/index.ts` 里 `registerModule(...)`；
 *   3. 若需要新的 wasm，把产物放进 `public/wasm/`（由 sync-engine 脚本统一生成）。
 */

import type { AlgorithmModule, AlgorithmModuleMeta } from './types';

const modules = new Map<string, AlgorithmModule>();

export function registerModule(module: AlgorithmModule): void {
  if (modules.has(module.id)) {
    throw new Error(`算法模块 id 重复：${module.id}`);
  }
  modules.set(module.id, module);
}

export function listModules(): AlgorithmModule[] {
  return [...modules.values()];
}

export function getModule(id: string): AlgorithmModule | undefined {
  return modules.get(id);
}

/** 按类别分组（首页展示用）。ready 模块排在 planned 之前。 */
export function groupModules(): Array<{ category: string; items: AlgorithmModuleMeta[] }> {
  const byCategory = new Map<string, AlgorithmModule[]>();
  for (const m of modules.values()) {
    const list = byCategory.get(m.category) ?? [];
    list.push(m);
    byCategory.set(m.category, list);
  }
  return [...byCategory.entries()].map(([category, items]) => ({
    category,
    items: items.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'ready' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh');
    }),
  }));
}

/** 仅用于测试：清空注册表。 */
export function __resetRegistry(): void {
  modules.clear();
}
