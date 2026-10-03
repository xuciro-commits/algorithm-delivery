/**
 * 发光节点：内核光点 + 细线圆环 + 柔和外晕（V2 §三-2）。
 * 用于取货/送达点、事件位置、机器人当前位置——避免传统大号图钉。
 */

import { useMemo } from 'react';
import * as THREE from 'three';

export interface GlowNodeProps {
  x: number;
  z: number;
  y?: number;
  color: string;
  /** 环半径。 */
  radius?: number;
  pulse?: boolean;
  dimmed?: boolean;
}

export function GlowNode({ x, z, y = 0.06, color, radius = 0.34, pulse = false, dimmed = false }: GlowNodeProps) {
  const opacity = dimmed ? 0.35 : 1;
  const mat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity,
        depthWrite: false,
      }),
    [color, opacity],
  );
  const haloMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity: 0.12 * opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [color, opacity],
  );
  const scale = pulse ? 1.18 : 1;

  return (
    <group position={[x, y, z]} scale={scale}>
      {/* 内核光点 */}
      <mesh material={mat}>
        <sphereGeometry args={[0.07, 12, 12]} />
      </mesh>
      {/* 细线圆环（贴地平放） */}
      <mesh material={mat} rotation={[-Math.PI / 2, 0, 0]} position={[0, -y + 0.015, 0]}>
        <ringGeometry args={[radius * 0.82, radius, 28]} />
      </mesh>
      {/* 柔和外晕（加法混合的扁平圆片） */}
      <mesh material={haloMat} rotation={[-Math.PI / 2, 0, 0]} position={[0, -y + 0.013, 0]}>
        <circleGeometry args={[radius * 1.7, 24]} />
      </mesh>
    </group>
  );
}
