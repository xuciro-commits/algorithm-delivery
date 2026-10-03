/**
 * 三维实验室（art-lab）模块登记。
 *
 * 定位：把**已上传的工业模型**升级为具有 C4D 工业科技插画风格的实时三维实验室，
 * 并把 APS / MAPF / AGV 的真实算法结果接入同一套空间视觉语言。
 *
 * 与其它模块的关系：
 *   - 几何来自 lab/design/assets（上传模型，同步到 public/models），不重制；
 *   - 算法来自既有 Rust/WASM 引擎（AGV / MAPF / APS），前端只做投影与呈现；
 *   - 视觉配置（模式 A/B/C、透明层、发光）是全局的，三个既有沙盘同时受益。
 */

import type { AlgorithmModule } from '../../core/types';
import { ArtLabPanel } from './ArtLabPanel';

export const artLabModule: AlgorithmModule = {
  id: 'art-lab',
  name: '三维实验室',
  tagline: '三个实验室：英雄设备 · 透明厂房 · 算法观察',
  category: '工业可视化',
  status: 'ready',
  problemKind: '复用 AGV / MAPF / APS 既有问题结构',
  engine: 'three.js 实时渲染（受控泛光）+ APS/MAPF/AGV WASM 引擎',
  Panel: ArtLabPanel,
};

export { ART_LABS, ART_ALGOS } from './ArtLabPanel';
