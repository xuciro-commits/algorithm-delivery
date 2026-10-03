/**
 * 科技地面（需求 §五）：精细网格 + 区域标识 + 合理反射。
 *
 * 单张平面 + 单材质（不是逐格 mesh，避免大场景掉帧），网格与区域框在材质着色器里
 * 用世界坐标 SDF 绘制：近处清晰、远处随距离衰减并与雾/背景融合，形成“沙盘”感。
 * 反射由 MeshStandardMaterial + 环境贴图提供（金属度/粗糙度来自模式配置）。
 */

import { useMemo } from 'react';
import { Color, DoubleSide, MeshStandardMaterial } from 'three';
import type { GroundConfig } from './modes';

export interface TechDeckProps {
  /** 地面覆盖尺寸（米）。 */
  size: number;
  /** 网格单元（米）。 */
  cell: number;
  config: GroundConfig;
  /** 中心区域框半尺寸（米），用于产线/仓库的作业区标识。 */
  zone?: { halfX: number; halfZ: number };
  y?: number;
}

interface DeckUniforms {
  uLine: { value: Color };
  uGrid: { value: number };
  uMajor: { value: number };
  uZone: { value: number };
  uFadeInner: { value: number };
  uFadeOuter: { value: number };
  uZoneHalf: { value: { x: number; y: number } };
}

export function TechDeck({ size, cell, config, zone, y = 0 }: TechDeckProps) {
  const material = useMemo(() => {
    const deck = new MeshStandardMaterial({
      color: new Color(config.tint),
      roughness: config.roughness,
      metalness: config.metalness,
      envMapIntensity: 0.9,
      side: DoubleSide,
      dithering: true,
    });
    const uniforms: DeckUniforms = {
      uLine: { value: new Color(config.lineColor) },
      uGrid: { value: config.gridIntensity },
      uMajor: { value: config.majorEvery },
      uZone: { value: config.zoneIntensity },
      uFadeInner: { value: (zone ? Math.max(zone.halfX, zone.halfZ) : size * 0.35) * 2.2 },
      uFadeOuter: { value: size * 0.62 },
      uZoneHalf: { value: { x: zone?.halfX ?? size * 0.3, y: zone?.halfZ ?? size * 0.3 } },
    };
    deck.userData.deckUniforms = uniforms;
    deck.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vDeckWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvDeckWorld = (modelMatrix * vec4(position, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vDeckWorld;
uniform vec3 uLine;
uniform float uGrid;
uniform float uMajor;
uniform float uZone;
uniform float uFadeInner;
uniform float uFadeOuter;
uniform vec2 uZoneHalf;
// 世界坐标网格：恒定世界宽度 → 近处清晰、远处自然融合
float vpGrid(vec2 p, float size, float width) {
  vec2 c = abs(fract(p / size - 0.5) - 0.5) * size;
  float d = min(c.x, c.y);
  return 1.0 - smoothstep(0.0, width, d);
}
float vpBox(vec2 p, vec2 half_, float width) {
  vec2 d = abs(p) - half_;
  float sdf = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  return 1.0 - smoothstep(0.0, width, abs(sdf));
}`,
        )
        .replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>
{
  vec2 vpP = vDeckWorld.xz;
  float vpCell = ${cell.toFixed(4)};
  float vpMinor = vpGrid(vpP, vpCell, vpCell * 0.035 + 0.006);
  float vpMajorLine = vpGrid(vpP, vpCell * uMajor, vpCell * uMajor * 0.012 + 0.008);
  float vpZoneLine = vpBox(vpP, uZoneHalf, 0.05);
  float vpRadius = length(vpP);
  float vpFade = 1.0 - smoothstep(uFadeInner, uFadeOuter, vpRadius);
  float vpGlow = (vpMinor * 0.55 + vpMajorLine) * uGrid + vpZoneLine * uZone;
  gl_FragColor.rgb += uLine * vpGlow * vpFade;
  gl_FragColor.a = mix(0.35, gl_FragColor.a, vpFade);
}`,
        );
    };
    deck.customProgramCacheKey = () => `vp-deck:${cell.toFixed(3)}:${config.gridIntensity}:${config.zoneIntensity}`;
    return deck;
  }, [config, cell, zone, size]);

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, y, 0]}
      receiveShadow
      name="tech-deck"
    >
      <planeGeometry args={[size, size, 1, 1]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}
