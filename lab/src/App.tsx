/**
 * 实验室外壳：顶部品牌区 + 引擎状态 + 模块导航（3D 按钮）+ 当前模块面板。
 *
 * 本轮改版要点：
 *   - 页面结构从"扁平三段"改为 **机架式**（rack）：顶栏 / 导航轨 / 主舞台 / 页脚状态；
 *   - 导航按钮改为**立体（3D）按钮**：凸起面板 + 顶面高光 + 冰蓝发光描边，
 *     配色与 3D 场景一致（石墨底 + 冰蓝/青色发光 + 少量琥珀），激活态像被按下；
 *   - 视觉模式（A/B/C）与泛光开关常驻顶栏——它们作用于所有实验室的**同一份场景几何与数据**；
 *   - hash 路由保持（`#aps` / `#art-lab` …），GitHub Pages 静态托管刷新不 404。
 */

import { useEffect, useMemo, useState } from 'react';
import { groupModules, listModules } from './core/registry';
import { installModules } from './modules';
import { useApsEngine } from './core/aps/useApsEngine';
import { useMapfEngine } from './core/mapf/useMapfEngine';
import { useAgvEngine } from './core/agv/useAgvEngine';
import { EngineBanner } from './components/EngineBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ART_MODE_OPTIONS } from './art/tokens';
import { ART_MODES } from './art/modes';
import { useArtStore } from './art/settings';
import type { AlgorithmModule } from './core/types';
import type { ApsPanelProps } from './modules/aps/ApsPanel';
import type { MapfPanelProps } from './modules/mapf/MapfPanel';
import type { AgvPanelProps } from './modules/agv/AgvPanel';
import type { ArtLabEngineProps } from './modules/art-lab/ArtLabPanel';

installModules();

function currentModuleId(): string {
  const hash = globalThis.location?.hash?.replace(/^#\/?/, '') ?? '';
  return hash || listModules().find((m) => m.status === 'ready')?.id || '';
}

export default function App() {
  const engine = useApsEngine();
  const mapf = useMapfEngine();
  const agv = useAgvEngine();
  const [activeId, setActiveId] = useState<string>(currentModuleId);
  const [navOpen, setNavOpen] = useState(false);

  const mode = useArtStore((s) => s.mode);
  const setMode = useArtStore((s) => s.setMode);
  const bloomEnabled = useArtStore((s) => s.bloomEnabled);
  const patch = useArtStore((s) => s.patch);

  useEffect(() => {
    const onHash = () => setActiveId(currentModuleId());
    globalThis.addEventListener('hashchange', onHash);
    return () => globalThis.removeEventListener('hashchange', onHash);
  }, []);

  const modules = useMemo(() => listModules(), []);
  const groups = useMemo(() => groupModules(), []);
  const active: AlgorithmModule | undefined = modules.find((m) => m.id === activeId) ?? modules[0];

  const select = (id: string) => {
    setActiveId(id);
    setNavOpen(false);
    if (globalThis.location) globalThis.location.hash = id;
  };

  const engines = [
    { id: 'aps', label: 'APS', ready: engine.status === 'ready', version: engine.version },
    { id: 'mapf', label: 'MAPF', ready: mapf.status === 'ready', version: mapf.version },
    { id: 'agv', label: 'AGV', ready: agv.status === 'ready', version: agv.version },
  ];
  const readyCount = engines.filter((e) => e.ready).length;

  return (
    <div className="lab-shell">
      {/* ——— 顶栏：品牌 + 引擎 + 视觉模式 ——— */}
      <header className="topbar">
        <button type="button" className="brand3d" onClick={() => setNavOpen((v) => !v)} title="展开 / 收起导航">
          <span className="brand3d-mark" aria-hidden>
            AD
            <span className="brand3d-sheen" aria-hidden />
          </span>
          <span className="brand3d-copy">
            <span className="brand3d-eyebrow">ALGORITHM DELIVERY · LAB</span>
            <span className="brand3d-title">
              算法实验室 <em>LAB / 02</em>
            </span>
            <span className="brand3d-sub">工业模型艺术化 · 三维实时沙盘 · 真实算法可视化</span>
          </span>
        </button>

        <div className="engine-cluster">
          {engines.map((item) => (
            <span key={item.id} className={`engine-pill ${item.ready ? 'is-ready' : 'is-off'}`} title={`${item.label} 引擎 v${item.version}`}>
              <span className="engine-pill-dot" aria-hidden />
              {item.label}
            </span>
          ))}
          <span className="engine-pill engine-pill--count" title="就绪引擎数 / 总数">
            {readyCount}/3
          </span>
        </div>

        <div className="mode-cluster" role="group" aria-label="视觉模式">
          {ART_MODE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`mode3d ${mode === option.id ? 'is-active' : ''}`}
              title={option.title}
              onClick={() => setMode(option.id)}
            >
              <span className="mode3d-key">{option.id}</span>
              <span className="mode3d-label">{option.label}</span>
            </button>
          ))}
          <button
            type="button"
            className={`mode3d mode3d--toggle ${bloomEnabled ? 'is-active' : ''}`}
            title="受控泛光：只对超过阈值的自发光元素（算法路径 / 状态灯）生效"
            onClick={() => patch({ bloomEnabled: !bloomEnabled })}
          >
            <span className="mode3d-key">✦</span>
            <span className="mode3d-label">泛光</span>
          </button>
        </div>
      </header>

      <div className="rack">
        {/* ——— 导航轨：3D 按钮 ——— */}
        <nav className={`navrail ${navOpen ? 'is-open' : ''}`} aria-label="算法模块">
          <span className="navrail-label">实验室</span>
          {groups.map((group) => (
            <div className="navrail-group" key={group.category}>
              <span className="navrail-cat">{group.category}</span>
              {group.items.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`nav3d ${m.id === active?.id ? 'is-active' : ''} ${m.status === 'planned' ? 'is-planned' : ''}`}
                  title={m.tagline}
                  onClick={() => select(m.id)}
                >
                  <span className="nav3d-face">
                    <span className="nav3d-name">{m.name}</span>
                    <span className="nav3d-tag">{m.tagline}</span>
                  </span>
                  <span className="nav3d-edge" aria-hidden />
                  {m.status === 'planned' && <span className="nav3d-badge">待接入</span>}
                </button>
              ))}
            </div>
          ))}
          <div className="navrail-foot">
            <span className="muted small">模式 {mode} · {ART_MODES[mode].label}</span>
            <EngineBanner
              status={engine.status}
              manifest={engine.manifest}
              runtimeVersion={engine.version}
              error={engine.error}
              onRetry={engine.refresh}
            />
          </div>
        </nav>

        {/* ——— 主舞台 ——— */}
        <main className="stage-main">
          {!active && <p className="muted">没有登记任何算法模块。</p>}

          {active && active.status === 'planned' && (
            <section className="panel">
              <h3>
                {active.name} <span className="badge">待接入</span>
              </h3>
              <p>{active.tagline}</p>
              <p className="muted">{active.plannedNote}</p>
              <p className="muted small">
                接入方式见 <code>lab/README.md</code> §5：新增 <code>src/modules/&lt;id&gt;/</code>，
                自带问题结构、引擎与可视化组件后注册进 <code>src/modules/index.ts</code>。
              </p>
            </section>
          )}

          {active?.Panel && (
            <ErrorBoundary key={active.id}>
              <PanelHost
                module={active}
                apsProps={{
                  manifest: engine.manifest,
                  runner: engine.runner,
                  engineReady: engine.status === 'ready',
                  engineVersion: engine.version,
                  assetUrl: engine.assetUrl,
                  cancelSolve: engine.cancel,
                }}
                mapfProps={{
                  manifest: mapf.manifest,
                  handle: mapf.handle,
                  engineReady: mapf.status === 'ready',
                  engineVersion: mapf.version,
                  assetUrl: mapf.assetUrl,
                  cancelSolve: mapf.cancel,
                  setBusy: mapf.setBusy,
                  engineError: mapf.error,
                  refresh: mapf.refresh,
                }}
                agvProps={{
                  manifest: agv.manifest,
                  handle: agv.handle,
                  engineReady: agv.status === 'ready',
                  engineVersion: agv.version,
                  assetUrl: agv.assetUrl,
                  cancelSolve: agv.cancel,
                  setBusy: agv.setBusy,
                  engineError: agv.error,
                  refresh: agv.refresh,
                }}
              />
            </ErrorBoundary>
          )}
        </main>
      </div>

      <footer className="footbar">
        <span>计算全部在浏览器内通过 WebAssembly 完成：不需要安装软件，也不依赖持续运行的服务端。</span>
        <span className="footbar-meta">
          {engine.manifest && <>APS 构建 {new Date(engine.manifest.builtAt).toLocaleString()}</>}
          {mapf.manifest && <> · MAPF v{mapf.version} 构建 {new Date(mapf.manifest.builtAt).toLocaleString()}</>}
          {agv.manifest && <> · AGV v{agv.version} 构建 {new Date(agv.manifest.builtAt).toLocaleString()}</>}
        </span>
      </footer>
    </div>
  );
}

