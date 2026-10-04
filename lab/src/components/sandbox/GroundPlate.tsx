/**
 * PBR micro-lab floor: a cast metal/satin-concrete plinth, inset floor panel,
 * reusable engineering grid and four distinct machined edge rails.
 */

import { Grid, RoundedBox } from '@react-three/drei';
import { SB } from './theme';
import { ART_MODES } from '../../art/modes';
import { useArtStore } from '../../art/settings';

export interface GroundPlateProps {
  width: number;
  height: number;
  centerX?: number;
  centerZ?: number;
  /** 网格细分（每格 1 单位）。 */
  cellSize?: number;
  /** 大刻线间隔（格）。 */
  sectionSize?: number;
}

export function GroundPlate({
  width,
  height,
  centerX: propCenterX,
  centerZ: propCenterZ,
  cellSize = 1,
  sectionSize = 5,
}: GroundPlateProps) {
  // 模式 A = 既有实验台观感；模式 B/C 使用艺术化地坪（冷色反射 + 细网格 + 分区刻线）。
  const artMode = useArtStore((state) => state.mode);
  const mode = ART_MODES[artMode];
  const art = artMode !== 'A';
  const floorColor = art ? mode.ground.tint : '#38444a';
  const gridCell = art ? mode.ground.gridColor : '#596b77';
  const gridSection = art ? mode.ground.sectionColor : '#82919b';
  const edge = 0.4;
  const centerX = propCenterX ?? width / 2;
  const centerZ = propCenterZ ?? height / 2;
  return (
    <group name="machined-base-plate">
      {/* 主基座：有厚度的石墨合金底板，顶面留给地坪层。 */}
      <RoundedBox
        args={[width + edge * 2, 0.46, height + edge * 2]}
        radius={0.13}
        smoothness={4}
        position={[centerX, -0.25, centerZ]}
        receiveShadow
        castShadow
      >
        <meshStandardMaterial color="#25313a" roughness={0.64} metalness={0.46} envMapIntensity={0.72} />
      </RoundedBox>

      {/* Industrial floor coating: a separate, matte PBR surface with visible value range. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[centerX, -0.012, centerZ]} receiveShadow>
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial
          color={floorColor}
          roughness={art ? 0.34 : 0.88}
          metalness={art ? 0.42 : 0.08}
          envMapIntensity={art ? 0.95 : 0.24}
        />
      </mesh>

      {/* Four edge rails (not a solid overlay, so the floor and grid remain visible). */}
      <mesh position={[centerX, 0.008, centerZ - height / 2 - edge / 2]} castShadow receiveShadow>
        <boxGeometry args={[width + edge * 2, 0.07, 0.12]} />
        <meshStandardMaterial color={SB.plateEdge} roughness={0.42} metalness={0.78} envMapIntensity={0.9} />
      </mesh>
      <mesh position={[centerX, 0.008, centerZ + height / 2 + edge / 2]} castShadow receiveShadow>
        <boxGeometry args={[width + edge * 2, 0.07, 0.12]} />
        <meshStandardMaterial color={SB.plateEdge} roughness={0.42} metalness={0.78} envMapIntensity={0.9} />
      </mesh>
      <mesh position={[centerX - width / 2 - edge / 2, 0.008, centerZ]} castShadow receiveShadow>
        <boxGeometry args={[0.12, 0.07, height + edge * 2]} />
        <meshStandardMaterial color={SB.plateEdge} roughness={0.42} metalness={0.78} envMapIntensity={0.9} />
      </mesh>
      <mesh position={[centerX + width / 2 + edge / 2, 0.008, centerZ]} castShadow receiveShadow>
        <boxGeometry args={[0.12, 0.07, height + edge * 2]} />
        <meshStandardMaterial color={SB.plateEdge} roughness={0.42} metalness={0.78} envMapIntensity={0.9} />
      </mesh>

      {/* Fine etched coordinate grid and restrained five-cell reference marks. */}
      <Grid
        position={[centerX, -0.004, centerZ]}
        args={[width, height]}
        cellSize={cellSize}
        cellThickness={0.48}
        cellColor={gridCell}
        sectionSize={sectionSize}
        sectionThickness={art ? 1.05 : 0.88}
        sectionColor={gridSection}
        fadeDistance={Math.max(width, height) * 3.2}
        fadeStrength={1.12}
        followCamera={false}
        infiniteGrid={false}
      />
    </group>
  );
}
