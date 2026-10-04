/**
 * 共享的货架结构层：立柱 / 横梁 / 层板，尺寸与层高全部取自契约拓扑。
 *
 * 立柱按"每 N 列一根"抽稀（大场景下 instance 数量必须可控），但**货位格**不做任何简化：
 * 热力层与方案层画的每一个格都对应一个真实库位 id。
 */

import { Instance, Instances } from '@react-three/drei';
import { useMemo } from 'react';
import type { RackSpec } from './geometry';

export interface RackPart {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: string;
}

export function rackParts(racks: RackSpec[], options: { postStep?: number } = {}) {
  const frames: RackPart[] = [];
  const beams: RackPart[] = [];
  const shelves: RackPart[] = [];
  for (const rack of racks) {
    const [bx, bz] = rack.bayAxis ?? [1, 0];
    const [dx, dz] = rack.depthAxis ?? [0, -1];
    const width = rack.locationSize?.width_m ?? 1.2;
    const depth = rack.locationSize?.depth_m ?? 1.1;
    const levelHeight = rack.locationSize?.height_m ?? 1.8;
    const levelYs = (rack.levels ?? []).map((level) => level.y_m);
    const topY = (levelYs.length ? Math.max(...levelYs) : 0) + levelHeight;
    const halfWidth = (rack.bays * width) / 2;
    const halfDepth = (rack.depths * depth) / 2;
    const centerX = rack.origin[0] + bx * halfWidth - bx * width * 0.5;
    const centerZ = rack.origin[2] + bz * halfWidth - bz * width * 0.5;
    const step = options.postStep ?? Math.max(1, Math.ceil(rack.bays / 14));
    for (let bay = 0; bay <= rack.bays; bay += step) {
      for (const side of [-1, 1]) {
        frames.push({
          x: rack.origin[0] + bx * bay * width + dx * side * halfDepth,
          y: topY / 2,
          z: rack.origin[2] + bz * bay * width + dz * side * halfDepth,
          w: 0.09,
          h: topY,
          d: 0.09,
          color: '#2b3a52',
        });
      }
    }
    for (const y of levelYs) {
      beams.push({
        x: centerX,
        y,
        z: centerZ,
        w: bx !== 0 ? Math.abs(bx) * rack.bays * width : 0.12,
        h: 0.08,
        d: bz !== 0 ? Math.abs(bz) * rack.bays * width : 0.12,
        color: '#3b4c66',
      });
      for (let depthIndex = 1; depthIndex <= rack.depths; depthIndex += 1) {
        shelves.push({
          x: rack.origin[0] + bx * halfWidth + dx * (depthIndex - 0.5) * depth - bx * width * 0.5,
          y: y + 0.04,
          z: rack.origin[2] + bz * halfWidth + dz * (depthIndex - 0.5) * depth - bz * width * 0.5,
          w: bx !== 0 ? Math.abs(bx) * rack.bays * width : depth * 0.92,
          h: 0.05,
          d: bz !== 0 ? Math.abs(bz) * rack.bays * width : depth * 0.92,
          color: '#4a5f7d',
        });
      }
    }
  }
  return { frames, beams, shelves };
}

function InstancedBoxes({ parts }: { parts: RackPart[] }) {
  if (parts.length === 0) return null;
  return (
    <Instances limit={parts.length} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#9fb6d2" roughness={0.62} metalness={0.32} envMapIntensity={0.6} />
      {parts.map((part, index) => (
        <Instance key={index} position={[part.x, part.y, part.z]} scale={[part.w, part.h, part.d]} color={part.color} />
      ))}
    </Instances>
  );
}

/** 货架结构（两个模块共用）。 */
export function RackStructure({ racks }: { racks: RackSpec[] }) {
  const parts = useMemo(() => rackParts(racks), [racks]);
  return (
    <group>
      <InstancedBoxes parts={parts.frames} />
      <InstancedBoxes parts={parts.beams} />
      <InstancedBoxes parts={parts.shelves} />
    </group>
  );
}
