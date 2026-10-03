/**
 * 等距相机 + 轨道控制：默认等距视角（方位 45°、俯角 ~35°），
 * 支持切到正交俯视；旋转/缩放/平移全开，按需渲染下由 drei 自动 invalidate。
 */

import { OrbitControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import * as THREE from 'three';

export interface IsoCameraProps {
  /** 场地尺寸（格数），决定相机距离。 */
  span: number;
  /** 视角预设。 */
  view?: 'iso' | 'top';
  /** 是否允许旋转（编辑模式下可锁定为俯视更精准）。 */
  rotatable?: boolean;
}

const ISO_DIR = new THREE.Vector3(0.9, 1.05, 0.9).normalize();
const TOP_DIR = new THREE.Vector3(0.001, 1, 0.001).normalize();

export function IsoCamera({ span, view = 'iso', rotatable = true }: IsoCameraProps) {
  const { camera, invalidate } = useThree();
  const center = new THREE.Vector3(span / 2, 0, span / 2);

  useEffect(() => {
    const dist = span * 1.6;
    const dir = view === 'top' ? TOP_DIR : ISO_DIR;
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    invalidate();
  }, [view, span, camera, center, invalidate]);

  return (
    <OrbitControls
      makeDefault
      target={[center.x, 0, center.z]}
      enableDamping
      dampingFactor={0.12}
      enableRotate={rotatable}
      minZoom={24}
      maxZoom={320}
      minPolarAngle={0.12}
      maxPolarAngle={Math.PI / 2 - 0.04}
    />
  );
}
