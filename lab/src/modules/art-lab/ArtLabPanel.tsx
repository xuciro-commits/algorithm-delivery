/**
 * 三维实验室主面板（本轮任务的落地界面）。
 *
 * 两个工作区：
 *   「阶段一 · 英雄设备实验」：单台上传设备的五组对照视图（原始材质 / 工业科技材质 /
 *      半透明外壳 / 内部机械结构 / 部件检查）+ 真实部件清单；
 *   「透明厂房 · 产线沙盘」：上传厂房构件装配的透明厂房 + 上传产线设备 +
 *     真实算法运行结果（AGV / MAPF / APS）的空间叠加。
 *
 * 三条不变式：
 *   1. 三种视觉模式（A/B/C）共用同一套几何与算法数据，只切换视觉配置；
 *   2. 面板上所有数字（三角形数、部件数、透明件数、状态、耗时）都来自真实读取或引擎输出；
 *   3. 引擎未就绪 / 模型清单缺失时给出可操作提示，绝不显示伪造结果。
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HudPanel, HudSection, Segmented, StatChip, ToolButton } from '../../components/hud';
import { ART_MODES } from '../../art/modes';
import { ART_MODE_LABEL, ART_MODE_OPTIONS } from '../../art/tokens';
import { useArtStore } from '../../art/settings';
import { artAssetUrl, heroModels, type ArtModelEntry } from '../../art/manifest';
import { missingModelKeys, resolveModelUrls } from '../../art/modelPaths';
import type { ApplyStats } from '../../art/materials';
import type { EquipmentPartInfo } from '../../art/EquipmentModel';
import type { AlgoOverlay } from '../../art/overlayModel';
import { EMPTY_OVERLAY } from '../../art/overlayModel';
import { HERO_VIEWS, HeroBench3D, type HeroView } from './HeroBench3D';
import { FactorySandbox3D, type FactoryCameraPreset } from './FactorySandbox3D';
import { buildAgvOverlay, buildApsOverlay, buildMapfOverlay } from './overlay';
import { STATION_PADS, stationForMachine } from './layout';
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
import { useArtManifest } from '../../art/manifest';

export type ArtAlgo = 'agv' | 'mapf' | 'aps';

export interface ArtLabEngineProps {
  aps?: {
    manifest: EngineManifest | null;
    runner: Runner | null;
    engineReady: boolean;
    engineVersion: string;
    assetUrl: (path: string) => string;
    /** 让外壳引擎横幅与其它模块知道本模块正在占用引擎。 */
    setBusy?: (busy: boolean) => void;
    /** 取消当前求解（APS 为 Worker 取消，MAPF/AGV 为停止求解）。 */
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

const REPLAY_INTERVAL_MS = 220;

