/**
 * 阶段一：单模型艺术化实验台（3D）。
 *
 * 五组对照视图，全部作用在**同一份上传几何**上（切换视图不重新加载模型）：
 *   1. 原始材质      —— 官方 glTF 材质原样呈现（结构核对基准）；
 *   2. 工业科技材质  —— 冷色工业材质 + 分层金属，透明层关闭；
 *   3. 半透明外壳    —— 外壳/防护罩进入冰蓝半透明，内部机构保持不透明；
 *   4. 内部机构      —— 外壳进一步透明并弱化，机械结构（导轨/主轴/工作台）强化；
 *   5. 部件检查      —— 点选部件清单，被选中部件高亮（发光 + 提高反射）。
 */

import { Suspense, useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { SandboxScene } from '../../components/sandbox/SandboxScene';
import { ArtGroundField } from '../../art/ArtGroundField';
import { RenderOnChange } from '../../art/RenderOnChange';
import { EquipmentModel, type EquipmentPartInfo } from '../../art/EquipmentModel';
import type { ApplyStats } from '../../art/materials';
import type { PartRole } from '../../art/types';
import { ART_MODES } from '../../art/modes';
import { useArtStore } from '../../art/settings';
import { OrbitControls } from '@react-three/drei';
import { SB } from '../../components/sandbox/theme';

export type HeroView = 'original' | 'art' | 'shell' | 'mechanism' | 'parts';

export const HERO_VIEWS: Array<{ id: HeroView; label: string; hint: string }> = [
  { id: 'original', label: '原始材质', hint: '上传模型的原始材质与配色，作为结构核对基准' },
  { id: 'art', label: '工业科技材质', hint: '冷色工业材质 + 分层金属，不开启透明层' },
  { id: 'shell', label: '半透明外壳', hint: '外壳/玻璃进入冰蓝半透明，内部机械结构保持不透明' },
  { id: 'mechanism', label: '内部机械结构', hint: '外壳进一步透明并弱化，突出导轨/主轴/工作台' },
  { id: 'parts', label: '部件检查', hint: '从真实部件清单里选择部件高亮，核对角色判定是否正确' },
];

export interface HeroBench3DProps {
  url: string | null;
  view: HeroView;
  /** 部件检查视图下被强调的部件名（子串）。 */
  emphasizeParts?: string[];
  onParts?: (parts: EquipmentPartInfo[]) => void;
  onStats?: (stats: ApplyStats) => void;
  /** 相机预设 id（变化即复位机位）。 */
  cameraPreset?: string;
  active: boolean;
  /** 模型真实尺寸（米），用于自适应机位与阴影范围。 */
  sizeMeters?: number[] | null;
}

/** 由真实尺寸推导的机位（不写死“好看的角度”，而是按设备尺寸取景）。 */
function heroCameras(size: number[] | null): Record<string, { position: [number, number, number]; target: [number, number, number] }> {
  const [w, h, d] = size && size.length === 3 ? size : [3, 2.4, 2];
  const radius = Math.max(w, d) * 0.5;
  const center: [number, number, number] = [0, h * 0.45, 0];
  const distance = Math.max(3.2, Math.max(w, h, d) * 2.05);
  return {
    threeQuarter: { position: [distance * 0.72, h * 1.1 + distance * 0.28, distance * 0.78], target: center },
    front: { position: [0, h * 0.75, distance * 1.25], target: center },
    side: { position: [distance * 1.3, h * 0.7, 0.001], target: center },
    top: { position: [radius * 0.4, distance * 1.35, radius * 0.4], target: center },
    interior: { position: [distance * 0.42, h * 0.62, distance * 0.5], target: center },
  };
}

export function HeroBench3D({
  url,
  view,
  emphasizeParts = [],
  onParts,
  onStats,
  cameraPreset = 'threeQuarter',
  active,
  sizeMeters = null,
}: HeroBench3DProps) {
  const settings = useArtStore();
  const mode = ART_MODES[settings.mode];
  /** 实验台始终以模式 B 的材质语言展示艺术化结果，除非全局模式是 C（算法观察）。 */
  const benchMode = settings.mode === 'C' ? 'C' : 'B';
  const cameras = useMemo(() => heroCameras(sizeMeters), [sizeMeters]);
  const camera = cameras[cameraPreset] ?? cameras.threeQuarter;

  const shellScale = view === 'shell' ? 1 : view === 'mechanism' ? 1 : view === 'parts' ? 1 : 0;
  const structureScale = view === 'original' ? 0 : 1;

  /** 内部机构视图：只有机械结构保持“正常”，外壳与面板被压暗（透明策略仍作用于外壳）。 */
  const isolateRoles: PartRole[] | undefined =
    view === 'mechanism'
      ? ['machined', 'frame', 'graphite', 'rubber', 'accent', 'hazard', 'emissive', 'metalWarm']
      : undefined;

  return (
    <SandboxScene
      width={12}
      height={12}
      className="sandbox-stage hero-bench"
      active={active}
      lighting="art"
      artMode={benchMode}
      orthographic={false}
      cameraPosition={camera.position}
      fov={30}
    >
      <HeroCamera preset={cameraPreset} position={camera.position} target={camera.target} />

      {/* 实验台底板：小尺寸科技地坪，让设备像摆在实验台上的实物 */}
      <group position={[-4, 0, -4]}>
        <ArtGroundField width={8} height={8} showScaleMarks={settings.showScaleMarks} />
      </group>
      {/* 按需渲染：视图 / 机位 / 模式 / 模型 / 高亮部件变化后补帧（设备材质是命令式应用的） */}
      <RenderOnChange
        watch={`${view}|${cameraPreset}|${benchMode}|${url ?? 'none'}|${settings.physicalGlass}|${settings.contactShadow}|${settings.showScaleMarks}|${emphasizeParts.join(',')}`}
        frames={4}
      />
      {/* 机位参考环：标出设备占地（真实包围盒的一半），不是装饰光 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]}>
        <ringGeometry args={[Math.max(1.6, (sizeMeters?.[0] ?? 3) * 0.62), Math.max(1.66, (sizeMeters?.[0] ?? 3) * 0.62) + 0.035, 64]} />
        <meshBasicMaterial color={SB.plateLine} transparent opacity={0.5} depthWrite={false} />
      </mesh>

      {url ? (
        <Suspense fallback={null}>
          <EquipmentModel
            url={url}
            position={[0, 0, 0]}
            modeOverride={view === 'original' ? 'A' : benchMode}
            forceOriginals={view === 'original'}
            shellScaleOverride={shellScale}
            structureScaleOverride={structureScale}
            isolateRoles={isolateRoles}
            emphasizeParts={view === 'parts' ? emphasizeParts : []}
            onParts={onParts}
            onStats={onStats}
          />
        </Suspense>
      ) : (
        /* 清单里没有该模型时如实显示一个线框占位（不伪造设备外观）。 */
        <mesh position={[0, 0.5, 0]}>
          <boxGeometry args={[1.6, 1, 1.2]} />
          <meshStandardMaterial color="#3b4650" wireframe />
        </mesh>
      )}
    </SandboxScene>
  );
}

/**
 * 英雄实验台相机：预设变化时复位机位（不自动旋转——场景按需渲染，静止时零 GPU 负载）。
 * 使用命令式写入，避免 OrbitControls 与 R3F 相机状态互相覆盖。
 */
function HeroCamera({ preset, position, target }: { preset: string; position: [number, number, number]; target: [number, number, number] }) {
  const { camera, invalidate } = useThree();
  const controls = useRef<{ target: { set: (x: number, y: number, z: number) => void }; update: () => void } | null>(null);

  useEffect(() => {
    camera.position.set(position[0], position[1], position[2]);
    camera.lookAt(target[0], target[1], target[2]);
    if ('fov' in camera) {
      camera.near = 0.05;
      camera.far = 400;
    }
    camera.updateProjectionMatrix();
    controls.current?.target.set(target[0], target[1], target[2]);
    controls.current?.update();
    invalidate();
  }, [preset, position, target, camera, invalidate]);

  return (
    <OrbitControls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ref={controls as any}
      makeDefault
      target={target}
      enableDamping
      dampingFactor={0.1}
      minDistance={1.2}
      maxDistance={40}
      maxPolarAngle={Math.PI / 2 - 0.03}
    />
  );
}
