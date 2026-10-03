/**
 * Shared Three.js scene shell: local HDR image-based lighting + layered industrial
 * lights, soft real shadows, explicit ACES exposure and demand-driven rendering.
 *
 * 本轮扩展（工业模型艺术化）：
 *   - `lighting="art"` → 使用 ArtLightRig（模式 A/B/C 的完整灯光方案：主光/补光/轮廓光/
 *     工业局部光/接触阴影），并让背景、雾、曝光与色调映射随模式切换；
 *   - `orthographic={false}` + `cameraPosition/fov` → 透视相机（英雄设备近距离观察用）；
 *   - 既有算法沙盘保持默认值，行为与之前完全一致。
 *
 * 性能红线保持不变：`frameloop` 只在 `active` 时连续渲染，否则按需渲染；dpr 上限 2；无后处理。
 */

import { Environment } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Color, PCFSoftShadowMap, ACESFilmicToneMapping, SRGBColorSpace } from 'three';
import { useEffect, useRef, type ReactNode } from 'react';
import { SB } from './theme';
import { ArtLightRig, ArtSceneEnvironment } from '../../art/ArtLightRig';
import { ArtBloom } from './ArtBloom';
import { ART_MODES } from '../../art/modes';
import { useArtStore } from '../../art/settings';
import type { ArtModeId } from '../../art/tokens';

export interface SandboxSceneProps {
  children: ReactNode;
  /** 底板尺寸（格数），用于灯光/雾的量级。 */
  width: number;
  height: number;
  className?: string;
  dpr?: [number, number];
  /**
   * true → playback renders continuously; false → idle scenes render on demand.
   * Robots only invalidate while this flag is true.
   */
  active?: boolean;
  /** 'legacy' = 既有沙盘灯光（默认，保持兼容）；'art' = 艺术化灯光（模式驱动）。 */
  lighting?: 'legacy' | 'art';
  /** 艺术化模式覆盖（默认跟随应用顶栏的全局视觉模式）。 */
  artMode?: ArtModeId;
  /** true（默认）= 正交等距；false = 透视（英雄设备/近距离观察）。 */
  orthographic?: boolean;
  /** 透视相机位置（orthographic=false 时生效）。 */
  cameraPosition?: [number, number, number];
  /** 透视相机视场角。 */
  fov?: number;
  /** 正交相机缩放（orthographic 时生效）。 */
  zoom?: number;
  /** 关闭内建 HDRI（极低端设备或纯色背景展示）。 */
  hdri?: boolean;
}

const warehouseHdri = new URL('../../assets/warehouse-studio.hdr', import.meta.url).href;

export function SandboxScene({
  children,
  width,
  height,
  className,
  dpr = [1, 2],
  active = false,
  lighting = 'legacy',
  artMode,
  orthographic = true,
  cameraPosition = [12, 9, 12],
  fov = 32,
  zoom = 48,
  hdri = true,
}: SandboxSceneProps) {
  const span = Math.max(width, height, 8);
  // 全局视觉模式（应用顶栏的模式簇）：既有沙盘不传 artMode 时跟随全局；
  // 模式 A 保持原有的 legacy 灯光与原始材质——行为与之前完全一致。
  const globalMode = useArtStore((state) => state.mode);
  const bloomEnabled = useArtStore((state) => state.bloomEnabled);
  const bloomStrength = useArtStore((state) => state.bloomStrength);
  const modeId = artMode ?? globalMode;
  const mode = ART_MODES[modeId];
  const artLighting = lighting === 'art' || globalMode !== 'A';
  // 受控泛光：模式配置给出阈值与上限，全局开关与强度倍率由用户控制（0 = 完全关闭）。
  const bloom = {
    enabled: artLighting && bloomEnabled && mode.bloom.strength > 0 && bloomStrength > 0.02,
    strength: mode.bloom.strength * bloomStrength,
    threshold: mode.bloom.threshold,
    radius: mode.bloom.radius,
  };
  return (
    <div
      className={className}
      data-testid="webgl-stage"
      data-renderer="three-webgl"
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <Canvas
        orthographic={orthographic}
        frameloop={active ? 'always' : 'demand'}
        dpr={dpr}
        camera={
          orthographic
            ? { position: [span, span * Math.SQRT2, span], zoom, near: 0.1, far: 10000 }
            : { position: cameraPosition, fov, near: 0.05, far: 10000 }
        }
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        onCreated={({ scene, gl }) => {
          scene.background = new Color(artLighting ? mode.background : SB.bgDeep);
          gl.setClearColor(artLighting ? mode.background : SB.bgDeep, 1);
          gl.shadowMap.enabled = true;
          gl.shadowMap.type = PCFSoftShadowMap;
          gl.toneMapping = ACESFilmicToneMapping;
          gl.toneMappingExposure = artLighting ? mode.exposure : 1.12;
          gl.outputColorSpace = SRGBColorSpace;
          gl.domElement.dataset.webglReady = 'true';
          gl.domElement.dataset.webglVersion = gl.capabilities.isWebGL2 ? '2' : '1';
          gl.domElement.dataset.artLighting = artLighting ? 'art' : 'legacy';
          gl.domElement.dataset.artMode = modeId;
          gl.domElement.dataset.artBloom = bloom.enabled ? 'on' : 'off';
        }}
      >
        {hdri && <Environment files={warehouseHdri} resolution={256} background={false} />}
        {artLighting ? (
          <>
            <ArtSceneEnvironment mode={mode} bbox={{ span }} />
            <ArtLightRig span={span} center={[width / 2, height / 2]} mode={mode} />
          </>
        ) : (
          <SceneRig span={span} width={width} height={height} />
        )}
        {children}
        <ArtBloom enabled={bloom.enabled} strength={bloom.strength} threshold={bloom.threshold} radius={bloom.radius} />
        <SceneHealthProbe />
      </Canvas>
    </div>
  );
}

