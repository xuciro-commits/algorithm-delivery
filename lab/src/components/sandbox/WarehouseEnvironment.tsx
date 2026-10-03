/**
 * Original modular micro-warehouse set dressing for the AGV lab.
 *
 * Rack bays are assembled from reusable instanced PBR parts (powder-coated uprights,
 * safety-orange beams, perforated shelves, pallets and labeled cartons). The scene is
 * purely presentational: grid occupancy, stations, tasks and every route still come
 * from the AGV problem / engine result; decorative meshes do not modify those inputs.
 */

import { Instances, Instance } from '@react-three/drei';
import { useMemo } from 'react';

interface BoxPart {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  rz?: number;
  color?: string;
}

interface WarehouseRackFieldProps {
  cells: Array<[number, number]>;
  maxDetailedBays?: number;
}

function BoxInstances({
  parts,
  color,
  roughness,
  metalness,
}: {
  parts: BoxPart[];
  color: string;
  roughness: number;
  metalness: number;
}) {
  if (parts.length === 0) return null;
  return (
    <Instances limit={parts.length} range={parts.length} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} envMapIntensity={0.8} />
      {parts.map((p, i) => (
        <Instance
          key={i}
          position={[p.x, p.y, p.z]}
          scale={[p.w, p.h, p.d]}
          rotation={[0, 0, p.rz ?? 0]}
          color={p.color}
        />
      ))}
    </Instances>
  );
}

function part(x: number, y: number, z: number, w: number, h: number, d: number, extra: Partial<BoxPart> = {}): BoxPart {
  return { x, y, z, w, h, d, ...extra };
}

export function WarehouseRackField({ cells, maxDetailedBays = 180 }: WarehouseRackFieldProps) {
  const details = useMemo(() => {
    const frame: BoxPart[] = [];
    const beams: BoxPart[] = [];
    const shelves: BoxPart[] = [];
    const cartons: BoxPart[] = [];
    const labels: BoxPart[] = [];
    const pallets: BoxPart[] = [];
    const detailed = cells.slice(0, maxDetailedBays);
    const compact = cells.slice(maxDetailedBays);

    for (let index = 0; index < detailed.length; index += 1) {
      const [gx, gz] = detailed[index];
      const cx = gx + 0.5;
      const cz = gz + 0.5;

      // Four upright columns with bolted foot plates.
      for (const dx of [-0.42, 0.42]) {
        for (const dz of [-0.34, 0.34]) {
          frame.push(part(cx + dx, 1.25, cz + dz, 0.055, 2.42, 0.055));
          frame.push(part(cx + dx, 0.055, cz + dz, 0.2, 0.045, 0.16));
          frame.push(part(cx + dx, 2.46, cz + dz, 0.095, 0.08, 0.095));
        }
      }

      // Three usable shelf levels, front/rear load beams and diagonal rear bracing.
      const levels = [0.43, 1.18, 1.93];
      for (const level of levels) {
        for (const dz of [-0.34, 0.34]) {
          beams.push(part(cx, level, cz + dz, 0.82, 0.075, 0.065));
        }
        shelves.push(part(cx, level - 0.085, cz, 0.78, 0.045, 0.61));

        // Two distinct cartons per level keep the frame readable and communicate scale.
        for (const dx of [-0.19, 0.19]) {
          const crateColor = (index + Math.round(level * 10) + (dx > 0 ? 1 : 0)) % 4 === 0 ? '#667887' : '#92734f';
          const boxY = level + 0.17;
          cartons.push(part(cx + dx, boxY, cz + 0.015, 0.31, 0.30, 0.39, { color: crateColor }));
          labels.push(part(cx + dx, boxY + 0.01, cz + 0.215, 0.12, 0.055, 0.009));
          // Two subtle wrap straps on each carton face.
          beams.push(part(cx + dx - 0.105, boxY, cz + 0.218, 0.018, 0.29, 0.012));
          beams.push(part(cx + dx + 0.105, boxY, cz + 0.218, 0.018, 0.29, 0.012));
        }
      }

      // Wood pallet runners and deck slats under the bottom load.
      pallets.push(part(cx, 0.145, cz, 0.76, 0.07, 0.61));
      for (const dx of [-0.26, 0, 0.26]) {
        pallets.push(part(cx + dx, 0.075, cz, 0.11, 0.075, 0.63));
      }

      // Back-plane cross bracing in both directions.
      frame.push(part(cx, 1.21, cz - 0.34, 0.045, 1.3, 0.045, { rz: 0.58 }));
      frame.push(part(cx, 1.21, cz - 0.34, 0.045, 1.3, 0.045, { rz: -0.58 }));
    }

    // Very large scenes retain every occupied bay while reducing fine shelf loads to
    // low-profile, instanced rack blocks. Nothing is removed from the map or solver.
    for (const [gx, gz] of compact) {
      shelves.push(part(gx + 0.5, 0.82, gz + 0.5, 0.9, 1.64, 0.88));
      beams.push(part(gx + 0.5, 1.67, gz + 0.5, 0.96, 0.09, 0.94));
    }

    return { frame, beams, shelves, cartons, labels, pallets };
  }, [cells, maxDetailedBays]);

  return (
    <group name="warehouse-rack-system">
      <BoxInstances parts={details.frame} color="#647784" roughness={0.38} metalness={0.72} />
      <BoxInstances parts={details.beams} color="#b17a45" roughness={0.44} metalness={0.54} />
      <BoxInstances parts={details.shelves} color="#364650" roughness={0.58} metalness={0.62} />
      <BoxInstances parts={details.pallets} color="#78583b" roughness={0.92} metalness={0.02} />
      <BoxInstances parts={details.cartons} color="#ffffff" roughness={0.93} metalness={0.015} />
      <BoxInstances parts={details.labels} color="#d5c5a3" roughness={0.8} metalness={0.03} />
    </group>
  );
}

