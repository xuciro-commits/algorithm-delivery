/**
 * AGV 调度实验面板（M4）：多车任务分配与联合路径可视化。
 *
 * 三栏：左（场景库/编辑工具/参数/求解）· 中（分层 Canvas 地图 + 回放）· 右（车辆/
 * 任务/核验/动态汇总）。所有计算来自 WASM agv-dispatch 引擎（真实求解 + 独立核验），
 * 前端零伪造；无法执行的操作如实说明（预检 + 引擎 errors 原文）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Cell } from '../../components/grid-map/types';
import { gridBasePainter, MapRenderer } from '../../components/grid-map/MapRenderer';
import { MapStage } from '../../components/grid-map/MapStage';
import type { AgvManifest, AgvSolution } from '../../core/agv/types';
import type { AgvEngineHandle } from '../../core/agv/engine';
import { isAgvCancelError } from '../../core/agv/engine';
import {
  agvDims,
  AgvSceneHistory,
  blankAgvScene,
  isAgvBlocked,
  locCells,
  parseAgvScene,
  precheckAgvScene,
  serializeAgvScene,
  type AgvCommand,
  type AgvScene,
} from './scene';
import { PlaybackClock, type Speed } from '../mapf/playback/clock';
import { agvColor, paintAgvEntitiesL2, paintAgvOverlayL3, paintAgvPathsL1, phaseAt, taskOfAt, type AgvRenderState } from './agvRender';
import { AgvTimeline } from './AgvTimeline';
import { AgvSandbox3D } from './Sandbox3D';
import { AgvDynamicWizard, type AgvWizardKind } from './DynamicWizard';
import { withDynamicBlock, type AgvDynamicEventInput } from './dynamic/contractBlock';
import { AGV_MAX_RUNS, agvRunsGroupable, diffAgvRuns, makeAgvRunRecord, type AgvRunRecord } from './runs';
import { Segmented } from '../../components/hud';

export interface AgvPanelProps {
  manifest: AgvManifest | null;
  handle: AgvEngineHandle | null;
  engineReady: boolean;
  engineVersion: string;
  assetUrl: (path: string) => string;
  cancelSolve: () => boolean;
  setBusy: (busy: boolean) => void;
  engineError: string | null;
  refresh: () => void;
}

type Tool = 'select' | 'wall' | 'erase' | 'addVehicle' | 'moveVehicle' | 'addTaskPickup' | 'addTaskDropoff' | 'stationDock' | 'removeItem';

const TOOLS: Array<{ id: Tool; label: string; hint: string }> = [
  { id: 'select', label: '选择/平移', hint: '点击选中车辆/任务；左键拖动旋转（3D）；右键/中键/空格/Shift 拖动平移；滚轮缩放' },
  { id: 'wall', label: '画障碍', hint: '拖刷画障碍（车辆起点/任务点/泊位会被拒绝）' },
  { id: 'erase', label: '擦障碍', hint: '拖刷恢复可通行' },
  { id: 'addVehicle', label: '加车辆', hint: '点击空格放置 AGV 起点' },
  { id: 'moveVehicle', label: '移车辆', hint: '选中车辆后点击新起点' },
  { id: 'addTaskPickup', label: '任务取点', hint: '点击格子设为当前任务的取货点' },
  { id: 'addTaskDropoff', label: '任务送点', hint: '点击格子设为当前任务的送货点' },
  { id: 'stationDock', label: '工作站', hint: '连续点击格加入当前站泊位，右栏「完成建站」生效' },
  { id: 'removeItem', label: '删除', hint: '点击车辆起点/任务点删除对应对象' },
];

const SPEEDS: Speed[] = [0.25, 0.5, 1, 2, 4, 8];

export function AgvPanel(props: AgvPanelProps) {
  const { manifest, handle, engineReady, engineVersion, assetUrl, cancelSolve, setBusy, engineError, refresh } = props;

  const historyRef = useRef<AgvSceneHistory>(new AgvSceneHistory(blankAgvScene(8, 5, 'agv-scene-initial')));
  const [scene, setScene] = useState<AgvScene>(historyRef.current.doc);
  const [fitNonce, setFitNonce] = useState(0);
  const [tool, setTool] = useState<Tool>('select');
  /** 撤销栈变化序号（笔画结算时递增，刷新 ↶/↷ 禁用态与读数）。 */
  const [histNonce, setHistNonce] = useState(0);
  // —— 运行历史 / 多策略对比（上限 20 条；同 problem_hash 才可对比）——
  const [runs, setRuns] = useState<AgvRunRecord[]>([]);
  const runSeqRef = useRef(0);
  const [compare, setCompare] = useState<{ a: AgvRunRecord; b: AgvRunRecord } | null>(null);

  /** 动态事件向导（回放至 T 时刻进入「动态调度」子模式）。 */
  const [wizard, setWizard] = useState<{
    active: boolean;
    kind: AgvWizardKind;
    events: AgvDynamicEventInput[];
    snapshotTime: number;
    pendingCell: [number, number] | null;
    editingIndex: number | null;
    taskPickTarget: 'pickup' | 'dropoff';
    draft: {
      id: string;
      pickup: [number, number] | null;
      dropoff: [number, number] | null;
      pickupService: number;
      dropoffService: number;
      releaseStep: number;
      priority: number;
      dueStep: number | null;
      requiredCapability: string;
    };
    targetTask: string;
    targetVehicle: string;
    priority: number;
    until: number | null;
  }>({
    active: false,
    kind: null,
    events: [],
    snapshotTime: 0,
    pendingCell: null,
    editingIndex: null,
    taskPickTarget: 'pickup',
    draft: {
      id: '',
      pickup: null,
      dropoff: null,
      pickupService: 1,
      dropoffService: 1,
      releaseStep: 0,
      priority: 1,
      dueStep: null,
      requiredCapability: '',
    },
    targetTask: '',
    targetVehicle: '',
    priority: 2,
    until: null,
  });
  /** 3D 沙盘 / 2D 轻量模式（默认 3D）。 */
  const [view3d, setView3d] = useState(true);
  /** 3D 相机预设：等距 ↔ 正交俯视。 */
  const [camView, setCamView] = useState<'iso' | 'top'>('iso');
  const [primary, setPrimary] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const [pendingStation, setPendingStation] = useState<{ id: string; cells: Array<[number, number]> } | null>(null);

  const [solution, setSolution] = useState<AgvSolution | null>(null);
  const [raw, setRaw] = useState('');
  const [problemUsed, setProblemUsed] = useState('');
  const [verifyChecks, setVerifyChecks] = useState<Array<{ name: string; ok: boolean }> | null>(null);
  const [violations, setViolations] = useState<Array<{ code: string; message: string; at_step?: number | null; cell?: [number, number] | null }>>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [solving, setSolving] = useState(false);
  const [hover, setHover] = useState<Cell | null>(null);
  const [jsonDraft, setJsonDraft] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [stationCap, setStationCap] = useState(1);

  const clockRef = useRef<PlaybackClock | null>(null);
  if (!clockRef.current && typeof requestAnimationFrame === 'function') clockRef.current = new PlaybackClock();
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);

  const limits = useMemo(() => {
    const caps = (manifest?.capabilities ?? {}) as Record<string, unknown>;
    const lim = (caps.limits ?? {}) as Record<string, unknown>;
    const get = (k: string, d: number) => (typeof lim[k] === 'number' ? Number(lim[k]) : d);
    return {
      maxVehicles: get('max_vehicles', 64),
      maxTasks: get('max_tasks', 128),
      maxCells: get('max_map_cells', 16384),
      maxBudgetMs: get('max_budget_ms', 120_000),
      maxEvents: get('max_events', 16),
      verified: Boolean(manifest),
    };
  }, [manifest]);

  const dims = useMemo(() => agvDims(scene), [scene]);
  const issues = useMemo(() => precheckAgvScene(scene, limits), [scene, limits]);
  const errors = issues.filter((i) => i.level === 'error');
  const solvable = errors.length === 0 && scene.vehicles.length > 0 && engineReady && !solving;

  const maxT = useMemo(() => {
    if (!solution?.plan?.vehicles?.length) return 0;
    return solution.plan.vehicles.reduce((m, v) => Math.max(m, (v.timeline?.length ?? 1) - 1), 0);
  }, [solution]);

  // —— 渲染管线 ——
  const rendererRef = useRef<MapRenderer | null>(null);
  const renderStateRef = useRef<AgvRenderState>({
    scene,
    solution: null,
    t: 0,
    primary: null,
    layers: { paths: true, executed: true, markers: true, vehicles: true },
    hover: null,
    invalidCells: [],
    conflictCells: [],
  });

  const invalidCells = useMemo(() => issues.filter((i) => i.cell).map((i) => ({ x: i.cell![0], y: i.cell![1] })), [issues]);
  const conflictCells = useMemo(() => violations.filter((v) => v.cell).map((v) => ({ x: v.cell![0], y: v.cell![1] })), [violations]);

  useEffect(() => {
    renderStateRef.current = {
      scene,
      solution,
      t,
      primary,
      layers: { paths: true, executed: true, markers: true, vehicles: true },
      hover,
      invalidCells,
      conflictCells,
    };
    rendererRef.current?.invalidate();
  });

  const cellsKey = scene.map.cells.join('\n');
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.setBasePainter(gridBasePainter(dims, (x, y) => isAgvBlocked(scene, x, y)));
    r.invalidateBase();
    r.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellsKey, dims.width, dims.height, rendererRef.current]);

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

  // 首屏先给出完整、可直接求解的仓库原型；若旧构建清单没有该样例，退回 a03。
  const loadMock = useCallback(
    async (file: string) => {
      try {
        const res = await fetch(assetUrl(file), { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const parsed = parseAgvScene(text);
        historyRef.current.load({ ...parsed, id: `${parsed.id}-copy` });
        setScene(historyRef.current.doc);
        setSolution(null);
        setWizard((w) => ({ ...w, active: false, kind: null, events: [], pendingCell: null, editingIndex: null }));
        setRaw('');
        setVerifyChecks(null);
        setViolations([]);
        setPrimary(parsed.vehicles[0]?.id ?? null);
        setActiveTask(parsed.tasks[0]?.id ?? null);
        setFitNonce((n) => n + 1);
        setT(0);
        setNotice(`已载入 ${file}（可编辑副本）`);
      } catch (err) {
        setNotice(`读取 ${file} 失败：${(err as Error).message}`);
      }
    },
    [assetUrl],
  );

  useEffect(() => {
    const target =
      manifest?.mocks?.find((m) => m.file.includes('warehouse-studio')) ??
      manifest?.mocks?.find((m) => m.file.includes('a03')) ??
      manifest?.mocks?.[0];
    if (target) void loadMock(target.file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest]);

  const clearComputedSolution = useCallback(() => {
    setSolution(null);
    setRaw('');
    setProblemUsed('');
    setVerifyChecks(null);
    setViolations([]);
    setT(0);
    setPlaying(false);
    setNotice(null);
    clockRef.current?.setRange(0, 0);
  }, []);

  const exec = useCallback((cmd: AgvCommand) => {
    const before = historyRef.current.doc;
    const next = historyRef.current.exec(cmd);
    if (next !== before) {
      setScene(next);
      clearComputedSolution();
    }
  }, [clearComputedSolution]);

  // —— 笔画级撤销：一笔障碍 = 一个历史步（V2 §4）——
  const beginStroke = useCallback(() => {
    if (wizard.active || (tool !== 'wall' && tool !== 'erase')) return;
    historyRef.current.beginStroke();
  }, [tool, wizard.active]);

  const endStroke = useCallback(() => {
    if (!historyRef.current.stroking) return;
    historyRef.current.endStroke();
    setScene(historyRef.current.doc);
    setHistNonce((n) => n + 1);
  }, []);

  // —— 求解 ——
  const solve = useCallback(
    async (dynamicProblem?: string, dynamicTime?: number) => {
      if (!handle) return;
      if (errors.length > 0) {
        setNotice(`场景存在 ${errors.length} 项结构性问题，先修复后再求解`);
        return;
      }
      const problemText = dynamicProblem ?? serializeAgvScene(scene);
    setSolving(true);
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await handle.solve(problemText, {
        algorithm: scene.solver.algorithm,
        time_limit_ms: scene.solver.time_limit_ms,
        verify: true,
      });
      const sol = outcome.solution as AgvSolution | null;
      setRaw(outcome.raw ?? '');
      setSolution(sol ?? null);
      setProblemUsed(problemText);
      setVerifyChecks(null);
      setViolations([]);
      if (sol?.plan?.vehicles?.length) {
        clockRef.current?.setRange(
          sol.plan.vehicles.reduce((m, v) => Math.max(m, (v.timeline?.length ?? 1) - 1), 0),
          dynamicProblem ? Math.min(dynamicTime ?? t, sol.plan.vehicles.reduce((m, v) => Math.max(m, (v.timeline?.length ?? 1) - 1), 0)) : 0,
        );
        if (!dynamicProblem) setT(0);
        setPrimary(sol.plan.vehicles[0]?.id ?? null);
      }
      if (sol && (sol.plan?.vehicles?.length ?? 0) > 0) {
        try {
          const v = await handle.verify(problemText, outcome.raw, { strict: false });
          const report = v.report as unknown as { checks?: Array<{ name: string; ok: boolean }>; violations?: Array<{ code: string; message: string; at_step?: number | null; cell?: [number, number] | null }> };
          setVerifyChecks(report.checks ?? []);
          setViolations(report.violations ?? []);
        } catch {
          /* 核验不可用如实显示 */
        }
      }
      runSeqRef.current += 1;
      const rec = makeAgvRunRecord(
        runSeqRef.current,
        problemText,
        outcome.raw ?? '',
        sol ?? ({ status: 'UNKNOWN' } as AgvSolution),
        `${scene.solver.algorithm}/t=${scene.solver.time_limit_ms}${dynamicProblem ? '/dynamic' : ''}`,
      );
      setRuns((rs) => [...rs.slice(-(AGV_MAX_RUNS - 1)), rec]);
      const errList = sol?.errors ?? [];
      if (errList.length) setNotice(`${sol?.status}：${errList[0].code} · ${errList[0].message}`);
    } catch (err) {
      setNotice(isAgvCancelError(err) ? '已取消：Worker 已终止，下次求解自动重建' : `求解异常：${(err as Error).message}`);
    } finally {
      setSolving(false);
      setBusy(false);
    }
  }, [handle, scene, errors.length, setBusy, t]);

  // —— 地图点击 ——
  const cellOwner = (cell: Cell): { kind: 'vehicle' | 'task' | 'station'; id: string } | null => {
    for (const v of scene.vehicles) {
      if (v.start[0] === cell.x && v.start[1] === cell.y) return { kind: 'vehicle', id: v.id };
    }
    for (const tk of scene.tasks) {
      for (const [label, loc] of [['pickup', tk.pickup], ['dropoff', tk.dropoff]] as const) {
        for (const [x, y] of locCells(scene, loc)) {
          if (x === cell.x && y === cell.y) return { kind: 'task', id: `${tk.id}·${label}` };
        }
      }
    }
    for (const s of scene.stations) {
      for (const [x, y] of s.cells) {
        if (x === cell.x && y === cell.y) return { kind: 'station', id: s.id };
      }
    }
    return null;
  };

  const onCellClick = useCallback(
    (cell: Cell) => {
      // 动态向导是独立子模式：地图选择只生成草稿，不会立刻入队或编辑基础地图。
      if (wizard.active) {
        if (!wizard.kind) {
          setNotice('先选择动态事件类型；当前地图点击不会修改基础场景');
          return;
        }
        setWizard((w) => {
          if (!w.kind) return w;
          if (w.kind === 'obstacle_add' || w.kind === 'obstacle_remove') {
            return { ...w, pendingCell: [cell.x, cell.y] };
          }
          if (w.kind === 'task_add') {
            const draft = { ...w.draft };
            if (!draft.id) draft.id = `T-dyn-${scene.tasks.length + w.events.length + 1}`;
            if (w.taskPickTarget === 'pickup') {
              draft.pickup = [cell.x, cell.y];
              return { ...w, draft, taskPickTarget: 'dropoff' };
            }
            draft.dropoff = [cell.x, cell.y];
            return { ...w, draft, taskPickTarget: 'pickup' };
          }
          return w;
        });
        setNotice(null);
        return;
      }
      const blocked = isAgvBlocked(scene, cell.x, cell.y);
      switch (tool) {
        case 'select': {
          const owner = cellOwner(cell);
          if (owner?.kind === 'vehicle') setPrimary(owner.id);
          if (owner?.kind === 'task') setActiveTask(owner.id.split('·')[0]);
          break;
        }
        case 'wall': {
          if (cellOwner(cell)) {
            setNotice('该格被车辆/任务/泊位占用，不能画障碍');
            return;
          }
          setNotice(null);
          exec({ type: 'toggleWall', cell: [cell.x, cell.y], blocked: true });
          break;
        }
        case 'erase':
          exec({ type: 'toggleWall', cell: [cell.x, cell.y], blocked: false });
          break;
        case 'addVehicle': {
          if (blocked) {
            setNotice('不能在障碍格上放置车辆');
            return;
          }
          if (scene.vehicles.length >= limits.maxVehicles) {
            setNotice(`车辆已达档位上限 ${limits.maxVehicles} 台`);
            return;
          }
          setNotice(null);
          const id = `V${scene.vehicles.length + 1}`;
          exec({ type: 'addVehicle', at: [cell.x, cell.y], id });
          setPrimary(id);
          break;
        }
        case 'moveVehicle': {
          if (!primary) {
            setNotice('先用「选择」点选一台车辆');
            return;
          }
          exec({ type: 'setVehicleStart', id: primary, at: [cell.x, cell.y] });
          break;
        }
        case 'addTaskPickup':
        case 'addTaskDropoff': {
          if (blocked) {
            setNotice('任务点不能在障碍格上');
            return;
          }
          // 点击工作站泊位 → 引用站点；否则显式格
          const st = scene.stations.find((s) => s.cells.some(([x, y]) => x === cell.x && y === cell.y));
          const loc = st ? { station: st.id } : ([cell.x, cell.y] as [number, number]);
          if (!activeTask) {
            const id = `T${scene.tasks.length + 1}`;
            const pickup: [number, number] = [cell.x, cell.y];
            exec({ type: 'addTask', pickup, dropoff: null, id });
            setActiveTask(id);
            setTool('addTaskDropoff');
            setNotice(`任务 ${id} 已设取点，接着点送货点`);
            return;
          }
          if (tool === 'addTaskPickup') exec({ type: 'setTaskPickup', id: activeTask, at: loc });
          else exec({ type: 'setTaskDropoff', id: activeTask, at: loc });
          break;
        }
        case 'stationDock': {
          if (blocked) {
            setNotice('泊位不能在障碍格上');
            return;
          }
          setPendingStation((ps) => {
            if (!ps) return { id: `ST${scene.stations.length + 1}`, cells: [[cell.x, cell.y]] };
            if (ps.cells.some(([x, y]) => x === cell.x && y === cell.y)) return ps;
            return { ...ps, cells: [...ps.cells, [cell.x, cell.y]] };
          });
          break;
        }
        case 'removeItem': {
          const owner = cellOwner(cell);
          if (!owner) return;
          if (owner.kind === 'vehicle') exec({ type: 'removeVehicle', id: owner.id });
          else if (owner.kind === 'task') exec({ type: 'removeTask', id: owner.id.split('·')[0] });
          else if (owner.kind === 'station') exec({ type: 'removeStation', id: owner.id });
          break;
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, scene, primary, activeTask, exec, limits.maxVehicles, wizard.active, wizard.kind, wizard.until, scene.tasks.length],
  );

  const onCellDrag = useCallback(
    (cell: Cell) => {
      if (wizard.active || (tool !== 'wall' && tool !== 'erase')) return;
      if (tool === 'wall') {
        const owner = cellOwner(cell);
        if (owner) {
          const target = owner.kind === 'task' ? `任务点 ${owner.id}` : owner.kind === 'station' ? `工作站 ${owner.id}` : `车辆 ${owner.id}`;
          setNotice(`${target} 占用了 (${cell.x},${cell.y})，未放置障碍`);
          return;
        }
      }
      const before = historyRef.current.doc;
      const next = historyRef.current.exec({ type: 'toggleWall', cell: [cell.x, cell.y], blocked: tool === 'wall' });
      if (next !== before) {
        setScene(next);
        setNotice(null);
        clearComputedSolution();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, scene, wizard.active, clearComputedSolution],
  );

  // pendingStation → 应用命令
  useEffect(() => {
    if (!pendingStation) return;
    for (const c of pendingStation.cells) {
      historyRef.current.exec({ type: 'addStationDock', stationId: pendingStation.id, cell: c });
    }
    historyRef.current.exec({ type: 'finishStation', stationId: pendingStation.id, capacity: stationCap });
    setScene(historyRef.current.doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingStation, stationCap]);

  const taskRows = solution?.plan?.tasks ?? [];
  const dyn = solution?.dynamic ?? null;
  const metrics = (solution?.metrics ?? {}) as Record<string, number | string | boolean | null>;
  const phaseLabel = useMemo(() => {
    if (!solution?.plan?.vehicles || !primary) return null;
    const vi = solution.plan.vehicles.findIndex((v) => v.id === primary);
    if (vi < 0) return null;
    const task = taskOfAt(solution, vi, t);
    return `${primary}: ${phaseAt(solution, vi, t)}${task ? ` · ${task}` : ''}`;
  }, [solution, primary, t]);

  return (
    <section className="panel mapf-panel mapf-visual agv-panel" data-visual-module="agv" data-solution-status={solution?.status ?? 'idle'} data-solution-vehicles={solution?.plan?.vehicles?.length ?? 0}>
      <div className="engine-banner">
        <span>
          <b>AGV 引擎</b> rust-agv-dispatch <code>v{engineVersion}</code>（wasm-light，浏览器内计算）
        </span>
        {engineError && <span className="badge">装载失败</span>}
        {!engineError && !engineReady && <span className="badge">引擎装载中…</span>}
        {!limits.verified && <span className="badge">未验证档位</span>}
        {engineError && (
          <button type="button" className="btn" onClick={refresh}>
            重试装载
          </button>
        )}
      </div>
      {engineError && <div className="error-panel">{engineError}</div>}

      <div className="mapf-workspace">
        {/* 左栏 */}
        <aside className="mapf-left">
          <section className="rail-group">
            <h4>场景库（agv/mock）</h4>
            <div className="scene-templates">
              <button
                type="button"
                className="btn tiny"
                disabled={wizard.active}
                onClick={() => {
                  const s = blankAgvScene(12, 6);
                  historyRef.current.load(s);
                  setScene(s);
                  setSolution(null);
                  setPrimary(null);
                  setActiveTask(null);
                  setFitNonce((n) => n + 1);
                }}
              >
                空白 12×6
              </button>
              <button
                type="button"
                className="btn tiny"
                disabled={wizard.active}
                onClick={() => {
                  const s = blankAgvScene(20, 12);
                  historyRef.current.load(s);
                  setScene(s);
                  setSolution(null);
                  setFitNonce((n) => n + 1);
                }}
              >
                空白 20×12
              </button>
            </div>
            <div className="scene-list">
              {(manifest?.mocks ?? []).map((entry) => (
                <button key={entry.file} type="button" className="scene-card" disabled={wizard.active} onClick={() => void loadMock(entry.file)} title={entry.description}>
                  <b>{entry.name}</b>
                  <span className="muted small">
                    {entry.vehicles != null ? `${entry.vehicles} 车 ` : ''}
                    {entry.tasks != null ? `${entry.tasks} 任务 ` : ''}
                    {entry.width != null ? `${entry.width}×${entry.height}` : ''}
                    {entry.dynamic ? ' · 动态' : ''}
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="rail-group">
            <h4>编辑工具</h4>
            <div className="tool-grid">
              {TOOLS.map((tl) => (
                <button key={tl.id} type="button" className={`btn tiny tool-btn ${tool === tl.id ? 'primary' : ''}`} disabled={wizard.active} title={tl.hint} onClick={() => setTool(tl.id)}>
                  {tl.label}
                </button>
              ))}
              <button type="button" className="btn tiny" disabled={wizard.active || !historyRef.current.canUndo} onClick={() => { const next = historyRef.current.undo(); if (next) { setScene(next); clearComputedSolution(); setHistNonce((n) => n + 1); } }}>
                ↶ 撤销
              </button>
              <button type="button" className="btn tiny" disabled={wizard.active || !historyRef.current.canRedo} onClick={() => { const next = historyRef.current.redo(); if (next) { setScene(next); clearComputedSolution(); setHistNonce((n) => n + 1); } }}>
                ↷ 重做
              </button>
            </div>
            <p className="muted small">{TOOLS.find((tl) => tl.id === tool)?.hint}{histNonce >= 0 && historyRef.current.steps > 0 && <span className="muted"> · 撤销栈 {historyRef.current.steps} 步</span>}</p>
            {pendingStation && (
              <div className="pending-station">
                <span className="small">
                  建站 {pendingStation.id}：{pendingStation.cells.length} 泊位
                </span>
                <label className="field">
                  容量
                  <input type="number" min={1} max={8} value={stationCap} onChange={(e) => setStationCap(Math.max(1, Number(e.target.value) || 1))} />
                </label>
                <button
                  type="button"
                  className="btn tiny primary"
                  onClick={() => {
                    setStationCap((c) => c); // 触发 effect 应用
                    setPendingStation(null);
                    setNotice(`工作站已建（容量 ${stationCap}）`);
                  }}
                >
                  完成建站
                </button>
              </div>
            )}
          </section>

          <section className="rail-group">
            <h4>求解参数</h4>
            <label className="field">
              算法
              <select value={scene.solver.algorithm} disabled={wizard.active} onChange={(e) => setScene({ ...scene, solver: { ...scene.solver, algorithm: e.target.value as AgvScene['solver']['algorithm'] } })}>
                <option value="insertion-ls">insertion-ls（正式）</option>
                <option value="baseline">baseline（基线）</option>
                <option value="auto">auto</option>
              </select>
            </label>
            <label className="field">
              预算 ms
              <input type="number" min={100} max={limits.maxBudgetMs} step={500} value={scene.solver.time_limit_ms} disabled={wizard.active} onChange={(e) => setScene({ ...scene, solver: { ...scene.solver, time_limit_ms: Number(e.target.value) || 5000 } })} />
            </label>
            <label className="field">
              时域
              <select
                value={String(scene.time_model.horizon)}
                disabled={wizard.active}
                onChange={(e) => setScene({ ...scene, time_model: { ...scene.time_model, horizon: e.target.value === 'auto' ? 'auto' : Number(e.target.value) } })}
              >
                <option value="auto">auto（引擎自定）</option>
                {[60, 120, 200, 400].map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="rail-group">
            <h4>求解控制</h4>
            <div className="solve-row">
              <button type="button" className="btn primary" disabled={wizard.active || !solvable} onClick={() => void solve()}>
                {solving ? '求解中…' : '求解调度'}
              </button>
              <button type="button" className="btn" disabled={!solving} onClick={() => cancelSolve()}>
                取消
              </button>
              {!solvable && !solving && <span className="muted small">{!engineReady ? '引擎装载中' : errors.length > 0 ? `先修复 ${errors.length} 项问题` : scene.vehicles.length === 0 ? '场景没有车辆' : ''}</span>}
            </div>
            {notice && <p className="muted small mapf-notice">{notice}</p>}
            {solution?.search && (
              <details className="mapf-details">
                <summary>搜索统计（过程数据）</summary>
                <pre className="small">{JSON.stringify(solution.search, null, 1)}</pre>
              </details>
            )}
          </section>

          <details className="mapf-details json-drawer">
            <summary>高级 · JSON（agv-dispatch-problem/1.0）</summary>
            <textarea rows={10} value={jsonDraft || serializeAgvScene(scene)} disabled={wizard.active} spellCheck={false} onChange={(e) => setJsonDraft(e.target.value)} />
            {jsonError && <p className="bad-text small">{jsonError}</p>}
            <div className="solve-row">
              <button
                type="button"
                className="btn tiny"
                disabled={wizard.active}
                onClick={() => {
                  try {
                    const parsed = parseAgvScene(jsonDraft);
                    historyRef.current.exec({ type: 'replace', doc: parsed });
                    setScene(parsed);
                    setJsonError(null);
                    setFitNonce((n) => n + 1);
                  } catch (err) {
                    setJsonError((err as Error).message);
                  }
                }}
              >
                应用
              </button>
              <button type="button" className="btn tiny" disabled={wizard.active} onClick={() => setJsonDraft('')}>
                刷新自场景
              </button>
            </div>
          </details>
        </aside>

        {/* 中央 */}
        <div className="mapf-center">
          <div className="mapf-stage-wrap">
            {view3d ? (
              <AgvSandbox3D
                scene={scene}
                solution={solution}
                t={t}
                primary={primary}
                layers={{ paths: true, executed: true, markers: true, vehicles: true }}
                hover={hover}
                invalidCells={invalidCells}
                conflictCells={conflictCells}
                view={camView}
                brushing={tool === 'wall' || tool === 'erase'}
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
                  renderer.setLayerPainter(1, paintAgvPathsL1(renderStateRef.current));
                  renderer.setLayerPainter(2, paintAgvEntitiesL2(renderStateRef.current));
                  renderer.setLayerPainter(3, paintAgvOverlayL3(renderStateRef.current));
                }}
              </MapStage>
            )}
            <div className="mapf-toolbar">
              <button type="button" className={`btn tiny ${tool === 'select' ? 'primary' : ''}`} onClick={() => setTool('select')}>
                选择
              </button>
              {!view3d && (
                <button type="button" className="btn tiny" onClick={() => setFitNonce((n) => n + 1)}>
                  适配
                </button>
              )}
              {solution && !wizard.active && (
                <button
                  type="button"
                  className="btn tiny"
                  title="在回放当前时刻注入动态事件并重调度"
                  onClick={() => {
                    clockRef.current?.pause();
                    setWizard((w) => ({
                      ...w,
                      active: true,
                      kind: null,
                      events: [],
                      snapshotTime: t,
                      pendingCell: null,
                      editingIndex: null,
                      taskPickTarget: 'pickup',
                      until: null,
                      targetTask: scene.tasks[0]?.id ?? '',
                      targetVehicle: scene.vehicles[0]?.id ?? '',
                      draft: { ...w.draft, id: `T-dyn-${scene.tasks.length + 1}`, pickup: null, dropoff: null },
                    }));
                  }}
                >
                  ⚡ 注入动态事件
                </button>
              )}
              <span style={{ width: 6 }} />
              <Segmented
                ariaLabel="视图模式"
                value={view3d ? '3d' : '2d'}
                onChange={(v) => setView3d(v === '3d')}
                options={[
                  { id: '3d', label: '3D 沙盘', title: '等距三维微缩仓库（默认）' },
                  { id: '2d', label: '2D 轻量', title: '轻量二维模式（低性能设备兜底）' },
                ]}
              />
              {view3d && (
                <Segmented
                  ariaLabel="相机视角"
                  value={camView}
                  onChange={setCamView}
                  options={[
                    { id: 'iso', label: '透视', title: '3D 透视视角（真实远小近大）' },
                    { id: 'top', label: '俯视', title: '俯视对格（垂直观察）' },
                  ]}
                />
              )}
              {raw && (
                <button
                  type="button"
                  className="btn tiny"
                  onClick={() => {
                    const blob = new Blob([raw], { type: 'application/json' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `${solution?.id ?? 'agv-solution'}.json`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                  }}
                >
                  导出方案
                </button>
              )}
            </div>
            <div className="mapf-readout muted small">
              {hover ? `(${hover.x}, ${hover.y}) · ${isAgvBlocked(scene, hover.x, hover.y) ? '障碍' : '可通行'}` : '—'}
            </div>
            {wizard.active && solution && (
              <AgvDynamicWizard
                scene={scene}
                solution={solution}
                time={wizard.snapshotTime}
                maxT={maxT}
                maxEvents={limits.maxEvents}
                busy={solving}
                events={wizard.events}
                kind={wizard.kind}
                pendingCell={wizard.pendingCell}
                editingIndex={wizard.editingIndex}
                taskPickTarget={wizard.taskPickTarget}
                draft={wizard.draft}
                targetTask={wizard.targetTask}
                targetVehicle={wizard.targetVehicle}
                priority={wizard.priority}
                until={wizard.until}
                pickLabel={
                  wizard.kind === 'obstacle_add'
                    ? '点击地图选择障碍格；确认后加入事件列表'
                    : wizard.kind === 'obstacle_remove'
                      ? '点击地图选择要移除的障碍格；确认后加入事件列表'
                      : wizard.kind === 'task_add'
                        ? `点击地图设置${wizard.taskPickTarget === 'pickup' ? '取货点' : '送达点'}`
                        : null
                }
                onPickKind={(kind) => setWizard((w) => ({ ...w, kind, pendingCell: null, editingIndex: null }))}
                onDraftChange={(patch) => setWizard((w) => ({ ...w, draft: { ...w.draft, ...patch } }))}
                onTargetTaskChange={(id) => setWizard((w) => ({ ...w, targetTask: id }))}
                onTargetVehicleChange={(id) => setWizard((w) => ({ ...w, targetVehicle: id }))}
                onPriorityChange={(n) => setWizard((w) => ({ ...w, priority: n }))}
                onUntilChange={(n) => setWizard((w) => ({ ...w, until: n }))}
                onTaskPickTargetChange={(target) => setWizard((w) => ({ ...w, taskPickTarget: target }))}
                onRemoveEvent={(i) =>
                  setWizard((w) => {
                    const editingIndex = w.editingIndex === i ? null : w.editingIndex != null && i < w.editingIndex ? w.editingIndex - 1 : w.editingIndex;
                    return { ...w, events: w.events.filter((_, j) => j !== i), editingIndex, pendingCell: w.editingIndex === i ? null : w.pendingCell };
                  })
                }
                onEditEvent={(i) =>
                  setWizard((w) => {
                    const event = w.events[i];
                    if (!event) return w;
                    const base = { ...w, kind: event.kind, editingIndex: i, pendingCell: null, until: null };
                    if (event.kind === 'obstacle_add') return { ...base, pendingCell: [...event.cell] as [number, number], until: event.until ?? null };
                    if (event.kind === 'obstacle_remove') return { ...base, pendingCell: [...event.cell] as [number, number] };
                    if (event.kind === 'task_add') {
                      return {
                        ...base,
                        taskPickTarget: 'pickup' as const,
                        draft: {
                          id: event.taskId,
                          pickup: Array.isArray(event.pickup) ? [...event.pickup] as [number, number] : null,
                          dropoff: Array.isArray(event.dropoff) ? [...event.dropoff] as [number, number] : null,
                          pickupService: event.pickupService,
                          dropoffService: event.dropoffService,
                          releaseStep: event.releaseStep,
                          priority: event.priority,
                          dueStep: event.dueStep,
                          requiredCapability: event.requiredCapability ?? '',
                        },
                      };
                    }
                    if (event.kind === 'task_cancel') return { ...base, targetTask: event.task };
                    if (event.kind === 'task_priority') return { ...base, targetTask: event.task, priority: event.priority };
                    return { ...base, targetVehicle: event.vehicle };
                  })
                }
                onAddEvent={() =>
                  setWizard((w) => {
                    if (!w.kind) return w;
                    let event: AgvDynamicEventInput | null = null;
                    if (w.kind === 'obstacle_add' && w.pendingCell) event = { kind: 'obstacle_add', cell: w.pendingCell, until: w.until };
                    else if (w.kind === 'obstacle_remove' && w.pendingCell) event = { kind: 'obstacle_remove', cell: w.pendingCell };
                    else if (w.kind === 'task_add') {
                      const d = w.draft;
                      if (!d.id.trim() || !d.pickup || !d.dropoff) return w;
                      event = {
                        kind: 'task_add',
                        taskId: d.id.trim(),
                        pickup: d.pickup,
                        dropoff: d.dropoff,
                        pickupService: d.pickupService,
                        dropoffService: d.dropoffService,
                        releaseStep: d.releaseStep,
                        priority: d.priority,
                        dueStep: d.dueStep,
                        requiredCapability: d.requiredCapability.trim() || null,
                      };
                    } else if (w.kind === 'task_cancel' && w.targetTask) event = { kind: 'task_cancel', task: w.targetTask };
                    else if (w.kind === 'task_priority' && w.targetTask) event = { kind: 'task_priority', task: w.targetTask, priority: w.priority };
                    else if (w.kind === 'vehicle_pause' && w.targetVehicle) event = { kind: 'vehicle_pause', vehicle: w.targetVehicle };
                    else if (w.kind === 'vehicle_resume' && w.targetVehicle) event = { kind: 'vehicle_resume', vehicle: w.targetVehicle };
                    if (!event) return w;

                    const events = [...w.events];
                    if (w.editingIndex != null) events[w.editingIndex] = event;
                    else {
                      if (events.length >= limits.maxEvents) return w;
                      events.push(event);
                    }
                    const draft = w.kind === 'task_add'
                      ? { ...w.draft, id: `T-dyn-${scene.tasks.length + events.filter((item) => item.kind === 'task_add').length + 1}`, pickup: null, dropoff: null }
                      : w.draft;
                    return { ...w, events, draft, pendingCell: null, editingIndex: null, taskPickTarget: 'pickup' };
                  })
                }
                onSubmit={(built) => {
                  setWizard((w) => ({ ...w, active: false, kind: null, pendingCell: null, editingIndex: null }));
                  void solve(withDynamicBlock(serializeAgvScene(scene), built), built.snapshot.time);
                }}
                onCancel={() => setWizard((w) => ({ ...w, active: false, kind: null, pendingCell: null, editingIndex: null }))}
              />
            )}
            <div className="mapf-legend muted small">
              <span>■车 ■载货 ◗服务中</span>
              <span>▲取 ▽送 ▣站泊位 P停车</span>
            </div>
          </div>

          <div className="mapf-bottom">
            <div className="mapf-play">
              <button type="button" className="btn tiny" disabled={wizard.active} onClick={() => clockRef.current?.seek(0)}>
                ⏮
              </button>
              <button type="button" className="btn tiny" disabled={wizard.active} onClick={() => clockRef.current?.step(-1)}>
                ◀
              </button>
              <button type="button" className="btn tiny primary" disabled={wizard.active} onClick={() => clockRef.current?.toggle()}>
                {playing ? '⏸' : '▶'}
              </button>
              <button type="button" className="btn tiny" disabled={wizard.active} onClick={() => clockRef.current?.step(1)}>
                ⏭
              </button>
              <span className="tabular-nums mapf-t-readout">
                t = {t} / {maxT}
              </span>
              <select value={speed} disabled={wizard.active} onChange={(e) => setSpeed(Number(e.target.value) as Speed)} aria-label="播放速度">
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
              {phaseLabel && <span className="muted small">当前相位：{phaseLabel}</span>}
            </div>
            <AgvTimeline solution={solution} t={t} maxT={maxT} primary={primary} disabled={wizard.active} onSeek={(tt) => clockRef.current?.seek(tt)} onSelectVehicle={(id) => setPrimary(id)} />
            <div className="mapf-metrics muted small">
              {solution ? (
                <>
                  <span className={`badge ${solution.status === 'FEASIBLE' ? 'ok' : solution.status === 'PARTIAL' ? 'warn' : 'bad-text'}`}>{solution.status}</span>
                  {metrics.completed_tasks != null && (
                    <span>
                      完成 <b>{String(metrics.completed_tasks)}</b>/{String(metrics.total_tasks ?? '?')}
                    </span>
                  )}
                  {metrics.flow_time != null && <span>流时 {String(metrics.flow_time)}</span>}
                  {metrics.makespan != null && <span>完时 {String(metrics.makespan)}</span>}
                  {metrics.dispatch_ms != null && <span>调度 {String(metrics.dispatch_ms)} ms</span>}
                  {metrics.total_ms != null && <span>总 {String(metrics.total_ms)} ms</span>}
                  <span>核验 {solution.verified === true ? '✓' : solution.verified === false ? '✗' : '—'}</span>
                </>
              ) : (
                <span>未求解 —— 地图/车辆/任务可编辑；泊位与停车格在 mock 场景中体验</span>
              )}
            </div>
          </div>
        </div>

        {/* 右栏 */}
        <div className="mapf-rail">
          {errors.length > 0 && (
            <section className="rail-group">
              <h4>
                问题清单 <span className="badge bad-text">{errors.length}</span>
              </h4>
              <ul className="issue-list">
                {errors.slice(0, 12).map((it, i) => (
                  <li key={i} className="error">
                    <code>{it.code}</code> {it.message}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rail-group">
            <h4>车辆（{scene.vehicles.length}）</h4>
            <div className="robot-list">
              {scene.vehicles.map((v, i) => {
                const sol = solution?.plan?.vehicles?.find((sv) => sv.id === v.id);
                const phase = sol ? (() => {
                  const vi = solution!.plan!.vehicles!.indexOf(sol);
                  return phaseAt(solution!, vi, t);
                })() : null;
                return (
                  <button key={v.id} type="button" className={`robot-row ${primary === v.id ? 'active' : ''}`} onClick={() => setPrimary(v.id)}>
                    <span className="mapf-swatch" style={{ background: agvColor(i) }} />
                    <span className="robot-id">{v.id}</span>
                    <span className="muted small">
                      ({v.start[0]},{v.start[1]})
                      {phase ? ` · ${phase}` : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rail-group">
            <h4>任务（{scene.tasks.length}）</h4>
            <div className="agv-task-list">
              {(solution?.plan?.tasks ?? scene.tasks.map((tk, i) => ({ id: tk.id, status: '未求解', vehicle: null, pickup_dock: Array.isArray(tk.pickup) ? tk.pickup : null, dropoff_dock: Array.isArray(tk.dropoff) ? tk.dropoff : null, pickup_done: null, dropoff_done: null, flow_time: null, lateness: null, reason: null, _i: i }))).map((tk) => (
                <div key={tk.id} className={`agv-task-row ${activeTask === tk.id ? 'active' : ''}`} onClick={() => setActiveTask(tk.id)}>
                  <b>{tk.id}</b>
                  <span className={`badge ${tk.status === 'completed' ? 'ok' : tk.status === 'cancelled' || tk.status === 'leg_infeasible' ? 'bad-text' : 'muted-badge'}`}>{tk.status}</span>
                  <span className="muted small">
                    {tk.vehicle ? `${tk.vehicle} · ` : ''}
                    {tk.dropoff_done != null ? `t=${tk.dropoff_done} 完成` : tk.reason ? tk.reason : ''}
                  </span>
                </div>
              ))}
            </div>
            {activeTask && scene.tasks.some((tk) => tk.id === activeTask) && (
              <TaskParamEditor
                task={scene.tasks.find((tk) => tk.id === activeTask)!}
                stations={scene.stations}
                onChange={(cmd) => exec(cmd)}
              />
            )}
          </section>

          {runs.length > 0 && (
            <section className="rail-group">
              <h4>运行历史（{runs.length}/{AGV_MAX_RUNS}）</h4>
              <div className="run-list">
                {runs.map((r) => (
                  <div key={r.seq} className="run-row">
                    <span className="robot-id">#{r.seq}</span>
                    <span className={`badge ${r.status === 'FEASIBLE' || r.status === 'OPTIMAL' ? 'ok' : 'muted-badge'}`}>{r.status}</span>
                    <span className="muted small">
                      {r.paramSummary} · 完成 {r.completedTasks ?? '—'}/{r.totalTasks ?? '—'} · makespan {r.makespan ?? '—'}
                      {r.dynamic ? ' · 动态' : ''}
                    </span>
                    <button
                      type="button"
                      className="btn tiny"
                      title="选为对比 A"
                      onClick={() => setCompare((c) => (c ? { ...c, a: r } : { a: r, b: r }))}
                    >
                      A
                    </button>
                    <button
                      type="button"
                      className="btn tiny"
                      title="选为对比 B"
                      onClick={() => setCompare((c) => (c ? { ...c, b: r } : { a: r, b: r }))}
                    >
                      B
                    </button>
                  </div>
                ))}
              </div>
              {compare && (
                <div className="compare-picker">
                  <div className="hud-row" style={{ justifyContent: 'space-between' }}>
                    <span className="muted small">
                      对比 #{compare.a.seq} vs #{compare.b.seq}
                      {!agvRunsGroupable(compare.a, compare.b) && '（问题不同，仅供查看）'}
                    </span>
                    <button type="button" className="btn tiny" onClick={() => setCompare(null)}>
                      关闭
                    </button>
                  </div>
                  <table className="data-table small-table">
                    <thead>
                      <tr>
                        <th>指标</th>
                        <th>#{compare.a.seq}</th>
                        <th>#{compare.b.seq}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diffAgvRuns(compare.a, compare.b).map((row) => (
                        <tr key={row.label}>
                          <td>{row.label}</td>
                          <td>{row.a}</td>
                          <td className={row.verdict === 'better' ? 'ok-text' : row.verdict === 'worse' ? 'bad-text' : ''}>{row.b}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
          {verifyChecks && (
            <section className="rail-group">
              <h4>冲突与核验</h4>
              <ul className="check-list">
                {verifyChecks.slice(0, 20).map((c, i) => (
                  <li key={i} className={c.ok ? 'ok' : 'bad'}>
                    {c.ok ? '✓' : '✗'} {c.name}
                  </li>
                ))}
              </ul>
              {violations.length > 0 ? (
                <ul className="violation-list">
                  {violations.slice(0, 8).map((v, i) => (
                    <li key={i}>
                      <code>{v.code}</code> {v.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">✓ {verifyChecks.filter((c) => c.ok).length} 项检查全部通过（独立验证器）</p>
              )}
            </section>
          )}

          {dyn && (
            <section className="rail-group">
              <h4>动态重调度汇总</h4>
              <table className="data-table small-table">
                <tbody>
                  <tr>
                    <td>快照时刻</td>
                    <td>T={dyn.snapshot_time ?? '—'}</td>
                  </tr>
                  <tr>
                    <td>事件</td>
                    <td>
                      {Object.entries(dyn.events ?? {})
                        .filter(([k]) => k !== 'total')
                        .map(([k, n]) => `${k}=${n}`)
                        .join(' · ') || '—'}
                    </td>
                  </tr>
                  {dyn.tasks_added?.length ? (
                    <tr>
                      <td>新增任务</td>
                      <td>{dyn.tasks_added.join(', ')}</td>
                    </tr>
                  ) : null}
                  {dyn.tasks_cancelled?.length ? (
                    <tr>
                      <td>取消任务</td>
                      <td>{dyn.tasks_cancelled.join(', ')}</td>
                    </tr>
                  ) : null}
                  {dyn.vehicles_paused?.length ? (
                    <tr>
                      <td>暂停车辆</td>
                      <td>{dyn.vehicles_paused.join(', ')}</td>
                    </tr>
                  ) : null}
                  <tr>
                    <td>受影响车辆</td>
                    <td>{dyn.affected_vehicles?.join(', ') || '—'}</td>
                  </tr>
                  <tr>
                    <td>T 后计划移动</td>
                    <td>{dyn.planned_moves_after_snapshot ?? '—'} 步</td>
                  </tr>
                  <tr>
                    <td>快照时已完成</td>
                    <td>{dyn.completed_at_snapshot?.join(', ') || '—'}</td>
                  </tr>
                  <tr>
                    <td>语义指纹</td>
                    <td>
                      <code>{dyn.semantic_digest?.slice(0, 19) ?? '—'}…</code>
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>
          )}

          {taskRows.length > 0 && (
            <section className="rail-group">
              <h4>任务明细</h4>
              <table className="data-table small-table">
                <thead>
                  <tr>
                    <th>任务</th>
                    <th>取</th>
                    <th>送</th>
                    <th>流时</th>
                  </tr>
                </thead>
                <tbody>
                  {taskRows.map((tk) => (
                    <tr key={tk.id}>
                      <td>{tk.id}</td>
                      <td>{tk.pickup_done ?? '—'}</td>
                      <td>{tk.dropoff_done ?? '—'}</td>
                      <td>{tk.flow_time ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      </div>
      {problemUsed && (
        <details className="mapf-details mapf-last-problem">
          <summary>上次提交的问题（agv-dispatch-problem/1.0 原文）</summary>
          <pre className="small">{problemUsed.slice(0, 4000)}</pre>
        </details>
      )}
    </section>
  );
}

/**
 * 任务参数完整编辑（V2 §5-3）：取/送服务时长、释放步、交期步、优先级、能力要求。
 * 只改场景文档（契约字段），求解仍由引擎完成。
 */
function TaskParamEditor({
  task,
  stations,
  onChange,
}: {
  task: AgvScene['tasks'][number];
  stations: AgvScene['stations'];
  onChange: (cmd: AgvCommand) => void;
}) {
  const locLabel = (loc: AgvScene['tasks'][number]['pickup']): string =>
    Array.isArray(loc) ? `(${loc[0]},${loc[1]})` : `站点 ${loc.station}`;
  return (
    <div className="param-grid" style={{ marginTop: 8 }}>
      <p className="muted small" style={{ gridColumn: '1 / -1' }}>
        {task.id}：取 {locLabel(task.pickup)} → 送 {locLabel(task.dropoff)}
      </p>
      <label className="field">
        取货服务
        <input
          type="number"
          min={0}
          value={task.pickup_service}
          onChange={(e) => onChange({ type: 'setTaskService', id: task.id, pickup_service: Math.max(0, Number(e.target.value) || 0), dropoff_service: task.dropoff_service })}
        />
      </label>
      <label className="field">
        送达服务
        <input
          type="number"
          min={0}
          value={task.dropoff_service}
          onChange={(e) => onChange({ type: 'setTaskService', id: task.id, pickup_service: task.pickup_service, dropoff_service: Math.max(0, Number(e.target.value) || 0) })}
        />
      </label>
      <label className="field">
        释放步
        <input
          type="number"
          min={0}
          value={task.release_step}
          onChange={(e) => onChange({ type: 'setTaskParams', id: task.id, release_step: Math.max(0, Number(e.target.value) || 0) })}
        />
      </label>
      <label className="field">
        交期步（可空）
        <input
          type="number"
          min={0}
          value={task.due_step ?? ''}
          onChange={(e) => onChange({ type: 'setTaskParams', id: task.id, due_step: e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0) })}
        />
      </label>
      <label className="field">
        优先级
        <input
          type="number"
          min={1}
          value={task.priority ?? 1}
          onChange={(e) => onChange({ type: 'setTaskParams', id: task.id, priority: Math.max(1, Number(e.target.value) || 1) })}
        />
      </label>
      <label className="field">
        能力要求（可空）
        <input
          value={task.required_capability ?? ''}
          placeholder="如 cold"
          onChange={(e) => onChange({ type: 'setTaskParams', id: task.id, required_capability: e.target.value.trim() || null })}
        />
      </label>
      {stations.length > 0 && (
        <p className="muted small" style={{ gridColumn: '1 / -1' }}>
          可用工作站：{stations.map((st) => `${st.id}（容量 ${st.capacity}）`).join(' · ')}
        </p>
      )}
    </div>
  );
}
