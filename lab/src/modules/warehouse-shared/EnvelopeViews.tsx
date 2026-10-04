/**
 * 结果阅读区（两个新模块共用）：指标卡、核验、目标/对比、问题清单。
 *
 * 唯一纪律：**显示的数字全部来自引擎信封**。组件本身不做任何统计、不补齐缺失字段，
 * 缺数据时显示"—"，并把"未核验/未产出"作为明确状态呈现出来。
 */

import { useState } from 'react';
import type {
  WarehouseEnvelope,
  WarehouseIssue,
  WarehouseMetrics,
  WarehouseViolation,
} from '../../core/warehouse/types';

export function fmt(value: unknown, digits = 2): string {
  if (value == null) return '—';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    if (Number.isInteger(value) && Math.abs(value) < 1e6) return value.toLocaleString('zh-CN');
    if (Math.abs(value) >= 1e6) return value.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
    return value.toFixed(digits);
  }
  return String(value);
}

export function statusTone(status: string): 'optimal' | 'feasible' | 'warn' | 'bad' | 'unknown' {
  if (status === 'OPTIMAL_PROVEN') return 'optimal';
  if (status === 'FEASIBLE' || status === 'FEASIBLE_WITH_BOUND') return 'feasible';
  if (status === 'BUDGET_EXCEEDED' || status === 'CANCELLED' || status === 'NO_SOLUTION_FOUND') return 'warn';
  if (status === 'INVALID_INPUT' || status === 'UNSUPPORTED' || status === 'INTERNAL_ERROR' || status === 'INFEASIBLE_PROVEN') return 'bad';
  return 'unknown';
}

export interface MetricCard {
  key: string;
  label: string;
  value: string;
  hint?: string;
  tone?: 'normal' | 'good' | 'warn' | 'bad';
}

export function MetricGrid({ cards, columns = 3 }: { cards: MetricCard[]; columns?: number }) {
  return (
    <div className="metrics-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {cards.map((card) => (
        <div key={card.key} className="metric">
          <span className="metric-label">{card.label}</span>
          <strong className={`metric-value ${card.tone === 'good' ? 'ok-text' : card.tone === 'bad' ? 'bad-text' : card.tone === 'warn' ? 'warn-text' : ''}`}>
            {card.value}
          </strong>
          {card.hint && <span className="metric-hint muted small">{card.hint}</span>}
        </div>
      ))}
    </div>
  );
}

/** 公共指标卡（两个域都会用到的部分；各模块再追加自己的域卡片）。 */
export function commonMetricCards(metrics: WarehouseMetrics, runtimeMs: number | null): MetricCard[] {
  const cards: MetricCard[] = [];
  if (typeof metrics.tasksTotal === 'number') {
    const done = metrics.tasksDone ?? 0;
    cards.push({
      key: 'tasks',
      label: '完成 / 总任务',
      value: `${fmt(done)} / ${fmt(metrics.tasksTotal)}`,
      hint: metrics.tasksUnserved ? `未服务 ${fmt(metrics.tasksUnserved)}` : undefined,
      tone: metrics.tasksUnserved ? 'warn' : 'good',
    });
  }
  if (metrics.makespan_s != null) {
    cards.push({ key: 'makespan', label: '完工时间', value: `${fmt(metrics.makespan_s, 1)} s` });
  }
  if (metrics.throughputPerHour != null) {
    cards.push({ key: 'throughput', label: '吞吐', value: `${fmt(metrics.throughputPerHour, 1)} 件/h` });
  }
  if (metrics.conflicts != null) {
    cards.push({
      key: 'conflicts',
      label: '时空冲突',
      value: fmt(metrics.conflicts),
      tone: metrics.conflicts === 0 ? 'good' : 'warn',
      hint: metrics.deadlocksPrevented ? `预防死锁 ${fmt(metrics.deadlocksPrevented)}` : undefined,
    });
  }
  if (runtimeMs != null) {
    cards.push({ key: 'runtime', label: '求解耗时', value: runtimeMs >= 1000 ? `${fmt(runtimeMs / 1000, 1)} s` : `${fmt(runtimeMs, 0)} ms` });
  }
  if (metrics.scale) {
    const parts: string[] = [];
    if (metrics.scale.skus) parts.push(`${fmt(metrics.scale.skus)} SKU`);
    if (metrics.scale.locations) parts.push(`${fmt(metrics.scale.locations)} 库位`);
    if (metrics.scale.tasks) parts.push(`${fmt(metrics.scale.tasks)} 任务`);
    if (metrics.scale.devices) parts.push(`${fmt(metrics.scale.devices)} 设备`);
    if (parts.length) {
      cards.push({ key: 'scale', label: '实例规模', value: parts.join(' · '), hint: metrics.scale.note });
    }
  }
  return cards;
}

