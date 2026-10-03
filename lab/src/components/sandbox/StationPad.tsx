/**
 * 工作站泊位（V2 §五-02）：发光垫面 + 容量灯条。
 * 泊位格 = 半透明平台（琥珀色发光边缘），容量用一组小灯条表示
 * （亮 = 已占用，暗 = 空闲）——把「工作站状态与容量」变成空间信息。
 */

import { RoundedBox } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';
import { SB } from './theme';

export interface StationPadProps {
  /** 泊位格（格坐标）。 */
  cells: Array<[number, number]>;
  capacity: number;
  /** 当前占用数（>capacity 时按 capacity 封顶）。 */
  occupied: number;
  selected?: boolean;
  label?: string;
}

export function StationPad({ cells, capacity, occupied, selected = false }: StationPadProps) {
  const padMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(SB.amber),
        transparent: true,
        opacity: 0.1,
        depthWrite: false,
      }),
    [],
  );
  const edgeMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(SB.amber),
        transparent: true,
        opacity: selected ? 0.85 : 0.5,
        depthWrite: false,
      }),
    [selected],
  );
  const lightMat = useMemo(() => new THREE.MeshBasicMaterial({ color: new THREE.Color(SB.amber) }), []);
  const dimMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: new THREE.Color(SB.inactive), transparent: true, opacity: 0.55 }),
    [],
  );

  const first = cells[0];
  if (!first) return null;
  const used = Math.max(0, Math.min(capacity, occupied));

  return (
    <group>
      {/* 泊位垫面（每格一片，贴地） */}
      {cells.map(([x, y]) => (
        <group key={`${x},${y}`}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x + 0.5, 0.012, y + 0.5]} material={padMat}>
            <planeGeometry args={[0.98, 0.98]} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x + 0.5, 0.013, y + 0.5]} material={edgeMat}>
            <ringGeometry args={[0.44, 0.49, 4]} />
          </mesh>
        </group>
      ))}

      {/* 容量灯条：在首个泊位格旁立一组小灯（亮=占用） */}
      <group position={[first[0] + 0.5, 0, first[1] + 0.5]}>
        <RoundedBox args={[0.16, 0.5, 0.16]} radius={0.03} smoothness={2} position={[0, 0.25, 0]}>
          <meshStandardMaterial color="#1a2740" roughness={0.6} metalness={0.5} />
        </RoundedBox>
        {Array.from({ length: Math.max(1, Math.min(6, capacity)) }, (_, i) => (
          <mesh key={i} position={[0, 0.14 + i * 0.075, 0.09]} material={i < used ? lightMat : dimMat}>
            <boxGeometry args={[0.09, 0.035, 0.02]} />
          </mesh>
        ))}
      </group>
    </group>
  );
}
