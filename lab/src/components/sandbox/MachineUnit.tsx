/**
 * APS 加工设备 / 工作站（V2 §五-03 / COMPONENT-DESIGN-V2 §2）：程序化几何，
 * 与 MAPF/AGV 共享材质语言（倒角 + 哑光金属 + 发光状态灯）。
 * 状态只由调用方按「当前在制工序 + 进度」提供，本组件不推断任何排程语义。
 */

import { RoundedBox } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';
import { SB } from './theme';

export interface MachineUnitProps {
  /** 世界坐标（格中心）。 */
  x: number;
  z: number;
  /** 识别色（订单色 / 默认冰蓝）。 */
  color: string;
  /** idle = 空闲（灰蓝状态灯）；working = 在制（识别色状态灯 + 主轴下压）。 */
  state?: 'idle' | 'working';
  /** 在制工序进度 0~1（仅 working 时有意义）。 */
  progress?: number;
  /** 是否有工件在台上。 */
  workpiece?: boolean;
  selected?: boolean;
  /** 是否压暗（选中其他设备时）。 */
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
  const lightColor = working ? color : SB.inactive;
  const spindleY = working ? 0.86 : 1.04;

  const bodyMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: new THREE.Color('#1b2740'), roughness: 0.52, metalness: 0.66 }),
    [],
  );
  const columnMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: new THREE.Color('#22314c'), roughness: 0.46, metalness: 0.7 }),
    [],
  );
  const tableMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: new THREE.Color('#0f1930'), roughness: 0.7, metalness: 0.35 }),
    [],
  );
  const accentMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: 0.34,
        metalness: 0.28,
        emissive: new THREE.Color(color),
        emissiveIntensity: working ? 0.55 : 0.18,
      }),
    [color, working],
  );
  const lightMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(lightColor),
        transparent: true,
        opacity: working ? 0.95 : 0.5,
      }),
    [lightColor, working],
  );
  const frameMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: new THREE.Color('#0b1424'), transparent: true, opacity: 0.85 }),
    [],
  );

  return (
    <group position={[x, 0, z]} rotation={[0, dimmed ? 0 : 0, 0]} scale={dimmed ? 0.985 : 1}>
      {/* 机身（倒角，深金属） */}
      <RoundedBox args={[1.5 * s, 0.42 * s, 1.16 * s]} radius={0.07 * s} smoothness={3} position={[0, 0.21 * s, 0]} material={bodyMat} />

      {/* 立柱 + 主轴箱（加工时下压） */}
      <RoundedBox args={[0.78 * s, 1.0 * s, 0.5 * s]} radius={0.06 * s} smoothness={3} position={[-0.3 * s, 0.7 * s, -0.32 * s]} material={columnMat} />
      <RoundedBox args={[0.44 * s, 0.3 * s, 0.42 * s]} radius={0.05 * s} smoothness={3} position={[-0.3 * s, spindleY * s, 0.04 * s]} material={columnMat} />
      <mesh position={[-0.3 * s, (spindleY - 0.16) * s, 0.04 * s]} material={accentMat}>
        <cylinderGeometry args={[0.045 * s, 0.045 * s, 0.2 * s, 8]} />
      </mesh>

      {/* 工作台 */}
      <RoundedBox args={[1.16 * s, 0.1 * s, 0.72 * s]} radius={0.03 * s} smoothness={2} position={[0.06 * s, 0.46 * s, 0.3 * s]} material={tableMat} />

      {/* 工件（在制时上台） */}
      {workpiece && (
        <RoundedBox args={[0.42 * s, 0.3 * s, 0.42 * s]} radius={0.05 * s} smoothness={3} position={[0.06 * s, 0.66 * s, 0.3 * s]} material={accentMat} />
      )}

      {/* 状态灯（顶） */}
      <mesh position={[-0.3 * s, 1.22 * s, -0.32 * s]} material={lightMat}>
        <boxGeometry args={[0.16 * s, 0.06 * s, 0.16 * s]} />
      </mesh>

      {/* 进度条（机身正面） */}
      <group position={[0.34 * s, 0.28 * s, 0.585 * s]} rotation={[0, 0, 0]}>
        <mesh material={frameMat}>
          <boxGeometry args={[0.62 * s, 0.07 * s, 0.012 * s]} />
        </mesh>
        <mesh position={[(p - 0.5) * 0.6 * s, 0, 0.006 * s]} material={accentMat}>
          <boxGeometry args={[Math.max(0.001, 0.6 * s * p), 0.055 * s, 0.008 * s]} />
        </mesh>
      </group>

      {/* 选中描边（薄发光环） */}
      {selected && (
        <mesh position={[0, 0.012 * s, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.95 * s, 1.02 * s, 40]} />
          <meshBasicMaterial color={new THREE.Color(SB.ice)} transparent opacity={0.85} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}
