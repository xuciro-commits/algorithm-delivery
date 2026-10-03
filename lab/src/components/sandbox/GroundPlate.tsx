/**
 * 空间底板：有厚度的倒角基座 + 细密工程网格（双色刻线）+ 边缘金属框线。
 * 栅格被转换为「具有轻微厚度的空间底板」（V2 §五-MAPF）。
 */

import { Grid, RoundedBox } from '@react-three/drei';
import { SB } from './theme';

export interface GroundPlateProps {
  width: number;
  height: number;
  /** 网格细分（每格 1 单位）。 */
  cellSize?: number;
  /** 大刻线间隔（格）。 */
  sectionSize?: number;
}

export function GroundPlate({ width, height, cellSize = 1, sectionSize = 5 }: GroundPlateProps) {
  return (
    <group>
      {/* 基座：倒角厚板 */}
      <RoundedBox
        args={[width + 0.8, 0.5, height + 0.8]}
        radius={0.12}
        smoothness={3}
        position={[width / 2, -0.28, height / 2]}
      >
        <meshStandardMaterial color={SB.plate} roughness={0.85} metalness={0.35} />
      </RoundedBox>
      {/* 顶面边缘金属框线（略大于基座顶面，形成精密边框） */}
      <mesh position={[width / 2, 0.004, height / 2]}>
        <boxGeometry args={[width + 0.72, 0.05, height + 0.72]} />
        <meshStandardMaterial color={SB.plateEdge} roughness={0.6} metalness={0.55} />
      </mesh>
      {/* 工程网格（着色器平面，置于基座顶面） */}
      <Grid
        position={[width / 2, 0.011, height / 2]}
        args={[width, height]}
        cellSize={cellSize}
        cellThickness={0.6}
        cellColor={SB.plateLine}
        sectionSize={sectionSize}
        sectionThickness={1.1}
        sectionColor={SB.plateEdge}
        fadeDistance={Math.max(width, height) * 3.2}
        fadeStrength={1.2}
        followCamera={false}
        infiniteGrid={false}
      />
    </group>
  );
}