/** 引擎句柄按模块注入：APS 与 MAPF/AGV 各挂各的 Worker/WASM，互不共享生命周期。 */
function PanelHost({
  module,
  apsProps,
  mapfProps,
  agvProps,
}: {
  module: AlgorithmModule;
  apsProps: ApsPanelProps;
  mapfProps: MapfPanelProps;
  agvProps: AgvPanelProps;
}) {
  const Panel = module.Panel!;
  if (module.id === 'aps') return <Panel {...apsProps} />;
  if (module.id === 'path-planning') return <Panel {...mapfProps} />;
  if (module.id === 'agv-dispatch') return <Panel {...agvProps} />;
  // 仓储优化的两个模块自带引擎生命周期（各自的 useWarehouseEngine），
  // 因此这里显式分支、不注入任何 props —— 避免"看起来共享、实际两套句柄"的混乱。
  if (module.id === 'slotting') return <Panel />;
  if (module.id === 'dense-asrs') return <Panel />;
  // 三维实验室复用三个引擎的句柄：几何来自上传模型，算法结果来自真实 WASM 引擎。
  if (module.id === 'art-lab') {
    const artProps: ArtLabEngineProps = {
      aps: {
        manifest: apsProps.manifest,
        runner: apsProps.runner,
        engineReady: apsProps.engineReady,
        engineVersion: apsProps.engineVersion,
        assetUrl: apsProps.assetUrl,
        cancelSolve: apsProps.cancelSolve,
      },
      mapf: {
        manifest: mapfProps.manifest,
        handle: mapfProps.handle,
        engineReady: mapfProps.engineReady,
        engineVersion: mapfProps.engineVersion,
        assetUrl: mapfProps.assetUrl,
        setBusy: mapfProps.setBusy,
        cancelSolve: mapfProps.cancelSolve,
      },
      agv: {
        manifest: agvProps.manifest,
        handle: agvProps.handle,
        engineReady: agvProps.engineReady,
        engineVersion: agvProps.engineVersion,
        assetUrl: agvProps.assetUrl,
        setBusy: agvProps.setBusy,
        cancelSolve: agvProps.cancelSolve,
      },
    };
    return <Panel {...artProps} />;
  }
  return <Panel />;
}
