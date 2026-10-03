/**
 * 艺术化灯光系统（需求 §四）。
 *
 * 一套灯光，三种模式共用，只切换强度/颜色/阴影档位：
 *   - HDRI 环境照明（仓库 IBL，负责金属与玻璃的反射来源）；
 *   - 有方向性的主光（暖白，唯一投影光源）；
 *   - 柔和补光（冰蓝，压低暗部死黑）；
 *   - 轮廓光（青色，从背面勾出机械轮廓）；
 *   - 工业局部光（高位灯带，少量、按场景尺寸布点）；
 *   - 经过性能控制的阴影 + 柔和接触阴影（沙盘感）。
 *
 * 性能红线（仓库 audit:perf）：
 *   - 不用后处理/泛光，发光完全靠材质自发光 + 细发光线；
 *   - 阴影只有主光投射，局部光一律 castShadow={false}；
 *   - 接触阴影 `frames={1}`（静态采样一次，不每帧重算）。
 */

import { ContactShadows } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useMemo, useEffect } from 'react';
import { ACESFilmicToneMapping, Color, Fog, LinearToneMapping, NeutralToneMapping } from 'three';
import type { ArtModeConfig } from './types';
import type { ArtSettings } from './settings';

export interface ArtLightRigProps {
  /** 场景跨度（用于阴影相机与局部光布点）。 */
  span: number;
  /** 场景中心（默认取原点附近的底板中心）。 */
  center?: [number, number];
  mode: ArtModeConfig;
  settings?: ArtSettings;
}

/** 主光/补光/轮廓光 + 工业局部光。 */
export function ArtLightRig({ span, center = [0, 0], mode, settings }: ArtLightRigProps) {
  const { lights } = mode;
  const [cx, cz] = center;
  const shadowMap = lights.key.mapSize;

  /** 工业灯带：按场景跨度布 3–5 个高位点光（数量受控，避免逐灯衰减开销）。 */
  const locals = useMemo(() => {
    const count = span > 26 ? 5 : span > 14 ? 4 : 3;
    const points: Array<[number, number, number]> = [];
    for (let i = 0; i < count; i += 1) {
      const t = i / (count - 1); // count 恒为 3–5
      points.push([cx + (t - 0.5) * span * 0.82, lights.locals.height * span * 0.62, cz + (i % 2 === 0 ? -1 : 1) * span * 0.18]);
    }
    return points;
  }, [span, cx, cz, lights.locals.height]);

  return (
    <group name="art-light-rig">
      <ambientLight intensity={lights.ambient.intensity} color={lights.ambient.color} />
      <hemisphereLight intensity={lights.hemisphere.intensity} color={lights.hemisphere.sky} groundColor={lights.hemisphere.ground} />

      {/* 主光：唯一投影光源，方向决定整个沙盘的空间感 */}
      <directionalLight
        position={[cx + span * 0.62, span * 1.35, cz + span * 0.48]}
        intensity={lights.key.intensity}
        color={lights.key.color}
        castShadow={lights.key.shadow}
        shadow-mapSize-width={shadowMap}
        shadow-mapSize-height={shadowMap}
        shadow-camera-near={0.1}
        shadow-camera-far={span * 4}
        shadow-camera-left={-span * 1.15}
        shadow-camera-right={span * 1.15}
        shadow-camera-top={span * 1.15}
        shadow-camera-bottom={-span * 1.15}
        shadow-bias={-0.00018}
        shadow-normalBias={0.022}
        shadow-radius={4}
      />

      {/* 补光：冰蓝冷色，从反方向抬暗部 */}
      <directionalLight
        position={[cx - span * 0.75, span * 0.62, cz - span * 0.55]}
        intensity={lights.fill.intensity}
        color={lights.fill.color}
      />

      {/* 轮廓光：几乎沿着视线的反方向，勾出设备边缘（低强度，不洗掉细节） */}
      {lights.rim.intensity > 0 && (
        <directionalLight
          position={[cx - span * 0.35, span * 0.45, cz + span * 0.95]}
          intensity={lights.rim.intensity}
          color={lights.rim.color}
        />
      )}

      {/* 工业局部光：高位灯带，制造局部冷暖渐变；不投影以控制开销 */}
      {lights.locals.intensity > 0 &&
        locals.map((p, i) => (
          <pointLight
            key={`art-local-${i}-${Math.round(p[0])}`}
            position={p}
            intensity={lights.locals.intensity}
            distance={span * lights.locals.distance}
            decay={2}
            color={lights.locals.color}
          />
        ))}

      {settings?.contactShadow !== false && mode.contactShadow > 0 && (
        <ContactShadows
          key={`contact-${mode.id}-${span > 20 ? 'l' : 's'}`}
          position={[cx, 0.012, cz]}
          scale={span * 1.25}
          opacity={mode.contactShadow}
          blur={2.6}
          far={Math.max(1.6, span * 0.12)}
          resolution={512}
          frames={1}
          color="#05080c"
        />
      )}
    </group>
  );
}

/**
 * 场景级环境：背景、雾、曝光与色调映射随模式切换。
 * 使用命令式设置（避免每帧写入），只在模式变化时执行一次并请求重绘。
 */
export function ArtSceneEnvironment({ mode, bbox }: { mode: ArtModeConfig; bbox?: { span: number } }) {
  const { scene, gl, invalidate } = useThree();

  useEffect(() => {
    scene.background = new Color(mode.background);
    gl.setClearColor(new Color(mode.background), 1);

    const span = bbox?.span ?? 24;
    if (mode.fog) {
      const far = Math.max(mode.fog.far, span * 2.6);
      if (scene.fog instanceof Fog) {
        scene.fog.color.set(mode.fog.color);
        scene.fog.near = mode.fog.near;
        scene.fog.far = far;
      } else {
        scene.fog = new Fog(new Color(mode.fog.color), mode.fog.near, far);
      }
    } else {
      scene.fog = null;
    }

    gl.toneMapping = mode.toneMapping === 'neutral' ? NeutralToneMapping : mode.toneMapping === 'linear' ? LinearToneMapping : ACESFilmicToneMapping;
    gl.toneMappingExposure = mode.exposure;
    scene.environmentIntensity = mode.lights.envIntensity;
    invalidate();
  }, [mode, gl, scene, invalidate, bbox?.span]);

  return null;
}
