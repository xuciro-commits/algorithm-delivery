/**
 * 资源使用情况：利用率条形 + 每台机器/每名人员的时间线（谁在什么时候被占用）。
 * 利用率 = 占用分钟 / 可用分钟（可用窗口由 problem 的 available 汇总）。
 */

import { useState } from 'react';
import type { ResourceTimeline, ResourceUsage } from '../core/aps/records';

function fmt(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ResourcePanel({
  usage,
  timelines,
}: {
  usage: ResourceUsage[];
  timelines: ResourceTimeline[];
}) {
  const [kind, setKind] = useState<'all' | 'machine' | 'worker'>('all');
  const rows = usage.filter((u) => kind === 'all' || u.kind === kind);
  const lanes = timelines.filter((t) => kind === 'all' || t.kind === kind);
  if (usage.length === 0) return <p className="muted">暂无资源数据。</p>;

  return (
    <div className="resource-panel">
      <div className="tabs">
        {(['all', 'machine', 'worker'] as const).map((k) => (
          <button key={k} type="button" className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
            {k === 'all' ? '全部' : k === 'machine' ? '机器' : '人员'}
          </button>
        ))}
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>资源</th>
            <th>类型</th>
            <th>能力</th>
            <th>工序</th>
            <th>占用 / 可用（分钟）</th>
            <th>利用率</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={`${u.kind}:${u.id}`}>
              <td>
                <code>{u.id}</code>
              </td>
              <td>{u.kind === 'machine' ? '机器' : '人员'}</td>
              <td className="small">{u.capabilities.join('/') || '—'}</td>
              <td>{u.operations}</td>
              <td>
                {u.busyMin} / {u.availableMin}
              </td>
              <td>
                <div className="util">
                  <div className="util-bar" style={{ width: `${Math.min(100, u.utilization * 100)}%` }} />
                  <span>{(u.utilization * 100).toFixed(1)}%</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>资源时间线</h4>
      <div className="lanes">
        {lanes.map((lane) => {
          const span = (lane.maxMs - lane.minMs) || 1;
          const pct = (ms: number) => ((ms - lane.minMs) / span) * 100;
          const busy = lane.bars.reduce((acc, b) => acc + b.durationMs, 0);
          return (
            <div className="lane" key={`${lane.kind}:${lane.id}`}>
              <span className="lane-label" title={lane.label}>
                {lane.id}
              </span>
              <div className="lane-track">
                {lane.bars.map((b) => (
                  <span
                    key={b.opId}
                    className="lane-bar"
                    style={{ left: `${pct(b.startMs)}%`, width: `${Math.max(0.3, (b.durationMs / span) * 100)}%` }}
                    title={`${b.opId}\n${fmt(b.startMs)} → ${fmt(b.endMs)}\n订单 ${b.orderId}`}
                  />
                ))}
              </div>
              <span className="lane-meta muted small">
                {lane.bars.length} 道 · {Math.round(busy / 60000)}m
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
