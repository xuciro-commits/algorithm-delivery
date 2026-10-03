/**
 * APS 算法模块注册（第一阶段接入的现有算法）。
 *
 * 该模块自带：问题结构（PlanProblem v1）、计算引擎（Rust WASM，wasm-light 档位）、
 * 可视化（订单甘特图 + 资源时间线 + 约束核验面板），符合“各算法保留独立实现”的要求。
 */

import type { AlgorithmModule } from '../../core/types';
import { ApsPanel } from './ApsPanel';

export const apsModule: AlgorithmModule = {
  id: 'aps',
  name: 'APS 计划排程',
  tagline: 'PlanProblem → 启发式排程 → 独立核验；浏览器内 WASM 计算',
  category: '生产排程',
  status: 'ready',
  problemKind: 'plan-problem/1.0（JSON，见 aps/contracts）',
  engine: 'rust-heuristic（WASM，零第三方依赖）',
  Panel: ApsPanel,
};

export { ApsPanel };
