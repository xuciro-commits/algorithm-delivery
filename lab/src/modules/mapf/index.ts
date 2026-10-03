/**
 * MAPF 多机器人路径规划模块注册。
 *
 * 自带问题结构（MapfProblem v1）、计算引擎（Rust WASM，wasm-light）与可视化
 * （M1 Visual Lab：地图优先的场景编辑器 + 分层渲染回放 + 动态事件向导 +
 * 运行历史对比 + 独立核验面板），符合“各算法保留独立实现”的要求。
 * 沿用路线图上的 `path-planning` 槽位：首页从“待接入”变为可运行。
 */

import type { AlgorithmModule } from '../../core/types';
import { MapfPanel } from './MapfPanel';

export const mapfModule: AlgorithmModule = {
  id: 'path-planning',
  name: 'MAPF 路径规划',
  tagline: '地图优先编辑器 + ECBS 求解 + 时空回放 + 动态事件 + 运行对比；浏览器内 WASM 计算',
  category: '运动规划',
  status: 'ready',
  problemKind: 'mapf-problem/1.0（JSON，见 mapf/contracts）',
  engine: 'rust-ecbs-cbs（WASM，零第三方依赖）',
  Panel: MapfPanel,
};

export { MapfPanel };
