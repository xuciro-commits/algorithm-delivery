/**
 * 工业级实时灯光方案（需求 §四）。
 *
 * 层次（每层都可在三种模式里独立配置，见 `modes.ts`）：
 *   1. HDRI 环境光照 —— 提供材质反射与整体氛围（不是背景板）；
 *   2. 主光（暖白，有方向性，投射 PCF 软阴影）—— 塑造机械体积；
 *   3. 补光（冷蓝，低强度）—— 压住阴影，保证设备细节可读；
 *   4. 轮廓光（冷色，来自主体侧后方）—— 勾出机械轮廓，形成冷暖对比；
 *   5. 局部工业灯（点位暖光）—— 沿产线布置，制造前后层次与接触高光。
 *
 * 全部灯光强度来自模式配置；不写死任何“看起来亮一点”的魔法数字。
 */

import { useMemo } from 'react';
import type { VisualModeConfig } from './modes';

export interface IndustrialRigProps {
  config: VisualModeConfig;
  /** 场景尺度（米）：用于按实际尺寸放大灯光距离，而不是靠调曝光硬凑。 */
  span: number;
  shadowMapSize: number;
  /** 局部工业灯沿 X 轴分布的起点与终点（世界坐标）。 */
  practicalLine?: { from: number; to: number; y: number; z: number };
}

export function IndustrialRig({ config, span, shadowMapSize, practicalLine }: IndustrialRigProps) {
  const { lighting } = config;
  const distance = Math.max(6, span * 1.35);

  const practicals = useMemo(() => {
    const count = Math.max(0, Math.min(6, lighting.practical.count));
    if (!count || !practicalLine) return [];
    const { from, to, y, z } = practicalLine;
    if (count === 1) return [[(from + to) / 2, y, z] as [number, number, number]];
    return Array.from({ length: count }, (_, index) => {
      const t = index / (count - 1);
      return [from + (to - from) * t, y, z] as [number, number, number];
    });
  }, [lighting.practical.count, practicalLine]);

  const keyPosition: [number, number, number] = [
    lighting.key.dir[0] * distance,
    lighting.key.dir[1] * distance,
    lighting.key.dir[2] * distance,
  ];
  const fillPosition: [number, number, number] = [
    lighting.fill.dir[0] * distance,
    lighting.fill.dir[1] * distance,
    lighting.fill.dir[2] * distance,
  ];
  const rimPosition: [number, number, number] = [
    lighting.rim.dir[0] * distance,
    lighting.rim.dir[1] * distance,
    lighting.rim.dir[2] * distance,
  ];

  return (
    <>
      <ambientLight intensity={lighting.ambient.intensity} color={lighting.ambient.color} />
      <hemisphereLight
        intensity={lighting.hemisphere.intensity}
        color={lighting.hemisphere.sky}
        groundColor={lighting.hemisphere.ground}
      />
      <directionalLight
        position={keyPosition}
        intensity={lighting.key.intensity}
        color={lighting.key.color}
        castShadow={lighting.key.castShadow}
        shadow-mapSize-width={shadowMapSize}
        shadow-mapSize-height={shadowMapSize}
        shadow-camera-near={0.5}
        shadow-camera-far={distance * 3.2}
        shadow-camera-left={-span * 0.95}
        shadow-camera-right={span * 0.95}
        shadow-camera-top={span * 0.95}
        shadow-camera-bottom={-span * 0.95}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-radius={3.5}
      />
      <directionalLight position={fillPosition} intensity={lighting.fill.intensity} color={lighting.fill.color} />
      <directionalLight position={rimPosition} intensity={lighting.rim.intensity} color={lighting.rim.color} />
      {practicals.map(([x, y, z], index) => (
        <pointLight
          key={`practical-${index}`}
          position={[x, y, z]}
          intensity={lighting.practical.intensity}
          distance={lighting.practical.distance * Math.max(1, span / 12)}
          decay={2}
          color={lighting.practical.color}
        />
      ))}
    </>
  );
}
