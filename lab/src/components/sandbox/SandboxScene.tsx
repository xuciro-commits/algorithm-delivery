/**
 * Shared Three.js scene shell: local HDR image-based lighting + layered industrial
 * lights, soft real shadows, explicit ACES exposure and demand-driven rendering.
 */

import { Environment } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Color, PCFSoftShadowMap, ACESFilmicToneMapping, SRGBColorSpace } from 'three';
import { useEffect, useRef, type ReactNode } from 'react';
import { SB } from './theme';

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
}

const warehouseHdri = new URL('../../assets/warehouse-studio.hdr', import.meta.url).href;

export function SandboxScene({ children, width, height, className, dpr = [1, 2], active = false }: SandboxSceneProps) {
  const span = Math.max(width, height, 8);
  return (
    <div
      className={className}
      data-testid="webgl-stage"
      data-renderer="three-webgl"
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <Canvas
        orthographic
        frameloop={active ? 'always' : 'demand'}
        dpr={dpr}
        camera={{ position: [span, span * Math.SQRT2, span], zoom: 48, near: 0.1, far: 10000 }}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        onCreated={({ scene, gl }) => {
          scene.background = new Color(SB.bgDeep);
          gl.setClearColor(SB.bgDeep, 1);
          gl.shadowMap.enabled = true;
          gl.shadowMap.type = PCFSoftShadowMap;
          gl.toneMapping = ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.12;
          gl.outputColorSpace = SRGBColorSpace;
          gl.domElement.dataset.webglReady = 'true';
          gl.domElement.dataset.webglVersion = gl.capabilities.isWebGL2 ? '2' : '1';
        }}
      >
        <Environment files={warehouseHdri} resolution={256} background={false} />
        <SceneRig span={span} width={width} height={height} />
        {children}
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
