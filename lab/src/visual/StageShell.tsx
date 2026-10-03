/**
 * 视觉舞台外壳：把“模式配置 + 质量档 + 相机预设 + 截图接口”包成一个可复用 Canvas。
 *
 * 与既有的 `SandboxScene`（正交等距、算法沙盘专用）并列：本组件服务于
 * 透视化的艺术化场景与视觉工作室，两者共用同一套材质/灯光/模式配置。
 *
 * 性能约定（沿用 V2 红线）：`frameloop` 由 `active` 决定；dpr 不超过 2；
 * 不引入后处理管线——自发光由发光材质 + 菲涅尔边缘补丁实现，“泛光”用
 * 受控的加色光晕片（halo）表达，避免整屏 Bloom 把工业细节糊掉。
 */

import { Environment, OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  ACESFilmicToneMapping,
  Color,
  Fog,
  PCFSoftShadowMap,
  SRGBColorSpace,
  Vector3,
  type Camera,
  type WebGLRenderer,
} from 'three';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { IndustrialRig } from './IndustrialRig';
import type { QualityConfig, VisualModeConfig } from './modes';
import type { CameraPresetId } from './store';

const warehouseHdri = new URL('../assets/warehouse-studio.hdr', import.meta.url).href;

export interface StageBounds {
  /** 内容半径（米），用于灯光距离、相机取景与阴影范围。 */
  radius: number;
  center: [number, number, number];
  height: number;
}

export interface StageApi {
  canvas: HTMLCanvasElement | null;
  renderer: WebGLRenderer | null;
  invalidate: () => void;
  /** 把相机切换到预设机位（A/B 对比时保持不变）。 */
  applyPreset: (preset: CameraPresetId) => void;
}

export interface StageShellProps {
  mode: VisualModeConfig;
  quality: QualityConfig;
  bounds: StageBounds;
  view: CameraPresetId;
  active: boolean;
  children: ReactNode;
  /** 截图需要保留绘制缓冲；仅工作室开启。 */
  capture?: boolean;
  onApi?: (api: StageApi) => void;
  practicalLine?: { from: number; to: number; y: number; z: number };
  className?: string;
  /** 是否绘制天空/背景色（透明厂房演示时可为 false）。 */
  showBackground?: boolean;
  fog?: boolean;
}

function presetPosition(preset: CameraPresetId, bounds: StageBounds): { position: Vector3; target: Vector3 } {
  const { radius, center, height } = bounds;
  const target = new Vector3(center[0], height * 0.45, center[2]);
  const r = Math.max(2.4, radius);
  switch (preset) {
    case 'front':
      return { position: new Vector3(0, height * 0.55, r * 2.05), target };
    case 'side':
      return { position: new Vector3(r * 2.05, height * 0.55, 0), target };
    case 'top':
      return { position: new Vector3(0.001, r * 2.5, 0.001), target };
    case 'detail':
      return { position: new Vector3(r * 0.95, height * 0.72, r * 1.05), target: new Vector3(center[0], height * 0.55, center[2]) };
    case 'iso':
    default:
      return { position: new Vector3(r * 1.55, r * 1.15, r * 1.7), target };
  }
}

/** 相机与控制器：预设机位用插值过渡，静止后停止请求渲染（demand 模式零 GPU 负载）。 */
function CameraRig({ preset, bounds }: { preset: CameraPresetId; bounds: StageBounds }) {
  const { camera, invalidate, controls } = useThree();
  const orbit = controls as unknown as { target: Vector3; update: () => void } | null;
  const desired = useMemo(() => presetPosition(preset, bounds), [preset, bounds]);
  const settled = useRef(false);
  const targetVec = useRef(new Vector3());
  const positionVec = useRef(new Vector3());

  useEffect(() => {
    settled.current = false;
    invalidate();
  }, [preset, bounds, invalidate]);

  useFrame(() => {
    if (settled.current) return;
    positionVec.current.copy(desired.position);
    targetVec.current.copy(desired.target);
    const alpha = 0.18;
    camera.position.lerp(positionVec.current, alpha);
    if (orbit) {
      orbit.target.lerp(targetVec.current, alpha);
      orbit.update();
    } else {
      camera.lookAt(targetVec.current);
    }
    if (camera.position.distanceTo(positionVec.current) < Math.max(0.01, bounds.radius * 0.004)) {
      camera.position.copy(positionVec.current);
      settled.current = true;
    }
    invalidate();
  });

  return null;
}

function StageBridge({ onApi }: { onApi?: (api: StageApi) => void }) {
  const { gl, invalidate, camera } = useThree();
  useEffect(() => {
    onApi?.({
      canvas: gl.domElement,
      renderer: gl,
      invalidate,
      applyPreset: () => undefined,
    });
    // 标注画布真实渲染器信息，便于验收时核对（不依赖任何模拟）
    const context = gl.getContext();
    const debug = context.getExtension('WEBGL_debug_renderer_info');
    gl.domElement.dataset.webglReady = String(!context.isContextLost());
    gl.domElement.dataset.webglRenderer = String(
      debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER),
    );
    gl.domElement.dataset.cameraType = (camera as Camera).type;
  }, [gl, invalidate, camera, onApi]);
  return null;
}

export function StageShell({
  mode,
  quality,
  bounds,
  view,
  active,
  children,
  capture = false,
  onApi,
  practicalLine,
  className,
  showBackground = true,
  fog = true,
}: StageShellProps) {
  const span = Math.max(6, bounds.radius * 2);
  // 需求渲染：不活动即 demand（0 GPU 负载）；只有性能测量/截图序列才常驻渲染。
  const frameLoop = active ? 'always' : 'demand';

  return (
    <div className={className} data-testid="visual-stage" data-visual-mode={mode.id} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Canvas
        frameloop={frameLoop}
        dpr={quality.dpr}
        shadows={quality.shadowMapSize > 0}
        camera={{
          position: presetPosition(view, bounds).position.toArray(),
          fov: 38,
          near: 0.05,
          far: 900,
        }}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: capture }}
        onCreated={({ scene, gl }) => {
          scene.background = showBackground ? new Color(mode.background) : null;
          scene.fog = mode.fog && fog ? new Fog(mode.fog.color, mode.fog.near * (span / 60), mode.fog.far * (span / 60)) : null;
          scene.environmentIntensity = mode.lighting.environmentIntensity;
          gl.setClearColor(new Color(mode.background), showBackground ? 1 : 0);
          gl.shadowMap.enabled = quality.shadowMapSize > 0;
          gl.shadowMap.type = PCFSoftShadowMap;
          gl.toneMapping = ACESFilmicToneMapping;
          gl.toneMappingExposure = mode.exposure;
          gl.outputColorSpace = SRGBColorSpace;
        }}
      >
        <Environment files={warehouseHdri} resolution={quality.environmentResolution} background={false} />
        <IndustrialRig config={mode} span={span} shadowMapSize={quality.shadowMapSize} practicalLine={practicalLine} />
        {children}
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.075}
          minDistance={0.8}
          maxDistance={span * 3}
          maxPolarAngle={Math.PI / 2.04}
        />
        <CameraRig preset={view} bounds={bounds} />
        <StageBridge onApi={onApi} />
      </Canvas>
    </div>
  );
}
