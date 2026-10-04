/**
 * 模块出口（注册表需要的元数据 + 面板组件）。
 *
 * 纪律：模块只有**真的能跑**才置 `status: 'ready'`。`SlottingPanel` 会先校验引擎产物
 * （wasm + worker + 能力快照），缺产物时给出明确指引，而不是渲染假数据。
 */

import type { AlgorithmModule } from '../../core/types';
import { SlottingPanel } from './SlottingPanel';

export const slottingModule: AlgorithmModule = {
  id: 'slotting',
  name: '库位优化',
  tagline: '储位分配 · 多目标元启发式 · 动态重排 · 联合闭环',
  category: '仓储优化',
  status: 'ready',
  problemKind: 'warehouse-slotting-problem/1.0（也支持 warehouse-joint-problem/1.0）',
  engine: 'warehouse-engine（Rust → WASM，Worker 内同步求解）',
  Panel: SlottingPanel,
};
