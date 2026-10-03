/**
 * 沙盘场景壳：按需渲染（frameloop="demand"）+ 柔和环境光/轮廓光 + 深海军蓝雾。
 * 空间场景是视觉主体；所有子原语共享这里的灯光与雾设定。
 */

import { Canvas } from '@react-three/fiber';
import { Color } from 'three';
import type { ReactNode } from 'react';
import { SB } from './theme';

export interface SandboxSceneProps {
  children: ReactNode;
  /** 底板尺寸（格数），用于灯光/雾的量级。 */
  width: number;
  height: number;
  className?: string;
  dpr?: [number, number];
  /**
   * 是否处于「活动」状态（回放播放中 / 动画进行中）：
   *   true  → frameloop="always"（只在播放时持续渲染）
   *   false → frameloop="demand"（静止 0 GPU 负载，状态变化才画一帧）
   */
  active?: boolean;
}

export function SandboxScene({ children, width, height, className, dpr = [1, 2], active = false }: SandboxSceneProps) {
  const span = Math.max(width, height, 8);
  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Canvas
        orthographic
        frameloop={active ? 'always' : 'demand'}
        dpr={dpr}
        camera={{ position: [span * 0.9, span * 1.05, span * 0.9], zoom: 58, near: -100, far: 400 }}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        onCreated={({ scene, gl }) => {
          scene.background = new Color(SB.bgDeep);
          gl.setClearColor(SB.bgDeep, 1);
        }}
      >
        <SceneRig span={span} />
        {children}
      </Canvas>
    </div>
  );
}

function SceneRig({ span }: { span: number }) {
  return (
    <>
      <ambientLight intensity={0.55} color="#cfe0f4" />
      <directionalLight position={[span * 0.7, span * 1.4, span * 0.5]} intensity={0.9} color="#eaf3ff" />
      <directionalLight position={[-span * 0.8, span * 0.6, -span * 0.6]} intensity={0.35} color="#7fa8d8" />
      <hemisphereLight intensity={0.25} color="#31435e" groundColor="#0a1220" />
    </>
  );
}
