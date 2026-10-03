/**
 * 机器人单元（MAPF）与 AGV 小车的程序化模型基础。
 * 精致倒角几何体 + 发光状态灯 + 选中环；哑光金属材质（V2 §二-2）。
 * 位置由调用方按「离散时间步插值」提供（stepInterp），本组件不做时间推进。
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
  /** 状态：run=执行中（灯常亮）；service=服务中（琥珀脉冲）；idle=待机（暗）。 */
  status?: 'run' | 'service' | 'idle';
  /** 载货（AGV）：显示托盘+货箱。 */
  loaded?: boolean;
  size?: number;
}

export function RobotUnit({ x, z, heading, color, selected = false, status = 'run', loaded = false, size = 1 }: RobotUnitProps) {
  const s = size;
  const lightColor = status === 'service' ? SB.amber : color;
  const lightIntensity = status === 'idle' ? 0.45 : 1;
  const bodyMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#232f45'),
        roughness: 0.55,
        metalness: 0.6,
      }),
    [],
  );
  const accentMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: 0.4,
        metalness: 0.3,
        emissive: new THREE.Color(color),
        emissiveIntensity: 0.55 * lightIntensity,
      }),
    [color, lightIntensity],
  );
  const lightMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(lightColor),
        transparent: true,
        opacity: 0.95 * lightIntensity,
      }),
    [lightColor, lightIntensity],
  );

  return (
    <group position={[x, 0, z]} rotation={[0, -heading, 0]}>
      {/* 底盘（倒角，深金属） */}
      <RoundedBox args={[0.72 * s, 0.22 * s, 0.82 * s]} radius={0.06 * s} smoothness={3} position={[0, 0.16 * s, 0]} material={bodyMat} />
      {/* 车身（略窄，配色 Accent 侧条） */}
      <RoundedBox args={[0.54 * s, 0.26 * s, 0.62 * s]} radius={0.07 * s} smoothness={3} position={[0, 0.36 * s, 0]} material={bodyMat} />
      {/* 两侧识别色条（发光） */}
      <mesh position={[0.28 * s, 0.36 * s, 0]} material={accentMat}>
        <boxGeometry args={[0.035 * s, 0.18 * s, 0.5 * s]} />
      </mesh>
      <mesh position={[-0.28 * s, 0.36 * s, 0]} material={accentMat}>
        <boxGeometry args={[0.035 * s, 0.18 * s, 0.5 * s]} />
      </mesh>
      {/* 前向指示（朝向轴小灯） */}
      <mesh position={[0, 0.3 * s, 0.43 * s]} material={lightMat}>
        <boxGeometry args={[0.16 * s, 0.05 * s, 0.03 * s]} />
      </mesh>
      {/* 顶部状态灯 */}
      <mesh position={[0, 0.52 * s, 0]} material={lightMat}>
        <sphereGeometry args={[0.055 * s, 10, 10]} />
      </mesh>
      {/* 载货：托盘 + 货箱（AGV 取送段） */}
      {loaded && (
        <>
          <mesh position={[0, 0.52 * s, 0]} material={accentMat}>
            <boxGeometry args={[0.4 * s, 0.04 * s, 0.44 * s]} />
          </mesh>
          <mesh position={[0, 0.64 * s, 0]}>
            <boxGeometry args={[0.3 * s, 0.2 * s, 0.32 * s]} />
            <meshStandardMaterial color="#8a6a3c" roughness={0.9} metalness={0.05} />
          </mesh>
        </>
      )}
      {/* 选中环（贴地细环 + 外晕） */}
      {selected && (
        <>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
            <ringGeometry args={[0.5 * s, 0.56 * s, 32]} />
            <meshBasicMaterial color={color} transparent opacity={0.9} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.018, 0]}>
            <circleGeometry args={[0.78 * s, 24]} />
            <meshBasicMaterial color={color} transparent opacity={0.1} blending={THREE.AdditiveBlending} depthWrite={false} />
          </mesh>
        </>
      )}
    </group>
  );
}
