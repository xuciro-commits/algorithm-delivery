/**
 * MAPF Visual Lab 主面板（M0 设计 §3–§10，M1 实现）。
 *
 * 地图优先三栏工作区：左栏（场景库/编辑工具/参数/求解控制）· 中央分层 Canvas
 * 地图 · 右栏（问题清单/机器人/详情/核验/图层/历史）· 底部时间轴 + 指标带。
 *
 * 红线遵守：
 *  - 场景文档 = MapfProblem（无私有模型，导出即契约）；
 *  - 地图上任何路径/位置/冲突只来自 WASM 引擎输出与独立验证器；
 *  - 渲染（MapRenderer + rAF）与 React 解耦：回放每步仅一次 setState；
 *  - 搜索过程统计只折叠呈现，绝不画为最终方案冲突；
 *  - 无法执行的操作如实解释（预检 + 引擎 errors 原文）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Cell } from '../../components/grid-map/types';
import { gridBasePainter } from '../../components/grid-map/MapRenderer';
import { MapStage } from '../../components/grid-map/MapStage';
import type { MapfManifest, MapfSolution } from '../../core/mapf/types';
import type { MapfEngineHandle } from '../../core/mapf/engine';
import { isMapfCancelError } from '../../core/mapf/engine';
import { MapfTimeline } from './MapfTimeline';
import { MapfSandbox3D } from './Sandbox3D';
import { Segmented } from '../../components/hud';
import { MapfRightRail, type LayerFlags, type ViolationItem } from './MapfRightRail';
import { DynamicWizard, type WizardKind } from './DynamicWizard';
import {
  SceneHistory,
  blankScene,
  nextRobotId,
  type SceneCommand,
} from './scene/commands';
import { parseScene, sceneDims, serializeScene, type SceneDoc } from './scene/SceneDoc';
import { FALLBACK_LIMITS, hasErrors, precheckScene, type CapabilityLimits, type PrecheckIssue } from './scene/precheck';
import {
  deleteLocalScene,
  listLocalScenes,
  loadLocalScene,
  saveLocalScene,
  type LocalScene,
} from './scene/storage';
import { PlaybackClock, type Speed } from './playback/clock';
import { diffRuns, makeRunRecord, runsGroupable, type RunRecord } from './runs/runs';
import { paintEntitiesL2, paintOverlayL3, paintPathsL1, type MapfRenderState } from './render/MapfLayers';
import type { DynamicEventInput } from './dynamic/contractBlock';

export interface MapfPanelProps {
  manifest: MapfManifest | null;
  handle: MapfEngineHandle | null;
  engineReady: boolean;
  engineVersion: string;
  assetUrl: (path: string) => string;
  cancelSolve: () => boolean;
  setBusy: (busy: boolean) => void;
  engineError: string | null;
  refresh: () => void;
}

type Tool = 'select' | 'wall' | 'erase' | 'addRobot' | 'setStart' | 'setGoal' | 'removeRobot';
type Mode = 'edit' | 'playback';

const TOOLS: Array<{ id: Tool; label: string; hint: string }> = [
  { id: 'select', label: '选择/平移', hint: '点击拾取机器人；空格/中键拖动平移；滚轮缩放' },
  { id: 'wall', label: '画障碍', hint: '按住拖刷画障碍（机器人起终点格会被拒绝）' },
  { id: 'erase', label: '擦障碍', hint: '按住拖刷恢复可通行' },
  { id: 'addRobot', label: '加机器人', hint: '点击空格新增机器人（起点=点击处）' },
  { id: 'setStart', label: '设起点', hint: '选中机器人后点击格子设为起点' },
  { id: 'setGoal', label: '设终点', hint: '选中机器人后点击格子设为终点' },
  { id: 'removeRobot', label: '删机器人', hint: '点击机器人删除' },
];

const SPEEDS: Speed[] = [0.25, 0.5, 1, 2, 4, 8];

export function MapfPanel(props: MapfPanelProps) {
  const { manifest, handle, engineReady, engineVersion, assetUrl, cancelSolve, setBusy, engineError, refresh } = props;

  // —— 场景与历史 ——
  const historyRef = useRef<SceneHistory>(new SceneHistory(blankScene(8, 8, 'mapf-scene-initial')));
  const [doc, setDoc] = useState<SceneDoc>(historyRef.current.doc);
  const [fitNonce, setFitNonce] = useState(0);
  /** 撤销栈变化序号（刷新 ↶/↷ 禁用态；笔画结算时递增）。 */
  const [histNonce, setHistNonce] = useState(0);
  const [mode, setMode] = useState<Mode>('edit');
  const [tool, setTool] = useState<Tool>('select');
  /** 3D 沙盘 / 2D 轻量模式（默认 3D；低性能设备可切 2D）。 */
  const [view3d, setView3d] = useState(true);
  /** 3D 相机预设：等距 ↔ 正交俯视。 */
  const [camView, setCamView] = useState<'iso' | 'top'>('iso');

  // —— 选择 / 图层 ——
  const [primary, setPrimary] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [layers, setLayers] = useState<LayerFlags>({
    goals: true,
    paths: true,
    executed: true,
    robots: true,
    conflicts: true,
    events: true,
  });

  // —— 运行结果 ——
  const [solution, setSolution] = useState<MapfSolution | null>(null);
  const [raw, setRaw] = useState('');
  const [ghost, setGhost] = useState<MapfSolution | null>(null);
  const [problemTextUsed, setProblemTextUsed] = useState('');
  const [verifyChecks, setVerifyChecks] = useState<Array<{ name: string; ok: boolean }> | null>(null);
  const [verifyViolations, setVerifyViolations] = useState<ViolationItem[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const runSeqRef = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [solving, setSolving] = useState(false);
  const [frozenAt, setFrozenAt] = useState<number | null>(null);
  const [compare, setCompare] = useState<{ a: RunRecord; b: RunRecord } | null>(null);

  // —— 回放 ——
  const clockRef = useRef<PlaybackClock | null>(null);
  if (!clockRef.current && typeof requestAnimationFrame === 'function') clockRef.current = new PlaybackClock();
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);

  // —— 动态向导 ——
  const [wizard, setWizard] = useState<{
    active: boolean;
    kind: WizardKind;
    robot: string;
    events: DynamicEventInput[];
    frozenSteps: number;
  }>({ active: false, kind: null, robot: '', events: [], frozenSteps: 1 });

  // —— 场景库 ——
  const [localScenes, setLocalScenes] = useState<LocalScene[]>([]);
  const [jsonDraft, setJsonDraft] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [hover, setHover] = useState<Cell | null>(null);

  // —— 能力限额（握手）——
  const limits: CapabilityLimits = useMemo(() => {
    const caps = (manifest?.capabilities ?? {}) as Record<string, unknown>;
    const lim = (caps.limits ?? {}) as Record<string, unknown>;
    const get = (k: string, d: number) => (typeof lim[k] === 'number' ? Number(lim[k]) : d);
    return manifest
      ? {
          maxRobots: get('max_robots', FALLBACK_LIMITS.maxRobots),
          maxCells: get('max_map_cells', FALLBACK_LIMITS.maxCells),
          maxHorizon: get('max_horizon', FALLBACK_LIMITS.maxHorizon),
          maxBudgetMs: get('max_budget_ms', FALLBACK_LIMITS.maxBudgetMs),
          maxEvents: get('max_events', FALLBACK_LIMITS.maxEvents),
          verified: true,
        }
      : FALLBACK_LIMITS;
  }, [manifest]);

  const dims = useMemo(() => sceneDims(doc), [doc]);
  const issues = useMemo(() => precheckScene(doc, limits), [doc, limits]);
  const solvable = !hasErrors(issues) && doc.robots.length > 0 && engineReady && !solving;
  const maxT = useMemo(() => {
    if (!solution?.robots?.length) return 0;
    return solution.robots.reduce((m, r) => Math.max(m, (r.path?.length ?? 1) - 1), 0);
  }, [solution]);

  // —— 渲染 refs（React 与 Canvas 解耦）——
  const rendererRef = useRef<import('../../components/grid-map/MapRenderer').MapRenderer | null>(null);
  const renderStateRef = useRef<MapfRenderState>({
    sceneRobots: [],
    solution: null,
    ghostSolution: null,
    t: 0,
    primary: null,
    selected: [],
    layers,
    hover: null,
    invalidCells: [],
    conflictCells: [],
    eventMarks: [],
    frozenAt: null,
    pathLimit: 0,
  });

  // 预检问题格（编辑期红框）
  const invalidCells = useMemo(
    () => issues.filter((i) => i.level === 'error' && i.cell).map((i) => i.cell!),
    [issues],
  );
  const conflictCells = useMemo(
    () => verifyViolations.filter((v) => v.cell).map((v) => ({ cell: { x: v.cell![0], y: v.cell![1] }, at: v.at_time ?? 0 })),
    [verifyViolations],
  );
  const eventMarks = useMemo(() => {
    const dyn = (solution?.dynamic ?? {}) as Record<string, unknown>;
    const evList = (dyn.events ?? []) as Array<Record<string, unknown>>;
    return evList.flatMap((e) => {
      const cell = e.cell as [number, number] | undefined;
      return cell ? [{ cell: { x: cell[0], y: cell[1] }, at: Number(e.at ?? 0), kind: String(e.type ?? '') }] : [];
    });
  }, [solution]);

  // 每次 React 渲染后同步渲染状态并触发重绘（L1/L2/L3）
  useEffect(() => {
    renderStateRef.current = {
      sceneRobots: doc.robots.map((r) => ({ id: r.id, start: r.start, goal: r.goal ?? null })),
      solution,
      ghostSolution: ghost,
      t,
      primary,
      selected,
      layers,
      hover,
      invalidCells,
      conflictCells,
      eventMarks,
      frozenAt,
      pathLimit: 0,
    };
    rendererRef.current?.invalidate();
  });

  // 地图变化 → 基底失效
  const cellsKey = doc.map.cells.join('\n');
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    const cells = doc.map.cells;
    r.setBasePainter(gridBasePainter(dims, (x, y) => {
      const row = cells[y];
      const c = row?.[x] ?? '#';
      return c === '#' || c === 'T' || c === 'S';
    }));
    r.invalidateBase();
    r.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellsKey, dims.width, dims.height, rendererRef.current]);

  // 时钟
  useEffect(() => {
    const clock = clockRef.current;
    if (!clock) return;
    clock.onTick((tt, pl) => {
      renderStateRef.current.t = tt;
      rendererRef.current?.invalidate();
      setT(tt);
      setPlaying(pl);
    });
    return () => clock.dispose();
  }, []);
  useEffect(() => {
    clockRef.current?.setSpeed(speed);
  }, [speed]);
  useEffect(() => {
    clockRef.current?.setRange(maxT, 0);
  }, [maxT]);

  // 本地场景列表
  const refreshLocal = useCallback(() => setLocalScenes(listLocalScenes()), []);
  useEffect(() => {
    refreshLocal();
    // 首屏：默认载入 m02（交叉示例）
    const m02 = manifest?.mocks?.find((m) => m.file.includes('m02'));
    if (m02) void loadMockFile(m02.file);
    else if (manifest?.mocks?.length) void loadMockFile(manifest.mocks[0].file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest]);

  // —— 场景操作 ——
  const execCommand = useCallback((cmd: SceneCommand) => {
    const next = historyRef.current.exec(cmd);
    if (next) {
      setDoc(next);
      setMode('edit');
    }
  }, []);

  const loadDoc = useCallback((next: SceneDoc, resetView = true) => {
    historyRef.current.load(next);
    setDoc(next);
    setSolution(null);
    setGhost(null);
    setRaw('');
    setVerifyChecks(null);
    setVerifyViolations([]);
    setFrozenAt(null);
    setWizard((w) => ({ ...w, active: false, events: [], kind: null }));
    setMode('edit');
    setPrimary(next.robots[0]?.id ?? null);
    setSelected([]);
    if (resetView) setFitNonce((n) => n + 1);
  }, []);

  async function loadMockFile(file: string) {
    try {
      const res = await fetch(assetUrl(file), { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const parsed = parseScene(text);
      // 内置 mock 载入即复制为可编辑副本
      const copy: SceneDoc = { ...parsed, id: `${parsed.id}-copy` };
      loadDoc(copy);
      setNotice(`已载入 ${file}（副本可编辑，不污染基准数据）`);
    } catch (err) {
      setNotice(`读取 ${file} 失败：${(err as Error).message}`);
    }
  }

  const loadBlank = (w: number, h: number) => {
    const scene = blankScene(w, h);
    scene.tags = { name: `空白 ${w}×${h}`, description: '' };
    loadDoc(scene);
  };

  // —— 求解 ——
  const solve = useCallback(
    async (dynamicProblem?: string, dynFrozenAt?: number) => {
      if (!handle) return;
      if (!dynamicProblem && hasErrors(issues)) {
        setNotice(`场景存在 ${issues.filter((i) => i.level === 'error').length} 项结构性问题，先修复后再求解`);
        return;
      }
      const problemText = dynamicProblem ?? serializeScene(doc);
      setSolving(true);
      setBusy(true);
      setNotice(null);
      const opts = {
        objective: doc.objective.kind,
        time_limit_ms: doc.solver.time_limit_ms,
        suboptimality_factor: doc.solver.suboptimality_factor,
        planner: doc.solver.planner === 'cbs' ? 'cbs' : doc.solver.planner,
        seed: doc.solver.seed,
        verify: true,
      };
      try {
        const outcome = await handle.solve(problemText, opts);
        const sol = outcome.solution as MapfSolution | null;
        if (sol) setGhost(dynamicProblem ? solution : null);
        setRaw(outcome.raw ?? '');
        setSolution(sol ?? null);
        setProblemTextUsed(problemText);
        setVerifyChecks(null);
        setVerifyViolations([]);
        setFrozenAt(dynFrozenAt ?? null);
        runSeqRef.current += 1;
        const rec = makeRunRecord(runSeqRef.current, problemText, outcome.raw ?? '', sol ?? ({ status: 'UNKNOWN' } as MapfSolution), `${doc.objective.kind}/w=${doc.solver.suboptimality_factor}/${doc.solver.planner}`);
        setRuns((rs) => [...rs.slice(-(20 - 1)), rec]);
        if (sol?.robots?.length) {
          setMode('playback');
          setT(0);
          clockRef.current?.setRange(
            sol.robots.reduce((m, r) => Math.max(m, (r.path?.length ?? 1) - 1), 0),
            0,
          );
          setPrimary(sol.robots[0]?.id ?? null);
        }
        // 独立核验（原始文本）
        if (sol && (sol.robots?.length ?? 0) > 0) {
          try {
            const v = await handle.verify(problemText, outcome.raw, { strict: false });
            const report = v.report as unknown as {
              checks?: Array<{ name: string; ok: boolean }>;
              violations?: ViolationItem[];
            };
            setVerifyChecks(report.checks ?? []);
            setVerifyViolations(report.violations ?? []);
          } catch {
            /* 核验不可用：右栏如实显示空 */
          }
        }
        const errList = sol?.errors ?? [];
        if (errList.length) setNotice(`${sol?.status}：${errList[0].code} · ${errList[0].message}`);
      } catch (err) {
        setNotice(isMapfCancelError(err) ? '已取消：Worker 已终止，下次求解自动重建' : `求解异常：${(err as Error).message}`);
      } finally {
        setSolving(false);
        setBusy(false);
      }
    },
    [handle, doc, issues, setBusy, solution],
  );

  // —— 地图点击分派 ——
  const onCellClick = useCallback(
    (cell: Cell, mods: { shift: boolean; meta: boolean }) => {
      // 动态向导优先
      if (wizard.active && wizard.kind) {
        setWizard((w) => {
          if (!w.kind) return w;
          if (w.kind === 'obstacle_add' || w.kind === 'obstacle_remove') {
            return { ...w, events: [...w.events, { kind: w.kind, cell: [cell.x, cell.y], at: mode === 'playback' ? t : 0 }] };
          }
          if (w.kind === 'goal_change') {
            return { ...w, events: [...w.events, { kind: 'goal_change', robot: w.robot, goal: [cell.x, cell.y], at: t }] };
          }
          return w;
        });
        return;
      }
      const robotAt = (c: Cell): string | null => {
        // 回放中：命中机器人当前所在格（3D 点选机器人）
        if (solution?.robots?.length) {
          for (const r of solution.robots) {
            const path = r.path ?? [];
            const pos = path[Math.min(t, Math.max(0, path.length - 1))];
            if (pos && pos[0] === c.x && pos[1] === c.y) return r.id;
          }
        }
        // 编辑中：命中起终点
        for (const r of doc.robots) {
          for (const p of [r.start, r.goal]) {
            if (p && p[0] === c.x && p[1] === c.y) return r.id;
          }
        }
        return null;
      };
      switch (tool) {
        case 'select': {
          const rid = robotAt(cell);
          if (rid) {
            if (mods.shift) {
              setPrimary(rid);
              setSelected((s) => (s.includes(rid) ? s.filter((x) => x !== rid) : [...s, rid]));
            } else {
              setPrimary(rid);
              setSelected([]);
            }
          }
          break;
        }
        case 'wall': {
          const rid = robotAt(cell);
          if (rid) {
            setNotice(`不能在 ${rid} 的起点/终点上画障碍（删除或移动该机器人后重试）`);
            return;
          }
          setNotice(null);
          execCommand({ type: 'toggleWall', cell: [cell.x, cell.y], blocked: true });
          break;
        }
        case 'erase':
          execCommand({ type: 'toggleWall', cell: [cell.x, cell.y], blocked: false });
          break;
        case 'addRobot': {
          const row = doc.map.cells[cell.y];
          const c = row?.[cell.x] ?? '#';
          if (c === '#') {
            setNotice('不能在障碍格上放置机器人');
            return;
          }
          if (doc.robots.length >= limits.maxRobots) {
            setNotice(`机器人已达档位上限 ${limits.maxRobots} 台（wasm-light）`);
            return;
          }
          setNotice(null);
          execCommand({ type: 'addRobot', at: [cell.x, cell.y], id: nextRobotId(doc) });
          setPrimary(nextRobotId(doc));
          break;
        }
        case 'setStart': {
          if (!primary) {
            setNotice('先在「选择」工具下点选一台机器人，再设起点');
            return;
          }
          execCommand({ type: 'setStart', id: primary, at: [cell.x, cell.y] });
          break;
        }
        case 'setGoal': {
          if (!primary) {
            setNotice('先在「选择」工具下点选一台机器人，再设终点');
            return;
          }
          execCommand({ type: 'setGoal', id: primary, at: [cell.x, cell.y] });
          break;
        }
        case 'removeRobot': {
          const rid = robotAt(cell);
          if (rid) execCommand({ type: 'removeRobot', id: rid });
          break;
        }
      }
    },
    [tool, doc, primary, execCommand, wizard, limits.maxRobots, mode, t],
  );

  const onCellDrag = useCallback(
    (cell: Cell) => {
      if (wizard.active) return;
      if (tool === 'wall' || tool === 'erase') {
        if (tool === 'wall') {
          const occupied = doc.robots.some((r) => (r.start && r.start[0] === cell.x && r.start[1] === cell.y) || (r.goal && r.goal[0] === cell.x && r.goal[1] === cell.y));
          if (occupied) return;
        }
        historyRef.current.exec({ type: 'toggleWall', cell: [cell.x, cell.y], blocked: tool === 'wall' });
        setDoc(historyRef.current.doc);
      }
    },
    [tool, wizard.active, doc],
  );

  // —— 笔画级撤销：一笔障碍 = 一个历史步（V2 §4）——
  const beginStroke = useCallback(() => {
    historyRef.current.beginStroke();
  }, []);

  const endStroke = useCallback(() => {
    historyRef.current.endStroke();
    setDoc(historyRef.current.doc);
    setHistNonce((n) => n + 1);
  }, []);

  // —— 导入导出 ——
  const exportScene = () => {
    const blob = new Blob([serializeScene(doc)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${doc.id || 'mapf-scene'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const exportSolution = () => {
    if (!raw) return;
    const blob = new Blob([raw], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${solution?.id ?? 'mapf-solution'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importFile = (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      setNotice('文件超过 2 MiB 上限');
      return;
    }
    void file.text().then((text) => {
      try {
        loadDoc(parseScene(text));
        setNotice(`已导入 ${file.name}`);
      } catch (err) {
        setNotice(`导入失败：${(err as Error).message}`);
      }
    });
  };

  const m = (solution?.metrics ?? {}) as Record<string, number | null>;
  const obj = solution?.objective;
  const gap = obj?.lower_bound && obj?.value ? obj.value / obj.lower_bound : null;

  const wizardPickLabel =
    wizard.active && wizard.kind
      ? wizard.kind === 'obstacle_add'
        ? '点击地图：选择新障碍格'
        : wizard.kind === 'obstacle_remove'
          ? '点击地图：选择要移除的障碍格'
          : wizard.kind === 'goal_change'
            ? `点击地图：为 ${wizard.robot || '？'} 选新终点`
            : null
      : null;

  return (
    <section className="panel mapf-panel mapf-visual">
      <div className="engine-banner">
        <span>
          <b>MAPF 引擎</b> rust-ecbs-cbs <code>v{engineVersion}</code>（wasm-light，浏览器内计算）
        </span>
        {engineError && <span className="badge">装载失败</span>}
        {!engineError && !engineReady && <span className="badge">引擎装载中…</span>}
        {!limits.verified && <span className="badge">未验证档位</span>}
        {engineError && (
          <button type="button" className="btn" onClick={refresh}>
            重试装载
          </button>
        )}
        <span className="muted small">
          模式：<b>{mode === 'edit' ? '场景编辑' : '回放'}</b>
          {wizard.active && ' · ⚡ 动态注入'}
        </span>
      </div>
      {engineError && <div className="error-panel">{engineError}</div>}

      <div className="mapf-workspace">
        {/* ————— 左栏 ————— */}
        <aside className="mapf-left">
          <section className="rail-group">
            <h4>场景库</h4>
            <div className="scene-templates">
              <button type="button" className="btn tiny" onClick={() => loadBlank(8, 8)}>
                空白 8×8
              </button>
              <button type="button" className="btn tiny" onClick={() => loadBlank(16, 16)}>
                空白 16×16
              </button>
              <button type="button" className="btn tiny" onClick={() => loadBlank(32, 32)}>
                空白 32×32
              </button>
            </div>
            <div className="scene-list">
              {(manifest?.mocks ?? []).map((entry) => (
                <button key={entry.file} type="button" className={`scene-card ${entry.kind === 'negative' ? 'neg' : ''}`} onClick={() => void loadMockFile(entry.file)} title={entry.description}>
                  <b>{entry.name}</b>
                  <span className="muted small">
                    {entry.robots != null ? `${entry.robots} 车 · ` : ''}
                    {entry.width != null ? `${entry.width}×${entry.height}` : ''}
                  </span>
                  {entry.expect && <em className="muted small">{entry.expect}</em>}
                </button>
              ))}
            </div>
            {localScenes.length > 0 && (
              <details className="mapf-details" open>
                <summary>本地场景（{localScenes.length}/10）</summary>
                <div className="scene-list">
                  {localScenes.map((s) => (
                    <div key={s.id} className="scene-card row">
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => {
                          const loaded = loadLocalScene(s.id);
                          if (loaded) loadDoc(loaded);
                          else setNotice('本地场景解析失败（可能来自旧版本，已跳过）');
                        }}
                      >
                        {s.name || s.id}
                      </button>
                      <button
                        type="button"
                        className="btn tiny"
                        title="删除"
                        onClick={() => {
                          deleteLocalScene(s.id);
                          refreshLocal();
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </details>
            )}
            <div className="scene-io">
              <label className="btn tiny file-btn">
                导入…
                <input
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) importFile(f);
                    e.target.value = '';
                  }}
                />
              </label>
              <button type="button" className="btn tiny" onClick={exportScene}>
                导出场景
              </button>
              {raw && (
                <button type="button" className="btn tiny" onClick={exportSolution}>
                  导出方案
                </button>
              )}
              <button
                type="button"
                className="btn tiny"
                onClick={() => {
                  const r = saveLocalScene(doc);
                  if (r.ok) {
                    refreshLocal();
                    setNotice('已保存到本地场景');
                  } else setNotice(r.error ?? '保存失败');
                }}
              >
                存本地
              </button>
            </div>
          </section>

          <section className="rail-group">
            <h4>编辑工具</h4>
            <div className="tool-grid">
              {TOOLS.map((tl) => (
                <button
                  key={tl.id}
                  type="button"
                  className={`btn tiny tool-btn ${tool === tl.id ? 'primary' : ''}`}
                  title={tl.hint}
                  onClick={() => {
                    setTool(tl.id);
                    setMode('edit');
                  }}
                >
                  {tl.label}
                </button>
              ))}
              <button
                type="button"
                className="btn tiny"
                disabled={!historyRef.current.canUndo}
                onClick={() => {
                  setDoc(historyRef.current.undo() ?? doc);
                  setHistNonce((n) => n + 1);
                }}
              >
                ↶ 撤销
              </button>
              <button
                type="button"
                className="btn tiny"
                disabled={!historyRef.current.canRedo}
                onClick={() => {
                  setDoc(historyRef.current.redo() ?? doc);
                  setHistNonce((n) => n + 1);
                }}
              >
                ↷ 重做
              </button>
            </div>
            <p className="muted small">
              {TOOLS.find((tl) => tl.id === tool)?.hint}
              {histNonce >= 0 && historyRef.current.steps > 0 && <span className="muted"> · 撤销栈 {historyRef.current.steps} 步</span>}
            </p>
            <div className="scene-resize">
              <label className="field">
                宽
                <input
                  type="number"
                  min={1}
                  max={256}
                  value={dims.width}
                  onChange={(e) => execCommand({ type: 'resize', width: Math.max(1, Math.min(256, Number(e.target.value) || 1)), height: dims.height })}
                />
              </label>
              <label className="field">
                高
                <input
                  type="number"
                  min={1}
                  max={256}
                  value={dims.height}
                  onChange={(e) => execCommand({ type: 'resize', width: dims.width, height: Math.max(1, Math.min(256, Number(e.target.value) || 1)) })}
                />
              </label>
            </div>
          </section>

          <section className="rail-group">
            <h4>规划参数</h4>
            <label className="field">
              目标
              <select value={doc.objective.kind} onChange={(e) => setDoc({ ...doc, objective: { ...doc.objective, kind: e.target.value as 'soc' | 'makespan' } })}>
                <option value="soc">SOC（总耗时）</option>
                <option value="makespan">Makespan（完时）</option>
              </select>
            </label>
            <label className="field">
              预算 ms
              <input
                type="number"
                min={100}
                max={limits.maxBudgetMs}
                step={100}
                value={doc.solver.time_limit_ms}
                onChange={(e) => setDoc({ ...doc, solver: { ...doc.solver, time_limit_ms: Number(e.target.value) || 3000 } })}
              />
            </label>
            <label className="field">
              w（次优上界）
              <input
                type="range"
                min={1}
                max={3}
                step={0.05}
                value={doc.solver.suboptimality_factor}
                onChange={(e) => setDoc({ ...doc, solver: { ...doc.solver, suboptimality_factor: Number(e.target.value) } })}
              />
              <span className="muted small">{doc.solver.suboptimality_factor.toFixed(2)}</span>
            </label>
            <label className="field">
              规划器
              <select value={doc.solver.planner} onChange={(e) => setDoc({ ...doc, solver: { ...doc.solver, planner: e.target.value as typeof doc.solver.planner } })}>
                <option value="auto">auto</option>
                <option value="ecbs">ECBS</option>
                <option value="pp">优先搜索 PP</option>
              </select>
            </label>
            <label className="field">
              时域
              <select
                value={String(doc.time_model.horizon)}
                onChange={(e) =>
                  setDoc({ ...doc, time_model: { ...doc.time_model, horizon: e.target.value === 'auto' ? 'auto' : Number(e.target.value) } })
                }
              >
                <option value="auto">auto（引擎自定）</option>
                {[20, 40, 60, 100, 200].map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              种子
              <input type="number" value={doc.solver.seed} onChange={(e) => setDoc({ ...doc, solver: { ...doc.solver, seed: Number(e.target.value) || 0 } })} />
            </label>
          </section>

          <section className="rail-group">
            <h4>求解控制</h4>
            <div className="solve-row">
              <button type="button" className="btn primary" disabled={!solvable} onClick={() => void solve()}>
                {solving ? '求解中…' : '求解'}
              </button>
              <button type="button" className="btn" disabled={!solving} onClick={() => cancelSolve()}>
                取消
              </button>
              {!solvable && !solving && (
                <span className="muted small">
                  {!engineReady ? '引擎装载中' : hasErrors(issues) ? `先修复 ${issues.filter((i) => i.level === 'error').length} 项问题` : doc.robots.length === 0 ? '场景没有机器人' : ''}
                </span>
              )}
            </div>
            {notice && <p className="muted small mapf-notice">{notice}</p>}
            {solution?.search && (
              <details className="mapf-details">
                <summary>搜索统计（过程数据，非最终方案冲突）</summary>
                <pre className="small">{JSON.stringify(solution.search, null, 1)}</pre>
              </details>
            )}
          </section>

          <details className="mapf-details json-drawer">
            <summary>高级 · JSON</summary>
            <p className="muted small">场景即契约 mapf-problem/1.0；【应用】经结构预检后进编辑器。</p>
            <textarea rows={10} value={jsonDraft || serializeScene(doc)} spellCheck={false} onChange={(e) => setJsonDraft(e.target.value)} />
            {jsonError && <p className="bad-text small">{jsonError}</p>}
            <div className="solve-row">
              <button
                type="button"
                className="btn tiny"
                onClick={() => {
                  try {
                    const parsed = parseScene(jsonDraft);
                    historyRef.current.exec({ type: 'replace', doc: parsed });
                    setDoc(parsed);
                    setJsonError(null);
                    setFitNonce((n) => n + 1);
                  } catch (err) {
                    setJsonError((err as Error).message);
                  }
                }}
              >
                应用
              </button>
              <button type="button" className="btn tiny" onClick={() => setJsonDraft('')}>
                刷新自场景
              </button>
            </div>
          </details>
        </aside>

        {/* ————— 中央地图 ————— */}
        <div className="mapf-center">
          <div className="mapf-stage-wrap">
            {view3d ? (
              <MapfSandbox3D
                doc={doc}
                solution={solution}
                ghost={ghost}
                t={t}
                primary={primary}
                selected={selected}
                layers={layers}
                hover={hover}
                invalidCells={invalidCells}
                conflictCells={conflictCells}
                eventMarks={eventMarks}
                view={camView}
                painting={tool === 'wall' || tool === 'erase'}
                clock={clockRef.current}
                playing={playing}
                onCellClick={onCellClick}
                onCellDrag={onCellDrag}
                onCellDown={beginStroke}
                onCellUp={endStroke}
                onHover={(c) => setHover(c)}
              />
            ) : (
              <MapStage
                dims={dims}
                fitNonce={fitNonce}
                onHover={(c) => setHover(c)}
                onCellClick={onCellClick}
                onCellDrag={onCellDrag}
                onCellDown={beginStroke}
                onCellUp={endStroke}
              >
                {(renderer) => {
                  rendererRef.current = renderer;
                  renderer.setLayerPainter(1, paintPathsL1(renderStateRef.current));
                  renderer.setLayerPainter(2, paintEntitiesL2(renderStateRef.current));
                  renderer.setLayerPainter(3, paintOverlayL3(renderStateRef.current));
                }}
              </MapStage>
            )}
            <div className="mapf-toolbar">
              <button type="button" className={`btn tiny ${tool === 'select' ? 'primary' : ''}`} onClick={() => setTool('select')}>
                选择
              </button>
              <button type="button" className={`btn tiny ${tool === 'wall' ? 'primary' : ''}`} onClick={() => setTool('wall')}>
                障碍
              </button>
              {!view3d && (
                <button type="button" className="btn tiny" title="适配窗口（F）" onClick={() => setFitNonce((n) => n + 1)}>
                  适配
                </button>
              )}
              <span style={{ width: 6 }} />
              <Segmented
                ariaLabel="视图模式"
                value={view3d ? '3d' : '2d'}
                onChange={(v) => setView3d(v === '3d')}
                options={[
                  { id: '3d', label: '3D 沙盘', title: '等距三维沙盘（默认）' },
                  { id: '2d', label: '2D 轻量', title: '轻量二维模式（低性能设备兜底）' },
                ]}
              />
              {view3d && (
                <Segmented
                  ariaLabel="相机视角"
                  value={camView}
                  onChange={setCamView}
                  options={[
                    { id: 'iso', label: '等距', title: '等距视角（微缩沙盘）' },
                    { id: 'top', label: '俯视', title: '正交俯视（精确对格）' },
                  ]}
                />
              )}
              {mode === 'playback' && !wizard.active && (
                <button
                  type="button"
                  className="btn tiny"
                  onClick={() => setWizard({ active: true, kind: null, robot: solution?.robots?.[0]?.id ?? '', events: [], frozenSteps: 1 })}
                >
                  ⚡ 注入动态事件
                </button>
              )}
              {mode === 'playback' && (
                <button type="button" className="btn tiny" onClick={() => setMode('edit')}>
                  编辑场景
                </button>
              )}
              {mode === 'edit' && solution && (
                <button type="button" className="btn tiny" onClick={() => setMode('playback')}>
                  回到回放
                </button>
              )}
            </div>
            <div className="mapf-readout muted small">
              {hover ? `(${hover.x}, ${hover.y}) · ${doc.map.cells[hover.y]?.[hover.x] === '.' ? '可通行' : '障碍'}` : '—'}
            </div>
            <div className="mapf-legend muted small">
              <span>●移动 ◌等待 ✓到达 ◎驻留</span>
              <span>{view3d ? '实线=已执行 · 虚线=未执行 · 轨迹悬浮于底板上方' : '虚线=未来 实线=已执行'}</span>
            </div>
            {!solution && mode === 'edit' && (
              <div className="mapf-guide muted">
                {doc.robots.length === 0
                  ? '用「加机器人」工具放置机器人，再设终点'
                  : doc.robots.some((r) => !r.goal)
                    ? '还有机器人未设终点（红色未完成态）'
                    : '设置好起终点后点击【求解】'}
              </div>
            )}
            {wizard.active && solution && (
              <DynamicWizard
                scene={doc}
                solution={solution}
                time={t}
                maxT={maxT}
                maxEvents={limits.maxEvents}
                busy={solving}
                events={wizard.events}
                kind={wizard.kind}
                robot={wizard.robot}
                frozenSteps={wizard.frozenSteps}
                pickLabel={wizardPickLabel}
                onPickKind={(kind, robot) => {
                  setWizard((w) => ({ ...w, kind, robot: robot ?? w.robot }));
                  if (kind === 'path_invalid') {
                    setWizard((w) => ({ ...w, kind: null, events: [...w.events, { kind: 'path_invalid', robot: w.robot || (solution.robots?.[0]?.id ?? ''), at: t }] }));
                  }
                }}
                onRobotChange={(robot) => setWizard((w) => ({ ...w, robot }))}
                onRemoveEvent={(i) => setWizard((w) => ({ ...w, events: w.events.filter((_, j) => j !== i) }))}
                onFrozenChange={(n) => setWizard((w) => ({ ...w, frozenSteps: n }))}
                onSubmit={(problemText, fa) => {
                  setWizard((w) => ({ ...w, active: false, events: [], kind: null }));
                  void solve(problemText, fa);
                }}
                onCancel={() => setWizard((w) => ({ ...w, active: false, kind: null, events: [] }))}
              />
            )}
            {compare && (
              <div className="mapf-compare">
                <header>
                  <b>运行对比 #{compare.a.seq} vs #{compare.b.seq}</b>
                  <button type="button" className="btn tiny" onClick={() => setCompare(null)}>
                    关闭
                  </button>
                </header>
                <table className="data-table small-table">
                  <thead>
                    <tr>
                      <th>指标</th>
                      <th>#{compare.a.seq}</th>
                      <th>#{compare.b.seq}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diffRuns(compare.a, compare.b).rows.map((row) => (
                      <tr key={row.label}>
                        <td>{row.label}</td>
                        <td>{row.a}</td>
                        <td className={row.verdict === 'better' ? 'ok-text' : row.verdict === 'worse' ? 'bad-text' : ''}>{row.b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted small">
                  参数 A：{compare.a.paramSummary} · B：{compare.b.paramSummary}
                </p>
              </div>
            )}
          </div>

          {/* 时间轴 + 指标带 */}
          <div className="mapf-bottom">
            <div className="mapf-play">
              <button type="button" className="btn tiny" onClick={() => clockRef.current?.seek(0)}>
                ⏮
              </button>
              <button type="button" className="btn tiny" onClick={() => clockRef.current?.step(-1)}>
                ◀
              </button>
              <button type="button" className="btn tiny primary" onClick={() => clockRef.current?.toggle()}>
                {playing ? '⏸' : '▶'}
              </button>
              <button type="button" className="btn tiny" onClick={() => clockRef.current?.step(1)}>
                ⏭
              </button>
              <span className="tabular-nums mapf-t-readout">t = {t} / {maxT}</span>
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value) as Speed)} aria-label="播放速度">
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
            </div>
            <MapfTimeline
              solution={solution}
              t={t}
              maxT={maxT}
              primary={primary}
              selected={selected}
              events={eventMarks.map((e) => ({ at: e.at }))}
              conflictAt={null}
              frozenAt={frozenAt}
              onSeek={(tt) => clockRef.current?.seek(tt)}
              onSelectRobot={(id) => setPrimary(id)}
            />
            <div className="mapf-metrics muted small">
              {solution ? (
                <>
                  <span className={`badge ${solution.status === 'OPTIMAL' ? 'ok' : solution.status === 'FEASIBLE' ? 'warn' : solution.status === 'UNKNOWN' || solution.status === 'CANCELLED' ? 'muted-badge' : 'bad-text'}`}>{solution.status}</span>
                  {obj?.value != null && (
                    <span>
                      {obj.kind === 'makespan' ? 'Makespan' : 'SOC'} <b>{obj.value}</b>
                      {obj.lower_bound != null && <span className="muted"> / 下界 {obj.lower_bound}</span>}
                      {gap != null && gap > 1.0001 && <span className="muted"> 差距 {(gap * 100 - 100).toFixed(1)}%</span>}
                    </span>
                  )}
                  {m.solve_ms != null && <span>求解 {m.solve_ms} ms</span>}
                  {m.first_feasible_ms != null && <span>首解 {m.first_feasible_ms} ms</span>}
                  <span>核验 {solution.verified === true ? '✓' : solution.verified === false ? '✗' : '—'}</span>
                  {frozenAt != null && <span>冻结窗 T+{frozenAt}</span>}
                  {solution.dynamic && (
                    <span>
                      动态：受影响 {String((solution.dynamic as Record<string, unknown>).affected_agents ?? '–')} · 路径改动{' '}
                      {String((solution.dynamic as Record<string, unknown>).path_change_steps ?? '–')} 步
                    </span>
                  )}
                </>
              ) : (
                <span>未求解 —— 地图、起终点与障碍可自由编辑</span>
              )}
            </div>
          </div>
        </div>

        {/* ————— 右栏 ————— */}
        <MapfRightRail
          doc={doc}
          issues={issues}
          solution={solution}
          verifyChecks={verifyChecks}
          verifyViolations={verifyViolations}
          primary={primary}
          selected={selected}
          layers={layers}
          runs={runs}
          onSelectRobot={(id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
          onSetPrimary={(id) => setPrimary(id)}
          onToggleLayer={(k) => setLayers((l) => ({ ...l, [k]: !l[k] }))}
          onLocateIssue={(it: PrecheckIssue) => it.cell && setHover({ x: it.cell.x, y: it.cell.y })}
          onLocateViolation={(v) => {
            if (v.at_time != null) clockRef.current?.seek(v.at_time);
            if (v.cell) setHover({ x: v.cell[0], y: v.cell[1] });
          }}
          onCompare={(a, b) => {
            if (runsGroupable(a, b)) setCompare({ a, b });
          }}
        />
      </div>
      {problemTextUsed && (
        <details className="mapf-details mapf-last-problem">
          <summary>上次提交的问题（mapf-problem/1.0 原文）</summary>
          <pre className="small">{problemTextUsed.slice(0, 4000)}</pre>
        </details>
      )}
    </section>
  );
}
