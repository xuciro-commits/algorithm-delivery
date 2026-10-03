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

const planned: AlgorithmModule[] = [
  {
    id: 'slotting',
    name: '库位优化',
    tagline: '按周转率与相关性分配库位',
    category: '仓储优化',
    status: 'planned',
    plannedNote: '待接入：库位/商品/相关性模型，可视化用热力图。',
  },
  {
    id: 'dense-asrs',
    name: '密集立库',
    tagline: '密集存储的巷道与提升机调度',
    category: '仓储优化',
    status: 'planned',
    plannedNote: '待接入：货架/提升机/穿梭车模型，可视化用巷道剖面图。',
  },
];

let installed = false;

/** 幂等安装（React 严格模式下会重复执行副作用）。 */
export function installModules(): void {
  if (installed) return;
  installed = true;
  registerModule(apsModule);
  registerModule(mapfModule);
  registerModule(agvModule);
  registerModule(artLabModule);
  for (const m of planned) registerModule(m);
}