export function VerificationPanel({
  verification,
  onThicken,
}: {
  verification: WarehouseEnvelope['verification'];
  onThicken?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!verification) {
    return (
      <div className="notice">
        <strong>未核验。</strong>该结果没有核验报告（引擎未产出 verification），面板不会把"未核验"当作"通过"。
      </div>
    );
  }
  const violations: WarehouseViolation[] = verification.violations ?? [];
  const hard = violations.filter((item) => (item.class ?? item.severity) !== 'soft');
  const soft = violations.filter((item) => (item.class ?? item.severity) === 'soft');
  return (
    <div className="verify-panel">
      <div className="verify-head">
        <span className={`badge ${verification.ok ? 'status-optimal' : 'status-unsupported_constraint'}`}>
          {verification.ok ? '独立核验通过' : '独立核验未通过'}
        </span>
        <span className="muted small">
          硬违反 {hard.length} · 软违反 {soft.length}
        </span>
        {violations.length > 0 && (
          <button type="button" className="btn tiny" onClick={() => setOpen((value) => !value)}>
            {open ? '收起' : '查看明细'}
          </button>
        )}
        {onThicken && (
          <button type="button" className="btn tiny" onClick={onThicken}>
            重新核验
          </button>
        )}
      </div>
      {verification.checked && (
        <details className="mapf-details">
          <summary>核验覆盖项</summary>
          <pre className="small">{JSON.stringify(verification.checked, null, 1)}</pre>
        </details>
      )}
      {open && (
        <ul className="violation-list small">
          {violations.slice(0, 60).map((item, index) => (
            <li key={`${item.code}-${index}`} className={item.class === 'soft' ? 'warn-text' : 'bad-text'}>
              <code>{item.code}</code> {item.message}
              {item.at_s != null && <span className="muted"> · t={fmt(item.at_s, 1)}s</span>}
              {item.deviceId && <span className="muted"> · {item.deviceId}</span>}
              {item.taskId && <span className="muted"> · {item.taskId}</span>}
            </li>
          ))}
          {violations.length > 60 && <li className="muted">…共 {violations.length} 条</li>}
        </ul>
      )}
    </div>
  );
}

export function IssuesPanel({ issues }: { issues: WarehouseIssue[] }) {
  if (!issues || issues.length === 0) return null;
  return (
    <details className="mapf-details" open={issues.some((item) => item.severity === 'error')}>
      <summary>问题清单（{issues.length}）</summary>
      <ul className="issue-list small">
        {issues.slice(0, 40).map((issue, index) => (
          <li key={`${issue.code}-${index}`} className={issue.severity === 'error' ? 'bad-text' : ''}>
            <code>{issue.code}</code> {issue.path ? <span className="muted">{issue.path}</span> : null} {issue.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function EnvelopeFooter({ envelope, peakMemoryBytes }: { envelope: WarehouseEnvelope; peakMemoryBytes: number | null }) {
  return (
    <div className="footbar-meta muted small">
      <span>{envelope.engine} {envelope.engineVersion}</span>
      <span>规则集 {envelope.rulesetVersion}</span>
      <span className="tabular-nums">指纹 {envelope.fingerprint?.slice(0, 16) ?? '—'}</span>
      {peakMemoryBytes != null && <span>峰值内存 {fmt(peakMemoryBytes / (1024 * 1024), 1)} MB</span>}
      <span>运行时 {fmt(envelope.runtimeMs, 0)} ms</span>
    </div>
  );
}
