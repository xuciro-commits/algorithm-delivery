/**
 * 电影级相机：预设机位之间**补间飞行**，而不是瞬移。
 *
 * 这是"算法展示要高级、丝滑"里最关键的一环：切换机位/算法/实验室时镜头连续推进，
 * 观感是"摄影机在移动"而不是"画面被替换"。
 *
 * 约束：
 *   - 只改写相机的位置与朝向，不产生任何场景几何，也不碰算法数据；
 *   - 补间用多项式缓动（smoothstep），运行在 `useFrame` 内且**零分配**（复用向量）；
 *   - 只在补间进行中排帧（`invalidate`），静止后回到按需渲染；
 *   - 用户一旦拖动轨道控制，补间立即让位，不抢夺交互。
 */

import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Vector3 } from 'three';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ControlsRef = any;

export interface SmoothOrbitProps {
  /** 预设 id：变化即触发一次补间飞行。 */
  preset: string;
  position: [number, number, number];
  target: [number, number, number];
  /** 场景跨度（米）：用于限制距离与 near/far。 */
  span: number;
  /** 补间时长（秒）。 */
  duration?: number;
  /** 是否允许用户拖动（英雄实验台的"内部"机位也允许）。 */
  enabled?: boolean;
  minDistanceFactor?: number;
  maxDistanceFactor?: number;
  /**
   * 跟踪目标（例如当前 AGV 的真实位置）：提供后镜头持续缓动跟随该点，
   * 保持当前观察方向与距离（跟踪镜头）。传 null 表示不跟随。
   */
  follow?: [number, number, number] | null;
}

export function SmoothOrbit({
  preset,
  position,
  target,
  span,
  duration = 0.75,
  enabled = true,
  minDistanceFactor = 0.06,
  maxDistanceFactor = 4,
  follow = null,
}: SmoothOrbitProps) {
  const { camera, invalidate } = useThree();
  const controls = useRef<ControlsRef>(null);
  const from = useRef(new Vector3());
  const fromTarget = useRef(new Vector3());
  const to = useRef(new Vector3());
  const toTarget = useRef(new Vector3());
  const currentTarget = useRef(new Vector3());
  const progress = useRef(1);

  // 目标点用 useMemo 固化，避免数组字面量每次渲染都变导致补间重启。
  const goal = useMemo(() => new Vector3(position[0], position[1], position[2]), [position]);
  const goalTarget = useMemo(() => new Vector3(target[0], target[1], target[2]), [target]);

  useEffect(() => {
    to.current.copy(goal);
    toTarget.current.copy(goalTarget);
    from.current.copy(camera.position);
    const controlsTarget = controls.current?.target as Vector3 | undefined;
    fromTarget.current.copy(controlsTarget ?? currentTarget.current);
    currentTarget.current.copy(controlsTarget ?? currentTarget.current);
    progress.current = 0;
    if ('fov' in camera) {
      camera.near = Math.max(0.05, span * 0.0015);
      camera.far = Math.max(400, span * 40);
      camera.updateProjectionMatrix();
    }
    invalidate();
    // preset 是"要不要飞过去"的触发键，goal 只影响目标位置。
  }, [preset, goal, goalTarget, camera, span, invalidate]);

  useFrame((_, delta) => {
    // 跟踪镜头：目标点缓动追向真实位置（跟随期间必须持续排帧）。
    if (follow) {
      const controlsTarget = controls.current?.target as Vector3 | undefined;
      currentTarget.current.set(follow[0], follow[1], follow[2]);
      if (controlsTarget) {
        controlsTarget.lerp(currentTarget.current, Math.min(1, delta * 3.2));
        controls.current?.update();
      }
      invalidate();
    }
    // 用户拖动时立即结束补间，把手感交回给轨道控制。
    if (controls.current?.__dragging) progress.current = 1;
    if (progress.current >= 1) return;
    progress.current = Math.min(1, progress.current + delta / Math.max(0.15, duration));
    const p = progress.current;
    const eased = p * p * (3 - 2 * p);
    camera.position.lerpVectors(from.current, to.current, eased);
    currentTarget.current.lerpVectors(fromTarget.current, toTarget.current, eased);
    const controlsTarget = controls.current?.target as Vector3 | undefined;
    if (controlsTarget) {
      controlsTarget.copy(currentTarget.current);
      controls.current?.update();
    } else {
      camera.lookAt(currentTarget.current);
    }
    // 补间期间持续排帧；结束后交回按需渲染。
    if (progress.current < 1) invalidate();
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={enabled}
      target={target}
      enableDamping
      dampingFactor={0.075}
      rotateSpeed={0.62}
      zoomSpeed={0.75}
      panSpeed={0.7}
      minDistance={Math.max(1.2, span * minDistanceFactor)}
      maxDistance={span * maxDistanceFactor}
      maxPolarAngle={Math.PI / 2 - 0.04}
    />
  );
}
