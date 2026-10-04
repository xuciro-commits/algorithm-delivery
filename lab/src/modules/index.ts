/**
 * 模块装配入口：在这里登记所有算法模块。
 *
 * ready = 已经能在实验室里跑；planned = 已登记但尚未实现（首页会显示为“待接入”，
 * 便于团队看到路线图，但**不会**渲染任何假数据或占位图表）。
 */

import { registerModule } from '../core/registry';
import type { AlgorithmModule } from '../core/types';
import { apsModule } from './aps';
import { mapfModule } from './mapf';
import { agvModule } from './agv';
import { artLabModule } from './art-lab';
import { slottingModule } from './slotting';
import { denseAsrsModule } from './dense-asrs';

/**
 * 仓储优化两个模块同属一个 Rust 引擎（`warehouse-engine`）：
 *   slotting（库位优化）+ dense-asrs（密集立库调度）都能吃 `kind=joint` 的联合实例，
 *   联合优化的闭环证据因此同时出现在两块画布上。
 */
const warehouse: AlgorithmModule[] = [slottingModule, denseAsrsModule];

let installed = false;

/** 幂等安装（React 严格模式下会重复执行副作用）。 */
export function installModules(): void {
  if (installed) return;
  installed = true;
  registerModule(apsModule);
  registerModule(mapfModule);
  registerModule(agvModule);
  registerModule(artLabModule);
  for (const m of warehouse) registerModule(m);
}
