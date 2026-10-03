/**
 * 实验室外壳：引擎状态条 + 模块导航 + 当前模块面板。
 *
 * 用 **hash 路由**（`#aps`）而不是 history 路由：GitHub Pages 是静态托管，
 * history 路由在刷新/直达子路径时会 404。
 */

import { useEffect, useMemo, useState } from 'react';
import { groupModules, listModules } from './core/registry';
import { installModules } from './modules';
import { useApsEngine } from './core/aps/useApsEngine';
import { useMapfEngine } from './core/mapf/useMapfEngine';
import { useAgvEngine } from './core/agv/useAgvEngine';
import { EngineBanner } from './components/EngineBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import type { AlgorithmModule } from './core/types';
import type { ApsPanelProps } from './modules/aps/ApsPanel';
import type { MapfPanelProps } from './modules/mapf/MapfPanel';
import type { AgvPanelProps } from './modules/agv/AgvPanel';

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
    if (globalThis.location) globalThis.location.hash = id;
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">AD</div>
          <div className="brand-copy">
            <span className="brand-eyebrow">ALGORITHM DELIVERY / LAB</span>
            <h1>算法实验室 <span>LAB / 01</span></h1>
            <p>统一实验 · 可视化 · 性能评测</p>
          </div>
        </div>
        <EngineBanner
          status={engine.status}
          manifest={engine.manifest}
          runtimeVersion={engine.version}
          error={engine.error}
          onRetry={engine.refresh}
        />
      </header>

      <nav className="module-nav" aria-label="算法模块">
        {groups.map((group) => (
          <div className="module-group" key={group.category}>
            <span className="group-label">{group.category}</span>
            {group.items.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`module-tab ${m.id === active?.id ? 'active' : ''} ${m.status === 'planned' ? 'planned' : ''}`}
                title={m.tagline}
                onClick={() => select(m.id)}
              >
                {m.name}
                {m.status === 'planned' && <span className="badge">待接入</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <main className="app-main">
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
              自带问题结构、引擎与可视化组件后注册进 <code>src/modules/index.ts</code>，
              实验室首页会自动出现该模块。
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

      <footer className="app-footer muted small">
        <span>
          计算全部在浏览器内通过 WebAssembly 完成：不需要安装软件，也不依赖持续运行的服务端。
        </span>
        {engine.manifest && (
          <span>
            构建时间 {new Date(engine.manifest.builtAt).toLocaleString()} · 清单{' '}
            <code>public/engine-manifest.json</code>
          </span>
        )}
        {mapf.manifest && (
          <span>
            MAPF v{mapf.version} · 构建时间 {new Date(mapf.manifest.builtAt).toLocaleString()} · 清单{' '}
            <code>public/mapf-manifest.json</code>
          </span>
        )}
        {agv.manifest && (
          <span>
            AGV v{agv.version} · 构建时间 {new Date(agv.manifest.builtAt).toLocaleString()} · 清单{' '}
            <code>public/agv-manifest.json</code>
          </span>
        )}
      </footer>
    </div>
  );
}

/** 引擎句柄按模块注入：APS 与 MAPF 各挂各的 Worker/WASM，互不共享生命周期。 */
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
  return <Panel />;
}
