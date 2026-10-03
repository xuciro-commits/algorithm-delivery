/**
 * 障碍场：低矮立体结构（倒角盒，石墨/冷灰蓝哑光金属），InstancedMesh 渲染。
 * 次要建筑弱化颜色与对比度，不抢夺发光轨迹的视觉焦点（V2 §二/§四）。
 */

import { Instance, Instances } from '@react-three/drei';
import { useLayoutEffect, useMemo, useRef } from 'react';
import type * as THREE from 'three';
import { SB } from './theme';
import { instanceLimit } from './instanceBudget';
import { useArtStore } from '../../art/settings';

export interface ObstacleFieldProps {
  /** 障碍格坐标（格坐标，0 基）。 */
  cells: Array<[number, number]>;
  /** 障碍高度（世界单位）。 */
  height?: number;
  /** 变体：wall=石墨灰；cold=冷灰蓝（货架/设备底座）。 */
  variant?: 'wall' | 'cold';
}

export function ObstacleField({ cells, height = 0.42, variant = 'wall' }: ObstacleFieldProps) {
  const groupRef = useRef<THREE.Group>(null);
  // 艺术化模式下结构体进入“深石墨 + 冷灰”层次：更暗、更金属，让发光轨迹成为焦点。
  const artMode = useArtStore((state) => state.mode);
  const art = artMode !== 'A';
  const color = art ? (variant === 'cold' ? '#2b3a46' : '#222c35') : variant === 'cold' ? SB.obstacleCold : SB.obstacle;
  const edge = art ? '#39485a' : SB.obstacleEdge;

  // 按连通性粗分组给少量色差，避免完全均质（低成本「体积感」）
  const tinted = useMemo(
    () =>
      cells.map(([x, y], i) => {
        const h = height * (0.82 + (((x * 7 + y * 13 + i) % 5) / 5) * 0.36);
        return { x, y, h };
      }),
    [cells, height],
  );

  useLayoutEffect(() => {
    groupRef.current?.updateMatrixWorld();
  }, [tinted]);

  return (
    <group ref={groupRef}>
      <Instances
        key={`walls-${instanceLimit(tinted.length, 64)}`}
        limit={instanceLimit(tinted.length, 64)}
        range={tinted.length}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[0.94, 1, 0.94]} />
        <meshStandardMaterial color={color} roughness={art ? 0.52 : 0.72} metalness={art ? 0.62 : 0.32} envMapIntensity={art ? 0.9 : 0.72} />
        {tinted.map((c, i) => (
          <Instance
            key={`${c.x},${c.y}`}
            position={[c.x + 0.5, c.h / 2, c.y + 0.5]}
            scale={[1, c.h, 1]}
            color={i % 3 === 0 ? edge : color}
          />
        ))}
      </Instances>
      {/* 接触阴影：底部渐隐暗面（假 AO，无阴影贴图开销） */}
      <Instances
        key={`wall-ao-${instanceLimit(tinted.length, 64)}`}
        limit={instanceLimit(tinted.length, 64)}
        range={tinted.length}
      >
        <planeGeometry args={[1.08, 1.08]} />
        <meshBasicMaterial color="#050a14" transparent opacity={0.5} />
        {tinted.map((c) => (
          <Instance key={`ao-${c.x},${c.y}`} position={[c.x + 0.5, 0.012, c.y + 0.5]} rotation={[-Math.PI / 2, 0, 0]} />
        ))}
      </Instances>
    </group>
  );
}
