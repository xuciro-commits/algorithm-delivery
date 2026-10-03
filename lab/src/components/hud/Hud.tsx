/**
 * HUD 悬浮玻璃面板体系（V2 §七）：空间场景是视觉主体，面板以轻量悬浮形式
 * 围绕主视图组织。所有面板共用同一套玻璃材质 / 细轮廓线 / 微标题条。
 */

import type { ReactNode } from 'react';

export interface HudPanelProps {
  title: string;
  /** 标题右侧的操作区（按钮 / 视图切换 / 状态点）。 */
  actions?: ReactNode;
  /** 面板右上角的附加信息（如计数）。 */
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  /** 内容区是否可滚动（侧栏长面板）。 */
  scroll?: boolean;
  style?: React.CSSProperties;
}

export function HudPanel({ title, actions, meta, children, className, scroll = false, style }: HudPanelProps) {
  return (
    <section className={`hud-panel ${className ?? ''}`} style={style}>
      <header className="hud-panel-head">
        <h2 className="hud-panel-title">{title}</h2>
        <div className="hud-row">
          {meta}
          {actions}
        </div>
      </header>
      <div className="hud-panel-body" style={scroll ? { overflow: 'auto' } : undefined}>
        {children}
      </div>
    </section>
  );
}

export interface HudSectionProps {
  label: string;
  /** 右侧行内操作（小按钮 / 数值）。 */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function HudSection({ label, action, children, className }: HudSectionProps) {
  return (
    <div className={`hud-section ${className ?? ''}`}>
      <div className="hud-row" style={{ justifyContent: 'space-between' }}>
        <span className="hud-label">{label}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

export interface StatChipProps {
  label: string;
  value: ReactNode;
  /** 发光色（默认冰蓝）；传 null 表示无色彩的点。 */
  tone?: string | null;
  hint?: string;
  title?: string;
}

/** 指标胶囊：label + 数值（等宽数字），可带发光色点。 */
export function StatChip({ label, value, tone = 'var(--sb-ice)', hint, title }: StatChipProps) {
  return (
    <span className="hud-chip" title={title} style={tone ? { color: tone } : undefined}>
      {tone && <i className="swatch" aria-hidden />}
      <span style={{ color: 'var(--sb-muted)' }}>{label}</span>
      <b>{value}</b>
      {hint && <span style={{ color: 'var(--sb-faint)' }}>{hint}</span>}
    </span>
  );
}

export interface ToolButtonProps {
  label: string;
  active?: boolean;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
  tone?: 'default' | 'danger' | 'primary';
  children?: ReactNode;
}

/** 工具按钮：细轮廓、激活时冰蓝发光（不抢焦点）。 */
export function ToolButton({ label, active = false, onClick, title, disabled, tone = 'default', children }: ToolButtonProps) {
  return (
    <button
      type="button"
      className={`hud-btn ${tone === 'danger' ? 'danger' : tone === 'primary' ? 'primary' : ''}`}
      aria-pressed={active}
      onClick={onClick}
      title={title ?? label}
      disabled={disabled}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
  title?: string;
}

export interface SegmentedProps<T extends string> {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (id: T) => void;
  ariaLabel?: string;
}

/** 分段切换（视图模式 / 算法模式）：等宽小字 + 激活发光。 */
export function Segmented<T extends string>({ options, value, onChange, ariaLabel }: SegmentedProps<T>) {
  return (
    <div className="view-toggle" role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={o.id === value}
          className={o.id === value ? 'active' : ''}
          title={o.title ?? o.label}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
