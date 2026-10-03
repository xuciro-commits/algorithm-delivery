/**
 * AGV 时间轴：Canvas 自绘 —— 每车一条轨道，任务 mission 按相位着色
 * （取货蓝 / 服务深 / 送货橙 / 空驶灰 / 停车浅），scrub 拖动 + 点轨道选车。
 */

import { useCallback, useEffect, useRef } from 'react';
import type { AgvSolution } from '../../core/agv/types';
import { agvColor } from './agvRender';

export interface AgvTimelineProps {
  solution: AgvSolution | null;
  t: number;
  maxT: number;
  primary: string | null;
  onSeek: (t: number) => void;
  onSelectVehicle: (id: string) => void;
}

const H_TRACK = 16;
const H_HEAD = 22;
const H_PAD = 6;
const LEFT = 34;

const PHASE_COLOR: Record<string, string> = {
  to_pickup: '#2f7de1',
  servicing_pickup: '#1d4e8f',
  to_dropoff: '#d98a2b',
  servicing_dropoff: '#a55f14',
  relocating: '#8a5fc9',
  parking: '#c5cbd2',
  idle: '#e2e6ea',
};

export function AgvTimeline(props: AgvTimelineProps) {
  const { solution, t, maxT, primary, onSeek, onSelectVehicle } = props;
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
    const vehicles = solution?.plan?.vehicles ?? [];
    const plotW = Math.max(10, W - LEFT - 8);
    const xOf = (time: number) => LEFT + (maxT <= 0 ? 0 : (time / maxT) * plotW);
    const n = Math.max(1, vehicles.length);
    const totalH = H_HEAD + n * H_TRACK + (n - 1) * H_PAD + 4;
    const scaleY = Math.min(1, H / totalH);
    const trackY = (i: number) => H_HEAD + i * (H_TRACK + H_PAD) * scaleY + (H_TRACK * scaleY) / 2;

    // 刻度
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
    // 当前游标
    const tx = Math.round(xOf(t)) + 0.5;
    ctx.strokeStyle = '#2f7de1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tx, 2);
    ctx.lineTo(tx, H - 2);
    ctx.stroke();

    for (const [i, v] of vehicles.entries()) {
      const y = trackY(i);
      const dim = primary && primary !== v.id;
      ctx.globalAlpha = dim ? 0.3 : 1;
      const color = agvColor(i);
      // 底轨（时间线跨度）
      ctx.fillStyle = `${color}22`;
      ctx.fillRect(xOf(0), y - (H_TRACK * scaleY) / 2, xOf(Math.min(maxT, (v.timeline?.length ?? 1) - 1)) - xOf(0), H_TRACK * scaleY);
      // mission 段
      for (const m of v.missions ?? []) {
        const c = PHASE_COLOR[m.phase] ?? '#9aa3ad';
        ctx.fillStyle = c;
        ctx.fillRect(xOf(m.from), y - (H_TRACK * scaleY) / 2 + 1, Math.max(1, xOf(m.to) - xOf(m.from)), H_TRACK * scaleY - 2);
        if (m.task && scaleY > 0.8 && H_TRACK >= 12 && xOf(m.to) - xOf(m.from) > 26) {
          ctx.fillStyle = '#fff';
          ctx.font = '9px system-ui';
          ctx.textAlign = 'left';
          ctx.fillText(m.task, xOf(m.from) + 3, y + 3);
        }
      }
      ctx.fillStyle = dim ? '#9aa3ad' : '#31404f';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(String(i + 1), LEFT - 6, y + 3);
      ctx.globalAlpha = 1;
    }
    // 图例
    ctx.font = '9px system-ui';
    ctx.textAlign = 'left';
    let lx = LEFT;
    const legend: Array<[string, string]> = [
      ['取货', PHASE_COLOR.to_pickup],
      ['服务', PHASE_COLOR.servicing_pickup],
      ['送货', PHASE_COLOR.to_dropoff],
      ['空驶', '#9aa3ad'],
    ];
    for (const [label, color] of legend) {
      ctx.fillStyle = color;
      ctx.fillRect(lx, 4, 8, 8);
      ctx.fillStyle = '#5b6470';
      ctx.fillText(label, lx + 11, 12);
      lx += 11 + ctx.measureText(label).width + 10;
    }
  }, [solution, t, maxT, primary]);

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

  return (
    <canvas
      ref={canvasRef}
      className="mapf-timeline"
      aria-label={`AGV 时间轴 t=${t}/${maxT}`}
      onPointerDown={(ev) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const y = ev.clientY - rect.top;
        const vehicles = solution?.plan?.vehicles ?? [];
        const n = Math.max(1, vehicles.length);
        const totalH = H_HEAD + n * H_TRACK + (n - 1) * H_PAD + 4;
        const scaleY = Math.min(1, sizeRef.current.h / totalH);
        const ti = Math.floor((y - H_HEAD) / ((H_TRACK + H_PAD) * scaleY));
        if (ti >= 0 && ti < vehicles.length) onSelectVehicle(vehicles[ti].id);
        draggingRef.current = true;
        const plotW = Math.max(10, sizeRef.current.w - LEFT - 8);
        onSeek(Math.max(0, Math.min(maxT, Math.round(((x - LEFT) / plotW) * maxT))));
      }}
      onPointerMove={(ev) => {
        if (!draggingRef.current) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const plotW = Math.max(10, sizeRef.current.w - LEFT - 8);
        onSeek(Math.max(0, Math.min(maxT, Math.round(((x - LEFT) / plotW) * maxT))));
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
