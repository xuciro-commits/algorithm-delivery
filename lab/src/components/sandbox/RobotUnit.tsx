/**
 * Compact MAPF mobile robot with a structural chassis, four drive wheels, lidar cap,
 * front ranging sensor and semantic status lights. Movement remains owned by the
 * caller and is keyed to the algorithm's discrete path time.
 */

import { RoundedBox } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';
import { SB } from './theme';

export interface RobotUnitProps {
  x: number;
  z: number;
  heading: number;
  color: string;
  selected?: boolean;
  status?: 'run' | 'service' | 'idle';
  loaded?: boolean;
  size?: number;
}

export function RobotUnit({ x, z, heading, color, selected = false, status = 'run', loaded = false, size = 1 }: RobotUnitProps) {
  const s = size;
  const lightColor = status === 'service' ? SB.amber : color;
  const lightIntensity = status === 'idle' ? 0.45 : 1;
  const bodyMat = useMemo(
    () => new THREE.MeshPhysicalMaterial({ color: '#3c4c58', roughness: 0.39, metalness: 0.64, clearcoat: 0.24, clearcoatRoughness: 0.42, envMapIntensity: 1.05 }),
    [],
  );
  const steelMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#76858d', roughness: 0.32, metalness: 0.8, envMapIntensity: 1.05 }),
    [],
  );
  const rubberMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#12191d', roughness: 0.93, metalness: 0.015 }),
    [],
  );
  const accentMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color, roughness: 0.36, metalness: 0.4, emissive: color, emissiveIntensity: 0.2 * lightIntensity, envMapIntensity: 0.85 }),
    [color, lightIntensity],
  );
  const lightMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: lightColor, transparent: true, opacity: 0.94 * lightIntensity }),
    [lightColor, lightIntensity],
  );
  const glassMat = useMemo(
    () => new THREE.MeshPhysicalMaterial({ color: '#31556a', roughness: 0.16, metalness: 0.16, transmission: 0.1, clearcoat: 1, envMapIntensity: 1.15 }),
    [],
  );

  return (
    <group position={[x, 0, z]} rotation={[0, -heading, 0]} scale={s}>
      {/* Low chassis and serviceable rubber drive wheels. */}
      <RoundedBox args={[0.78, 0.14, 0.9]} radius={0.045} smoothness={3} position={[0, 0.15, 0]} material={steelMat} castShadow receiveShadow />
      {[-0.34, 0.34].flatMap((wx) => [-0.31, 0.31].map((wz) => (
        <mesh key={`${wx}-${wz}`} position={[wx, 0.11, wz]} rotation={[0, 0, Math.PI / 2]} material={rubberMat} castShadow receiveShadow>
          <cylinderGeometry args={[0.105, 0.105, 0.1, 18]} />
        </mesh>
      )))}

      {/* Powder-coated shell, machined deck and side recognition rails. */}
      <RoundedBox args={[0.64, 0.24, 0.72]} radius={0.075} smoothness={4} position={[0, 0.35, 0]} material={bodyMat} castShadow receiveShadow />
      <RoundedBox args={[0.52, 0.038, 0.62]} radius={0.018} smoothness={3} position={[0, 0.49, 0]} material={steelMat} />
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * 0.33, 0.35, 0]} material={accentMat}>
          <boxGeometry args={[0.026, 0.12, 0.56]} />
        </mesh>
      ))}

      {/* Front ranging window and direction / state indicators. */}
      <RoundedBox args={[0.44, 0.075, 0.026]} radius={0.018} smoothness={3} position={[0, 0.3, 0.371]} material={glassMat} />
      {[-0.15, 0, 0.15].map((sx) => (
        <mesh key={sx} position={[sx, 0.3, 0.393]} material={lightMat}>
          <sphereGeometry args={[0.021, 10, 8]} />
        </mesh>
      ))}
      <mesh position={[0, 0.52, 0.08]} material={lightMat}>
        <sphereGeometry args={[0.047, 14, 12]} />
      </mesh>

      {/* Lidar turret: brushed base, dark lens and a restrained ring. */}
      <mesh position={[0, 0.56, -0.2]} material={steelMat} castShadow>
        <cylinderGeometry args={[0.13, 0.15, 0.06, 28]} />
      </mesh>
      <mesh position={[0, 0.595, -0.2]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.104, 0.01, 6, 28]} />
        <meshStandardMaterial color={color} roughness={0.28} metalness={0.4} emissive={color} emissiveIntensity={0.14} />
      </mesh>
      <mesh position={[0, 0.6, -0.2]} material={glassMat}>
        <cylinderGeometry args={[0.06, 0.07, 0.022, 20]} />
      </mesh>

      {loaded && (
        <group>
          <mesh position={[0, 0.54, 0]}>
            <boxGeometry args={[0.42, 0.035, 0.46]} />
            <meshStandardMaterial color="#76583c" roughness={0.9} />
          </mesh>
          <mesh position={[0, 0.67, 0]}>
            <boxGeometry args={[0.31, 0.21, 0.33]} />
            <meshStandardMaterial color="#92734f" roughness={0.92} metalness={0.01} />
          </mesh>
        </group>
      )}

      {selected && (
        <>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
            <ringGeometry args={[0.52, 0.58, 40]} />
            <meshBasicMaterial color={color} transparent opacity={0.9} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.018, 0]}>
            <circleGeometry args={[0.8, 28]} />
            <meshBasicMaterial color={color} transparent opacity={0.08} blending={THREE.AdditiveBlending} depthWrite={false} />
          </mesh>
        </>
      )}
    </group>
  );
}