export function ArtLabPanel({ aps, mapf, agv }: ArtLabEngineProps) {
  const settings = useArtStore();
  const mode = ART_MODES[settings.mode];
  const { status: manifestStatus, manifest, error: manifestError } = useArtManifest();

  const [tab, setTab] = useState<'hero' | 'factory'>('hero');
  const urls = useMemo(() => resolveModelUrls(manifest), [manifest]);
  const missing = useMemo(() => (manifest ? missingModelKeys(urls) : []), [manifest, urls]);
  const heroes = useMemo(() => heroModels(manifest), [manifest]);

  // —— 英雄实验台状态 ——
  const [heroSlug, setHeroSlug] = useState<string | null>(null);
  const [heroView, setHeroView] = useState<HeroView>('art');
  const [heroCamera, setHeroCamera] = useState<'threeQuarter' | 'front' | 'side' | 'top' | 'interior'>('threeQuarter');
  const [heroParts, setHeroParts] = useState<EquipmentPartInfo[]>([]);
  const [heroStats, setHeroStats] = useState<ApplyStats | null>(null);
  const [emphasizeParts, setEmphasizeParts] = useState<string[]>([]);
  const [partFilter, setPartFilter] = useState('');

  useEffect(() => {
    if (!heroSlug && heroes.length) setHeroSlug(heroes[0].slug);
  }, [heroes, heroSlug]);

  const heroEntry: ArtModelEntry | null = useMemo(
    () => heroes.find((h) => h.slug === heroSlug) ?? heroes[0] ?? null,
    [heroes, heroSlug],
  );

  // —— 厂房沙盘状态 ——
  const [factoryCamera, setFactoryCamera] = useState<FactoryCameraPreset>('overview');
  const [showRoof, setShowRoof] = useState(false);
  const [showWalls, setShowWalls] = useState(true);
  const [showMezzanine, setShowMezzanine] = useState(false);
  const [hallParts, setHallParts] = useState<EquipmentPartInfo[]>([]);
  const [algo, setAlgo] = useState<ArtAlgo>('agv');
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [agvRun, setAgvRun] = useState<AgvRun | null>(null);
  const [mapfRun, setMapfRun] = useState<MapfRun | null>(null);
  const [apsRun, setApsRun] = useState<ApsRun | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const steps = algo === 'agv' ? agvRun?.steps ?? 0 : algo === 'mapf' ? mapfRun?.steps ?? 0 : 0;

  useEffect(() => {
    if (!playing) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return undefined;
    }
    timerRef.current = setInterval(() => {
      setStep((s) => {
        if (s >= steps) {
          setPlaying(false);
          return s;
        }
        return s + 1;
      });
    }, REPLAY_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [playing, steps]);

  const overlay: AlgoOverlay = useMemo(() => {
    if (!settings.showOverlays) return EMPTY_OVERLAY;
    if (algo === 'agv' && agvRun) return buildAgvOverlay({ problem: agvRun.problem, solution: agvRun.solution, step });
    if (algo === 'mapf' && mapfRun) return buildMapfOverlay({ problem: mapfRun.problem, solution: mapfRun.solution, step });
    if (algo === 'aps' && apsRun) {
      const machineStations = new Map(apsRun.machines.map((id, i) => [id, stationForMachine(i)]).filter(([, pad]) => Boolean(pad)) as Array<[string, NonNullable<ReturnType<typeof stationForMachine>>]>);
      const span = Math.max(1, apsRun.maxMs - apsRun.minMs);
      const nowMs = apsRun.minMs + (span * step) / Math.max(1, steps || 60);
      return buildApsOverlay({ operations: apsRun.operations, machineStations, nowMs, verify: apsRun.verify });
    }
    return EMPTY_OVERLAY;
  }, [settings.showOverlays, algo, agvRun, mapfRun, apsRun, step, steps]);

  const flowOffset = useMemo(() => step * 0.36, [step]);

  // —— 真实求解 ——
  const runAlgorithm = useCallback(async () => {
    setNotice(null);
    setPlaying(false);
    setStep(0);
    // 引擎是共享资源：占用期间通知外壳，避免与其它模块的求解互相争抢。
    const markBusy = (value: boolean) => {
      const setBusy = algo === 'agv' ? agv?.setBusy : algo === 'mapf' ? mapf?.setBusy : aps?.setBusy;
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
        const text = await res.text();
        const scene = parseAgvScene(text);
        const outcome = await agv.handle.solve(serializeAgvScene(scene), { algorithm: scene.solver.algorithm, time_limit_ms: scene.solver.time_limit_ms, verify: true });
        const solution = outcome.solution as AgvSolution | null;
        if (!solution) throw new Error('引擎未返回方案');
        setAgvRun({
          problem: { map: scene.map, vehicles: scene.vehicles, tasks: scene.tasks, stations: scene.stations, id: scene.id } as AgvProblemLite,
          solution,
          steps: solution.plan?.vehicles?.reduce((max, v) => Math.max(max, (v.timeline?.length ?? 1) - 1), 0) ?? 0,
          label: entry.file,
        });
        setStep(0);
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
        const outcome = await mapf.handle.solve(serializeScene(doc), { objective: doc.objective.kind, suboptimality_factor: doc.solver.suboptimality_factor, planner: doc.solver.planner, seed: doc.solver.seed, verify: true });
        const solution = outcome.solution as MapfSolution | null;
        if (!solution) throw new Error('引擎未返回方案');
        setMapfRun({
          problem: { map: { width: dims.width, height: dims.height, cells: doc.map.cells }, robots: doc.robots, id: doc.id } as MapfProblemLite,
          solution,
          steps: solution.robots.reduce((max, r) => Math.max(max, (r.path?.length ?? 1) - 1), 0),
          label: entry.file,
        });
        setStep(0);
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
    markBusy(true);
    try {
      const problem = await loadProblem(entry, aps.assetUrl);
      const record = await aps.runner.run({ problem, problemName: entry.name, params: DEFAULT_PARAMS, verify: true });
      const operations = record.solution?.operations ?? [];
      if (!operations.length) throw new Error(record.error ?? '方案中没有工序');
      const times = operations.flatMap((op) => [parseIsoMs(op.start_at), parseIsoMs(op.end_at)]).filter((v) => Number.isFinite(v));
      const machines = [...new Set(operations.map((op) => op.machine_id))];
      setApsRun({
        operations,
        machines,
        verify: record.verify ?? null,
        minMs: Math.min(...times),
        maxMs: Math.max(...times),
        label: entry.name,
        status: `${record.status}${record.verify?.ok === false ? ' · 核验发现问题' : ''}`,
      });
      setStep(0);
      setNotice(`已用真实 APS 引擎求解「${entry.name}」：${record.status}，${operations.length} 道工序`);
    } catch (err) {
      setNotice(`APS 求解失败：${(err as Error).message}`);
    } finally {
      setRunning(false);
      markBusy(false);
    }
  }, [algo, agv, mapf, aps]);

  const play = useCallback(() => {
    if (steps <= 0) {
      setNotice('先运行一次算法：回放步来自引擎时间轴，没有方案就没有可回放的时间步。');
      return;
    }
    setPlaying((p) => {
      const next = !p;
      if (next) setStep((s) => (s >= steps ? 0 : s));
      return next;
    });
  }, [steps]);

  const filteredParts = useMemo(() => {
    const q = partFilter.trim().toLowerCase();
    const list = q ? heroParts.filter((p) => p.name.toLowerCase().includes(q) || p.role.includes(q) || p.group.includes(q)) : heroParts;
    return list.slice(0, 60);
  }, [heroParts, partFilter]);

  const activeRunLabel = algo === 'agv' ? agvRun?.label : algo === 'mapf' ? mapfRun?.label : apsRun?.label;

  return (
    <div className="artlab">
      <HudPanel
        title="三维实验室 · 工业模型艺术化"
        className="artlab-head"
        actions={
          <div className="hud-row">
            <Segmented
              ariaLabel="视觉模式"
              options={ART_MODE_OPTIONS}
              value={settings.mode}
              onChange={settings.setMode}
            />
            <Segmented
              ariaLabel="工作区"
              options={[
                { id: 'hero', label: '阶段一 · 英雄设备' },
                { id: 'factory', label: '透明厂房 · 产线沙盘' },
              ]}
              value={tab}
              onChange={setTab}
            />
          </div>
        }
        meta={
          <>
            <StatChip label="模式" value={ART_MODE_LABEL[settings.mode]} tone={settings.mode === 'B' ? 'var(--sb-ice)' : null} title={mode.tagline} />
            <StatChip
              label="模型清单"
              value={manifestStatus === 'ready' ? `${manifest?.totals.models ?? 0} 个` : manifestStatus === 'loading' ? '读取中' : '缺失'}
              tone={manifestStatus === 'ready' ? 'var(--sb-teal)' : 'var(--sb-coral)'}
              title={manifestError ?? '由 lab/scripts/sync-assets.mjs 生成'}
            />
          </>
        }
      >
        <p className="artlab-mode-note">{mode.tagline}</p>
        {manifestStatus === 'missing' && <p className="artlab-warn">{manifestError}</p>}
        {missing.length > 0 && (
          <p className="artlab-warn">
            清单缺少 {missing.length} 个模型（{missing.slice(0, 4).join('、')}{missing.length > 4 ? '…' : ''}）：这些构件不会渲染，也不会用占位几何替代。
          </p>
        )}
      </HudPanel>

      <div className="artlab-grid">
        {/* ——— 左栏：英雄设备 / 产线设备 ——— */}
        <HudPanel
          title={tab === 'hero' ? '英雄设备实验' : '产线设备与厂房构件'}
          scroll
          className="artlab-rail"
          meta={<StatChip label="资产" value={tab === 'hero' ? `${heroes.length} 台` : `${hallParts.length} 件`} tone={null} />}
        >
          {tab === 'hero' ? (
            <>
              <HudSection label="设备选择（按结构复杂度的真实评分排序）">
                <div className="artlab-list">
                  {heroes.map((model) => (
                    <button
                      key={model.slug}
                      type="button"
                      className={`artlab-item ${model.slug === heroEntry?.slug ? 'active' : ''}`}
                      onClick={() => {
                        setHeroSlug(model.slug);
                        setEmphasizeParts([]);
                      }}
                    >
                      <b>{model.slug}</b>
                      <span>
                        {model.triangles.toLocaleString('en-US')} tris · {model.meshes} 网格 · {(model.sizeMeters ?? []).map((v) => v.toFixed(2)).join('×')} m
                      </span>
                      <em>评分 {model.heroScore ?? '—'} · 透明潜力 {model.transparentCapable ? '有' : '无'}</em>
                    </button>
                  ))}
                  {!heroes.length && <p className="muted small">等待模型清单（先运行 node lab/scripts/sync-assets.mjs）。</p>}
                </div>
              </HudSection>

              <HudSection label="部件清单（真实遍历结果）" action={<span className="muted small">{heroParts.length} 个网格</span>}>
                <input
                  className="artlab-search"
                  value={partFilter}
                  placeholder="按名称 / 角色 / 部件组过滤（如 door、glass、machine）"
                  onChange={(event) => setPartFilter(event.target.value)}
                />
                <div className="artlab-parts">
                  {filteredParts.map((part) => (
                    <button
                      key={part.name}
                      type="button"
                      className={`artlab-part ${emphasizeParts.includes(part.name) ? 'active' : ''}`}
                      title={`${part.name}｜角色 ${part.role}｜组 ${part.group}${part.transparent ? '｜可半透明' : ''}`}
                      onClick={() =>
                        setEmphasizeParts((list) => (list.includes(part.name) ? list.filter((n) => n !== part.name) : [...list, part.name]))
                      }
                    >
                      <span className={`role-dot role-${part.role}`} aria-hidden />
                      <b>{part.name.length > 34 ? `${part.name.slice(0, 32)}…` : part.name}</b>
                      <span>
                        {part.role} · {part.group} · {part.triangles.toLocaleString('en-US')} tris
                        {part.transparent ? ' · 半透明' : ''}
                      </span>
                    </button>
                  ))}
                  {!filteredParts.length && <p className="muted small">没有匹配的部件。</p>}
                </div>
                {emphasizeParts.length > 0 && (
                  <ToolButton label="清除部件高亮" onClick={() => setEmphasizeParts([])} />
                )}
              </HudSection>
            </>
          ) : (
            <>
              <HudSection label="厂房构件（上传模块，6 m 柱距装配）">
                <p className="muted small">
                  {hallParts.length
                    ? `已装配构件 ${hallParts.length} 类：${[...new Set(hallParts.map((p) => p.group))].join('、')}`
                    : '切换“透明厂房 · 产线沙盘”后会读取装配统计。'}
                </p>
                <p className="muted small">
                  屋面 / 墙板 / 天窗 / 柱 / 桁架来自 12 个上传构件：hall-steel-column、hall-roof-truss-bay-6-m、
                  hall-roof-cladding-bay-6-m、hall-ridge-skylight-bay、hall-wall-bay-with-high-windows 等。
                </p>
              </HudSection>
              <HudSection label="产线设备（上传模型，按真实尺寸摆放）">
                <table className="artlab-table">
                  <thead>
                    <tr>
                      <th>工位</th>
                      <th>坐标 (m)</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {STATION_PADS.map((pad) => (
                      <tr key={pad.id}>
                        <td>{pad.label}</td>
                        <td>
                          {pad.x.toFixed(1)} / {pad.z.toFixed(1)}
                        </td>
                        <td>APS 机器按下标映射到该泊位</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </HudSection>
              <HudSection label="算法运行">
                <Segmented
                  ariaLabel="算法"
                  options={[
                    { id: 'agv', label: 'AGV 调度' },
                    { id: 'mapf', label: 'MAPF 路径' },
                    { id: 'aps', label: 'APS 排程' },
                  ]}
                  value={algo}
                  onChange={setAlgo}
                />
                <div className="hud-row">
                  <ToolButton label={running ? '求解中…' : '运行真实引擎'} tone="primary" disabled={running} onClick={() => void runAlgorithm()} />
                  <ToolButton label="读取当前引擎状态" onClick={() => setNotice(engineSummary(algo, aps, mapf, agv))} />
                  {running && Boolean(algo === 'aps' ? aps?.cancelSolve : algo === 'mapf' ? mapf?.cancelSolve : agv?.cancelSolve) && (
                    <ToolButton
                      label="取消求解"
                      tone="danger"
                      onClick={() => {
                        const cancel = algo === 'aps' ? aps?.cancelSolve : algo === 'mapf' ? mapf?.cancelSolve : agv?.cancelSolve;
                        cancel?.();
                        setNotice('已请求取消：引擎返回后本次结果作废（不会显示半截数据）。');
                      }}
                    />
                  )}
                </div>
                <p className="muted small">
                  {algo === 'agv' && `引擎 ${agv?.engineVersion ?? '—'}｜${agv?.engineReady ? '就绪' : '未就绪'}`}
                  {algo === 'mapf' && `引擎 ${mapf?.engineVersion ?? '—'}｜${mapf?.engineReady ? '就绪' : '未就绪'}`}
                  {algo === 'aps' && `引擎 ${aps?.engineVersion ?? '—'}｜${aps?.engineReady ? '就绪' : '未就绪'}`}
                </p>
                {notice && <p className="artlab-notice">{notice}</p>}
              </HudSection>
            </>
          )}
        </HudPanel>

        {/* ——— 中央：3D 舞台 ——— */}
        <div className="artlab-stage">
          {tab === 'hero' ? (
            <HeroBench3D
              url={heroEntry ? artAssetUrl(heroEntry.url) : null}
              view={heroView}
              emphasizeParts={emphasizeParts}
              onParts={setHeroParts}
              onStats={setHeroStats}
              cameraPreset={heroCamera}
              active={false}
              sizeMeters={heroEntry?.sizeMeters ?? null}
            />
          ) : (
            <Suspense fallback={<div className="artlab-stage-loading">正在装配透明厂房…</div>}>
              <FactorySandbox3D
                urls={urls}
                overlay={overlay}
                cameraPreset={factoryCamera}
                active={playing}
                showRoof={showRoof}
                showWalls={showWalls}
                showMezzanine={showMezzanine}
                flowOffset={flowOffset}
                onHallParts={setHallParts}
              />
            </Suspense>
          )}
          <div className="artlab-stage-bar">
            <Segmented
              ariaLabel="相机预设"
              options={
                tab === 'hero'
                  ? [
                      { id: 'threeQuarter', label: '3/4 视角' },
                      { id: 'front', label: '正面' },
                      { id: 'side', label: '侧面' },
                      { id: 'top', label: '俯视' },
                      { id: 'interior', label: '内部' },
                    ]
                  : [
                      { id: 'overview', label: '全景' },
                      { id: 'aisle', label: '通道' },
                      { id: 'line', label: '产线' },
                      { id: 'top', label: '俯视' },
                      { id: 'entry', label: '入口' },
                    ]
              }
              value={tab === 'hero' ? heroCamera : factoryCamera}
              onChange={(id) => (tab === 'hero' ? setHeroCamera(id as typeof heroCamera) : setFactoryCamera(id as FactoryCameraPreset))}
            />
            {tab === 'factory' && (
              <div className="hud-row">
                <ToolButton label={playing ? '暂停回放' : '按引擎时间步回放'} active={playing} onClick={play} />
                <span className="muted small">
                  步 {step}/{steps} {activeRunLabel ? `· ${activeRunLabel}` : ''}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* ——— 右栏：艺术化控制 + 算法叠加信息 ——— */}
        <HudPanel title="艺术化控制" scroll className="artlab-rail">
          <HudSection label="透明与层次（选择性，不是整场透明）">
            <div className="artlab-toggles">
              <ToolButton label="透明厂房" active={settings.transparentFactory} onClick={() => settings.patch({ transparentFactory: !settings.transparentFactory })} />
              <ToolButton label="隐藏屋顶" active={showRoof} onClick={() => setShowRoof((v) => !v)} />
              <ToolButton label="隐藏墙板" active={!showWalls} onClick={() => setShowWalls((v) => !v)} />
              <ToolButton label="夹层平台" active={showMezzanine} onClick={() => setShowMezzanine((v) => !v)} />
              <ToolButton label="高质量玻璃(transmission)" active={settings.physicalGlass} onClick={() => settings.patch({ physicalGlass: !settings.physicalGlass })} />
            </div>
            <label className="artlab-slider">
              <span>结构透明强度 {settings.structureAlpha.toFixed(2)}</span>
              <input type="range" min={0} max={1} step={0.05} value={settings.structureAlpha} onChange={(e) => settings.patch({ structureAlpha: Number(e.target.value) })} />
            </label>
            <label className="artlab-slider">
              <span>外壳透明强度 {settings.shellAlpha.toFixed(2)}</span>
              <input type="range" min={0} max={1} step={0.05} value={settings.shellAlpha} onChange={(e) => settings.patch({ shellAlpha: Number(e.target.value) })} />
            </label>
          </HudSection>

          <HudSection label="灯光与后期（无后处理：发光来自自发光材质 + 双层细线）">
            <div className="artlab-toggles">
              <ToolButton label="接触阴影" active={settings.contactShadow} onClick={() => settings.patch({ contactShadow: !settings.contactShadow })} />
              <ToolButton label="工程网格" active={settings.showGrid} onClick={() => settings.patch({ showGrid: !settings.showGrid })} />
              <ToolButton label="比例刻度" active={settings.showScaleMarks} onClick={() => settings.patch({ showScaleMarks: !settings.showScaleMarks })} />
              <ToolButton label="算法叠加层" active={settings.showOverlays} onClick={() => settings.patch({ showOverlays: !settings.showOverlays })} />
              <ToolButton label="模式 C 弱化" active={settings.deEmphasize} onClick={() => settings.patch({ deEmphasize: !settings.deEmphasize })} />
            </div>
            <p className="muted small">
              主光强度 {mode.lights.key.intensity.toFixed(2)}｜补光 {mode.lights.fill.intensity.toFixed(2)}｜轮廓光 {mode.lights.rim.intensity.toFixed(2)}｜
              曝光 {mode.exposure.toFixed(2)}｜阴影贴图 {mode.lights.key.mapSize}px
            </p>
          </HudSection>

          {tab === 'hero' ? (
            <>
              <HudSection label="阶段一对照视图">
                <Segmented ariaLabel="英雄视图" options={HERO_VIEWS.map((v) => ({ id: v.id, label: v.label, title: v.hint }))} value={heroView} onChange={setHeroView} />
                <p className="muted small">{HERO_VIEWS.find((v) => v.id === heroView)?.hint}</p>
              </HudSection>
              <HudSection label="本机实测（来自模型与遍历结果）">
                <div className="artlab-stats">
                  <StatChip label="三角形" value={(heroEntry?.triangles ?? 0).toLocaleString('en-US')} tone={null} />
                  <StatChip label="网格" value={heroEntry?.meshes ?? 0} tone={null} />
                  <StatChip label="材质" value={heroEntry?.materials.length ?? 0} tone={null} />
                  <StatChip label="玻璃占比" value={`${((heroEntry?.glassShare ?? 0) * 100).toFixed(1)}%`} tone="var(--sb-ice)" />
                  <StatChip label="透明件" value={heroStats?.transparent ?? 0} tone="var(--sb-cyan)" />
                  <StatChip label="隐藏件" value={heroStats?.hidden ?? 0} tone="var(--sb-muted)" />
                  <StatChip label="未分类件" value={heroStats?.unknownRoles.length ?? 0} tone={(heroStats?.unknownRoles.length ?? 0) > 0 ? 'var(--sb-amber)' : null} />
                </div>
                {heroStats && Object.keys(heroStats.roles).length > 0 && (
                  <p className="muted small">
                    角色分布：
                    {Object.entries(heroStats.roles)
                      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                      .map(([role, count]) => `${role}×${count}`)
                      .join(' · ')}
                  </p>
                )}
                {heroStats && heroStats.unknownRoles.length > 0 && (
                  <p className="artlab-warn">
                    有部件未命中规则：{heroStats.unknownRoles.slice(0, 3).join('、')}。请在 lab/src/art/part-roles.json 补充规则，而不是让它们随波逐流地变成金属色。
                  </p>
                )}
              </HudSection>
            </>
          ) : (
            <>
              <HudSection label="算法叠加（全部来自真实引擎输出）">
                <p className="artlab-status">{overlay.label}</p>
                <p className="muted small">{overlay.status}</p>
                <p className="muted small">{overlay.mapping}</p>
                <ul className="artlab-legend">
                  {overlay.legend.map((item) => (
                    <li key={item.text}>
                      <span className="legend-dot" style={{ background: item.color }} aria-hidden />
                      {item.text}
                    </li>
                  ))}
                </ul>
              </HudSection>
              <HudSection label="空间语汇对应关系">
                <table className="artlab-table">
                  <tbody>
                    <tr>
                      <td>AGV 调度</td>
                      <td>车辆时间轴 → 已执行/计划轨迹 + 任务取送点 + 相位状态光 + 超期事件</td>
                    </tr>
                    <tr>
                      <td>MAPF 路径</td>
                      <td>机器人 path → 多色轨迹 + 目标投影 + 到达状态</td>
                    </tr>
                    <tr>
                      <td>APS 排程</td>
                      <td>工序区间 → 工位状态光 + 订单工序流转线 + 核验违规标记</td>
                    </tr>
                  </tbody>
                </table>
              </HudSection>
              <HudSection label="透明厂房说明">
                <p className="muted small">
                  屋面（roof）最先隐去 → 墙板与窗带磨砂半透明 → 柱子 / 桁架保持清晰 → 天窗与门窗保留玻璃质感。
                  内部设备始终保持不透明，保证“从外部看清生产系统”。
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