interface WarehouseEnvironmentProps {
  width: number;
  height: number;
}

export function WarehouseEnvironment({ width, height }: WarehouseEnvironmentProps) {
  const infrastructure = useMemo(() => {
    const frame: BoxPart[] = [];
    const panels: BoxPart[] = [];
    const lights: BoxPart[] = [];
    const lane: BoxPart[] = [];
    const posts: BoxPart[] = [];

    const frameHeight = 3.15;
    const edgeX = [-0.52, width + 0.52];
    const edgeZ = [-0.52, height + 0.52];

    // Portal columns and top rails create a legible warehouse envelope without closing
    // the camera or hiding the algorithm board behind opaque walls.
    for (const x of edgeX) {
      for (const z of edgeZ) {
        frame.push(part(x, frameHeight / 2, z, 0.16, frameHeight, 0.16));
        frame.push(part(x, 0.22, z, 0.24, 0.12, 0.24));
        posts.push(part(x, 0.58, z, 0.205, 0.48, 0.205));
      }
    }
    frame.push(part(width / 2, frameHeight, -0.52, width + 1.08, 0.16, 0.16));
    frame.push(part(width / 2, frameHeight, height + 0.52, width + 1.08, 0.16, 0.16));
    frame.push(part(-0.52, frameHeight, height / 2, 0.16, 0.16, height + 1.08));
    frame.push(part(width + 0.52, frameHeight, height / 2, 0.16, 0.16, height + 1.08));

    // Rear wall panels remain below the truss line so the scene reads as a real bay,
    // while its open front keeps route endpoints and racks visible from the camera.
    const panelCount = Math.max(3, Math.min(10, Math.ceil(width / 2.8)));
    const panelWidth = (width + 0.84) / panelCount;
    for (let i = 0; i < panelCount; i += 1) {
      const x = -0.42 + panelWidth * (i + 0.5);
      panels.push(part(x, 1.13, -0.56, panelWidth - 0.035, 2.05, 0.08));
      panels.push(part(x, 2.27, -0.505, panelWidth - 0.1, 0.045, 0.035));
      // A narrow glazed daylight strip on the back wall.
      panels.push(part(x, 2.02, -0.505, panelWidth - 0.12, 0.32, 0.025, { color: '#9bb5c4' }));
    }

    // Evenly spaced suspended LED battens above the rack aisles.
    const lampCount = Math.max(2, Math.min(6, Math.ceil(width / 5.5)));
    for (let i = 0; i < lampCount; i += 1) {
      const x = ((i + 0.5) / lampCount) * width;
      const z = height * (i % 2 === 0 ? 0.29 : 0.71);
      lights.push(part(x, 2.88, z, Math.min(3.0, width / lampCount * 0.78), 0.055, 0.18));
    }

    // Fine safety/yield markings stay at aisle edges and do not encode a route.
    lane.push(part(width / 2, 0.016, 0.38, width - 1.1, 0.012, 0.035));
    lane.push(part(width / 2, 0.016, height - 0.38, width - 1.1, 0.012, 0.035));
    lane.push(part(0.38, 0.016, height / 2, 0.035, 0.012, height - 1.1));
    lane.push(part(width - 0.38, 0.016, height / 2, 0.035, 0.012, height - 1.1));
    // Safety bollards at the access corners, with yellow caps and dark bases.
    for (const x of [0.68, width - 0.68]) {
      for (const z of [0.68, height - 0.68]) {
        posts.push(part(x, 0.27, z, 0.14, 0.54, 0.14));
        posts.push(part(x, 0.52, z, 0.16, 0.10, 0.16, { color: '#c69743' }));
      }
    }
    return { frame, panels, lights, lane, posts };
  }, [width, height]);

  return (
    <group name="warehouse-interior">
      <BoxInstances parts={infrastructure.frame} color="#73828a" roughness={0.43} metalness={0.66} />
      <BoxInstances parts={infrastructure.panels} color="#34434c" roughness={0.76} metalness={0.2} />
      <BoxInstances parts={infrastructure.posts} color="#28343d" roughness={0.5} metalness={0.58} />
      <BoxInstances parts={infrastructure.lane} color="#d39b43" roughness={0.7} metalness={0.08} />
      <Instances limit={Math.max(1, infrastructure.lights.length)} range={infrastructure.lights.length}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#fff1cd" emissive="#ffe8b0" emissiveIntensity={1.35} roughness={0.28} metalness={0.08} />
        {infrastructure.lights.map((p, i) => (
          <Instance key={i} position={[p.x, p.y, p.z]} scale={[p.w, p.h, p.d]} />
        ))}
      </Instances>
      {infrastructure.lights.map((p, i) => (
        <pointLight key={`bay-light-${i}`} position={[p.x, p.y - 0.12, p.z]} intensity={4.2} distance={11} decay={2} color="#f8f0dd" />
      ))}
    </group>
  );
}
