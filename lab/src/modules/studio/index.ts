/**
 * 视觉工作室模块注册：把既有工业模型的艺术化重构（材质 / 光影 / 三种模式 /
 * 真实截图与性能测量）作为实验室的一个正式模块接入。
 *
 * 该模块不依赖任何算法引擎，也不产生算法数据：它只处理几何与美术。
 */

import type { AlgorithmModule } from '../../core/types';
import { StudioPanel } from './StudioPanel';

export const studioModule: AlgorithmModule = {
  id: 'visual-studio',
  name: '视觉工作室',
  tagline: '既有工业模型的艺术化重构：三种视觉模式、半透明外壳、真实截图与性能测量',
  category: '视觉与场景',
  status: 'ready',
  problemKind: 'lab/design/assets 既有模型（CC0，只读复用）',
  engine: 'Three.js / React Three Fiber 实时渲染（无算法引擎依赖）',
  Panel: StudioPanel,
};

export { StudioPanel };
