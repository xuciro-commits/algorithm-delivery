/**
 * 受控泛光（Bloom）——唯一允许的后处理，且必须满足四条约束：
 *
 *   1. **只作用于自发光元素**：阈值取得很高（模式 B 0.86 / 模式 C 0.72），普通金属、
 *      石墨与玻璃反射达不到阈值，因此泛光只会出现在算法路径、状态灯、发光标识上，
 *      不会把工业表面糊成一片白；
 *   2. **可以关掉**：`enabled = false` 或强度为 0 时完全绕过 composer（直接 `gl.render`），
 *      与改造前的渲染路径逐像素一致（模式 A 恒为关）；
 *   3. **不引入新依赖**：只用 `three/examples/jsm/postprocessing`（three 自带），
 *      不装 `@react-three/postprocessing`；
 *   4. **接管渲染但仍受 active 控制**：`useFrame(..., 1)` 取代 R3F 的默认渲染，
 *      因此按需渲染（demand）与 `active` 开关的语义不变——不活动时依然 0 GPU 负载。
 *
 * 走的是标准三段式：RenderPass → UnrealBloomPass → OutputPass（后者负责色调映射与
 * sRGB 输出，避免颜色被二次转换）。
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Vector2 } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

export interface ArtBloomProps {
  enabled: boolean;
  strength: number;
  threshold: number;
  radius: number;
}

export function ArtBloom({ enabled, strength, threshold, radius }: ArtBloomProps) {
  const { gl, scene, camera, size } = useThree();
  const bloomRef = useRef<UnrealBloomPass | null>(null);
  const active = enabled && strength > 0.02;

  const composer = useMemo(() => {
    const instance = new EffectComposer(gl);
    instance.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new Vector2(1, 1), strength, radius, threshold);
    bloomRef.current = bloom;
    instance.addPass(bloom);
    instance.addPass(new OutputPass());
    return instance;
    // 只在渲染器/场景/相机实例变化时重建（strength 等参数走下面的 effect 更新）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera]);

  // 尺寸与像素比跟着 Canvas 走（dpr 已被 SandboxScene 限制在 ≤ 2）。
  useEffect(() => {
    const pixelRatio = gl.getPixelRatio();
    composer.setPixelRatio(pixelRatio);
    composer.setSize(size.width, size.height);
  }, [composer, gl, size.width, size.height]);

  useEffect(() => {
    const bloom = bloomRef.current;
    if (!bloom) return;
    bloom.strength = strength;
    bloom.threshold = threshold;
    bloom.radius = radius;
  }, [strength, threshold, radius]);

  useEffect(() => () => composer.dispose(), [composer]);

  // priority > 0 → 接管渲染：不启用泛光时等价于 R3F 的默认渲染路径。
  useFrame((state, delta) => {
    if (active) composer.render(delta);
    else state.gl.render(scene, camera);
  }, 1);

  return null;
}
