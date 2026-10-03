/**
 * MAPF 多机器人路径规划模块注册。
 *
 * 自带问题结构（MapfProblem v1）、计算引擎（Rust WASM，wasm-light）与可视化
 * （栅格地图 + 时空路径回放 + 核验面板），符合“各算法保留独立实现”的要求。
 * 沿用路线图上的 `path-planning` 槽位：首页从“待接入”变为可运行。
 */

import type { AlgorithmModule } from '../../core/types';
import { MapfPanel } from './MapfPanel';

export const mapfModule: AlgorithmModule = {
  id: 'path-planning',
  name: 'MAPF 路径规划',
  tagline: 'MapfProblem → ECBS/优先搜索 → 独立核验；浏览器内 WASM 计算',
  category: '运动规划',
  status: 'ready',
  problemKind: 'mapf-problem/1.0（JSON，见 mapf/contracts）',
  engine: 'rust-ecbs-cbs（WASM，零第三方依赖）',
  Panel: MapfPanel,
};

export { MapfPanel };
