/**
 * MAPF（多机器人路径规划）实验面板。
 *
 * 需求对照：
 *  - 导入 Mock 与用户自己的 MapfProblem → 数据集卡片 + JSON 编辑器；
 *  - 设置目标 / 预算 / w / 种子 / 规划器 → 参数区；
 *  - 展示时空路径（栅格地图 + 逐步动画回放）与核验结果 → Canvas + 指标带 + 机器人表；
 *  - 首解时间、耗时、峰值内存、目标值与下界 → 指标卡；
 *  - 正确处理求解中断与 Worker 生命周期 → 运行中“取消”（terminate + 自动重建）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MapfManifest, MapfProblemLite, MapfSolution } from '../../core/mapf/types';
import type { MapfEngineHandle } from '../../core/mapf/engine';
import { isMapfCancelError } from '../../core/mapf/engine';

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

interface SolveParams {
  objective: 'soc' | 'makespan';
  time_limit_ms: number;
  suboptimality_factor: number;
  planner: 'auto' | 'ecbs' | 'pp';
  seed: number;
  verify: boolean;
}

const DEFAULT_PARAMS: SolveParams = {
  objective: 'soc',
  time_limit_ms: 3000,
  suboptimality_factor: 1.5,
  planner: 'auto',
  seed: 42,
  verify: true,
};

const PALETTE = ['#2f7de1', '#e2593b', '#3fa45a', '#b08300', '#8a5fc9', '#1e9aa7', '#c94f7c', '#5b7c00', '#4b6eaf', '#a5572f'];

const cellAt = (problem: MapfProblemLite | null, x: number, y: number): string => {
  if (!problem?.map?.cells?.[y]) return '#';
  return problem.map.cells[y][x] ?? '#';
};

export function MapfPanel(props: MapfPanelProps) {
  const { manifest, handle, engineReady, engineVersion, assetUrl, cancelSolve, setBusy, engineError, refresh } = props;
  const [selected, setSelected] = useState<string>('');
  const [problemText, setProblemText] = useState<string>('');
  const [params, setParams] = useState<SolveParams>(DEFAULT_PARAMS);
  const [busy, setBusyLocal] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [solution, setSolution] = useState<MapfSolution | null>(null);
  const [raw, setRaw] = useState<string>('');
  const [verifyReport, setVerifyReport] = useState<{ ok: boolean; counts?: Record<string, number> } | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const mocks = manifest?.mocks ?? [];
  const problem = useMemo<MapfProblemLite | null>(() => {
    if (!problemText.trim()) return null;
    try {
      return JSON.parse(problemText) as MapfProblemLite;
    } catch {
      return null;
    }
  }, [problemText]);
  const problemParseError = problemText.trim() && !problem ? 'JSON 无法解析（编辑后需是合法 MapfProblem）' : null;

  const loadMock = useCallback(
    async (file: string) => {
      setSelected(file);
      setNotice(null);
      try {
        const res = await fetch(assetUrl(file), { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setProblemText(await res.text());
        setSolution(null);
        setRaw('');
        setVerifyReport(null);
      } catch (err) {
        setNotice(`读取 ${file} 失败：${String((err as Error).message ?? err)}`);
      }
    },
    [assetUrl],
  );

  useEffect(() => {
    if (!selected && mocks.length > 0) void loadMock(mocks[0].file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest]);

  const maxT = useMemo(() => {
    if (!solution?.robots?.length) return 0;
    return solution.robots.reduce((m, r) => Math.max(m, (r.path?.length ?? 1) - 1), 0);
  }, [solution]);

  // 播放：固定步频（步/秒 = 2·speed）
  useEffect(() => {
    if (!playing) return;
    if (t >= maxT) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => setT((v) => Math.min(v + 1, maxT)), 500 / speed);
    return () => clearTimeout(id);
  }, [playing, t, maxT, speed]);

  const solve = useCallback(async () => {
    if (!handle || !problem) return;
    setBusyLocal(true);
    setBusy(true);
    setNotice(null);
    setSolution(null);
    setVerifyReport(null);
    const options: Record<string, unknown> = {
      objective: params.objective,
      time_limit_ms: params.time_limit_ms,
      suboptimality_factor: params.suboptimality_factor,
      planner: params.planner,
      seed: params.seed,
      verify: params.verify,
    };
    try {
      const outcome = await handle.solve(problemText, options);
      const sol = outcome.solution as MapfSolution | null;
      setRaw(outcome.raw ?? '');
      setSolution(sol ?? null);
      setT(0);
      setPlaying(Boolean(sol?.robots?.length));
      // 独立复核：用**原始输出文本**（不要在 UI 侧重序列化，指纹语义依赖原文）
      if (sol?.robots?.length && params.verify) {
        try {
          const v = await handle.verify(problemText, outcome.raw);
          setVerifyReport({ ok: v.report.ok, counts: v.report.counts });
        } catch {
          setVerifyReport(null);
        }
      }
      const errList = sol?.errors ?? [];
      if (errList.length) setNotice(`${sol?.status}：${errList[0].code} · ${errList[0].message}`);
    } catch (err) {
      setNotice(isMapfCancelError(err) ? '已取消：Worker 已终止，下次求解自动重建' : `求解异常：${String((err as Error).message ?? err)}`);
    } finally {
      setBusyLocal(false);
      setBusy(false);
    }
  }, [handle, problem, problemText, params, setBusy]);

  const cancel = useCallback(() => {
    cancelSolve();
  }, [cancelSolve]);

  // —— 画布：栅格 + 起止标记 + 当前时刻机器人位置（含等待自环提示） ——
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !problem?.map) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = problem.map.width;
    const H = problem.map.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const side = Math.max(6, Math.floor(Math.min(720 / W, 520 / H, 26)));
    const pw = side * W;
    const ph = side * H;
    canvas.width = pw * dpr;
    canvas.height = ph * dpr;
    canvas.style.width = `${pw}px`;
    canvas.style.height = `${ph}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#f6f7f9';
    ctx.fillRect(0, 0, pw, ph);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = cellAt(problem, x, y);
        if (c === '#' || c === 'T' || c === 'S') {
          ctx.fillStyle = c === 'T' ? '#31404f' : c === 'S' ? '#63717f' : '#3a3f46';
          ctx.fillRect(x * side, y * side, side, side);
        } else {
          ctx.strokeStyle = '#e2e6ea';
          ctx.strokeRect(x * side + 0.5, y * side + 0.5, side - 1, side - 1);
        }
      }
    }
    const posAt = (path: Array<[number, number]>, time: number): [number, number] => {
      if (!path || path.length === 0) return [0, 0];
      return path[Math.min(time, path.length - 1)];
    };
    const robots = solution?.robots ?? [];
    const draws = robots.length
      ? robots
      : (problem.robots ?? []).map((r) => ({ id: r.id, start: r.start, goal: r.goal, path: [r.start] as [number, number][], locked: false }));
    // 计划轨迹淡线
    if (solution) {
      for (const [i, r] of draws.entries()) {
        const path = (r as MapfSolution['robots'][number]).path ?? [];
        if (path.length < 2) continue;
        ctx.strokeStyle = `${PALETTE[i % PALETTE.length]}44`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let k = 0; k < path.length; k++) {
          const [x, y] = path[k];
          const cx = x * side + side / 2;
          const cy = y * side + side / 2;
          if (k === 0) ctx.moveTo(cx, cy);
          else ctx.lineTo(cx, cy);
        }
        ctx.stroke();
      }
    }
    // 起点/终点
    for (const [i, r] of draws.entries()) {
      const color = PALETTE[i % PALETTE.length];
      const [sx, sy] = r.start;
      const [gx, gy] = r.goal;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx * side + 3.5, sy * side + 3.5, side - 7, side - 7);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(gx * side + side / 2, gy * side + 2);
      ctx.lineTo(gx * side + side - 4, gy * side + side / 2);
      ctx.lineTo(gx * side + side / 2, gy * side + side - 2);
      ctx.lineTo(gx * side + 2, gy * side + side / 2);
      ctx.closePath();
      ctx.globalAlpha = 0.4;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // 当前时刻的机器人
    for (const [i, r] of draws.entries()) {
      if (!solution) continue;
      const [x, y] = posAt((r as MapfSolution['robots'][number]).path ?? [], t);
      const color = PALETTE[i % PALETTE.length];
      const cx = x * side + side / 2;
      const cy = y * side + side / 2;
      const rad = side * 0.32;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fill();
      const rr = r as MapfSolution['robots'][number];
      if (rr.locked) {
        ctx.strokeStyle = '#111';
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.arc(cx, cy, rad + 2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (side >= 14) {
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.round(rad)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), cx, cy + 0.5);
      }
    }
  }, [problem, solution, t]);

  const exportRaw = useCallback(() => {
    if (!raw) return;
    const blob = new Blob([raw], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${solution?.id ?? 'mapf-solution'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [raw, solution]);

  const m = solution?.metrics ?? {};
  const gap = solution?.objective?.lower_bound && solution?.objective?.value ? solution.objective.value / solution.objective.lower_bound : null;
  const engineWaiting = engineError ? '引擎未就绪' : !engineReady ? '引擎装载中…' : null;

  return (
    <section className="panel mapf-panel">
      <div className="engine-banner">
        <span>
          <b>MAPF 引擎</b> rust-ecbs-cbs <code>v{engineVersion}</code>（wasm-light，浏览器内计算）
        </span>
        {engineWaiting && <span className="badge">{engineWaiting}</span>}
        {engineError && <span className="badge">装载失败</span>}
        {engineError && (
          <button type="button" className="btn" onClick={refresh}>
            重试装载
          </button>
        )}
        <span className="muted small">
          清单：mapf-manifest.json{manifest ? ` · 构建于 ${new Date(manifest.builtAt).toLocaleString()}` : ''}
        </span>
      </div>
      {engineError && <div className="error-panel">{engineError}</div>}

      <div className="dataset-grid">
        {mocks.map((entry) => (
          <button
            type="button"
            key={entry.file}
            className={`dataset-card ${selected === entry.file ? 'active' : ''}`}
            onClick={() => void loadMock(entry.file)}
          >
            <span className="dataset-card-top">
              <span className="eyebrow">{entry.kind === 'negative' ? '负例' : 'Mock'}</span>
              <b>{entry.name}</b>
            </span>
            <span className="dataset-description">{entry.description}</span>
            <span className="dataset-stats">
              {entry.robots != null && <span>{entry.robots} 台</span>}
              {entry.width != null && <span>{entry.width}×{entry.height}</span>}
              {entry.expect && <em>{entry.expect}</em>}
            </span>
          </button>
        ))}
      </div>

      <div className="controls mapf-controls">
        <label className="field">
          目标
          <select value={params.objective} onChange={(e) => setParams({ ...params, objective: e.target.value as SolveParams['objective'] })}>
            <option value="soc">SOC（总耗时）</option>
            <option value="makespan">Makespan（完时）</option>
          </select>
        </label>
        <label className="field">
          预算 ms
          <input
            type="number"
            min={100}
            max={120000}
            step={100}
            value={params.time_limit_ms}
            onChange={(e) => setParams({ ...params, time_limit_ms: Number(e.target.value) || 3000 })}
          />
        </label>
        <label className="field">
          w（次优上界）
          <input
            type="range"
            min={1}
            max={3}
            step={0.05}
            value={params.suboptimality_factor}
            onChange={(e) => setParams({ ...params, suboptimality_factor: Number(e.target.value) })}
          />
          <span className="muted small">{params.suboptimality_factor.toFixed(2)}</span>
        </label>
        <label className="field">
          规划器
          <select value={params.planner} onChange={(e) => setParams({ ...params, planner: e.target.value as SolveParams['planner'] })}>
            <option value="auto">auto</option>
            <option value="ecbs">ECBS</option>
            <option value="pp">优先搜索 PP</option>
          </select>
        </label>
        <label className="field">
          种子
          <input type="number" value={params.seed} onChange={(e) => setParams({ ...params, seed: Number(e.target.value) || 0 })} />
        </label>
        <div className="mapf-actions">
          <button type="button" className="btn primary" disabled={!engineReady || busy || !problem} onClick={() => void solve()}>
            {busy ? '求解中…' : '求解'}
          </button>
          <button type="button" className="btn" disabled={!busy} onClick={cancel}>
            取消
          </button>
        </div>
      </div>
      {problemParseError && <div className="error-panel">{problemParseError}</div>}
      {notice && <p className="muted small">{notice}</p>}

      <details className="mapf-editor">
        <summary>问题 JSON（可直接编辑覆盖当前数据集） · {(problemText.length / 1024).toFixed(1)} KB</summary>
        <textarea rows={10} value={problemText} spellCheck={false} onChange={(e) => setProblemText(e.target.value)} />
      </details>

      {solution && (
        <div className="mapf-result">
          <div className="mapf-chips">
            <span className={`badge ${solution.status === 'OPTIMAL' ? 'ok' : solution.status === 'FEASIBLE' ? 'warn' : solution.status === 'UNKNOWN' || solution.status === 'CANCELLED' ? 'muted-badge' : 'bad-text'}`}>
              {solution.status}
            </span>
            {solution.objective?.value != null && (
              <span className="mapf-chip">
                {solution.objective.kind === 'makespan' ? 'Makespan' : 'SOC'} <b>{solution.objective.value}</b>
                {solution.objective.lower_bound != null && <span className="muted small"> / 下界 {solution.objective.lower_bound}</span>}
                {gap != null && gap > 1.0001 && <span className="muted small"> 差距 {(gap * 100 - 100).toFixed(1)}%</span>}
              </span>
            )}
            {solution.verified === true && <span className="mapf-chip ok-chip">核验通过</span>}
            {solution.verified === false && (solution.status === 'OPTIMAL' || solution.status === 'FEASIBLE') && (
              <span className="mapf-chip bad-text">核验失败</span>
            )}
            {verifyReport && <span className="mapf-chip">独立复核 {verifyReport.ok ? '✓' : `✗（${verifyReport.counts?.errors ?? '?'} 项）`}</span>}
            {m.first_feasible_ms != null && <span className="mapf-chip">首解 {m.first_feasible_ms} ms</span>}
            {m.solve_ms != null && <span className="mapf-chip">求解 {m.solve_ms} ms</span>}
            {m.verify_ms != null && <span className="mapf-chip">核验 {m.verify_ms} ms</span>}
            {m.peak_memory_bytes != null && <span className="mapf-chip">峰值 {(Number(m.peak_memory_bytes) / 1048576).toFixed(1)} MB</span>}
            {raw && (
              <button type="button" className="btn tiny" onClick={exportRaw}>
                导出方案 JSON
              </button>
            )}
          </div>

          {solution.dynamic && (
            <p className="muted small">
              动态事件：受影响 <b>{String(solution.dynamic.affected_agents ?? '–')}</b> · 路径改动 <b>{String(solution.dynamic.path_change_steps ?? '–')}</b> 步 · 冻结前缀覆盖 <b>{String(solution.dynamic.frozen_prefix_covered ?? '–')}</b>
            </p>
          )}

          {maxT > 0 && (
            <div className="mapf-canvas-wrap">
              <canvas ref={canvasRef} className="mapf-canvas" aria-label="时空路径回放" />
              <div className="mapf-play">
                <button type="button" className="btn tiny" onClick={() => setT(0)}>⏮</button>
                <button type="button" className="btn tiny" onClick={() => setT((v) => Math.max(0, v - 1))}>◀</button>
                <button type="button" className="btn tiny primary" onClick={() => setPlaying((p) => !p)}>
                  {playing ? '⏸' : '▶'}
                </button>
                <button type="button" className="btn tiny" onClick={() => setT((v) => Math.min(maxT, v + 1))}>▶</button>
                <input
                  type="range"
                  min={0}
                  max={maxT}
                  value={t}
                  onChange={(e) => {
                    setPlaying(false);
                    setT(Number(e.target.value));
                  }}
                  className="mapf-slider"
                  aria-label={`时刻 t=${t}/${maxT}`}
                />
                <span className="tabular-nums">t = {t} / {maxT}</span>
                <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="播放速度">
                  <option value={0.5}>0.5×</option>
                  <option value={1}>1×</option>
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                </select>
              </div>
            </div>
          )}

          {solution.robots?.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>机器人</th>
                  <th>起点 → 终点</th>
                  <th>步数</th>
                  <th>到达时刻</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {solution.robots.map((r, i) => (
                  <tr key={r.id}>
                    <td>
                      <span className="mapf-swatch" style={{ background: PALETTE[i % PALETTE.length] }} />
                      {r.id}
                    </td>
                    <td>
                      ({r.start[0]},{r.start[1]}) → ({r.goal[0]},{r.goal[1]})
                    </td>
                    <td>{r.steps ?? r.path.length - 1}</td>
                    <td>{r.arrival ?? '—'}</td>
                    <td>{r.locked ? '冻结前缀' : r.path.length - 1 > (r.arrival ?? r.path.length - 1) ? '等待后到' : '常规'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {(solution.errors?.length ?? 0) > 0 && (
            <div className="error-panel">
              {solution.errors!.slice(0, 8).map((e, i) => (
                <p key={i}>
                  <code>{e.code}</code> {e.path ? <span className="muted small">{e.path}</span> : null} — {e.message}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