function SceneRig({ span, width, height }: { span: number; width: number; height: number }) {
  return (
    <>
      <ambientLight intensity={0.72} color="#d8e3ee" />
      <hemisphereLight intensity={0.92} color="#dbeeff" groundColor="#46505a" />
      <directionalLight
        position={[span * 0.72, span * 1.55, span * 0.55]}
        intensity={2.15}
        color="#fff2df"
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-near={0.1}
        shadow-camera-far={span * 4}
        shadow-camera-left={-span * 1.2}
        shadow-camera-right={span * 1.2}
        shadow-camera-top={span * 1.2}
        shadow-camera-bottom={-span * 1.2}
        shadow-bias={-0.00018}
        shadow-normalBias={0.025}
        shadow-radius={4}
      />
      <directionalLight position={[-span * 0.8, span * 0.7, -span * 0.65]} intensity={0.72} color="#aacdff" />
      <pointLight position={[width * 0.5, span * 0.9, height * 0.5]} intensity={Math.min(12, span * 0.34)} distance={span * 2.3} decay={2} color="#d9eaff" />
    </>
  );
}

/**
 * Small real-WebGL health probe consumed by the visual CI task. This does not draw a
 * replacement image: it inspects the live R3F scene, renderer counters and GL context.
 */
function SceneHealthProbe() {
  const { gl, scene, camera, invalidate } = useThree();
  const frames = useRef(0);

  useEffect(() => {
    const canvas = gl.domElement;
    let meshes = 0;
    let triangles = 0;
    scene.traverse((object) => {
      const mesh = object as import('three').Mesh;
      if (mesh.isMesh && mesh.visible) {
        meshes += 1;
        const geometry = mesh.geometry;
        if (geometry.index) triangles += geometry.index.count / 3;
        else if (geometry.attributes.position) triangles += geometry.attributes.position.count / 3;
      }
    });
    const context = gl.getContext();
    const debug = context.getExtension('WEBGL_debug_renderer_info');
    canvas.dataset.webglReady = String(!context.isContextLost());
    canvas.dataset.sceneMeshes = String(meshes);
    canvas.dataset.sceneTriangles = String(Math.round(triangles));
    canvas.dataset.webglRenderer = String(
      debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER),
    );
    canvas.dataset.webglVendor = String(
      debug ? context.getParameter(debug.UNMASKED_VENDOR_WEBGL) : context.getParameter(context.VENDOR),
    );
    invalidate();
  }, [gl, scene, invalidate]);

  useFrame(() => {
    frames.current += 1;
    const canvas = gl.domElement;
    const context = gl.getContext();
    canvas.dataset.webglFrameCount = String(frames.current);
    canvas.dataset.webglDrawCalls = String(gl.info.render.calls);
    canvas.dataset.webglRendered = String(!context.isContextLost() && (gl.info.render.calls > 0 || frames.current > 1));
    canvas.dataset.hdriReady = String(Boolean(scene.environment));
    canvas.dataset.cameraZoom = 'zoom' in camera ? Number(camera.zoom).toFixed(2) : 'perspective';
    canvas.dataset.canvasSize = `${canvas.clientWidth}x${canvas.clientHeight}`;
    // R3F useFrame runs immediately before gl.render(). Keep one follow-up frame in
    // demand mode so the probe can observe the renderer counters from a completed pass.
    if (frames.current < 2) invalidate();
  });

  return null;
}
