/**
 * 等距相机 + 轨道控制：默认等距视角（方位 45°、俯角 ~35°），
 * 支持平滑切到正交俯视；旋转/缩放/平移全开，按需渲染下由 drei 自动 invalidate。
 *
 * 正交相机的可视世界宽度 = 画布像素宽 / zoom（three.js makeOrthographic 语义，
 * R3F 把 left/right/top/bottom 设为 ±size/2）。因此这里按「场地跨度 + 画布宽度」
 * 计算适配 zoom，保证 8×8 到 32×32 的沙盘都能完整落进取景框。
 */

import { OrbitControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

export interface IsoCameraProps {
  /** 场地尺寸（格数），决定相机距离与适配缩放。 */
  span: number;
  /** 视角预设。 */
  view?: 'iso' | 'top';
  /** 是否允许旋转（编辑模式下可锁定为俯视更精准）。 */
  rotatable?: boolean;
}

const ISO_DIR = new THREE.Vector3(0.9, 1.05, 0.9).normalize();
const TOP_DIR = new THREE.Vector3(0.001, 1, 0.001).normalize();

/** 适配 zoom：留 28% 边距给轨迹悬浮与节点。 */
export function fitZoom(canvasWidth: number, span: number): number {
  const w = Math.max(320, canvasWidth);
  return Math.max(4, Math.min(800, w / Math.max(4, span * 1.28)));
}

export function IsoCamera({ span, view = 'iso', rotatable = true }: IsoCameraProps) {
  const { camera, invalidate, size } = useThree();
  const center = useMemo(() => new THREE.Vector3(span / 2, 0, span / 2), [span]);
  const fitRef = useRef(60);

  useEffect(() => {
    const zoom = fitZoom(size.width, span);
    fitRef.current = zoom;
    const dist = span * 1.6;
    const dir = view === 'top' ? TOP_DIR : ISO_DIR;
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.lookAt(center);
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
    invalidate();
  }, [view, span, size.width, size.height, camera, center, invalidate]);

  return (
    <OrbitControls
      makeDefault
      target={[center.x, 0, center.z]}
      enableDamping
      dampingFactor={0.12}
      enableRotate={rotatable}
      minZoom={Math.max(2, fitRef.current * 0.35)}
      maxZoom={Math.min(2000, fitRef.current * 8)}
      minPolarAngle={0.12}
      maxPolarAngle={Math.PI / 2 - 0.04}
    />
  );
}
