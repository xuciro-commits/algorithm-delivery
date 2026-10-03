/**
 * Modular APS production-cell environment: floor lanes, safety barriers, ceiling
 * portals and an unanimated roller conveyor. It is spatial context only; workpieces
 * remain visible only when a real APS operation is active on its assigned machine.
 */

import { Instances, Instance } from '@react-three/drei';
import { useMemo } from 'react';

interface FactoryEnvironmentProps {
  width: number;
  height: number;
}

interface BoxPart {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color?: string;
}

function Parts({ parts, color, roughness, metalness }: { parts: BoxPart[]; color: string; roughness: number; metalness: number }) {
  if (parts.length === 0) return null;
  return (
    <Instances limit={parts.length} range={parts.length} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} envMapIntensity={0.8} />
      {parts.map((p, i) => (
        <Instance key={i} position={[p.x, p.y, p.z]} scale={[p.w, p.h, p.d]} color={p.color} />
      ))}
    </Instances>
  );
}

export function FactoryEnvironment({ width, height }: FactoryEnvironmentProps) {
  const data = useMemo(() => {
    const structure: BoxPart[] = [];
    const fence: BoxPart[] = [];
    const hazard: BoxPart[] = [];
    const floor: BoxPart[] = [];
    const lights: BoxPart[] = [];
    const rollers: Array<[number, number, number]> = [];

    const postX = [-0.22, width + 0.22];
    const postZ = [-0.18, height + 0.18];
    for (const x of postX) {
      for (const z of postZ) {
        structure.push({ x, y: 1.62, z, w: 0.14, h: 3.24, d: 0.14 });
        structure.push({ x, y: 0.12, z, w: 0.24, h: 0.08, d: 0.24 });
      }
    }
    structure.push({ x: width / 2, y: 3.18, z: -0.18, w: width + 0.44, h: 0.16, d: 0.16 });
    structure.push({ x: width / 2, y: 3.18, z: height + 0.18, w: width + 0.44, h: 0.16, d: 0.16 });
    structure.push({ x: -0.22, y: 3.18, z: height / 2, w: 0.16, h: 0.16, d: height + 0.36 });
    structure.push({ x: width + 0.22, y: 3.18, z: height / 2, w: 0.16, h: 0.16, d: height + 0.36 });

    // Safety rail and alternating yellow corner posts behind the machine row.
    const fenceZ = 0.72;
    const fenceCount = Math.max(3, Math.floor(width / 2.6));
    for (let i = 0; i <= fenceCount; i += 1) {
      const x = 0.38 + ((width - 0.76) * i) / fenceCount;
      fence.push({ x, y: 0.52, z: fenceZ, w: 0.09, h: 1.04, d: 0.09 });
      hazard.push({ x, y: 0.89, z: fenceZ, w: 0.105, h: 0.13, d: 0.11, color: '#d1a14d' });
    }
    for (const y of [0.36, 0.76]) {
      fence.push({ x: width / 2, y, z: fenceZ, w: width - 0.75, h: 0.055, d: 0.055 });
    }

    // Painted workcell borders and centerline: infrastructure, not an algorithm path.
    floor.push({ x: width / 2, y: 0.018, z: 0.3, w: width - 0.7, h: 0.014, d: 0.035 });
    floor.push({ x: width / 2, y: 0.018, z: height - 0.3, w: width - 0.7, h: 0.014, d: 0.035 });
    floor.push({ x: width / 2, y: 0.019, z: height * 0.72, w: width - 0.8, h: 0.012, d: 0.025, color: '#82909a' });

    // Static roller transfer line on the operator aisle; it carries no fabricated jobs.
    const conveyorZ = height - 1.05;
    for (let x = 0.7; x <= width - 0.7; x += 0.48) rollers.push([x, 0.53, conveyorZ]);
    for (const dz of [-0.36, 0.36]) {
      structure.push({ x: width / 2, y: 0.38, z: conveyorZ + dz, w: width - 1.05, h: 0.12, d: 0.065 });
      structure.push({ x: width / 2, y: 0.62, z: conveyorZ + dz, w: width - 1.05, h: 0.08, d: 0.09 });
    }
    for (let x = 1.1; x < width - 0.5; x += 2.4) {
      structure.push({ x, y: 0.23, z: conveyorZ, w: 0.1, h: 0.38, d: 0.65 });
    }

    // Ceiling battens sit above the guard portals; the shared IBL provides reflections.
    const count = Math.max(2, Math.min(6, Math.ceil(width / 4.6)));
    for (let i = 0; i < count; i += 1) {
      const x = ((i + 0.5) / count) * width;
      lights.push({ x, y: 2.94, z: height * 0.42, w: Math.min(2.8, width / count * 0.76), h: 0.055, d: 0.15 });
    }
    return { structure, fence, hazard, floor, lights, rollers };
  }, [width, height]);

  return (
    <group name="aps-production-hall">
      <Parts parts={data.structure} color="#52636d" roughness={0.43} metalness={0.68} />
      <Parts parts={data.fence} color="#32424b" roughness={0.5} metalness={0.55} />
      <Parts parts={data.hazard} color="#d1a14d" roughness={0.5} metalness={0.32} />
      <Parts parts={data.floor} color="#c79a4a" roughness={0.72} metalness={0.06} />
      <Instances limit={data.rollers.length} range={data.rollers.length} castShadow receiveShadow>
        <cylinderGeometry args={[0.062, 0.062, 0.66, 12]} />
        <meshStandardMaterial color="#9ba5a5" roughness={0.31} metalness={0.83} envMapIntensity={1.1} />
        {data.rollers.map(([x, y, z], i) => (
          <Instance key={i} position={[x, y, z]} rotation={[Math.PI / 2, 0, 0]} />
        ))}
      </Instances>
      <Instances limit={Math.max(1, data.lights.length)} range={data.lights.length}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#fff0cf" emissive="#ffe9b6" emissiveIntensity={1.15} roughness={0.3} metalness={0.06} />
        {data.lights.map((p, i) => (
          <Instance key={i} position={[p.x, p.y, p.z]} scale={[p.w, p.h, p.d]} />
        ))}
      </Instances>
      {data.lights.map((p, i) => (
        <pointLight key={`cell-light-${i}`} position={[p.x, p.y - 0.1, p.z]} intensity={3.4} distance={8.5} decay={2} color="#f4eddd" />
      ))}
    </group>
  );
}
