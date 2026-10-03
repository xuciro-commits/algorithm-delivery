/**
 * 算法叠加层渲染（模式 C 的主视觉）。
 *
 * 只消费 `AlgoOverlay` 中性模型：不接触任何算法结构，因此 APS / MAPF / AGV 共用一套
 * 空间语汇，且**渲染层无法凭空造出数据**（模型里没有的点不会出现）。
 */

import { ArtEventMark, ArtNode, ArtProjection, ArtRoute, ArtStatusLight, type Pt3 } from './ArtAlgorithmOverlay';
import { EMPTY_OVERLAY, type AlgoOverlay } from './overlayModel';

export interface ArtOverlayLayerProps {
  overlay?: AlgoOverlay;
  /** 光流相位（由回放 tick 驱动）。 */
  flowOffset?: number;
  /** 强调某个实体（选中设备 / 选中任务）。 */
  highlightId?: string | null;
}

export function ArtOverlayLayer({ overlay = EMPTY_OVERLAY, flowOffset = 0, highlightId = null }: ArtOverlayLayerProps) {
  return (
    <group name="art-algorithm-overlay">
      {overlay.projections.map((item) => (
        <ArtProjection key={`proj-${item.id}`} position={item.position} color={item.color} radius={item.radius} />
      ))}
      {overlay.routes.map((route) => (
        <ArtRoute
          key={`route-${route.id}`}
          points={route.points}
          color={route.color}
          executedTo={route.executedTo ?? null}
          selected={route.selected || route.id === highlightId}
          flowOffset={flowOffset}
          conflict={route.conflict}
          y={route.y ?? 0.09}
        />
      ))}
      {overlay.nodes.map((node) => (
        <ArtNode
          key={`node-${node.id}`}
          position={node.position}
          color={node.color}
          radius={node.radius ?? 0.34}
          ticks={node.ticks}
          selected={node.selected || node.id === highlightId}
          filled={node.filled}
          progress={node.progress}
        />
      ))}
      {overlay.statuses.map((status) => (
        <ArtStatusLight key={`status-${status.id}`} position={status.position} tone={status.tone} />
      ))}
      {overlay.marks.map((mark) => (
        <ArtEventMark key={`mark-${mark.id}`} position={mark.position} color={mark.color} />
      ))}
    </group>
  );
}

/** 把格坐标数组直接转成路径点（调用方给出世界坐标换算函数，保证映射可追溯）。 */
export function cellsToPoints(
  cells: Array<[number, number]>,
  toWorld: (cell: [number, number]) => Pt3,
): Pt3[] {
  return cells.map((cell) => toWorld(cell));
}
