/**
 * 算法叠加层的**中性数据模型**（与具体算法解耦）。
 *
 * 三个算法各自把自己引擎输出的解投影成这个模型，再交给同一套艺术化渲染
 * （ArtOverlayLayer）——这就是“APS 任务 / AGV 路线 / MAPF 路径使用统一空间视觉语言”
 * 的落点：颜色语义、节点形态、路径线宽与发光层级全部一致。
 *
 * 约束：模型里的每个坐标与时刻都必须来自引擎输出或其在世界坐标系里的确定性投影，
 * 装饰性动画不得写入这里。
 */

import type { Pt3 } from './ArtAlgorithmOverlay';
import type { StatusTone } from './ArtAlgorithmOverlay';

export interface OverlayRoute {
  id: string;
  color: string;
  points: Pt3[];
  /** 已执行到的点索引（含）；null = 全部未执行（计划中）。 */
  executedTo?: number | null;
  selected?: boolean;
  conflict?: boolean;
  /** 悬浮高度（AGV 贴地、MAPF 略高、APS 工序连线更高）。 */
  y?: number;
}

export interface OverlayNodeItem {
  id: string;
  position: Pt3;
  color: string;
  radius?: number;
  ticks?: number;
  selected?: boolean;
  filled?: boolean;
  /** 在制工序的真实完成度 0–1（引擎起止时刻推导）；未定义 = 不画进度弧。 */
  progress?: number;
}

export interface OverlayStatusItem {
  id: string;
  position: Pt3;
  tone: StatusTone;
}

export interface OverlayMarkItem {
  id: string;
  position: Pt3;
  color: string;
}

export interface OverlayProjectionItem {
  id: string;
  position: Pt3;
  color: string;
  radius: number;
}

export interface OverlayLegendItem {
  color: string;
  text: string;
}

/** 一次算法运行的可视化描述（真实解 → 空间语汇）。 */
export interface AlgoOverlay {
  /** 来源标注（哪个算法、哪个样例、什么状态）。 */
  label: string;
  /** 引擎状态与指标摘要（如实显示，不做美化）。 */
  status: string;
  routes: OverlayRoute[];
  nodes: OverlayNodeItem[];
  statuses: OverlayStatusItem[];
  marks: OverlayMarkItem[];
  projections: OverlayProjectionItem[];
  legend: OverlayLegendItem[];
  /** 数据说明：坐标如何从算法格映射到厂房世界坐标（可追溯）。 */
  mapping: string;
}

export const EMPTY_OVERLAY: AlgoOverlay = {
  label: '未运行',
  status: '—',
  routes: [],
  nodes: [],
  statuses: [],
  marks: [],
  projections: [],
  legend: [],
  mapping: '',
};
