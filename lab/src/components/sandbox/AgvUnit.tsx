/**
 * Low-profile autonomous mobile robot, built from reusable mechanical parts.
 * Powder-coated shell, chassis rails, four rubber drive wheels, lidar puck, safety
 * scanner, bumper sensors, status beacon and (only when engine phase says loaded) a
 * real pallet / carton payload. Position and heading are supplied by the caller.
 */

import { RoundedBox } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';
import { SB } from './theme';

export interface AgvUnitProps {
  x: number;
  z: number;
  heading: number;
  color: string;
  selected?: boolean;
  phase?: string;
  loaded?: boolean;
  paused?: boolean;
  size?: number;
}

const WHEEL_POSITIONS: Array<[number, number]> = [
  [-0.33, -0.32],
  [0.33, -0.32],
  [-0.33, 0.32],
  [0.33, 0.32],
];

export function AgvUnit({
  x,
  z,
  heading,
  color,
  selected = false,
  phase = 'idle',
  loaded = false,
  paused = false,
  size = 1,
}: AgvUnitProps) {
  const s = size;
  const servicing = phase === 'servicing_pickup' || phase === 'servicing_dropoff';
  const lightColor = paused ? SB.coral : servicing ? SB.amber : color;
  const bodyMat = useMemo(
    () => new THREE.MeshPhysicalMaterial({ color: '#35434e', roughness: 0.38, metalness: 0.68, clearcoat: 0.28, clearcoatRoughness: 0.42, envMapIntensity: 1.1 }),
    [],
  );
  const frameMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#687781', roughness: 0.32, metalness: 0.82, envMapIntensity: 1.15 }),
    [],
  );
  const darkMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#141d24', roughness: 0.62, metalness: 0.55, envMapIntensity: 0.6 }),
    [],
  );
  const wheelMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#111619', roughness: 0.94, metalness: 0.02 }),
    [],
  );
  const accentMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color, roughness: 0.36, metalness: 0.44, emissive: color, emissiveIntensity: 0.22, envMapIntensity: 0.9 }),
    [color],
  );
  const hazardMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#d59a41', roughness: 0.5, metalness: 0.34 }),
    [],
  );
  const sensorMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: lightColor, transparent: true, opacity: paused ? 0.98 : 0.92 }),
    [lightColor, paused],
  );
  const sensorLensMat = useMemo(
    () => new THREE.MeshPhysicalMaterial({ color: '#25465a', roughness: 0.12, metalness: 0.2, transmission: 0.12, clearcoat: 1, envMapIntensity: 1.2 }),
    [],
  );
  const crateMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#8c704e', roughness: 0.92, metalness: 0.02 }),
    [],
  );
  const palletMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#76583c', roughness: 0.9, metalness: 0.015 }),
    [],
  );

  return (
    <group position={[x, 0, z]} rotation={[0, -heading, 0]} scale={s}>
      {/* Chassis rails and industrial rubber wheels. */}
      <RoundedBox args={[0.76, 0.13, 0.94]} radius={0.045} smoothness={3} position={[0, 0.18, 0]} material={frameMat} castShadow receiveShadow />
      {WHEEL_POSITIONS.map(([wx, wz]) => (
        <group key={`${wx},${wz}`} position={[wx, 0.115, wz]}>
          <mesh rotation={[0, 0, Math.PI / 2]} material={wheelMat} castShadow receiveShadow>
            <cylinderGeometry args={[0.115, 0.115, 0.11, 20]} />
          </mesh>
          <mesh position={[Math.sign(wx) * 0.057, 0, 0]} rotation={[0, 0, Math.PI / 2]} material={frameMat}>
            <cylinderGeometry args={[0.055, 0.055, 0.014, 18]} />
          </mesh>
        </group>
      ))}

      {/* Bumper / painted shell with independent deck and replaceable impact strip. */}
      <RoundedBox args={[0.88, 0.10, 1.04]} radius={0.045} smoothness={3} position={[0, 0.17, 0]} material={darkMat} castShadow receiveShadow />
      <RoundedBox args={[0.66, 0.24, 0.78]} radius={0.075} smoothness={4} position={[0, 0.38, 0]} material={bodyMat} castShadow receiveShadow />
      <RoundedBox args={[0.56, 0.045, 0.66]} radius={0.018} smoothness={3} position={[0, 0.53, -0.005]} material={frameMat} castShadow receiveShadow />
      <RoundedBox args={[0.7, 0.045, 0.045]} radius={0.018} smoothness={2} position={[0, 0.19, 0.51]} material={hazardMat} />
      <RoundedBox args={[0.7, 0.045, 0.045]} radius={0.018} smoothness={2} position={[0, 0.19, -0.51]} material={hazardMat} />

      {/* Side datum strips and inset service louvers. */}
      {[-1, 1].map((side) => (
        <group key={`side-${side}`}>
          <mesh position={[side * 0.34, 0.39, 0]} material={accentMat}>
            <boxGeometry args={[0.025, 0.12, 0.58]} />
          </mesh>
          {[-0.18, -0.08, 0.02, 0.12].map((ventZ) => (
            <mesh key={ventZ} position={[side * 0.337, 0.45, ventZ]} material={darkMat}>
              <boxGeometry args={[0.012, 0.022, 0.065]} />
            </mesh>
          ))}
        </group>
      ))}

      {/* Front safety scanner window, ranging emitters and bumper sonar. */}
      <RoundedBox args={[0.54, 0.09, 0.028]} radius={0.022} smoothness={3} position={[0, 0.31, 0.402]} material={sensorLensMat} />
      {[-0.2, 0, 0.2].map((sensorX) => (
        <mesh key={sensorX} position={[sensorX, 0.31, 0.422]} material={sensorMat}>
          <sphereGeometry args={[0.025, 12, 10]} />
        </mesh>
      ))}
      <mesh position={[0, 0.285, 0.423]} material={darkMat}>
        <boxGeometry args={[0.42, 0.012, 0.018]} />
      </mesh>

      {/* 2D lidar puck with a slim scan ring; the lens is non-emissive and readable. */}
      <mesh position={[0, 0.604, -0.2]} material={darkMat} castShadow receiveShadow>
        <cylinderGeometry args={[0.145, 0.16, 0.075, 32]} />
      </mesh>
      <mesh position={[0, 0.645, -0.2]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.112, 0.012, 8, 32]} />
        <meshStandardMaterial color={color} roughness={0.28} metalness={0.38} emissive={color} emissiveIntensity={0.18} />
      </mesh>
      <mesh position={[0, 0.65, -0.2]} material={sensorLensMat}>
        <cylinderGeometry args={[0.052, 0.065, 0.025, 20]} />
      </mesh>
      <mesh position={[0, 0.684, -0.2]} material={sensorMat}>
        <sphereGeometry args={[0.024, 12, 10]} />
      </mesh>

      {/* Rear three-state beacon (color remains a semantic state, not decoration). */}
      <mesh position={[0, 0.62, -0.32]} material={darkMat}>
        <cylinderGeometry args={[0.035, 0.035, 0.11, 12]} />
      </mesh>
      <mesh position={[0, 0.70, -0.32]} material={sensorMat}>
        <sphereGeometry args={[0.045, 14, 12]} />
      </mesh>

      {/* The payload appears only when the actual engine timeline is in a loaded phase. */}
      {loaded && (
        <group>
          <mesh position={[0, 0.59, 0.02]} material={palletMat} castShadow receiveShadow>
            <boxGeometry args={[0.5, 0.045, 0.48]} />
          </mesh>
          {[-0.16, 0, 0.16].map((dx) => (
            <mesh key={dx} position={[dx, 0.555, 0.02]} material={palletMat}>
              <boxGeometry args={[0.08, 0.035, 0.46]} />
            </mesh>
          ))}
          <RoundedBox args={[0.34, 0.29, 0.34]} radius={0.018} smoothness={2} position={[0, 0.76, 0.02]} material={crateMat} castShadow receiveShadow />
          <mesh position={[0, 0.765, 0.195]}>
            <boxGeometry args={[0.12, 0.045, 0.008]} />
            <meshStandardMaterial color="#d1c2a1" roughness={0.82} />
          </mesh>
          <mesh position={[0, 0.76, 0.20]} material={hazardMat}>
            <boxGeometry args={[0.025, 0.29, 0.012]} />
          </mesh>
        </group>
      )}

      {selected && (
        <>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.022, 0]}>
            <ringGeometry args={[0.54, 0.59, 48]} />
            <meshBasicMaterial color={color} transparent opacity={0.88} depthWrite={false} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.019, 0]}>
            <circleGeometry args={[0.8, 32]} />
            <meshBasicMaterial color={color} transparent opacity={0.085} blending={THREE.AdditiveBlending} depthWrite={false} />
          </mesh>
        </>
      )}
    </group>
  );
}
