/**
 * 科技地坪（需求 §五）：细密工程网格 + 区域标识 + 受控反射。
 *
 * 做法与既有的 `GroundPlate`（微缩实验台底板）区分：
 *   - `GroundPlate` 是“实验台”语汇（倒角厚板 + 金属边条），继续服务于既有算法沙盘；
 *   - `ArtGroundField` 是“工业厂房地坪”语汇（大面积环氧地坪 + 分区标线 + 大刻线），
 *     服务于三维实验室的透明厂房。
 *
 * 两者都用单 mesh 地面 + 一个 Grid（不逐格实例化，遵守性能红线）。
 */

import { Grid, Line, RoundedBox } from '@react-three/drei';
import { useMemo } from 'react';
import { ART_MODES } from './modes';
import { useArtStore } from './settings';

/** 分区标识：由调用方给出真实语义（产线区 / AGV 通道 / 存储区…），颜色取自统一发光语义。 */
export interface FloorZone {
  id: string;
  /** 左上角（世界 XZ）。 */
  x: number;
  z: number;
  width: number;
  depth: number;
  color: string;
  label?: string;
  /** 虚线边框（通道类）。 */
  dashed?: boolean;
}

export interface ArtGroundFieldProps {
  width: number;
  height: number;
  /** 大刻线间距（米）——厂房柱距。 */
  sectionSize?: number;
  zones?: FloorZone[];
  /** 比例标尺刻度（每 6 m 一个刻度线）。 */
  showScaleMarks?: boolean;
  /** 地坪抬升（避免与厂房构件共面闪烁）。 */
  y?: number;
}

export function ArtGroundField({ width, height, sectionSize = 6, zones, showScaleMarks, y = 0 }: ArtGroundFieldProps) {
  const settings = useArtStore();
  const mode = ART_MODES[settings.mode];
  const centerX = width / 2;
  const centerZ = height / 2;

  const marks = useMemo(() => {
    if (!showScaleMarks) return [] as Array<{ pos: [number, number, number]; size: [number, number, number] }>;
    const out: Array<{ pos: [number, number, number]; size: [number, number, number] }> = [];
    const step = sectionSize;
    for (let x = step; x < width; x += step) {
      out.push({ pos: [x, y + 0.006, 0.34], size: [0.035, 0.008, 0.68] });
      out.push({ pos: [x, y + 0.006, height - 0.34], size: [0.035, 0.008, 0.68] });
    }
    for (let z = step; z < height; z += step) {
      out.push({ pos: [0.34, y + 0.006, z], size: [0.68, 0.008, 0.035] });
      out.push({ pos: [width - 0.34, y + 0.006, z], size: [0.68, 0.008, 0.035] });
    }
    return out;
  }, [width, height, sectionSize, showScaleMarks, y]);

  return (
    <group name="art-ground-field">
      {/* 基座：有厚度的石墨底板（沙盘感 + 遮挡视线外的地面边缘） */}
      <RoundedBox
        args={[width + 1.2, 0.5, height + 1.2]}
        radius={0.16}
        smoothness={4}
        position={[centerX, y - 0.27, centerZ]}
        receiveShadow
      >
        <meshStandardMaterial color="#131b22" roughness={0.6} metalness={0.5} envMapIntensity={0.7} />
      </RoundedBox>

      {/* 环氧地坪：低粗糙度 + 环境反射，形成“高级科技地面”的反射层次 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[centerX, y - 0.006, centerZ]} receiveShadow>
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial
          color={mode.ground.tint}
          roughness={mode.id === 'A' ? 0.88 : 0.34}
          metalness={mode.id === 'A' ? 0.08 : 0.42}
          envMapIntensity={mode.id === 'A' ? 0.24 : 0.95}
        />
      </mesh>

      {/* 分区标线：半透明填充 + 细发光边框（语义来自调用方给出的真实区域） */}
      {zones?.map((zone) => (
        <group key={zone.id}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[zone.x + zone.width / 2, y + 0.004, zone.z + zone.depth / 2]}>
            <planeGeometry args={[zone.width, zone.depth]} />
            <meshBasicMaterial color={zone.color} transparent opacity={0.07} depthWrite={false} />
          </mesh>
          <Line
            points={[
              [zone.x, y + 0.012, zone.z],
              [zone.x + zone.width, y + 0.012, zone.z],
              [zone.x + zone.width, y + 0.012, zone.z + zone.depth],
              [zone.x, y + 0.012, zone.z + zone.depth],
              [zone.x, y + 0.012, zone.z],
            ]}
            color={zone.color}
            lineWidth={1.15}
            transparent
            opacity={0.75}
            dashed={zone.dashed}
            dashSize={0.42}
            gapSize={0.34}
            depthWrite={false}
          />
        </group>
      ))}

      {/* 工程网格：细格 + 柱距粗刻线（颜色随模式变化） */}
      {settings.showGrid && (
        <Grid
          position={[centerX, y + 0.002, centerZ]}
          args={[width, height]}
          cellSize={1}
          cellThickness={mode.id === 'A' ? 0.48 : 0.4}
          cellColor={mode.ground.gridColor}
          sectionSize={sectionSize}
          sectionThickness={mode.id === 'A' ? 0.88 : 1.05}
          sectionColor={mode.ground.sectionColor}
          fadeDistance={Math.max(width, height) * 3}
          fadeStrength={1.05}
          followCamera={false}
          infiniteGrid={false}
        />
      )}

      {/* 比例刻度（每柱距一个刻度） */}
      {marks.map((mark, i) => (
        <mesh key={`mark-${i}`} position={mark.pos}>
          <boxGeometry args={mark.size} />
          <meshBasicMaterial color={mode.ground.sectionColor} transparent opacity={0.5} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}
