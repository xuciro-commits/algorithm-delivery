/**
 * 模块装配入口：在这里登记所有算法模块。
 *
 * ready = 已经能在实验室里跑；planned = 已登记但尚未实现（首页会显示为“待接入”，
 * 便于团队看到路线图，但**不会**渲染任何假数据或占位图表）。
 */

import { registerModule } from '../core/registry';
import type { AlgorithmModule } from '../core/types';
import { apsModule } from './aps';

const planned: AlgorithmModule[] = [
  {
    id: 'path-planning',
    name: '路径规划',
    tagline: '栅格/路网上的最短路径与避障',
    category: '运动规划',
    status: 'planned',
    plannedNote: '待接入：各自的问题结构（地图/障碍/代价）与可视化（路径叠加在地图上），不套用 APS 模型。',
  },
  {
    id: 'agv-dispatch',
    name: 'AGV 调度',
    tagline: '多车任务分配与冲突消解',
    category: '运动规划',
    status: 'planned',
    plannedNote: '待接入：任务/车辆/路段资源模型，可视化用时空轨迹图。',
  },
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
  for (const m of planned) registerModule(m);
}
