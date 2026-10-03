/**
 * CNC / automated machining cell for the APS line. The stylized enclosure is built
 * from differentiated PBR parts (painted cast shell, machined feet, glazed guard,
 * spindle, worktable, vents and operator panel) rather than generic cubes. Only the
 * active workpiece, status tower and progress strip consume schedule-derived props.
 */

import { RoundedBox } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';
import { SB } from './theme';

export interface MachineUnitProps {
  x: number;
  z: number;
  color: string;
  state?: 'idle' | 'working';
  progress?: number;
  workpiece?: boolean;
  selected?: boolean;
  dimmed?: boolean;
  size?: number;
}

export function MachineUnit({
  x,
  z,
  color,
  state = 'idle',
  progress = 0,
  workpiece = false,
  selected = false,
  dimmed = false,
  size = 1,
}: MachineUnitProps) {
  const s = size;
  const working = state === 'working';
  const p = Math.max(0, Math.min(1, progress));
  const lightColor = working ? color : '#8aa0b2';
  const spindleY = working ? 0.87 : 1.03;

  const shellMat = useMemo(
    () => new THREE.MeshPhysicalMaterial({ color: '#52616b', roughness: 0.4, metalness: 0.66, clearcoat: 0.3, clearcoatRoughness: 0.42, envMapIntensity: 1.08 }),
    [],
  );
  const panelMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#34434d', roughness: 0.5, metalness: 0.58, envMapIntensity: 0.92 }),
    [],
  );
  const machinedMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#9aa7aa', roughness: 0.3, metalness: 0.82, envMapIntensity: 1.18 }),
    [],
  );
  const darkMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#172229', roughness: 0.58, metalness: 0.48, envMapIntensity: 0.66 }),
    [],
  );
  const glassMat = useMemo(
    () => new THREE.MeshPhysicalMaterial({ color: '#2c5262', roughness: 0.2, metalness: 0.16, transmission: 0.16, clearcoat: 1, clearcoatRoughness: 0.16, envMapIntensity: 1.2 }),
    [],
  );
  const accentMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color, roughness: 0.34, metalness: 0.38, emissive: color, emissiveIntensity: working ? 0.26 : 0.09, envMapIntensity: 0.9 }),
    [color, working],
  );
  const warningMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#c48a3e', roughness: 0.47, metalness: 0.38, envMapIntensity: 0.82 }),
    [],
  );
  const lightMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: lightColor, transparent: true, opacity: working ? 0.98 : 0.7 }),
    [lightColor, working],
  );
  const displayMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#183842', roughness: 0.22, metalness: 0.12, emissive: '#0d3945', emissiveIntensity: 0.34 }),
    [],
  );

  return (
    <group position={[x, 0, z]} scale={dimmed ? s * 0.99 : s}>
      {/* Isolated machine feet and the heavy, machined lower plinth. */}
      {[-0.68, 0.68].flatMap((fx) => [-0.54, 0.54].map((fz) => (
        <group key={`${fx}-${fz}`} position={[fx * s, 0, fz * s]}>
          <mesh position={[0, 0.045 * s, 0]} material={darkMat} castShadow receiveShadow>
            <boxGeometry args={[0.22 * s, 0.09 * s, 0.23 * s]} />
          </mesh>
          <mesh position={[0, 0.091 * s, 0]} material={machinedMat}>
            <cylinderGeometry args={[0.045 * s, 0.045 * s, 0.018 * s, 12]} />
          </mesh>
        </group>
      )))}
      <RoundedBox args={[1.72 * s, 0.28 * s, 1.42 * s]} radius={0.055 * s} smoothness={3} position={[0, 0.16 * s, 0]} material={panelMat} castShadow receiveShadow />
      <RoundedBox args={[1.58 * s, 0.88 * s, 1.28 * s]} radius={0.065 * s} smoothness={4} position={[0, 0.72 * s, 0]} material={shellMat} castShadow receiveShadow />
      <RoundedBox args={[1.66 * s, 0.15 * s, 1.36 * s]} radius={0.045 * s} smoothness={3} position={[0, 1.22 * s, 0]} material={machinedMat} castShadow receiveShadow />
      <mesh position={[0, 1.305 * s, 0]} material={warningMat}>
        <boxGeometry args={[1.22 * s, 0.025 * s, 1.02 * s]} />
      </mesh>

      {/* Guarded machining window: dark cavity, brushed rails and glazed safety door. */}
      <RoundedBox args={[0.92 * s, 0.73 * s, 0.045 * s]} radius={0.032 * s} smoothness={3} position={[-0.22 * s, 0.94 * s, 0.656 * s]} material={darkMat} />
      <RoundedBox args={[0.8 * s, 0.58 * s, 0.026 * s]} radius={0.022 * s} smoothness={3} position={[-0.22 * s, 0.96 * s, 0.685 * s]} material={glassMat} />
      <mesh position={[-0.22 * s, 0.96 * s, 0.702 * s]} material={accentMat}>
        <boxGeometry args={[0.68 * s, 0.018 * s, 0.008 * s]} />
      </mesh>
      <mesh position={[-0.65 * s, 0.95 * s, 0.708 * s]} material={machinedMat}>
        <boxGeometry args={[0.035 * s, 0.79 * s, 0.055 * s]} />
      </mesh>
      <mesh position={[0.2 * s, 0.95 * s, 0.708 * s]} material={machinedMat}>
        <boxGeometry args={[0.035 * s, 0.79 * s, 0.055 * s]} />
      </mesh>
      <mesh position={[-0.22 * s, 0.55 * s, 0.712 * s]} material={warningMat}>
        <boxGeometry args={[0.88 * s, 0.025 * s, 0.052 * s]} />
      </mesh>

      {/* X/Z worktable, guide ways and schedule-backed in-process part. */}
      <RoundedBox args={[0.96 * s, 0.09 * s, 0.6 * s]} radius={0.025 * s} smoothness={2} position={[-0.1 * s, 0.57 * s, 0.28 * s]} material={machinedMat} castShadow receiveShadow />
      {[-0.31, 0.31].map((dx) => (
        <mesh key={dx} position={[-0.1 * s + dx * s, 0.64 * s, 0.28 * s]} material={panelMat}>
          <boxGeometry args={[0.045 * s, 0.05 * s, 0.55 * s]} />
        </mesh>
      ))}
      {workpiece && (
        <RoundedBox args={[0.36 * s, 0.25 * s, 0.34 * s]} radius={0.035 * s} smoothness={3} position={[-0.1 * s, 0.75 * s, 0.27 * s]} material={accentMat} castShadow receiveShadow />
      )}

      {/* Spindle head / tool holder: only its schedule state changes. */}
      <RoundedBox args={[0.46 * s, 0.32 * s, 0.44 * s]} radius={0.045 * s} smoothness={3} position={[-0.28 * s, spindleY * s, 0.1 * s]} material={panelMat} castShadow receiveShadow />
      <mesh position={[-0.28 * s, (spindleY - 0.18) * s, 0.1 * s]} material={machinedMat}>
        <cylinderGeometry args={[0.07 * s, 0.052 * s, 0.2 * s, 16]} />
      </mesh>
      <mesh position={[-0.28 * s, (spindleY - 0.3) * s, 0.1 * s]} material={darkMat}>
        <cylinderGeometry args={[0.026 * s, 0.026 * s, 0.08 * s, 12]} />
      </mesh>

      {/* Operator terminal with glass display, tactile controls and progress strip. */}
      <RoundedBox args={[0.47 * s, 0.44 * s, 0.1 * s]} radius={0.045 * s} smoothness={3} position={[0.54 * s, 0.91 * s, 0.67 * s]} material={panelMat} castShadow />
      <RoundedBox args={[0.34 * s, 0.24 * s, 0.025 * s]} radius={0.022 * s} smoothness={3} position={[0.54 * s, 1.0 * s, 0.731 * s]} material={darkMat} />
      <mesh position={[0.54 * s, 1.0 * s, 0.748 * s]} material={displayMat}>
        <planeGeometry args={[0.29 * s, 0.18 * s]} />
      </mesh>
      <mesh position={[0.54 * s, 0.87 * s, 0.75 * s]} material={accentMat}>
        <boxGeometry args={[0.25 * s, 0.012 * s, 0.009 * s]} />
      </mesh>
      {[-0.15, 0, 0.15].map((dx, i) => (
        <mesh key={dx} position={[0.54 * s + dx * s, 0.72 * s, 0.725 * s]} material={i === 1 ? warningMat : lightMat}>
          <cylinderGeometry args={[0.035 * s, 0.035 * s, 0.032 * s, 12]} />
        </mesh>
      ))}
      <group position={[0.34 * s, 0.31 * s, 0.716 * s]}>
        <mesh material={darkMat}>
          <boxGeometry args={[0.56 * s, 0.075 * s, 0.03 * s]} />
        </mesh>
        <mesh position={[(p - 0.5) * 0.53 * s, 0, 0.018 * s]} material={accentMat}>
          <boxGeometry args={[Math.max(0.001, 0.53 * s * p), 0.046 * s, 0.012 * s]} />
        </mesh>
      </group>

      {/* Side ventilation louvers and conduit-style service strips. */}
      {[-1, 1].map((side) => (
        <group key={`vent-${side}`}>
          {[-0.18, -0.08, 0.02, 0.12, 0.22].map((dy) => (
            <mesh key={dy} position={[side * 0.794 * s, 0.71 * s + dy * s, -0.12 * s]} material={darkMat}>
              <boxGeometry args={[0.018 * s, 0.035 * s, 0.55 * s]} />
            </mesh>
          ))}
          <mesh position={[side * 0.81 * s, 0.9 * s, -0.47 * s]} material={warningMat}>
            <boxGeometry args={[0.026 * s, 0.28 * s, 0.08 * s]} />
          </mesh>
        </group>
      ))}

      {/* Three-segment status tower, tied only to real active/idle state. */}
      <mesh position={[0.62 * s, 1.47 * s, -0.42 * s]} material={darkMat}>
        <cylinderGeometry args={[0.035 * s, 0.04 * s, 0.21 * s, 12]} />
      </mesh>
      <mesh position={[0.62 * s, 1.59 * s, -0.42 * s]} material={lightMat}>
        <sphereGeometry args={[0.055 * s, 14, 12]} />
      </mesh>
      <mesh position={[0.62 * s, 1.51 * s, -0.42 * s]} material={warningMat}>
        <sphereGeometry args={[0.04 * s, 12, 10]} />
      </mesh>

      {selected && (
        <mesh position={[0, 0.018 * s, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.96 * s, 1.04 * s, 48]} />
          <meshBasicMaterial color={new THREE.Color(SB.ice)} transparent opacity={0.82} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}
