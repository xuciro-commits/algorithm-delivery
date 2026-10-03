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

// 3D 透视推荐方向：方位角 45°，俯仰角 ~41°（y=1.25），视野自然开阔，无广角畸变
const ISO_DIR = new THREE.Vector3(1, 1.25, 1).normalize();
const TOP_DIR = new THREE.Vector3(0.0001, 1, 0.0001).normalize();

/**
 * 计算透视相机在指定视野（FOV）下刚好框选整个沙盘（含边框与外扩裙边）的最优距离。
 * 根据画布宽高比（aspect）自适应，确保横向与纵向均有安全留白，消除倒梯形错觉。
 */
export function fitPerspectiveDistance(
  canvasWidth: number,
  canvasHeight: number,
  boardWidth: number,
  boardHeight: number,
  view: 'iso' | 'top' = 'iso',
  fov = 38,
): number {
  const aspect = Math.max(0.1, canvasWidth / Math.max(1, canvasHeight));
  const fovRad = (fov * Math.PI) / 180;
  const tanV = Math.tan(fovRad / 2);
  const tanH = tanV * aspect;

  if (view === 'top') {
    // 俯视：直接由画幅宽高比推算刚好框住底板（外加 2.8 格裙边安全裕量）
    const halfW = boardWidth / 2 + 2.8;
    const halfH = boardHeight / 2 + 2.8;
    const distH = halfW / tanH;
    const distV = halfH / tanV;
    return Math.max(distH, distV) * 1.05;
  }

  // 3D 视角：计算包含底板与周边设备/厂房立柱的三维外接球半径
  const halfW = boardWidth / 2 + 3.0;
  const halfH = boardHeight / 2 + 3.0;
  const radius = Math.sqrt(halfW * halfW + halfH * halfH + 3.6 * 3.6);
  const minTan = Math.min(tanV, tanH);
  return (radius / minTan) * 1.15;
}

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
  const { camera, invalidate, size, gl } = useThree();
  const [fit, setFit] = useState(48);
  const [distState, setDistState] = useState(60);
  const center = useMemo(() => new THREE.Vector3(width / 2, 0, height / 2), [width, height]);
  const [spacePressed, setSpacePressed] = useState(false);
  const [shiftPressed, setShiftPressed] = useState(false);

  // 屏蔽画布上的原生右键菜单，让右键拖动平移顺畅可用
  useEffect(() => {
    const dom = gl?.domElement;
    if (!dom) return;
    const prevent = (e: MouseEvent) => e.preventDefault();
    dom.addEventListener('contextmenu', prevent);
    return () => dom.removeEventListener('contextmenu', prevent);
  }, [gl]);

  // 空格键 / Shift 键平移修饰：按住时切到平移模式（与 2D 地图及主流 3D 软件体验一致）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) setSpacePressed(true);
      if ((e.key === 'Shift' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat) setShiftPressed(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpacePressed(false);
      if (e.key === 'Shift' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') setShiftPressed(false);
    };
    const onBlur = () => {
      setSpacePressed(false);
      setShiftPressed(false);
    };
    globalThis.addEventListener?.('keydown', onKeyDown);
    globalThis.addEventListener?.('keyup', onKeyUp);
    globalThis.addEventListener?.('blur', onBlur);
    return () => {
      globalThis.removeEventListener?.('keydown', onKeyDown);
      globalThis.removeEventListener?.('keyup', onKeyUp);
      globalThis.removeEventListener?.('blur', onBlur);
    };
  }, []);

  const isPerspective = Boolean((camera as THREE.PerspectiveCamera).isPerspectiveCamera);

  useEffect(() => {
    const direction = view === 'top' ? TOP_DIR : ISO_DIR;

    if (isPerspective) {
      const pCam = camera as THREE.PerspectiveCamera;
      const fov = pCam.fov || 38;
      const dist = fitPerspectiveDistance(size.width, size.height, width, height, view, fov);
      setDistState(dist);
      pCam.position.copy(center).addScaledVector(direction, dist);
      pCam.lookAt(center);
      pCam.near = Math.max(0.1, dist * 0.01);
      pCam.far = Math.max(2500, dist * 15);
      pCam.zoom = 1;
      pCam.updateProjectionMatrix();
    } else {
      const zoom = fitZoom(size.width, span, size.height, width, height, view);
      setFit(zoom);
      const distance = Math.max(width, height, span) * 1.7;
      setDistState(distance);
      camera.position.copy(center).addScaledVector(direction, distance);
      camera.lookAt(center);
      camera.near = 0.1;
      camera.far = Math.max(500, Math.max(width, height, span) * 8 + 100);
      camera.zoom = zoom;
      camera.updateProjectionMatrix();
    }
    invalidate();
  }, [isPerspective, view, span, width, height, size.width, size.height, camera, center, invalidate]);

  const canRotate = rotatable && view !== 'top' && !spacePressed && !shiftPressed;
  const leftAction = canRotate
    ? THREE.MOUSE.ROTATE
    : rotatable
      ? THREE.MOUSE.PAN
      : THREE.MOUSE.ROTATE;

  return (
    <OrbitControls
      makeDefault
      target={[center.x, 0, center.z]}
      enableDamping
      dampingFactor={0.12}
      enableRotate={canRotate}
      enablePan={true}
      screenSpacePanning={true}
      mouseButtons={{
        LEFT: leftAction,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.PAN,
      }}
      minDistance={isPerspective ? Math.max(2, distState * 0.12) : undefined}
      maxDistance={isPerspective ? Math.max(120, distState * 4.5) : undefined}
      minZoom={!isPerspective ? Math.max(2, fit * 0.35) : undefined}
      maxZoom={!isPerspective ? Math.min(2000, fit * 8) : undefined}
      minPolarAngle={0.05}
      maxPolarAngle={Math.PI / 2 - 0.04}
    />
  );
}
