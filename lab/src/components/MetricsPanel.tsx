/**
 * 指标面板：首解时间 / 总耗时 / 内存 / 目标值（需求明确要求展示）。
 * 数值全部取自引擎返回的 `metrics` 与 `objective`，缺失即显示 unavailable。
 */

import type { MetricCard } from '../core/aps/transform';

export function MetricsPanel({ cards }: { cards: MetricCard[] }) {
  if (cards.length === 0) return <p className="muted">尚无指标。</p>;
  return (
    <div className="metrics-grid">
      {cards.map((c) => (
        <div key={c.key} className={`metric tone-${c.tone ?? 'normal'}`} title={c.hint}>
          <span className="metric-label">{c.label}</span>
          <span className="metric-value">{c.value}</span>
          {c.hint && <span className="metric-hint">{c.hint}</span>}
        </div>
      ))}
    </div>
  );
}
