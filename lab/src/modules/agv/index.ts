/**
 * AGV 调度模块注册：从 planned → ready（M4）。
 *
 * 问题结构（agv-dispatch-problem/1.0）、引擎（rust-agv-dispatch WASM）、
 * 可视化（仓库地图 + 任务相位回放 + 核验面板 + 动态汇总）。
 * 与 MAPF 模块复用 grid-map 栅格原语（无算法语义耦合）。
 */

import type { AlgorithmModule } from '../../core/types';
import { AgvPanel } from './AgvPanel';

export const agvModule: AlgorithmModule = {
  id: 'agv-dispatch',
  name: 'AGV 调度',
  tagline: '任务分配 + 联合路径 + 工作站容量 + 动态重调度；浏览器内 WASM 计算',
  category: '运动规划',
  status: 'ready',
  problemKind: 'agv-dispatch-problem/1.0（JSON，见 agv/contracts）',
  engine: 'rust-agv-dispatch（WASM，零第三方依赖）',
  Panel: AgvPanel,
};

export { AgvPanel };
