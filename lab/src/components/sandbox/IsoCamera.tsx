/**
 * Responsive orthographic camera for square and long-form industrial sand tables.
 * Fit uses both canvas dimensions and the projected board bounds, then recomputes on
 * every ResizeObserver update from React Three Fiber.
 */

import { OrbitControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';

export interface IsoCameraProps {
  /** Legacy maximum extent; retained for callers that only know a single span. */
  span: number;
  /** Actual board bounds improve framing for long / wide scenes. */
  width?: number;
  height?: number;
  view?: 'iso' | 'top';
  /** 编辑模式下锁定旋转，避免与笔刷冲突。 */
  rotatable?: boolean;
}

// True 45° azimuth + 45° elevation for an affine, symmetric isometric projection.
const ISO_DIR = new THREE.Vector3(1, Math.SQRT2, 1).normalize();
const TOP_DIR = new THREE.Vector3(0.001, 1, 0.001).normalize();

/**
 * Fit an orthographic camera against the *projected* isometric diamond, not only the
 * longest grid side. Optional arguments keep the old two-parameter API compatible.
 */
export function fitZoom(
  canvasWidth: number,
  span: number,
  canvasHeight = canvasWidth,
  boardWidth = span,
  boardHeight = span,
  view: 'iso' | 'top' = 'iso',
): number {
  const viewportWidth = Math.max(240, canvasWidth);
  const viewportHeight = Math.max(240, canvasHeight);
  const w = Math.max(1, boardWidth);
  const h = Math.max(1, boardHeight);
  const projectedWidth = view === 'top' ? w + 1.6 : (w + h) * Math.SQRT1_2 + 1.9;
  const projectedHeight = view === 'top' ? h + 1.6 : (w + h) * 0.5 + 3.5;
  const fit = Math.min(viewportWidth / projectedWidth, viewportHeight / projectedHeight) * 0.94;
  return Math.max(3, Math.min(800, fit));
}

export function IsoCamera({ span, width = span, height = span, view = 'iso', rotatable = true }: IsoCameraProps) {
  const { camera, invalidate, size } = useThree();
  const [fit, setFit] = useState(48);
  const center = useMemo(() => new THREE.Vector3(width / 2, 0, height / 2), [width, height]);

  useEffect(() => {
    const zoom = fitZoom(size.width, span, size.height, width, height, view);
    setFit(zoom);
    const distance = Math.max(width, height, span) * 1.7;
    const direction = view === 'top' ? TOP_DIR : ISO_DIR;
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.lookAt(center);
    camera.near = 0.1;
    camera.far = Math.max(500, Math.max(width, height, span) * 8 + 100);
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
    invalidate();
  }, [view, span, width, height, size.width, size.height, camera, center, invalidate]);

  return (
    <OrbitControls
      makeDefault
      target={[center.x, 0, center.z]}
      enableDamping
      dampingFactor={0.12}
      enableRotate={rotatable}
      minZoom={Math.max(2, fit * 0.35)}
      maxZoom={Math.min(2000, fit * 8)}
      minPolarAngle={0.12}
      maxPolarAngle={Math.PI / 2 - 0.04}
    />
  );
}
