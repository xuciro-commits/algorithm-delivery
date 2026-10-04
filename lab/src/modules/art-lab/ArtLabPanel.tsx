/**
 * 三维实验室主面板：**三个实验室** + 全新的舞台/按钮布局。
 *
 *   01 英雄设备实验室  —— 单台上传设备的五组天然对照（原始 / 艺术化 / 半透明 / 内部 / 部件）
 *   02 透明厂房实验室  —— 上传构件装配的厂房：分层透明、结构层次与布局核对
 *   03 算法观察实验室  —— 三个真实引擎（AGV / MAPF / APS）的解在同一套空间语汇里回放
 *
 * 三条不变式（与需求一致）：
 *   1. 三种视觉模式（A/B/C）共用同一套几何与算法数据，只切换视觉配置；
 *   2. 面板上所有数字（三角形、部件数、透明件数、状态、耗时）都来自真实读取或引擎输出；
 *   3. 引擎未就绪 / 清单缺失时给出可操作提示，绝不显示伪造结果。
 *
 * 布局：左栏 = 实验室切换 + 该实验室的选择器；中央 = 3D 舞台 + HUD + 底部操作坞；
 * 右栏 = 检查器（部件 / 构件 / 指标 / 图例）。所有按钮都是"玻璃 + 发光"体系，
 * 激活态使用与 3D 场景一致的冰蓝/青色，状态色与算法图例同源。
 */

import { Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { HudPanel, HudSection, Segmented, StatChip, ToolButton } from '../../components/hud';
import { ART_MODES } from '../../art/modes';
import { ART_MODE_LABEL, ART_MODE_OPTIONS } from '../../art/tokens';
import { useArtStore } from '../../art/settings';
import { heroModels, useArtManifest, type ArtModelEntry } from '../../art/manifest';
import { missingModelKeys, resolveModelUrls } from '../../art/modelPaths';
import type { ApplyStats } from '../../art/materials';
import type { EquipmentPartInfo } from '../../art/EquipmentModel';
import type { AlgoOverlay } from '../../art/overlayModel';
import { EMPTY_OVERLAY } from '../../art/overlayModel';
import { HERO_CAMERAS, HERO_VIEWS, HeroBench3D, type HeroCameraPreset, type HeroView } from './HeroBench3D';
import { FACTORY_CAMERAS, FactorySandbox3D, type FactoryCameraPreset } from './FactorySandbox3D';
import { buildAgvOverlay, buildApsOverlay, buildMapfOverlay } from './overlay';
import { usePlaybackClock } from './playback';
import { equipmentKeysForMachines, FLOOR_ZONES, HALL, LINE_EQUIPMENT, STATION_PADS, stationForMachine } from './layout';
import type { AgvProblemLite, AgvSolution } from '../../core/agv/types';
import type { MapfProblemLite, MapfSolution } from '../../core/mapf/types';
import type { RawOperation } from '../../core/types';
import { parseAgvScene, serializeAgvScene } from '../agv/scene';
import { parseScene, sceneDims, serializeScene } from '../mapf/scene/SceneDoc';
import { entriesFromManifest, loadProblem, type ProblemEntry } from '../../core/aps/mocks';
import { DEFAULT_PARAMS } from '../../core/aps/params';
import { parseIsoMs } from '../../core/aps/transform';
import type { MapfEngineHandle } from '../../core/mapf/engine';
import type { AgvEngineHandle } from '../../core/agv/engine';
import type { Runner } from '../../core/aps/engine';
import type { EngineManifest, VerifyReport } from '../../core/types';
import type { MapfManifest } from '../../core/mapf/types';
import type { AgvManifest } from '../../core/agv/types';

export type ArtAlgo = 'agv' | 'mapf' | 'aps';
export type ArtLabId = 'hero' | 'factory' | 'algo';

/** 三个实验室的登记（顺序即界面顺序）。 */
export const ART_LABS: Array<{ id: ArtLabId; index: string; name: string; tagline: string; accent: string }> = [
  {
    id: 'hero',
    index: '01',
    name: '英雄设备实验室',
    tagline: '单台生产设备的艺术化重构与部件级核对',
    accent: 'var(--sb-ice)',
  },
  {
    id: 'factory',
    index: '02',
    name: '透明厂房实验室',
    tagline: '厂房分层透明、结构层次与产线空间关系',
    accent: 'var(--sb-cyan)',
  },
  {
    id: 'algo',
    index: '03',
    name: '算法观察实验室',
    tagline: 'AGV / MAPF / APS 真实解的空间回放',
    accent: 'var(--sb-teal)',
  },
];

export const ART_ALGOS: Array<{ id: ArtAlgo; label: string; hint: string }> = [
  { id: 'agv', label: 'AGV 调度', hint: '车辆时间轴 → 已执行/计划轨迹、任务取送点、相位状态光、超期事件' },
  { id: 'mapf', label: 'MAPF 路径', hint: '机器人 path → 多色轨迹、目标投影、到达状态' },
  { id: 'aps', label: 'APS 排程', hint: '工序区间 → 工位状态光与进度弧、订单流转线、核验违规标记' },
];

const REPLAY_SPEEDS = [1, 2, 4, 8] as const;

export interface ArtLabEngineProps {
  aps?: {
    manifest: EngineManifest | null;
    runner: Runner | null;
    engineReady: boolean;
    engineVersion: string;
    assetUrl: (path: string) => string;
    cancelSolve?: () => boolean;
  };
  mapf?: {
    manifest: MapfManifest | null;
    handle: MapfEngineHandle | null;
    engineReady: boolean;
    engineVersion: string;
    assetUrl: (path: string) => string;
    setBusy?: (busy: boolean) => void;
    cancelSolve?: () => boolean;
  };
  agv?: {
    manifest: AgvManifest | null;
    handle: AgvEngineHandle | null;
    engineReady: boolean;
    engineVersion: string;
    assetUrl: (path: string) => string;
    setBusy?: (busy: boolean) => void;
    cancelSolve?: () => boolean;
  };
}

interface AgvRun {
  problem: AgvProblemLite;
  solution: AgvSolution;
  steps: number;
  label: string;
}

interface MapfRun {
  problem: MapfProblemLite;
  solution: MapfSolution;
  steps: number;
  label: string;
}

interface ApsRun {
  operations: RawOperation[];
  machines: string[];
  verify: VerifyReport | null;
  minMs: number;
  maxMs: number;
  label: string;
  status: string;
}

export function ArtLabPanel({ aps, mapf, agv }: ArtLabEngineProps) {
  const settings = useArtStore();
  const mode = ART_MODES[settings.mode];
  const { status: manifestStatus, manifest, error: manifestError } = useArtManifest();

  const [lab, setLab] = useState<ArtLabId>('hero');
  const urls = useMemo(() => resolveModelUrls(manifest), [manifest]);
  const missing = useMemo(() => (manifest ? missingModelKeys(urls) : []), [manifest, urls]);
  const heroes = useMemo(() => heroModels(manifest), [manifest]);

  // —— 实验室 01：英雄设备 ——
  const [heroSlug, setHeroSlug] = useState<string | null>(null);
  const [heroView, setHeroView] = useState<HeroView>('art');
  const [heroCamera, setHeroCamera] = useState<HeroCameraPreset>('threeQuarter');
  const [heroParts, setHeroParts] = useState<EquipmentPartInfo[]>([]);
  const [heroStats, setHeroStats] = useState<ApplyStats | null>(null);
  const [emphasizeParts, setEmphasizeParts] = useState<string[]>([]);
  const [deviceFilter, setDeviceFilter] = useState('');

  useEffect(() => {
    if (!heroSlug && heroes.length) setHeroSlug(heroes[0].slug);
  }, [heroes, heroSlug]);

  const heroEntry: ArtModelEntry | null = useMemo(
    () => heroes.find((h) => h.slug === heroSlug) ?? heroes[0] ?? null,
    [heroes, heroSlug],
  );
  const heroList = useMemo(() => {
    const q = deviceFilter.trim().toLowerCase();
    return q ? heroes.filter((h) => h.slug.includes(q) || h.use.toLowerCase().includes(q)) : heroes;
  }, [heroes, deviceFilter]);

  // —— 实验室 02：透明厂房 ——
  const [factoryCamera, setFactoryCamera] = useState<FactoryCameraPreset>('overview');
  const [showRoof, setShowRoof] = useState(!settings.hideRoof);
  const [showWalls, setShowWalls] = useState(true);
  const [showMezzanine, setShowMezzanine] = useState(false);
  const [hallParts, setHallParts] = useState<EquipmentPartInfo[]>([]);

  // 隐藏屋顶（透明厂房主手段）跟随全局设置：模式 B/C 默认隐去，模式 A 一律保留原貌。
  useEffect(() => {
    setShowRoof(!(settings.hideRoof && settings.mode !== 'A'));
  }, [settings.hideRoof, settings.mode]);

  // —— 实验室 03：算法观察 ——
  const [algo, setAlgo] = useState<ArtAlgo>('agv');
  const [algoCamera, setAlgoCamera] = useState<FactoryCameraPreset>('overview');
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [agvRun, setAgvRun] = useState<AgvRun | null>(null);
  const [mapfRun, setMapfRun] = useState<MapfRun | null>(null);
  const [apsRun, setApsRun] = useState<ApsRun | null>(null);
  const [selectedRun, setSelectedRun] = useState<ArtAlgo | null>(null);

  const steps = useMemo(() => {
    if (algo === 'agv') return agvRun?.steps ?? 0;
    if (algo === 'mapf') return mapfRun?.steps ?? 0;
    return apsRun ? 60 : 0; // APS 回放步数固定为 60 段（真实时间跨度的等分采样）
  }, [algo, agvRun, mapfRun, apsRun]);

  const clock = usePlaybackClock({ steps, defaultSpeed: 3 });
  const resetPlayback = clock.reset;
  const busy = clock.playing;
  const stageActive = lab === 'algo' ? busy : false;

  const overlay: AlgoOverlay = useMemo(() => {
    if (!settings.showOverlays) return EMPTY_OVERLAY;
    const t = clock.t;
    if (algo === 'agv' && agvRun) return buildAgvOverlay({ problem: agvRun.problem, solution: agvRun.solution, step: t });
    if (algo === 'mapf' && mapfRun) return buildMapfOverlay({ problem: mapfRun.problem, solution: mapfRun.solution, step: t });
    if (algo === 'aps' && apsRun) {
      const machineStations = new Map(
        apsRun.machines
          .map((id, i) => [id, stationForMachine(i)] as const)
          .filter((pair): pair is [string, NonNullable<ReturnType<typeof stationForMachine>>] => Boolean(pair[1])),
      );
      const span = Math.max(1, apsRun.maxMs - apsRun.minMs);
      const nowMs = apsRun.minMs + (span * t) / Math.max(1, steps);
      return buildApsOverlay({ operations: apsRun.operations, machineStations, nowMs, verify: apsRun.verify });
    }
    return EMPTY_OVERLAY;
  }, [settings.showOverlays, algo, agvRun, mapfRun, apsRun, clock.t, steps]);

  /** 光流相位：与平滑回放位置绑定（不是独立动画时钟）。 */
  const flowOffset = useMemo(() => clock.t * 0.36, [clock.t]);

  /** 本次排程实际使用的设备：只做"机器 → 泊位 → 设备"的确定性映射。 */
  const emphasizeKeys = useMemo(
    () => (algo === 'aps' && apsRun ? equipmentKeysForMachines(apsRun.machines) : []),
    [algo, apsRun],
  );

  /** 跟踪镜头：跟随第一台载体的真实位置（仅在回放中提供）。 */
  const followTarget = useMemo<[number, number, number] | null>(() => {
    if (algoCamera !== 'follow' || !busy) return null;
    const first = overlay.statuses[0]?.position;
    return first ? [first[0], first[1], first[2]] : null;
  }, [algoCamera, busy, overlay.statuses]);

  // —— 真实求解 ——
  const runAlgorithm = useCallback(async () => {
    setNotice(null);
    resetPlayback();
    const markBusy = (value: boolean) => {
      const setBusy = algo === 'agv' ? agv?.setBusy : algo === 'mapf' ? mapf?.setBusy : undefined;
      setBusy?.(value);
    };
    if (algo === 'agv') {
      if (!agv?.handle || !agv.engineReady) {
        setNotice('AGV 引擎未就绪：请等待顶部引擎状态变为可用（或查看引擎错误提示）。');
        return;
      }
      const entry = agv.manifest?.mocks?.find((m) => m.file.includes('warehouse-studio')) ?? agv.manifest?.mocks?.[0];
      if (!entry) {
        setNotice('AGV 示例清单为空：请先运行 lab/scripts/sync-agv.mjs 生成 mock 数据。');
        return;
      }
      setRunning(true);
      markBusy(true);
      try {
        const res = await fetch(agv.assetUrl(entry.file), { cache: 'no-cache' });
        if (!res.ok) throw new Error(`读取 ${entry.file} 失败：HTTP ${res.status}`);
        const scene = parseAgvScene(await res.text());
        const outcome = await agv.handle.solve(serializeAgvScene(scene), {
          algorithm: scene.solver.algorithm,
          time_limit_ms: scene.solver.time_limit_ms,
          verify: true,
        });
        const solution = outcome.solution as AgvSolution | null;
        if (!solution) throw new Error('引擎未返回方案');
        setAgvRun({
          problem: { map: scene.map, vehicles: scene.vehicles, tasks: scene.tasks, stations: scene.stations, id: scene.id } as AgvProblemLite,
          solution,
          steps: solution.plan?.vehicles?.reduce((max, v) => Math.max(max, (v.timeline?.length ?? 1) - 1), 0) ?? 0,
          label: entry.file,
        });
        setSelectedRun('agv');
        setNotice(`已用真实 AGV 引擎求解 ${entry.file}：${solution.status}${solution.verified ? '（已独立核验）' : ''}`);
      } catch (err) {
        setNotice(`AGV 求解失败：${(err as Error).message}`);
      } finally {
        setRunning(false);
        markBusy(false);
      }
      return;
    }

    if (algo === 'mapf') {
      if (!mapf?.handle || !mapf.engineReady) {
        setNotice('MAPF 引擎未就绪：请等待顶部引擎状态变为可用。');
        return;
      }
      const entry = mapf.manifest?.mocks?.[0];
      if (!entry) {
        setNotice('MAPF 示例清单为空：请先运行 lab/scripts/sync-mapf.mjs 生成 mock 数据。');
        return;
      }
      setRunning(true);
      markBusy(true);
      try {
        const res = await fetch(mapf.assetUrl(entry.file), { cache: 'no-cache' });
        if (!res.ok) throw new Error(`读取 ${entry.file} 失败：HTTP ${res.status}`);
        const doc = parseScene(await res.text());
        const dims = sceneDims(doc);
        const outcome = await mapf.handle.solve(serializeScene(doc), {
          objective: doc.objective.kind,
          suboptimality_factor: doc.solver.suboptimality_factor,
          planner: doc.solver.planner,
          seed: doc.solver.seed,
          verify: true,
        });
        const solution = outcome.solution as MapfSolution | null;
        if (!solution) throw new Error('引擎未返回方案');
        setMapfRun({
          problem: { map: { width: dims.width, height: dims.height, cells: doc.map.cells }, robots: doc.robots, id: doc.id } as MapfProblemLite,
          solution,
          steps: solution.robots.reduce((max, r) => Math.max(max, (r.path?.length ?? 1) - 1), 0),
          label: entry.file,
        });
        setSelectedRun('mapf');
        setNotice(`已用真实 MAPF 引擎求解 ${entry.file}：${solution.status}${solution.optimality_proven ? '（已证明最优）' : ''}`);
      } catch (err) {
        setNotice(`MAPF 求解失败：${(err as Error).message}`);
      } finally {
        setRunning(false);
        markBusy(false);
      }
      return;
    }

    // APS
    if (!aps?.runner || !aps.engineReady) {
      setNotice('APS 引擎未就绪：请等待顶部引擎状态变为可用。');
      return;
    }
    const entries: ProblemEntry[] = entriesFromManifest(aps.manifest);
    const entry = entries[0];
    if (!entry) {
      setNotice('APS 示例清单为空：请先运行 lab/scripts/sync-engine.mjs 生成 mock 数据。');
      return;
    }
    setRunning(true);
    try {
      const problem = await loadProblem(entry, aps.assetUrl);
      const record = await aps.runner.run({ problem, problemName: entry.name, params: DEFAULT_PARAMS, verify: true });
      const operations = record.solution?.operations ?? [];
      if (!operations.length) throw new Error(record.error ?? '方案中没有工序');
      const times = operations.flatMap((op) => [parseIsoMs(op.start_at), parseIsoMs(op.end_at)]).filter((v) => Number.isFinite(v));
      setApsRun({
        operations,
        machines: [...new Set(operations.map((op) => op.machine_id))],
        verify: record.verify ?? null,
        minMs: Math.min(...times),
        maxMs: Math.max(...times),
        label: entry.name,
        status: `${record.status}${record.verify?.ok === false ? ' · 核验发现问题' : ''}`,
      });
      setSelectedRun('aps');
      setNotice(`已用真实 APS 引擎求解「${entry.name}」：${record.status}，${operations.length} 道工序`);
    } catch (err) {
      setNotice(`APS 求解失败：${(err as Error).message}`);
    } finally {
      setRunning(false);
    }
  }, [algo, agv, mapf, aps, resetPlayback]);

  const filteredParts = useMemo(() => {
    const q = deviceFilter.trim().toLowerCase();
    const list = lab === 'hero' && q && heroView === 'parts' ? heroParts.filter((p) => p.name.toLowerCase().includes(q) || p.role.includes(q)) : heroParts;
    return list.slice(0, 80);
  }, [heroParts, deviceFilter, lab, heroView]);

  const heroCameraOptions = lab === 'hero' ? HERO_CAMERAS : FACTORY_CAMERAS;
  const cameraValue = lab === 'factory' ? factoryCamera : lab === 'algo' ? algoCamera : heroCamera;
  const setCameraValue = (id: string) => {
    if (lab === 'factory') setFactoryCamera(id as FactoryCameraPreset);
    else if (lab === 'algo') setAlgoCamera(id as FactoryCameraPreset);
    else setHeroCamera(id as HeroCameraPreset);
  };

  const runLabel = algo === 'agv' ? agvRun?.label : algo === 'mapf' ? mapfRun?.label : apsRun?.label;
  const engineReady = algo === 'agv' ? agv?.engineReady : algo === 'mapf' ? mapf?.engineReady : aps?.engineReady;
  const engineVersion = (algo === 'agv' ? agv?.engineVersion : algo === 'mapf' ? mapf?.engineVersion : aps?.engineVersion) ?? '—';

  const followOf = lab === 'hero' ? null : lab === 'factory' ? null : followTarget;
  // 审批：模式 B/C 在算法观察实验室默认隐去屋面；模式 A 一律保留原貌。
  const roofVisible = lab === 'algo' ? !(settings.hideRoof && settings.mode !== 'A') : showRoof;

  return (
    <div className="artlab">
      {/* ——— 顶部：实验室切换 + 全局视觉模式 ——— */}
      <header className="labbar">
        <div className="labbar-labs" role="tablist" aria-label="实验室">
          {ART_LABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={lab === item.id}
              className={`labcard ${lab === item.id ? 'is-active' : ''}`}
              style={{ '--lab-accent': item.accent } as CSSProperties}
              onClick={() => setLab(item.id)}
            >
              <span className="labcard-index">{item.index}</span>
              <span className="labcard-body">
                <span className="labcard-name">{item.name}</span>
                <span className="labcard-tag">{item.tagline}</span>
              </span>
              <span className="labcard-glow" aria-hidden />
            </button>
          ))}
        </div>
        <div className="labbar-modes">
          <span className="labbar-label">视觉模式</span>
          <Segmented ariaLabel="视觉模式" options={ART_MODE_OPTIONS} value={settings.mode} onChange={settings.setMode} />
          <ToolButton
            label="透明厂房"
            active={settings.transparentFactory}
            title="建筑层（屋面/墙板/次要遮挡）进入半透明或隐藏，主要生产设备保持清晰"
            onClick={() => settings.patch({ transparentFactory: !settings.transparentFactory })}
          />
          <ToolButton
            label={`泛光 ${settings.bloomEnabled ? settings.bloomStrength.toFixed(2) : '关'}`}
            active={settings.bloomEnabled}
            title="受控泛光：只对超过阈值的自发光元素（算法路径 / 状态灯）生效，可完全关闭"
            onClick={() => settings.patch({ bloomEnabled: !settings.bloomEnabled })}
          />
        </div>
      </header>

      {/* ——— 状态条：清单 / 缺失 / 引擎 ——— */}
      <div className="statusstrip">
        <StatChip
          label="模型清单"
          value={manifestStatus === 'ready' ? `${manifest?.totals.models ?? 0} 个 / ${((manifest?.totals.bytes ?? 0) / 1024 / 1024).toFixed(2)} MB` : manifestStatus === 'loading' ? '读取中' : '缺失'}
          tone={manifestStatus === 'ready' ? 'var(--sb-teal)' : 'var(--sb-coral)'}
          title={manifestError ?? '由 lab/scripts/sync-assets.mjs 生成'}
        />
        <StatChip label="三角形" value={(manifest?.totals.triangles ?? 0).toLocaleString('en-US')} tone={null} />
        <StatChip label="视觉模式" value={ART_MODE_LABEL[settings.mode]} tone={settings.mode === 'B' ? 'var(--sb-ice)' : null} title={mode.tagline} />
        <StatChip label="引擎" value={engineReady ? `${algo.toUpperCase()} 就绪` : `${algo.toUpperCase()} 未就绪`} tone={engineReady ? 'var(--sb-teal)' : 'var(--sb-amber)'} title={`版本 ${engineVersion}`} />
        {manifestStatus === 'missing' && <span className="statusstrip-warn">{manifestError}</span>}
        {missing.length > 0 && (
          <span className="statusstrip-warn">
            清单缺少 {missing.length} 个模型（{missing.slice(0, 3).join('、')}{missing.length > 3 ? '…' : ''}）：这些构件不渲染，也不用占位几何替代。
          </span>
        )}
      </div>

      <div className="artlab-grid">
        {/* ——————————— 左栏：该实验室的选择器 ——————————— */}
        <HudPanel
          title={lab === 'hero' ? '设备选择' : lab === 'factory' ? '厂房与结构' : '算法与样例'}
          scroll
          className="artlab-rail"
          meta={<StatChip label="来源" value="上传模型" tone={null} />}
        >
          {lab === 'hero' && (
            <>
              <HudSection label="英雄设备（按结构复杂度评分排序）" action={<span className="muted small">{heroes.length} 台</span>}>
                <input
                  className="artlab-search"
                  value={deviceFilter}
                  placeholder="按 slug / 用途过滤（如 cnc、robot）"
                  onChange={(event) => setDeviceFilter(event.target.value)}
                />
                <div className="pick-list">
                  {heroList.map((model) => (
                    <button
                      key={model.slug}
                      type="button"
                      className={`pick ${model.slug === heroEntry?.slug ? 'is-active' : ''}`}
                      onClick={() => {
                        setHeroSlug(model.slug);
                        setEmphasizeParts([]);
                      }}
                    >
                      <span className="pick-name">{model.slug}</span>
                      <span className="pick-meta">
                        {model.triangles.toLocaleString('en-US')} tris · {model.meshes} 网格 · {(model.sizeMeters ?? []).map((v) => v.toFixed(2)).join('×')} m
                      </span>
                      <span className="pick-tags">
                        <em className="tag">评分 {model.heroScore ?? '—'}</em>
                        <em className={`tag ${model.transparentCapable ? 'tag--on' : ''}`}>{model.transparentCapable ? '可透明' : '无透明件'}</em>
                        {model.internalMechanism && <em className="tag tag--on">内部机构</em>}
                      </span>
                    </button>
                  ))}
                  {!heroList.length && <p className="muted small">等待模型清单（先运行 node lab/scripts/sync-assets.mjs）。</p>}
                </div>
              </HudSection>
              <HudSection label="对照视图说明">
                <p className="muted small">{HERO_VIEWS.find((v) => v.id === heroView)?.hint}</p>
                <p className="muted small">
                  五种视图共用同一份上传几何：切换只改变材质、透明层与部件高亮，模型不会被重建。
                </p>
              </HudSection>
            </>
          )}

          {lab === 'factory' && (
            <>
              <HudSection label="分层透明（选择性，不是整场透明）">
                <div className="toggles">
                  <ToolButton label="透明厂房" active={settings.transparentFactory} onClick={() => settings.patch({ transparentFactory: !settings.transparentFactory })} />
                  <ToolButton label="隐去屋面" active={!showRoof} onClick={() => setShowRoof((v) => !v)} />
                  <ToolButton label="隐去墙板" active={!showWalls} onClick={() => setShowWalls((v) => !v)} />
                  <ToolButton label="夹层平台" active={showMezzanine} onClick={() => setShowMezzanine((v) => !v)} />
                  <ToolButton label="高质量玻璃" active={settings.physicalGlass} onClick={() => settings.patch({ physicalGlass: !settings.physicalGlass })} />
                </div>
                <label className="slider">
                  <span>建筑层透明 {settings.structureAlpha.toFixed(2)}</span>
                  <input type="range" min={0} max={1} step={0.05} value={settings.structureAlpha} onChange={(e) => settings.patch({ structureAlpha: Number(e.target.value) })} />
                </label>
                <label className="slider">
                  <span>设备外壳透明 {settings.shellAlpha.toFixed(2)}</span>
                  <input type="range" min={0} max={1} step={0.05} value={settings.shellAlpha} onChange={(e) => settings.patch({ shellAlpha: Number(e.target.value) })} />
                </label>
              </HudSection>
              <HudSection label="厂房参数（真实柱距体系）">
                <div className="stat-rows">
                  <span>跨数<b>{HALL.baysX} × {HALL.baysZ}</b></span>
                  <span>柱距<b>{HALL.bay} m</b></span>
                  <span>屋架下弦<b>{HALL.height} m</b></span>
                  <span>占地<b>{(HALL.baysX * HALL.bay).toFixed(0)} × {(HALL.baysZ * HALL.bay).toFixed(0)} m</b></span>
                </div>
              </HudSection>
              <HudSection label="地坪分区（语义来自工艺布置）">
                <ul className="zone-list">
                  {FLOOR_ZONES.map((zone) => (
                    <li key={zone.label}>
                      <span className="zone-swatch" style={{ background: zone.color }} aria-hidden />
                      {zone.label}
                      {zone.dashed && <em className="tag">映射范围</em>}
                    </li>
                  ))}
                </ul>
              </HudSection>
            </>
          )}

          {lab === 'algo' && (
            <>
              <HudSection label="算法（真实引擎，样例来自同步脚本）">
                <div className="pick-list">
                  {ART_ALGOS.map((item) => {
                    const ready = item.id === 'agv' ? agv?.engineReady : item.id === 'mapf' ? mapf?.engineReady : aps?.engineReady;
                    const version = (item.id === 'agv' ? agv?.engineVersion : item.id === 'mapf' ? mapf?.engineVersion : aps?.engineVersion) ?? '—';
                    const samples = (item.id === 'agv' ? agv?.manifest?.mocks?.length : item.id === 'mapf' ? mapf?.manifest?.mocks?.length : aps?.manifest?.mocks?.length) ?? 0;
                    const hasRun = Boolean(item.id === 'agv' ? agvRun : item.id === 'mapf' ? mapfRun : apsRun);
                    return (
                      <button key={item.id} type="button" className={`pick ${algo === item.id ? 'is-active' : ''}`} onClick={() => setAlgo(item.id)}>
                        <span className="pick-name">{item.label}</span>
                        <span className="pick-meta">v{version} · 样例 {samples} 个{hasRun ? ' · 已有结果' : ''}</span>
                        <span className="pick-tags">
                          <em className={`tag ${ready ? 'tag--on' : 'tag--warn'}`}>{ready ? '引擎就绪' : '未就绪'}</em>
                          {selectedRun === item.id && <em className="tag">当前展示</em>}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="btn-row">
                  <ToolButton label={running ? '求解中…' : '运行真实引擎'} tone="primary" disabled={running} onClick={() => void runAlgorithm()} />
                  <ToolButton label="引擎状态" onClick={() => setNotice(engineSummary(algo, aps, mapf, agv))} />
                  {running && Boolean(algo === 'aps' ? aps?.cancelSolve : algo === 'mapf' ? mapf?.cancelSolve : agv?.cancelSolve) && (
                    <ToolButton
                      label="取消"
                      tone="danger"
                      onClick={() => {
                        const cancel = algo === 'aps' ? aps?.cancelSolve : algo === 'mapf' ? mapf?.cancelSolve : agv?.cancelSolve;
                        cancel?.();
                        setNotice('已请求取消：引擎返回后本次结果作废（不会显示半截数据）。');
                      }}
                    />
                  )}
                </div>
                {notice && <p className="notice">{notice}</p>}
              </HudSection>
              <HudSection label="空间语汇">
                <table className="mini-table">
                  <tbody>
                    <tr><td>AGV</td><td>时间轴 → 已执行/计划轨迹 + 取送点 + 相位状态光 + 超期事件</td></tr>
                    <tr><td>MAPF</td><td>path → 多色轨迹 + 目标投影 + 到达状态</td></tr>
                    <tr><td>APS</td><td>工序区间 → 工位状态光 + 进度弧 + 订单流转线 + 违规标记</td></tr>
                  </tbody>
                </table>
                <p className="muted small">叠加层只消费引擎输出：坐标、时刻、数量全部可追溯；没有结果时显示空叠加层。</p>
              </HudSection>
            </>
          )}
        </HudPanel>

        {/* ——————————— 中央：3D 舞台 ——————————— */}
        <section className="stage">
          <div className="stage-viewport">
            {lab === 'hero' && (
              <HeroBench3D
                /* EquipmentModel 内部统一走 artAssetUrl，这里传清单里的原始 path */
                url={heroEntry ? heroEntry.url : null}
                view={heroView}
                emphasizeParts={emphasizeParts}
                onParts={setHeroParts}
                onStats={setHeroStats}
                cameraPreset={heroCamera}
                active={stageActive}
                sizeMeters={heroEntry?.sizeMeters ?? null}
              />
            )}
            {lab !== 'hero' && (
              <Suspense fallback={<div className="stage-loading">正在装配透明厂房…</div>}>
                <FactorySandbox3D
                  urls={urls}
                  overlay={lab === 'algo' ? overlay : EMPTY_OVERLAY}
                  cameraPreset={lab === 'factory' ? factoryCamera : algoCamera}
                  active={lab === 'algo' ? stageActive : false}
                  showRoof={roofVisible}
                  showWalls={showWalls}
                  showMezzanine={showMezzanine}
                  flowOffset={lab === 'algo' ? flowOffset : 0}
                  emphasizeKeys={lab === 'algo' ? emphasizeKeys : []}
                  follow={lab === 'algo' ? followOf : null}
                  onHallParts={setHallParts}
                />
              </Suspense>
            )}
            <div className="stage-veil" aria-hidden />
            {/* HUD：全部字段来自真实数据（清单 / 引擎输出 / 交互状态） */}
            <div className="stage-hud">
              <span className="stage-hud-title">{ART_LABS.find((l) => l.id === lab)?.name}</span>
              {lab === 'algo' ? (
                <>
                  <span className="stage-hud-line">{overlay.label}</span>
                  <span className="stage-hud-line stage-hud-dim">{overlay.status}</span>
                  <span className="stage-hud-line stage-hud-dim">{overlay.mapping}</span>
                </>
              ) : lab === 'hero' ? (
                <>
                  <span className="stage-hud-line">{heroEntry?.slug ?? '—'}</span>
                  <span className="stage-hud-line stage-hud-dim">
                    {heroEntry ? `${heroEntry.triangles.toLocaleString('en-US')} tris · ${heroEntry.meshes} 网格 · ${heroEntry.materials.length} 材质` : '等待清单'}
                  </span>
                </>
              ) : (
                <>
                  <span className="stage-hud-line">厂房 {(HALL.baysX * HALL.bay).toFixed(0)} × {(HALL.baysZ * HALL.bay).toFixed(0)} m · 柱距 {HALL.bay} m</span>
                  <span className="stage-hud-line stage-hud-dim">产线设备 {LINE_EQUIPMENT.length} 处 · 工位泊位 {STATION_PADS.length} 个</span>
                </>
              )}
            </div>
          </div>

          {/* 底部操作坞：视图 / 相机 / 回放，全部是同一套"玻璃 + 发光"按钮 */}
          <div className="dock">
            {lab === 'hero' && (
              <div className="dock-block">
                <span className="dock-label">对照视图</span>
                <div className="chips">
                  {HERO_VIEWS.map((view) => (
                    <button key={view.id} type="button" className={`chip ${heroView === view.id ? 'is-active' : ''}`} title={view.hint} onClick={() => setHeroView(view.id)}>
                      {view.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="dock-block">
              <span className="dock-label">机位</span>
              <div className="chips">
                {heroCameraOptions.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`chip ${cameraValue === preset.id ? 'is-active' : ''}`}
                    title={'hint' in preset ? preset.hint : undefined}
                    onClick={() => setCameraValue(preset.id)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            {lab === 'factory' && (
              <div className="dock-block">
                <span className="dock-label">结构</span>
                <div className="chips">
                  <button type="button" className={`chip ${showRoof ? '' : 'is-active'}`} onClick={() => setShowRoof((v) => !v)}>
                    {showRoof ? '隐去屋面' : '显示屋面'}
                  </button>
                  <button type="button" className={`chip ${showWalls ? '' : 'is-active'}`} onClick={() => setShowWalls((v) => !v)}>
                    {showWalls ? '隐去墙板' : '显示墙板'}
                  </button>
                  <button type="button" className={`chip ${showMezzanine ? 'is-active' : ''}`} onClick={() => setShowMezzanine((v) => !v)}>
                    夹层
                  </button>
                </div>
              </div>
            )}
            {lab === 'algo' && (
              <div className="dock-block dock-block--grow">
                <span className="dock-label">回放</span>
                <div className="transport">
                  <button
                    type="button"
                    className={`play ${busy ? 'is-playing' : ''}`}
                    title={busy ? '暂停' : steps > 0 ? '播放（按引擎时间步缓动推进）' : '先运行一次算法'}
                    onClick={() => (steps > 0 ? clock.toggle() : setNotice('先运行一次算法：回放步来自引擎时间轴。'))}
                  >
                    <span aria-hidden>{busy ? '❚❚' : '▶'}</span>
                  </button>
                  <input
                    className="scrub"
                    type="range"
                    min={0}
                    max={Math.max(0, steps)}
                    step={0.02}
                    value={Math.min(clock.t, steps)}
                    disabled={steps <= 0}
                    aria-label="回放进度"
                    onChange={(event) => clock.seek(Number(event.target.value))}
                  />
                  <span className="transport-readout">
                    {clock.t.toFixed(2)} / {steps}
                    <em>{runLabel ? runLabel.split('/').pop() : '未运行'}</em>
                  </span>
                  <div className="chips">
                    {REPLAY_SPEEDS.map((speed) => (
                      <button key={speed} type="button" className={`chip chip--tight ${clock.speed === speed ? 'is-active' : ''}`} onClick={() => clock.setSpeed(speed)}>
                        {speed}×
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ——————————— 右栏：检查器 ——————————— */}
        <HudPanel
          title={lab === 'hero' ? '部件检查器' : lab === 'factory' ? '构件与设备' : '运行指标'}
          scroll
          className="artlab-rail"
          meta={
            <StatChip
              label={lab === 'hero' ? '网格' : lab === 'factory' ? '构件' : '步'}
              value={lab === 'hero' ? heroParts.length : lab === 'factory' ? hallParts.length : steps}
              tone={null}
            />
          }
        >
          {lab === 'hero' && (
            <>
              <HudSection label="实测（来自模型清单与运行时遍历）">
                <div className="stat-grid">
                  <StatChip label="三角形" value={(heroEntry?.triangles ?? 0).toLocaleString('en-US')} tone={null} />
                  <StatChip label="网格" value={heroEntry?.meshes ?? 0} tone={null} />
                  <StatChip label="材质" value={heroEntry?.materials.length ?? 0} tone={null} />
                  <StatChip label="玻璃占比" value={`${((heroEntry?.glassShare ?? 0) * 100).toFixed(1)}%`} tone="var(--sb-ice)" />
                  <StatChip label="透明件" value={heroStats?.transparent ?? 0} tone="var(--sb-cyan)" />
                  <StatChip label="隐藏件" value={heroStats?.hidden ?? 0} tone="var(--sb-muted)" />
                  <StatChip label="未分类" value={heroStats?.unknownRoles.length ?? 0} tone={(heroStats?.unknownRoles.length ?? 0) > 0 ? 'var(--sb-amber)' : null} />
                  <StatChip label="弱化件" value={heroStats?.dimmed ?? 0} tone={null} />
                </div>
                {heroStats && Object.keys(heroStats.roles).length > 0 && (
                  <div className="rolebars">
                    {Object.entries(heroStats.roles)
                      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                      .slice(0, 8)
                      .map(([role, count]) => {
                        const total = Object.values(heroStats.roles).reduce((sum, value) => sum + (value ?? 0), 0) || 1;
                        return (
                          <div className="rolebar" key={role}>
                            <span className={`role-dot role-${role}`} aria-hidden />
                            <span className="rolebar-label">{role}</span>
                            <span className="rolebar-track">
                              <span className="rolebar-fill" style={{ width: `${(((count ?? 0) / total) * 100).toFixed(1)}%` }} />
                            </span>
                            <span className="rolebar-value">{count}</span>
                          </div>
                        );
                      })}
                  </div>
                )}
                {heroStats && heroStats.unknownRoles.length > 0 && (
                  <p className="notice notice--warn">
                    有部件未命中规则：{heroStats.unknownRoles.slice(0, 3).join('、')}。请在 lab/src/art/part-roles.json 补充规则。
                  </p>
                )}
              </HudSection>
              <HudSection label="部件清单（真实遍历）" action={<span className="muted small">{heroParts.length} 个</span>}>
                <div className="pick-list pick-list--parts">
                  {filteredParts.map((part) => (
                    <button
                      key={part.name}
                      type="button"
                      className={`pick pick--part ${emphasizeParts.includes(part.name) ? 'is-active' : ''}`}
                      title={`${part.name}｜角色 ${part.role}｜组 ${part.group}${part.transparent ? '｜可半透明' : ''}`}
                      onClick={() => setEmphasizeParts((list) => (list.includes(part.name) ? list.filter((n) => n !== part.name) : [...list, part.name]))}
                    >
                      <span className={`role-dot role-${part.role}`} aria-hidden />
                      <span className="pick-name">{part.name.length > 34 ? `${part.name.slice(0, 32)}…` : part.name}</span>
                      <span className="pick-meta">
                        {part.role} · {part.group} · {part.triangles.toLocaleString('en-US')} tris{part.transparent ? ' · 半透明' : ''}
                      </span>
                    </button>
                  ))}
                  {!filteredParts.length && <p className="muted small">没有匹配的部件。</p>}
                </div>
                {emphasizeParts.length > 0 && <ToolButton label={`清除高亮（${emphasizeParts.length}）`} onClick={() => setEmphasizeParts([])} />}
              </HudSection>
            </>
          )}

          {lab === 'factory' && (
            <>
              <HudSection label="产线设备布置（真实尺寸摆位）">
                <table className="mini-table">
                  <thead>
                    <tr><th>key</th><th>模型</th><th>坐标 (m)</th></tr>
                  </thead>
                  <tbody>
                    {LINE_EQUIPMENT.map((item) => (
                      <tr key={item.key}>
                        <td>{item.key}</td>
                        <td>{item.model}</td>
                        <td>{item.position[0].toFixed(1)} / {item.position[2].toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </HudSection>
              <HudSection label="工位泊位（APS 机器 → 泊位映射）">
                <table className="mini-table">
                  <thead>
                    <tr><th>泊位</th><th>坐标</th><th>设备</th></tr>
                  </thead>
                  <tbody>
                    {STATION_PADS.map((pad) => (
                      <tr key={pad.id}>
                        <td>{pad.label}</td>
                        <td>{pad.x.toFixed(1)} / {pad.z.toFixed(1)}</td>
                        <td>{pad.equipment ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </HudSection>
              {hallParts.length > 0 && (
                <HudSection label="已装配构件分组">
                  <div className="stat-rows">
                    {[...new Set(hallParts.map((p) => p.group))].map((group) => (
                      <span key={group}>
                        {group}
                        <b>{hallParts.filter((p) => p.group === group).length}</b>
                      </span>
                    ))}
                  </div>
                </HudSection>
              )}
              <HudSection label="透明策略（选择性）">
                <p className="muted small">
                  屋面最先隐去 → 墙板与窗带磨砂半透明 → 柱/桁架保持清晰 → 门窗保留玻璃质感；
                  设备内部机构（frame/graphite/machined/drive/robot/conveyor）永不透明。
                </p>
              </HudSection>
            </>
          )}

          {lab === 'algo' && (
            <>
              <HudSection label="当前运行" action={<span className="muted small">{engineReady ? '引擎就绪' : '引擎未就绪'}</span>}>
                <div className="stat-rows">
                  <span>算法<b>{ART_ALGOS.find((a) => a.id === algo)?.label}</b></span>
                  <span>样例<b>{runLabel ?? '未运行'}</b></span>
                  <span>离散步<b>{steps}</b></span>
                  <span>当前步<b>{clock.t.toFixed(2)}</b></span>
                  <span>速度<b>{clock.speed}×</b></span>
                </div>
                {apsRun && algo === 'aps' && (
                  <div className="stat-rows">
                    <span>工序<b>{apsRun.operations.length}</b></span>
                    <span>机器<b>{apsRun.machines.length}</b></span>
                    <span>核验<b>{apsRun.verify ? (apsRun.verify.ok === false ? '发现问题' : '通过') : '—'}</b></span>
                    <span>时间跨度<b>{((apsRun.maxMs - apsRun.minMs) / 3600000).toFixed(2)} h</b></span>
                  </div>
                )}
                {agvRun && algo === 'agv' && (
                  <div className="stat-rows">
                    <span>车辆<b>{agvRun.solution.plan?.vehicles?.length ?? 0}</b></span>
                    <span>任务<b>{agvRun.solution.plan?.tasks?.length ?? 0}</b></span>
                    <span>完成<b>{(agvRun.solution.plan?.tasks ?? []).filter((t) => t.status === 'DONE').length}</b></span>
                    <span>状态<b>{agvRun.solution.status}</b></span>
                  </div>
                )}
                {mapfRun && algo === 'mapf' && (
                  <div className="stat-rows">
                    <span>机器人<b>{mapfRun.solution.robots.length}</b></span>
                    <span>makespan<b>{mapfRun.solution.makespan ?? '—'}</b></span>
                    <span>SOC<b>{mapfRun.solution.soc ?? '—'}</b></span>
                    <span>最优性<b>{mapfRun.solution.optimality_proven ? '已证明' : '未证明'}</b></span>
                  </div>
                )}
              </HudSection>
              <HudSection label="图例（与 3D 同源配色）">
                <ul className="legend">
                  {(overlay.legend.length ? overlay.legend : [
                    { color: 'var(--sb-ice)', text: '已执行 / 在制' },
                    { color: 'var(--sb-cyan)', text: '计划中（虚线 + 光流）' },
                    { color: 'var(--sb-teal)', text: '完成' },
                    { color: 'var(--sb-coral)', text: '超期 / 违规（引擎报告）' },
                  ]).map((item) => (
                    <li key={item.text}>
                      <span className="legend-dot" style={{ background: item.color }} aria-hidden />
                      {item.text}
                    </li>
                  ))}
                </ul>
                <p className="muted small">回放是**步间缓动插值**：引擎给出的离散事实不变，只是绘制更顺滑。</p>
              </HudSection>
              <HudSection label="泛光（受控）">
                <label className="slider">
                  <span>强度倍率 {settings.bloomStrength.toFixed(2)}</span>
                  <input type="range" min={0} max={1} step={0.05} value={settings.bloomStrength} onChange={(e) => settings.patch({ bloomStrength: Number(e.target.value) })} />
                </label>
                <div className="toggles">
                  <ToolButton label={settings.bloomEnabled ? '泛光开' : '泛光关'} active={settings.bloomEnabled} onClick={() => settings.patch({ bloomEnabled: !settings.bloomEnabled })} />
                  <ToolButton label="算法叠加层" active={settings.showOverlays} onClick={() => settings.patch({ showOverlays: !settings.showOverlays })} />
                  <ToolButton label="接触阴影" active={settings.contactShadow} onClick={() => settings.patch({ contactShadow: !settings.contactShadow })} />
                  <ToolButton label="工程网格" active={settings.showGrid} onClick={() => settings.patch({ showGrid: !settings.showGrid })} />
                  <ToolButton label="比例刻度" active={settings.showScaleMarks} onClick={() => settings.patch({ showScaleMarks: !settings.showScaleMarks })} />
                </div>
                <p className="muted small">
                  当前模式：{mode.label} · 阈值 {mode.bloom.threshold.toFixed(2)} · 强度上限 {mode.bloom.strength.toFixed(2)}（只对自发光路径与状态灯生效）
                </p>
              </HudSection>
            </>
          )}
        </HudPanel>
      </div>
    </div>
  );
}

function engineSummary(
  algo: ArtAlgo,
  aps: ArtLabEngineProps['aps'],
  mapf: ArtLabEngineProps['mapf'],
  agv: ArtLabEngineProps['agv'],
): string {
  if (algo === 'agv') {
    if (!agv) return 'AGV 引擎上下文未注入。';
    return `AGV 引擎：${agv.engineVersion}｜${agv.engineReady ? '就绪' : '未就绪'}｜样例 ${agv.manifest?.mocks?.length ?? 0} 个`;
  }
  if (algo === 'mapf') {
    if (!mapf) return 'MAPF 引擎上下文未注入。';
    return `MAPF 引擎：${mapf.engineVersion}｜${mapf.engineReady ? '就绪' : '未就绪'}｜样例 ${mapf.manifest?.mocks?.length ?? 0} 个`;
  }
  if (!aps) return 'APS 引擎上下文未注入。';
  return `APS 引擎：${aps.engineVersion}｜${aps.engineReady ? '就绪' : '未就绪'}｜样例 ${aps.manifest?.mocks?.length ?? 0} 个`;
}
