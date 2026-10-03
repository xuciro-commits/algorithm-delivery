/**
 * AGV 小车（V2 §五-02 / COMPONENT-DESIGN-V2 §2）：程序化几何，与 MAPF 机器人
 * 共享材质语言（倒角 + 哑光金属 + 发光状态灯）。
 * 位置由调用方按「离散时间步 + frac」提供，本组件不做时间推进。
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
  /** 任务相位（决定状态灯与载货呈现）。 */
  phase?: string;
  loaded?: boolean;
  /** 暂停（动态事件）：车辆静止 + 珊瑚红警示。 */
  paused?: boolean;
  size?: number;
}

export function AgvUnit({ x, z, heading, color, selected = false, phase = 'idle', loaded = false, paused = false, size = 1 }: AgvUnitProps) {
  const s = size;
  const servicing = phase === 'servicing_pickup' || phase === 'servicing_dropoff';
  const lightColor = paused ? SB.coral : servicing ? SB.amber : color;
  const bodyMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: new THREE.Color('#1e2b40'), roughness: 0.5, metalness: 0.62 }),
    [],
  );
  const accentMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: 0.38,
        metalness: 0.3,
        emissive: new THREE.Color(color),
        emissiveIntensity: 0.6,
      }),
    [color],
  );
  const lightMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(lightColor),
        transparent: true,
        opacity: paused ? 0.95 : 0.9,
      }),
    [lightColor, paused],
  );
  const wheelMat = useMemo(() => new THREE.MeshStandardMaterial({ color: new THREE.Color('#0d1524'), roughness: 0.9, metalness: 0.1 }), []);

  return (
    <group position={[x, 0, z]} rotation={[0, -heading, 0]}>
      {/* 车轮舱（四角矮舱，暗示轮组） */}
      {[
        [0.3, 0.34],
        [-0.3, 0.34],
        [0.3, -0.34],
        [-0.3, -0.34],
      ].map(([wx, wz]) => (
        <mesh key={`${wx},${wz}`} position={[wx * s, 0.07 * s, wz * s]} material={wheelMat}>
          <cylinderGeometry args={[0.075 * s, 0.075 * s, 0.1 * s, 10]} />
        </mesh>
      ))}

      {/* 底盘（倒角，深金属） */}
      <RoundedBox args={[0.66 * s, 0.16 * s, 0.8 * s]} radius={0.05 * s} smoothness={3} position={[0, 0.17 * s, 0]} material={bodyMat} />

      {/* 车身（略窄，两侧识别色条） */}
      <RoundedBox args={[0.5 * s, 0.2 * s, 0.66 * s]} radius={0.06 * s} smoothness={3} position={[0, 0.33 * s, 0]} material={bodyMat} />
      <mesh position={[0.26 * s, 0.33 * s, 0]} material={accentMat}>
        <boxGeometry args={[0.03 * s, 0.13 * s, 0.54 * s]} />
      </mesh>
      <mesh position={[-0.26 * s, 0.33 * s, 0]} material={accentMat}>
        <boxGeometry args={[0.03 * s, 0.13 * s, 0.54 * s]} />
      </mesh>

      {/* 载货：托盘 + 货箱（取货后显示） */}
      {loaded && (
        <>
          <mesh position={[0, 0.45 * s, 0]} material={accentMat}>
            <boxGeometry args={[0.4 * s, 0.03 * s, 0.46 * s]} />
          </mesh>
          <mesh position={[0, 0.56 * s, 0]}>
            <boxGeometry args={[0.3 * s, 0.2 * s, 0.34 * s]} />
            <meshStandardMaterial color="#8a6a3c" roughness={0.92} metalness={0.04} />
          </mesh>
        </>
      )}

      {/* 顶部状态灯 / 警示灯 */}
      <mesh position={[0, 0.46 * s, -0.2 * s]} material={lightMat}>
        <sphereGeometry args={[0.05 * s, 10, 10]} />
      </mesh>
      {/* 前向朝向轴 */}
      <mesh position={[0, 0.26 * s, 0.44 * s]} material={lightMat}>
        <boxGeometry args={[0.14 * s, 0.04 * s, 0.03 * s]} />
      </mesh>

      {/* 选中环 */}
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
