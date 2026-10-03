/**
 * 时间轴（M0 §7.3）：Canvas 自绘 —— 上方统一步刻度轴 + 每车一条水平轨道。
 * 移动段 = 车色 · 等待段 = 灰 · 驻留段 = 车色 20% 透明 · 事件 ⚡ · 违规脉冲游标。
 * 交互：点击/拖动 scrub；点击某车轨道 = 选中该车。
 * React 只在 props 变化时重绘（回放步通过 t prop 传入——每步一次，远低于 rAF）。
 */

import { useCallback, useEffect, useRef } from 'react';
import type { MapfSolution } from '../../core/mapf/types';
import { phaseAt } from './playback/clock';
import { robotColor } from './render/MapfLayers';

export interface MapfTimelineProps {
  solution: MapfSolution | null;
  t: number;
  maxT: number;
  primary: string | null;
  selected: string[];
  events: Array<{ at: number; label?: string }>;
  conflictAt: number | null;
  frozenAt: number | null;
  onSeek: (t: number) => void;
  onSelectRobot: (id: string) => void;
}

const H_TRACK = 14;
const H_HEAD = 22;
const H_PAD = 6;

export function MapfTimeline(props: MapfTimelineProps) {
  const { solution, t, maxT, primary, selected, events, conflictAt, frozenAt, onSeek, onSelectRobot } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const draggingRef = useRef(false);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w: W, h: H } = sizeRef.current;
    if (W < 10 || H < 10) return;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(W * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const robots = solution?.robots ?? [];
    const leftPad = 34;
    const rightPad = 8;
    const plotW = Math.max(10, W - leftPad - rightPad);
    const nTracks = Math.max(1, robots.length);
    const tracksH = nTracks * H_TRACK + (nTracks - 1) * H_PAD;
    const totalH = H_HEAD + tracksH + 4;
    const scaleY = Math.min(1, H / totalH);
    const xOf = (time: number) => leftPad + (maxT <= 0 ? 0 : (time / maxT) * plotW);
    const trackY = (i: number) => H_HEAD + i * (H_TRACK + H_PAD) * scaleY + (H_TRACK * scaleY) / 2;

    // 刻度轴（每 5 步主刻度；密集时 10/25/50）
    const step = maxT > 300 ? 50 : maxT > 120 ? 25 : maxT > 50 ? 10 : 5;
    ctx.strokeStyle = '#c9cfd6';
    ctx.fillStyle = '#5b6470';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    ctx.lineWidth = 1;
    for (let s = 0; s <= maxT; s += step) {
      const x = Math.round(xOf(s)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, H_HEAD - 6);
      ctx.lineTo(x, H_HEAD - 2);
      ctx.stroke();
      if (maxT <= 400 || s % (step * 2) === 0) ctx.fillText(String(s), x, H_HEAD - 9);
    }
    // 当前 t 游标
    const tx = Math.round(xOf(t)) + 0.5;
    ctx.strokeStyle = '#2f7de1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tx, 2);
    ctx.lineTo(tx, H - 2);
    ctx.stroke();

    // 冻结窗底色
    if (frozenAt != null && frozenAt > 0) {
      ctx.fillStyle = 'rgba(47,125,225,0.08)';
      ctx.fillRect(xOf(0), H_HEAD, xOf(frozenAt) - xOf(0), H - H_HEAD - 2);
    }

    // 轨道
    for (const [i, r] of robots.entries()) {
      const y = trackY(i);
      const dim = primary && primary !== r.id && !selected.includes(r.id);
      const color = robotColor(i);
      ctx.globalAlpha = dim ? 0.25 : 1;
      const path = r.path ?? [];
      const arrival = r.arrival ?? path.length - 1;
      let segStart = 0;
      let segPhase = path.length > 1 ? phaseAt({ path, arrival: r.arrival }, 0) : 'waiting';
      const flush = (end: number, phase: string) => {
        if (end <= segStart) return;
        const x0 = xOf(segStart);
        const x1 = xOf(end);
        ctx.fillStyle = phase === 'waiting' ? '#9aa3ad' : phase === 'staying' ? `${color}33` : color;
        const barH = phase === 'waiting' ? Math.max(2, H_TRACK * 0.3) : Math.max(3, H_TRACK * 0.55);
        ctx.fillRect(x0, y - (barH * scaleY) / 2, x1 - x0, barH * scaleY);
      };
      for (let s = 1; s <= path.length - 1; s++) {
        const ph = phaseAt({ path, arrival: r.arrival }, s);
        if (ph !== segPhase) {
          flush(s, segPhase);
          segStart = s;
          segPhase = ph;
        }
      }
      flush(Math.max(segStart, Math.min(arrival + 1, maxT)), segPhase);
      // 驻留到 maxT
      if (arrival < maxT) {
        ctx.fillStyle = `${color}33`;
        ctx.fillRect(xOf(arrival + 1), y - (3 * scaleY) / 2, xOf(maxT) - xOf(arrival + 1), 3 * scaleY);
      }
      // 到达点
      if (arrival <= maxT) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(xOf(arrival), y, 2.5 * scaleY, 0, Math.PI * 2);
        ctx.fill();
      }
      // 车序号
      ctx.fillStyle = dim ? '#9aa3ad' : '#31404f';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(String(i + 1), leftPad - 6, y + 3);
      ctx.globalAlpha = 1;
    }

    // 事件标记 ⚡
    for (const e of events) {
      const x = xOf(e.at);
      ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#b08300';
      ctx.fillText('⚡', x, H_HEAD + 8);
    }
    // 冲突脉冲游标
    if (conflictAt != null) {
      const x = Math.round(xOf(conflictAt)) + 0.5;
      ctx.strokeStyle = 'rgba(226,89,59,0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 2);
      ctx.lineTo(x, H - 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [solution, t, maxT, primary, selected, events, conflictAt, frozenAt]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      sizeRef.current = { w: Math.max(1, Math.floor(rect.width)), h: Math.max(1, Math.floor(rect.height)) };
      draw();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => {
    draw();
  }, [draw]);

  const locate = (ev: PointerEvent | MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    return { x, y };
  };
  const timeAt = (x: number) => {
    const leftPad = 34;
    const plotW = Math.max(10, sizeRef.current.w - leftPad - 8);
    return Math.round(((x - leftPad) / plotW) * maxT);
  };
  const trackAt = (y: number): number => {
    const robots = solution?.robots ?? [];
    const n = Math.max(1, robots.length);
    const tracksH = n * H_TRACK + (n - 1) * H_PAD;
    const totalH = H_HEAD + tracksH + 4;
    const scaleY = Math.min(1, sizeRef.current.h / totalH);
    const i = Math.floor((y - H_HEAD) / ((H_TRACK + H_PAD) * scaleY));
    return i >= 0 && i < robots.length ? i : -1;
  };

  return (
    <canvas
      ref={canvasRef}
      className="mapf-timeline"
      aria-label={`时间轴 t=${t}/${maxT}`}
      onPointerDown={(ev) => {
        const p = locate(ev.nativeEvent);
        if (!p) return;
        const ti = trackAt(p.y);
        if (ti >= 0 && Math.abs(p.y - (H_HEAD + ti * (H_TRACK + H_PAD))) > H_TRACK) {
          const robots = solution?.robots ?? [];
          if (robots[ti]) {
            onSelectRobot(robots[ti].id);
            return;
          }
        }
        if (p.y < H_HEAD + 4) {
          draggingRef.current = true;
          onSeek(Math.max(0, Math.min(maxT, timeAt(p.x))));
        } else {
          // 轨道区域点击：选车 + 定位
          const ti2 = trackAt(p.y);
          const robots = solution?.robots ?? [];
          if (ti2 >= 0 && robots[ti2]) {
            onSelectRobot(robots[ti2].id);
          }
          draggingRef.current = true;
          onSeek(Math.max(0, Math.min(maxT, timeAt(p.x))));
        }
      }}
      onPointerMove={(ev) => {
        if (!draggingRef.current) return;
        const p = locate(ev.nativeEvent);
        if (p) onSeek(Math.max(0, Math.min(maxT, timeAt(p.x))));
      }}
      onPointerUp={() => {
        draggingRef.current = false;
      }}
      onPointerLeave={() => {
        draggingRef.current = false;
      }}
    />
  );
}
