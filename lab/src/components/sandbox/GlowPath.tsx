/**
 * 发光轨迹（V2 §三·最重要的视觉元素）：
 * 像精密仪器投射在沙盘上方悬浮的细光线——
 *   内层：纤细、锐利的核心线（全亮）；
 *   外层：宽而极淡的光晕线（低透明度）；
 * 已执行段明亮实线，未执行段半透明虚线；选中时增强。
 * 动画只做与真实离散时间步绑定的 dashOffset 光流，不编造运动。
 */

import { Line } from '@react-three/drei';
import { useMemo } from 'react';
import { smoothPath, type Pt3 } from './smoothPath';

export interface GlowPathProps {
  /** 格心世界坐标序列（含悬浮高度 y）。 */
  points: Pt3[];
  color: string;
  /** 已执行到的点索引（含）；null = 全部未执行。 */
  executedTo?: number | null;
  selected?: boolean;
  /** 光流偏移（由回放 tick 驱动，映射离散时间）。 */
  flowOffset?: number;
  /** 光晕强度倍率。 */
  glow?: number;
  dimmed?: boolean;
}

export function GlowPath({
  points,
  color,
  executedTo = null,
  selected = false,
  flowOffset = 0,
  glow = 1,
  dimmed = false,
}: GlowPathProps) {
  const coreW = selected ? 2.4 : 1.6;
  const haloW = (selected ? 9 : 6.5) * glow;
  const alpha = dimmed ? 0.32 : 1;

  const smoothed = useMemo(() => smoothPath(points, 0.34, 6), [points]);
  const k = executedTo == null ? -1 : Math.max(0, Math.min(points.length - 1, executedTo));

  // 平滑后按「执行点数」近似切分：执行比例 = (k)/(n-1)
  const ratio = points.length > 1 ? k / (points.length - 1) : 0;
  const cut = Math.max(2, Math.min(smoothed.length - 1, Math.round(ratio * (smoothed.length - 1)) + 1));
  const execPts = k >= 0 ? smoothed.slice(0, Math.max(2, cut)) : [];
  const planPts = smoothed.slice(Math.max(0, Math.min(smoothed.length - 2, cut - 1)));

  return (
    <group>
      {execPts.length >= 2 && (
        <>
          <Line points={execPts} color={color} lineWidth={haloW} transparent opacity={0.16 * alpha} />
          <Line points={execPts} color={color} lineWidth={coreW} transparent opacity={(selected ? 1 : 0.92) * alpha} />
        </>
      )}
      {planPts.length >= 2 && (
        <>
          <Line
            points={planPts}
            color={color}
            lineWidth={haloW * 0.8}
            transparent
            opacity={0.09 * alpha}
            dashed
            dashSize={0.34}
            gapSize={0.26}
            dashOffset={-flowOffset}
          />
          <Line
            points={planPts}
            color={color}
            lineWidth={coreW * 0.85}
            transparent
            opacity={(selected ? 0.66 : 0.45) * alpha}
            dashed
            dashSize={0.34}
            gapSize={0.26}
            dashOffset={-flowOffset}
          />
        </>
      )}
    </group>
  );
}
