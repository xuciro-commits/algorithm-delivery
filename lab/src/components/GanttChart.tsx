/**
 * 订单甘特图：一行一个订单，条 = 工序，颜色按技能区分，虚线 = 交期。
 *
 * 只做呈现：条形位置直接来自引擎返回的 `start_at/end_at`，不重算、不四舍五入到“好看的整数”。
 * 支持时间窗缩放（拖拽/滚轮）与工序点击（查看详情，供 `explain` 之外的快速排查）。
 */

import { useMemo, useRef, useState } from 'react';
import type { GanttBar, GanttModel } from '../core/aps/records';

const SKILL_COLORS = [
  '#4f9cf9',
  '#f2994a',
  '#27ae60',
  '#9b51e0',
  '#eb5757',
  '#2d9cdb',
  '#f2c94c',
  '#56ccf2',
];

function colorForSkill(skill: string, skills: string[]): string {
  const idx = skills.indexOf(skill);
  return SKILL_COLORS[(idx >= 0 ? idx : skills.length) % SKILL_COLORS.length];
}

function fmt(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface GanttProps {
  model: GanttModel;
  selectedOp?: string | null;
  onSelectOp?: (bar: GanttBar | null) => void;
}

export function GanttChart({ model, selectedOp, onSelectOp }: GanttProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<[number, number]>([0, 1]); // 相对窗口 [start, end]
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);

  const window = useMemo(() => {
    if (model.operationCount === 0) return { start: 0, end: 1 };
    const full = model.maxMs - model.minMs || 1;
    const start = model.minMs + full * zoom[0];
    const end = model.minMs + full * zoom[1];
    return { start, end: Math.max(end, start + 60_000) };
  }, [model, zoom]);

  const span = window.end - window.start;
  const pct = (ms: number) => ((ms - window.start) / span) * 100;

  const ticks = useMemo(() => {
    const count = 6;
    return Array.from({ length: count + 1 }, (_, i) => window.start + (span * i) / count);
  }, [window.start, span]);

  if (model.operationCount === 0) {
    return <p className="muted">暂无排程结果。</p>;
  }

  return (
    <div className="gantt" ref={containerRef}>
      <div className="gantt-toolbar">
        <span className="muted">
          {model.operationCount} 道工序 · {model.rows.length} 个订单 · 窗口 {fmt(window.start)} →{' '}
          {fmt(window.end)}
        </span>
        <div className="zoom">
          <button
            type="button"
            onClick={() => setZoom(([a, b]) => [Math.max(0, a - (b - a) * 0.25), Math.min(1, b + (b - a) * 0.1)])}
          >
            − 缩放
          </button>
          <button type="button" onClick={() => setZoom([0, 1])}>
            全览
          </button>
          <button
            type="button"
            onClick={() => setZoom(([a, b]) => [Math.min(1, a + (b - a) * 0.1), Math.min(1, b + (b - a) * 0.25)])}
          >
            + 缩放
          </button>
        </div>
      </div>

      <div className="gantt-axis">
        <div className="gantt-label-col" />
        <div className="gantt-axis-track">
          {ticks.map((t, i) => (
            <span key={i} className="tick" style={{ left: `${(i / (ticks.length - 1)) * 100}%` }}>
              {fmt(t)}
            </span>
          ))}
        </div>
      </div>

      <div className="gantt-rows">
        {model.rows.map((row) => (
          <div className="gantt-row" key={row.orderId}>
            <div className="gantt-label-col">
              <span className="order-id">{row.orderId}</span>
              <span className="muted small">
                P{row.priority} · {row.bars.length} 工序
                {row.tardinessMin > 0 ? ` · 延期 ${row.tardinessMin}m` : ' · 准时'}
              </span>
            </div>
            <div className="gantt-track">
              {ticks.map((_, i) => (
                <span key={i} className="grid-line" style={{ left: `${(i / (ticks.length - 1)) * 100}%` }} />
              ))}
              {Number.isFinite(row.dueMs) && (
                <span
                  className="due-line"
                  style={{ left: `${pct(row.dueMs)}%` }}
                  title={`交期 ${fmt(row.dueMs)}`}
                />
              )}
              {row.bars.map((bar) => {
                const left = pct(bar.startMs);
                const width = Math.max(0.35, (bar.durationMs / span) * 100);
                const visible = left + width >= 0 && left <= 100;
                if (!visible) return null;
                return (
                  <button
                    key={bar.opId}
                    type="button"
                    className={`gantt-bar ${selectedOp === bar.opId ? 'selected' : ''}`}
                    style={{
                      left: `${Math.max(0, left)}%`,
                      width: `${Math.min(100 - Math.max(0, left), width)}%`,
                      background: colorForSkill(bar.skill, model.skills),
                    }}
                    onClick={() => onSelectOp?.(bar)}
                    onMouseEnter={(e) =>
                      setTip({
                        x: e.clientX,
                        y: e.clientY,
                        text: `${bar.opId} · ${bar.skill}\n${bar.machineId} / ${bar.workerId}\n${fmt(
                          bar.startMs,
                        )} → ${fmt(bar.endMs)}`,
                      })
                    }
                    onMouseLeave={() => setTip(null)}
                    title={`${bar.opId}｜${bar.machineId} / ${bar.workerId}`}
                  >
                    <span className="bar-label">{bar.opId.split('-').slice(-1)[0]}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="legend">
        {model.skills.map((s) => (
          <span key={s} className="legend-item">
            <i style={{ background: colorForSkill(s, model.skills) }} />
            {s}
          </span>
        ))}
        <span className="legend-item">
          <i className="due-legend" />
          交期
        </span>
      </div>

      {tip && (
        <div className="tooltip" style={{ left: tip.x + 12, top: tip.y + 12 }}>
          {tip.text.split('\n').map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
