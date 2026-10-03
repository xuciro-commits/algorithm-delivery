import type { ReactNode } from "react";
import { cn } from "../utils/cn";

/** 丝印标签分区标题 */
export function InsSection({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <section className="border-b border-border px-3 py-2.5">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">{title}</h3>
        {hint && <span className="font-mono text-[10px] text-muted">{hint}</span>}
      </div>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

export function InsRow({ label, children, hint }: { label: string; children?: ReactNode; hint?: string }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-2">
      <span className="text-xs text-foreground" title={hint}>
        {label}
      </span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

export function InsSeg<T extends string>({ value, options, onChange }: { value: T; options: { key: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex h-7 items-center rounded border border-border p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={cn("h-6 rounded-sm px-2 text-xs transition-colors", value === o.key ? "bg-primary text-primary-foreground" : "text-muted hover:bg-row-hover hover:text-foreground")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function InsToggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn("relative h-4 w-8 shrink-0 rounded-full border transition-colors", checked ? "border-primary bg-primary" : "border-border bg-surface")}
    >
      <span className={cn("absolute top-0.5 size-2.5 rounded-full bg-primary-foreground transition-all", checked ? "left-4" : "left-0.5 bg-muted")} />
    </button>
  );
}

export function InsCheck({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex h-6 cursor-pointer items-center gap-1.5 rounded-sm px-1 text-xs hover:bg-row-hover">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-3 accent-primary" />
      <span className="text-foreground">{label}</span>
    </label>
  );
}

export function InsSlider({ value, min, max, step, onChange, suffix }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <div className="flex items-center gap-2">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} className="h-1 w-24 accent-primary" />
      <span className="w-12 text-right font-mono text-[11px] tabular-nums text-muted">
        {value}
        {suffix}
      </span>
    </div>
  );
}

export function InsBtn({ children, onClick, active, disabled }: { children: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-7 flex-1 items-center justify-center gap-1 rounded border px-2 text-xs transition-colors disabled:opacity-50",
        active ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-foreground hover:bg-row-hover",
      )}
    >
      {children}
    </button>
  );
}

export function InsStat({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-border/50 py-1 last:border-0">
      <span className="text-xs text-muted">{k}</span>
      <span className="font-mono text-xs tabular-nums text-foreground">{v}</span>
    </div>
  );
}

export function InsEmpty({ text }: { text: string }) {
  return <div className="rounded-sm border border-dashed border-border px-2 py-4 text-center text-[11px] text-muted">{text}</div>;
}
