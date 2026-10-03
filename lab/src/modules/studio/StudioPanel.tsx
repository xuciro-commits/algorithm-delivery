/**
 * 视觉工作室（Visual Studio）· 阶段一「单模型艺术化实验」的交付界面。
 *
 * 用途（对应需求 §九 阶段一、§九 阶段四）：
 *   1. 审查既有模型的部件划分（真实几何统计：三角面、尺寸、材质、判定角色）；
 *   2. 在同一相机机位下对比 模式 A（工业原貌）/ 模式 B（工业科技艺术化）/ 模式 C（算法观察）；
 *   3. 控制半透明外壳强度、外壳显隐、爆炸视图、部件高亮；
 *   4. 一键导出**浏览器真实 WebGL 截图**与 A/B 并排对比图；
 *   5. 一键做真实帧率/绘制调用测量（不是参数估算）。
 *
 * 本页不产生任何算法数据：算法可视化只在三个算法实验室里由真实引擎输出驱动。
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContactShadows } from '@react-three/drei';
import { HudPanel, HudSection, Segmented, StatChip, ToolButton } from '../../components/hud';
import { VP } from '../../visual/palette';
import type { PartRole } from '../../visual/roles';
import { QUALITY_TIERS, VISUAL_MODE_LIST, resolveMode, resolveQuality, type QualityTier, type VisualModeId } from '../../visual/modes';
import { ModelStage, inspectionBounds } from '../../visual/ModelStage';
import { StageShell, type StageApi } from '../../visual/StageShell';
import { TechDeck } from '../../visual/TechDeck';
import { HERO_MODEL_KEY, findAsset, useVisualManifest, visualBaseUrl, visualModelUrl } from '../../visual/manifest';
import type { ModelInspection, PartInfo } from '../../visual/inspect';
import { useVisualStore, type CameraPresetId } from '../../visual/store';
import { captureCanvas, composeSideBySide, downloadDataUrl, nextFrames, timestamp, type CapturedShot } from '../../visual/capture';

const CAMERA_PRESETS: Array<{ id: CameraPresetId; label: string; hint: string }> = [
  { id: 'iso', label: '等距', hint: '三分之四等距视角（默认验收机位）' },
  { id: 'front', label: '正视', hint: '正面，用于核对防护门与操作面' },
  { id: 'side', label: '侧视', hint: '侧面，用于核对结构与深度关系' },
  { id: 'top', label: '俯视', hint: '俯视，用于核对布局与占地' },
  { id: 'detail', label: '近景', hint: '近景，用于观察材质与机械细节' },
];

const ROLE_LABEL: Record<PartRole, string> = {
  shell: '外壳/罩壳',
  glass: '玻璃/窗口',
  structure: '结构件',
  building: '厂房围护',
  metal: '精加工金属',
  darkmetal: '深色金属',
  mechanism: '内部机构',
  rubber: '皮带/轮胎',
  accent: '涂装色',
  emissive: '灯/屏',
  floor: '地面构件',
  detail: '其它细节',
};

const ROLE_TONE: Record<PartRole, string> = {
  shell: VP.iceGlass,
  glass: VP.cyanGlass,
  structure: VP.steelDark,
  building: VP.iceGlassDeep,
  metal: VP.brushed,
  darkmetal: VP.graphiteLight,
  mechanism: VP.ice,
  rubber: '#6b737c',
  accent: VP.amber,
  emissive: VP.cyan,
  floor: VP.base,
  detail: VP.muted,
};

interface PerfResult {
  fps: number;
  frameMs: number;
  worstMs: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  renderer: string;
  mode: VisualModeId;
  quality: QualityTier;
  at: string;
}

export function StudioPanel() {
  const manifestState = useVisualManifest();
  const manifest = manifestState.status === 'ready' ? manifestState.manifest : null;

  const [selectedKey, setSelectedKey] = useState<string>(HERO_MODEL_KEY);
  const [inspection, setInspection] = useState<ModelInspection | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<PartRole | 'all'>('all');
  const [bench, setBench] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [perf, setPerf] = useState<PerfResult | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const apiRef = useRef<StageApi | null>(null);

  const mode = useVisualStore((state) => state.mode);
  const quality = useVisualStore((state) => state.quality);
  const shellScale = useVisualStore((state) => state.shellScale);
  const explode = useVisualStore((state) => state.explode);
  const showShells = useVisualStore((state) => state.showShells);
  const camera = useVisualStore((state) => state.camera);
  const highlight = useVisualStore((state) => state.highlight);
  const setMode = useVisualStore((state) => state.setMode);
  const setQuality = useVisualStore((state) => state.setQuality);
  const setShellScale = useVisualStore((state) => state.setShellScale);
  const setExplode = useVisualStore((state) => state.setExplode);
  const setShowShells = useVisualStore((state) => state.setShowShells);
  const setCamera = useVisualStore((state) => state.setCamera);
  const setHighlight = useVisualStore((state) => state.setHighlight);

  const modeConfig = resolveMode(mode);
  const qualityConfig = resolveQuality(quality);
  const baseUrl = visualBaseUrl();
  const asset = findAsset(manifest, selectedKey) ?? manifest?.assets[0] ?? null;

  const note = useCallback((message: string) => {
    setNotes((prev) => [`${new Date().toLocaleTimeString()} · ${message}`, ...prev].slice(0, 8));
  }, []);

  useEffect(() => {
    setInspection(null);
    setLoadedKey(null);
  }, [asset?.key]);

  const bounds = useMemo(() => inspectionBounds(inspection, 3), [inspection]);
  const deckSize = useMemo(() => Math.max(14, bounds.radius * 12), [bounds.radius]);
  const deckCell = bounds.radius > 6 ? 2 : bounds.radius > 2.5 ? 0.5 : 0.25;

  const parts = inspection?.parts ?? [];
  const filteredParts = useMemo(
    () => (roleFilter === 'all' ? parts : parts.filter((part) => part.role === roleFilter)),
    [parts, roleFilter],
  );
  const heaviest = useMemo(() => [...parts].sort((a, b) => b.triangles - a.triangles).slice(0, 5), [parts]);

  /** 真实帧率/绘制调用测量：采样 1.5 秒，取平均与最差帧。 */
  const runBenchmark = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    setBench(true);
    note('性能测量开始（1.5s 连续渲染）');
    await nextFrames(12);
    const frames: number[] = [];
    let last = performance.now();
    const deadline = last + 1500;
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        frames.push(now - last);
        last = now;
        if (now >= deadline) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const info = api.renderer?.info;
    const context = api.renderer?.getContext();
    const debug = context?.getExtension('WEBGL_debug_renderer_info');
    const usable = frames.slice(1);
    const avg = usable.reduce((sum, value) => sum + value, 0) / Math.max(1, usable.length);
    const result: PerfResult = {
      fps: 1000 / Math.max(0.001, avg),
      frameMs: avg,
      worstMs: usable.reduce((max, value) => Math.max(max, value), 0),
      drawCalls: info?.render.calls ?? 0,
      triangles: info?.render.triangles ?? 0,
      programs: info?.programs?.length ?? 0,
      renderer: String(
        context
          ? debug
            ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL)
            : context.getParameter(context.RENDERER)
          : 'unknown',
      ),
      mode,
      quality,
      at: new Date().toLocaleTimeString(),
    };
    setPerf(result);
    setBench(false);
    note(`性能测量完成：${result.fps.toFixed(1)} fps · ${result.drawCalls} draw calls · ${result.triangles.toLocaleString()} 三角面`);
  }, [mode, quality, note]);

  const captureSingle = useCallback(async () => {
    const api = apiRef.current;
    if (!api?.canvas) return;
    setCapturing(true);
    await nextFrames(4);
    const dataUrl = captureCanvas(api.canvas);
    downloadDataUrl(`lab-studio-${asset?.key ?? 'model'}-${mode}-${timestamp()}.png`, dataUrl);
    setCapturing(false);
    note(`已导出单张截图（模式 ${mode}，画布 ${api.canvas.width}×${api.canvas.height}）`);
  }, [asset?.key, mode, note]);

  /** 同机位 A/B（可选 C）对比导出：直接读取真实 WebGL 画布像素。 */
  const captureComparison = useCallback(async () => {
    const api = apiRef.current;
    if (!api?.canvas) return;
    const previous = mode;
    setCapturing(true);
    const shots: CapturedShot[] = [];
    const targets: VisualModeId[] = ['A', 'B', 'C'];
    for (const target of targets) {
      setMode(target);
      await nextFrames(6);
      shots.push({
        label: `模式 ${target} · ${resolveMode(target).name}`,
        dataUrl: captureCanvas(api.canvas),
        meta: {
          三角面: inspection?.totals.triangles ?? 0,
          部件: inspection?.totals.parts ?? 0,
          画布: `${api.canvas.width}×${api.canvas.height}`,
        },
      });
    }
    setMode(previous);
    const composed = await composeSideBySide(shots, {
      title: `Algorithm Lab · ${asset?.title ?? ''} — 同一相机 / 同一几何，仅切换视觉模式`,
    });
    downloadDataUrl(`lab-compare-${asset?.key ?? 'model'}-ABC-${timestamp()}.png`, composed);
    setCapturing(false);
    note('已导出 A/B/C 对比图（真实 WebGL 像素）');
  }, [asset?.key, asset?.title, inspection, mode, note, setMode]);

  const active = bench || capturing;

  if (manifestState.status === 'error') {
    return (
      <section className="panel">
        <h3>视觉工作室</h3>
        <p className="muted">
          视觉资产清单不可用：{manifestState.error}
        </p>
        <p className="muted small">
          该清单由 <code>npm run sync:visual</code>（<code>scripts/sync-visual-assets.mjs</code>）从仓库内既有资产
          <code> lab/design/assets</code> 原样复制生成；源模型从不被修改。
        </p>
      </section>
    );
  }

  return (
    <div className="studio-panel" data-mode={mode}>
      <aside className="studio-rail">
        <HudPanel
          title="模型库"
          meta={<span className="hud-chip">{manifest ? `${manifest.total} 个` : '载入中'}</span>}
          scroll
        >
          <HudSection label="阶段一主角">
            <p className="studio-note">
              结构最复杂、机械细节最丰富的加工设备：独立防护门组（含玻璃）、卡盘/尾座/刀塔机构、
              10 套原始材质 —— 用于验证材质语言与半透明外壳策略。
            </p>
          </HudSection>
          {manifest?.assets.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={`studio-model ${entry.key === asset?.key ? 'active' : ''}`}
              onClick={() => setSelectedKey(entry.key)}
              title={entry.summary || entry.title}
            >
              <span className="studio-model-title">{entry.title}</span>
              <span className="studio-model-meta">
                {entry.category} · {entry.triangles?.toLocaleString() ?? '?'} 面 ·{' '}
                {entry.sizeMeters ? `${entry.sizeMeters.map((value) => value.toFixed(2)).join(' × ')} m` : '尺寸未知'}
              </span>
              {entry.animations.length > 0 && <span className="studio-badge">动画 {entry.animations.length}</span>}
            </button>
          ))}
        </HudPanel>
      </aside>

      <div className="studio-stage-wrap">
        <div className="studio-toolbar">
          <Segmented
            ariaLabel="视觉模式"
            value={mode}
            onChange={(id) => setMode(id)}
            options={VISUAL_MODE_LIST.map((entry) => ({ id: entry.id, label: `${entry.id} · ${entry.name}`, title: entry.tagline }))}
          />
          <Segmented
            ariaLabel="相机预设"
            value={camera}
            onChange={(id) => setCamera(id)}
            options={CAMERA_PRESETS.map((entry) => ({ id: entry.id, label: entry.label, title: entry.hint }))}
          />
          <select
            className="studio-select"
            value={quality}
            aria-label="渲染质量"
            onChange={(event) => setQuality(event.target.value as QualityTier)}
          >
            {Object.values(QUALITY_TIERS).map((tier) => (
              <option key={tier.id} value={tier.id}>
                {tier.label}
              </option>
            ))}
          </select>
          <ToolButton label="导出截图" onClick={captureSingle} disabled={!loadedKey || capturing} />
          <ToolButton label="A/B/C 对比" onClick={captureComparison} disabled={!loadedKey || capturing} tone="primary" />
          <ToolButton label="性能测量" onClick={runBenchmark} disabled={!loadedKey || bench} />
        </div>

        <div className="studio-stage">
          {asset && (
            <StageShell
              mode={modeConfig}
              quality={qualityConfig}
              bounds={bounds}
              view={camera}
              active={active}
              capture
              onApi={(api) => {
                apiRef.current = api;
              }}
              practicalLine={{ from: -bounds.radius * 1.4, to: bounds.radius * 1.4, y: Math.max(2.6, bounds.height * 1.35), z: bounds.radius * 1.1 }}
            >
              <TechDeck size={deckSize} cell={deckCell} config={modeConfig.ground} zone={{ halfX: bounds.radius * 1.25, halfZ: bounds.radius * 1.25 }} />
              {modeConfig.contactShadows && quality !== 'low' && (
                <ContactShadows
                  position={[0, 0.004, 0]}
                  scale={Math.max(6, bounds.radius * 4)}
                  blur={2.6}
                  opacity={0.5}
                  far={Math.max(2, bounds.height * 1.6)}
                  resolution={qualityConfig.contactShadowResolution}
                  color="#04080e"
                />
              )}
              <Suspense fallback={null}>
                <ModelStage
                  asset={asset}
                  baseUrl={baseUrl}
                  keyMachine
                  onInspect={(result) => {
                    setInspection(result);
                    setLoadedKey(asset.key);
                  }}
                  onPartClick={(part) => {
                    if (part) note(`选中部件 ${part.id}（${ROLE_LABEL[part.role]}，${part.triangles.toLocaleString()} 面）`);
                  }}
                />
              </Suspense>
            </StageShell>
          )}

          <div className="studio-overlay">
            <div className="hud-row">
              <StatChip label="模式" value={`${mode} · ${modeConfig.name}`} tone={VP.ice} />
              <StatChip label="部件" value={inspection ? inspection.totals.parts : '—'} tone={VP.cyan} />
              <StatChip label="三角面" value={inspection ? inspection.totals.triangles.toLocaleString() : '—'} />
              <StatChip label="材质" value={inspection ? inspection.totals.materials.length : '—'} />
              <StatChip label="真实尺寸" value={inspection ? `${inspection.totals.size.map((value) => value.toFixed(2)).join('×')} m` : '—'} />
            </div>
            <p className="studio-caption">{modeConfig.tagline}</p>
            {!loadedKey && <p className="studio-loading">正在载入模型…（首次加载会解析 GLB 并做部件审查）</p>}
          </div>
        </div>

        <div className="studio-controls">
          <label className="studio-slider">
            <span>半透明外壳强度</span>
            <input
              type="range"
              min={0}
              max={1.6}
              step={0.05}
              value={shellScale}
              onChange={(event) => setShellScale(Number(event.target.value))}
            />
            <b>{shellScale.toFixed(2)}</b>
          </label>
          <label className="studio-slider">
            <span>爆炸视图</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={explode}
              onChange={(event) => setExplode(Number(event.target.value))}
            />
            <b>{explode.toFixed(2)}</b>
          </label>
          <label className="studio-check">
            <input type="checkbox" checked={showShells} onChange={(event) => setShowShells(event.target.checked)} />
            <span>显示外壳（取消勾选即可直视内部机构）</span>
          </label>
          <p className="studio-note">
            透明策略：外壳/玻璃优先使用 <code>MeshPhysicalMaterial</code> 物理透射（磨砂玻璃/冰蓝树脂），
            内部机构始终保持不透明金属质感；轻量档才退化为 alpha 混合。透明只作用于判定为
            「可透明角色」的部件，不做全场景统一透明度。
          </p>
        </div>
      </div>

      <aside className="studio-rail right">
        <HudPanel title="部件审查" meta={inspection ? <span className="hud-chip">{inspection.totals.parts} 部件</span> : null} scroll>
          {!inspection && <p className="muted small">等待模型载入后给出真实几何统计。</p>}
          {inspection && (
            <>
              <HudSection label="角色分布">
                <div className="studio-roles">
                  {(Object.keys(inspection.totals.byRole) as PartRole[])
                    .sort((a, b) => (inspection.totals.byRole[b] ?? 0) - (inspection.totals.byRole[a] ?? 0))
                    .map((role) => (
                      <button
                        key={role}
                        type="button"
                        className={`studio-role ${roleFilter === role ? 'active' : ''}`}
                        onClick={() => setRoleFilter(roleFilter === role ? 'all' : role)}
                        title={`只看「${ROLE_LABEL[role]}」部件`}
                      >
                        <i style={{ background: ROLE_TONE[role] }} aria-hidden />
                        {ROLE_LABEL[role]}
                        <b>{inspection.totals.byRole[role]}</b>
                      </button>
                    ))}
                </div>
              </HudSection>

              <HudSection label="最重部件（三角面）">
                <ol className="studio-heavy">
                  {heaviest.map((part) => (
                    <li key={part.id}>
                      <button type="button" onClick={() => setHighlight(part.id)}>
                        {part.name} · {part.triangles.toLocaleString()} 面
                      </button>
                    </li>
                  ))}
                </ol>
              </HudSection>

              <HudSection label="原始材质">
                <p className="studio-materials">{inspection.totals.materials.join(' · ')}</p>
              </HudSection>

              <HudSection label={`部件清单（${filteredParts.length}${roleFilter === 'all' ? '' : ` / ${parts.length}`}）`}>
                <div className="studio-parts">
                  {filteredParts.slice(0, 140).map((part) => (
                    <button
                      key={part.id}
                      type="button"
                      className={`studio-part ${highlight === part.id ? 'active' : ''}`}
                      onClick={() => setHighlight(highlight === part.id ? null : part.id)}
                      title={`${part.id}\n材质：${part.materials.join(', ')}\n尺寸：${part.size.map((value) => value.toFixed(2)).join(' × ')} m`}
                    >
                      <span className="studio-part-role" style={{ color: ROLE_TONE[part.role] }}>
                        {ROLE_LABEL[part.role]}
                      </span>
                      <span className="studio-part-name">{part.id}</span>
                      <span className="studio-part-tris">{part.triangles.toLocaleString()}</span>
                    </button>
                  ))}
                  {filteredParts.length > 140 && <p className="muted small">仅显示前 140 个部件（共 {filteredParts.length} 个）。</p>}
                </div>
              </HudSection>
            </>
          )}
        </HudPanel>

        <HudPanel title="真实渲染测量" meta={perf ? <span className="hud-chip">模式 {perf.mode}</span> : null}>
          {!perf && (
            <p className="muted small">
              点击「性能测量」用 1.5 秒连续渲染采样真实帧时间；数据来自本机浏览器 WebGL 上下文，
              不是材质参数推算。
            </p>
          )}
          {perf && (
            <>
              <div className="hud-row">
                <StatChip label="帧率" value={`${perf.fps.toFixed(1)} fps`} tone={perf.fps >= 50 ? VP.teal : perf.fps >= 30 ? VP.amber : VP.coral} />
                <StatChip label="平均帧" value={`${perf.frameMs.toFixed(2)} ms`} />
                <StatChip label="最差帧" value={`${perf.worstMs.toFixed(2)} ms`} tone={VP.amber} />
              </div>
              <div className="hud-row">
                <StatChip label="绘制调用" value={perf.drawCalls} />
                <StatChip label="三角面" value={perf.triangles.toLocaleString()} />
                <StatChip label="着色器" value={perf.programs} />
              </div>
              <p className="studio-materials">{perf.renderer}</p>
              <p className="muted small">质量档 {perf.quality} · {new Date(perf.at).toLocaleString()}</p>
            </>
          )}
        </HudPanel>

        <HudPanel title="导出记录">
          {notes.length === 0 && <p className="muted small">导出截图 / 对比图 / 性能测量的结果会记录在这里。</p>}
          <ul className="studio-log">
            {notes.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
          {asset && (
            <p className="studio-materials">
              运行时资源：<code>{visualModelUrl(baseUrl, asset.file).replace(baseUrl, '')}</code> · 源文件 lab/design/assets/
              {asset.source.replace('lab/design/assets/', '')}
            </p>
          )}
        </HudPanel>
      </aside>
    </div>
  );
}

export type { PartInfo };
