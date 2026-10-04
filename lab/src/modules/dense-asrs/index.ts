/**
 * 模块出口（注册表需要的元数据 + 面板组件）。
 *
 * 与 `slotting` 共用同一个 Rust 引擎，但走的是 kind=asrs 的入口：
 * 输入是拓扑 + 设备 + 任务 + 事件，输出是可重放的设备时间线与独立核验报告。
 */

import type { AlgorithmModule } from '../../core/types';
import { DenseAsrsPanel } from './DenseAsrsPanel';

export const denseAsrsModule: AlgorithmModule = {
  id: 'dense-asrs',
  name: '密集立库',
  tagline: '多层穿梭车/提升机调度 · 时空预约 · 倒垛 · 动态事件',
  category: '仓储优化',
  status: 'ready',
  problemKind: 'warehouse-asrs-problem/1.0（也支持 warehouse-joint-problem/1.0）',
  engine: 'warehouse-engine（Rust → WASM；求解与核验在 Worker 内完成）',
  Panel: DenseAsrsPanel,
};
