import "./gantt.css";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Crosshair,
  Diamond,
  Lock,
  Route,
} from "lucide-react";
import { cn } from "../../utils/cn";
import { normalizeTasks } from "./Accessors";
import type { GanttAccessors } from "./Accessors";
import { DEFAULT_COLUMNS } from "./types";
import type {
  GanttCalendar,
  GanttColumn,
  GanttDependency,
  GanttProps,
  GanttTask,
  GanttTimeScale,
} from "./types";

export type * from "./types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HEADER_H = 48;
const OVERSCAN = 5;
const MAX_EXPORT_ROWS = 1200;

const PX_PER_MS: Record<GanttTimeScale, number> = {
  hour: 44 / HOUR,
  day: 36 / DAY,
  week: 16 / DAY,
  month: 5 / DAY,
};

type Unit = "hour" | "day" | "week" | "month" | "year";
const TIERS: Record<GanttTimeScale, [Unit, Unit]> = {
  hour: ["day", "hour"],
  day: ["month", "day"],
  week: ["month", "week"],
  month: ["year", "month"],
};

function floorUnit(t: number, u: Unit): number {
  const d = new Date(t);
  switch (u) {
    case "hour":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
    case "day":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    case "week": {
      const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      return day - ((d.getUTCDay() + 6) % 7) * DAY;
    }
    case "month":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    case "year":
      return Date.UTC(d.getUTCFullYear(), 0, 1);
  }
}
function nextUnit(t: number, u: Unit): number {
  const d = new Date(t);
  switch (u) {
    case "hour":
      return t + HOUR;
    case "day":
      return t + DAY;
    case "week":
      return t + 7 * DAY;
    case "month":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    case "year":
      return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  }
}
function unitLabel(t: number, u: Unit, top: boolean): string {
  const d = new Date(t);
  const m = d.getUTCMonth() + 1;
  switch (u) {
    case "hour":
      return String(d.getUTCHours()).padStart(2, "0");
    case "day":
      return top ? `${d.getUTCFullYear()}-${String(m).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}` : String(d.getUTCDate());
    case "week": {
      const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
      return `W${Math.ceil(((t - jan1) / DAY + 1) / 7)} · ${m}/${d.getUTCDate()}`;
    }
    case "month":
      return top ? `${d.getUTCFullYear()} 年 ${m} 月` : `${m} 月`;
    case "year":
      return `${d.getUTCFullYear()} 年`;
  }
}
function isWorkday(t: number, cal?: GanttCalendar): boolean {
  const d = new Date(t);
  const wds = cal?.workdays ?? [1, 2, 3, 4, 5];
  if (!wds.includes(d.getUTCDay())) return false;
  return !(cal?.holidays ?? []).includes(d.toISOString().slice(0, 10));
}
function fmtShort(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

interface Span {
  s: number;
  e: number;
}
interface DragState {
  id: string;
  mode: "move" | "start" | "end";
  originX: number;
  orig: Span;
  delta: number;
}
interface LinkState {
  from: string;
  x0: number;
  y0: number;
  x: number;
  y: number;
}
interface Row {
  task: GanttTask;
  depth: number;
  hasChildren: boolean;
}
type EditState = { id: string; field: "title" | "assignee" | "progress"; value: string } | null;

const SCALES: { key: GanttTimeScale; label: string }[] = [
  { key: "hour", label: "时" },
  { key: "day", label: "日" },
  { key: "week", label: "周" },
  { key: "month", label: "月" },
];
const STATUS_FILL: Record<NonNullable<GanttTask["status"]>, string> = {
  pending: "fill-muted",
  in_progress: "fill-primary",
  completed: "fill-tone-success",
  delayed: "fill-tone-danger",
};
const STATUS_TEXT: Record<NonNullable<GanttTask["status"]>, string> = {
  pending: "text-muted",
  in_progress: "text-primary",
  completed: "text-tone-success",
  delayed: "text-tone-danger",
};
const STATUS_LABEL: Record<NonNullable<GanttTask["status"]>, string> = {
  pending: "待开始",
  in_progress: "进行中",
  completed: "已完成",
  delayed: "延期",
};

// 导出为独立 SVG/PNG 时必须把 oklch 等 CSS 变量烘焙成具体十六进制色
let hexCtx: CanvasRenderingContext2D | null = null;
function cssHex(raw: string, fb: string): string {
  if (typeof document === "undefined") return fb;
  if (!hexCtx) {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    hexCtx = c.getContext("2d", { willReadFrequently: true });
  }
  const ctx = hexCtx;
  if (!ctx) return fb;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = raw || fb;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  if (r + g + b === 0 && raw === "") return fb;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
function readColors(root: HTMLElement): Record<string, string> {
  const cs = getComputedStyle(root);
  const pick = (n: string, fb: string) => cssHex(cs.getPropertyValue(n).trim(), fb);
  return {
    bg: pick("--surface", "#ffffff"),
    fg: pick("--foreground", "#111111"),
    muted: pick("--muted", "#777777"),
    border: pick("--border", "#dddddd"),
    primary: pick("--primary", "#3355ff"),
    success: pick("--tone-success", "#16a34a"),
    danger: pick("--tone-danger", "#dc2626"),
    hover: pick("--row-hover", "#eeeeee"),
  };
}

export function Gantt<T = GanttTask>({
  tasks: tasksProp,
  data,
  accessors,
  getTaskId,
  getTitle,
  getStartTime,
  getEndTime,
  getProgress,
  getStatus,
  getParentId,
  getAssignee,
  getMilestone,
  getBaseline,
  dependencies = [],
  timeScale,
  readOnly = false,
  selectedTaskId,
  className,
  calendar,
  cascade = true,
  showCritical,
  showBaseline,
  columns,
  rowHeight,
  renderTaskBar,
  renderTooltip,
  onTaskEdit,
  onTaskSelect,
  onTaskChange,
  onDependencyCreate,
  onTimeScaleChange,
  onShowCriticalChange,
  onShowBaselineChange,
  ref,
}: GanttProps<T>) {
  // 访问器归一化：任意业务字段 → GanttTask，外部更新 data 时保持视图状态（不重置缩放/视口）
  const accessorsRef = useRef<GanttAccessors<T> | null>(null);
  accessorsRef.current = {
    getTaskId: getTaskId ?? accessors?.getTaskId ?? ((d) => (d as unknown as GanttTask).id),
    getTitle: getTitle ?? accessors?.getTitle,
    getStartTime: getStartTime ?? accessors?.getStartTime ?? ((d) => (d as unknown as GanttTask).start),
    getEndTime: getEndTime ?? accessors?.getEndTime ?? ((d) => (d as unknown as GanttTask).end),
    getProgress: getProgress ?? accessors?.getProgress,
    getStatus: getStatus ?? accessors?.getStatus,
    getParentId: getParentId ?? accessors?.getParentId,
    getAssignee: getAssignee ?? accessors?.getAssignee,
    getMilestone: getMilestone ?? accessors?.getMilestone,
    getBaseline: getBaseline ?? accessors?.getBaseline,
  };
  const tasks = useMemo<GanttTask[]>(() => {
    if (tasksProp) return tasksProp;
    return normalizeTasks(data ?? [], accessorsRef.current!);
  }, [tasksProp, data]);
  const [innerScale, setInnerScale] = useState<GanttTimeScale>(timeScale ?? "day");
  const scale = onTimeScaleChange && timeScale !== undefined ? timeScale : innerScale;
  const [innerCritical, setInnerCritical] = useState(false);
  const criticalOn = onShowCriticalChange && showCritical !== undefined ? showCritical : innerCritical;
  const [innerBaseline, setInnerBaseline] = useState(true);
  const baselineOn = onShowBaselineChange && showBaseline !== undefined ? showBaseline : innerBaseline;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [link, setLink] = useState<LinkState | null>(null);
  const [hoverRow, setHoverRow] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditState>(null);
  const [leftW, setLeftW] = useState(380);
  const [zoom, setZoom] = useState(1);
  const [scrollTop, setScrollTop] = useState(0);
  const [vpH, setVpH] = useState(600);
  const [vpW, setVpW] = useState(1000);
  const [exporting, setExporting] = useState<string | null>(null);
  // 悬停气泡（供 renderTooltip 插槽使用；与选中 / 拖拽状态严格分离）
  const [tipTask, setTipTask] = useState<GanttTask | null>(null);
  const [tipPos, setTipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<SVGSVGElement>(null);
  const rafRef = useRef(0);
  const rowH = Math.min(36, Math.max(24, rowHeight ?? 28));
  const cols: GanttColumn[] = columns ?? DEFAULT_COLUMNS;
  const ppm = PX_PER_MS[scale] * zoom;

  // ---------- 树 / 范围 ----------
  const { childrenMap, spans, byId, depByTo } = useMemo(() => {
    const byId = new Map<string, GanttTask>();
    tasks.forEach((t) => byId.set(t.id, t));
    const childrenMap = new Map<string, GanttTask[]>();
    tasks.forEach((t) => {
      const key = t.parentId && byId.has(t.parentId) ? t.parentId : "__root__";
      const arr = childrenMap.get(key) ?? [];
      arr.push(t);
      childrenMap.set(key, arr);
    });
    const spans = new Map<string, Span>();
    tasks.forEach((t) => {
      const s = Date.parse(t.start);
      const e = Date.parse(t.end);
      if (Number.isFinite(s) && Number.isFinite(e)) spans.set(t.id, { s, e: Math.max(e, s) });
    });
    const depByTo = new Map<string, GanttDependency[]>();
    dependencies.forEach((d) => depByTo.set(d.to, [...(depByTo.get(d.to) ?? []), d]));
    return { childrenMap, spans, byId, depByTo };
  }, [tasks, dependencies]);

  const snap = useCallback((t: number) => Math.round(t / (scale === "hour" ? HOUR : DAY)) * (scale === "hour" ? HOUR : DAY), [scale]);

  const computeChanges = useCallback(
    (d: DragState): Map<string, Span> => {
      const out = new Map<string, Span>();
      const o = d.orig;
      let next: Span;
      if (d.mode === "move") {
        let shift = snap(o.s + d.delta) - o.s;
        if (scale !== "hour") {
          let ns = o.s + shift;
          let g = 0;
          while (!isWorkday(ns, calendar) && g++ < 21) ns += DAY;
          shift = ns - o.s;
        }
        next = { s: o.s + shift, e: o.e + shift };
      } else if (d.mode === "start") {
        next = { s: Math.min(snap(o.s + d.delta), o.e - HOUR), e: o.e };
      } else {
        next = { s: o.s, e: Math.max(snap(o.e + d.delta), o.s + HOUR) };
      }
      out.set(d.id, next);
      if (!cascade) return out;
      const get = (id: string) => out.get(id) ?? spans.get(id);
      const queue = [d.id];
      let guard = 0;
      while (queue.length && guard++ < 8000) {
        const pid = queue.shift() as string;
        const p = get(pid);
        if (!p) continue;
        dependencies
          .filter((dep) => dep.from === pid)
          .forEach((dep) => {
            const c = get(dep.to);
            if (!c) return;
            const t = dep.type ?? "FS";
            const need = t === "FS" ? p.e - c.s : t === "SS" ? p.s - c.s : t === "FF" ? p.e - c.e : p.s - c.e;
            if (need <= 0) return;
            let ns = c.s + need;
            if (scale !== "hour") {
              let g = 0;
              while (!isWorkday(ns, calendar) && g++ < 21) ns += DAY;
            }
            out.set(dep.to, { s: c.s + (ns - c.s), e: c.e + (ns - c.s) });
            queue.push(dep.to);
          });
      }
      return out;
    },
    [snap, scale, calendar, cascade, spans, dependencies],
  );

  const preview = useMemo(() => (drag && drag.delta !== 0 ? computeChanges(drag) : null), [drag, computeChanges]);

  // 汇总行：父任务条 = 全部子孙的并集
  const effSpans = useMemo(() => {
    const memo = new Map<string, Span | undefined>();
    const visiting = new Set<string>();
    const calc = (id: string): Span | undefined => {
      if (memo.has(id)) return memo.get(id);
      // 脏数据兜底：parentId 形成环时不再递归，避免栈溢出导致整页白屏
      if (visiting.has(id)) return memo.get(id);
      visiting.add(id);
      try {
        return calcInner(id);
      } finally {
        visiting.delete(id);
      }
    };
    const calcInner = (id: string): Span | undefined => {
      const own = preview?.get(id) ?? spans.get(id);
      const kids = childrenMap.get(id);
      if (!kids || kids.length === 0) {
        memo.set(id, own);
        return own;
      }
      let s = Infinity;
      let e = -Infinity;
      kids.forEach((k) => {
        const ks = calc(k.id);
        if (ks) {
          s = Math.min(s, ks.s);
          e = Math.max(e, ks.e);
        }
      });
      const v = Number.isFinite(s) ? { s, e } : own;
      memo.set(id, v);
      return v;
    };
    const out = new Map<string, Span>();
    tasks.forEach((t) => {
      const v = calc(t.id);
      if (v) out.set(t.id, v);
    });
    return out;
  }, [preview, spans, childrenMap, tasks]);

  const rows = useMemo(() => {
      const out: Row[] = [];
    const seen = new Set<string>();
    const walk = (pid: string, depth: number) => {
      (childrenMap.get(pid) ?? []).forEach((t) => {
        if (seen.has(t.id)) return; // 环 / 重复引用兜底
        seen.add(t.id);
        const hasChildren = (childrenMap.get(t.id) ?? []).length > 0;
        out.push({ task: t, depth, hasChildren });
        if (hasChildren && !collapsed.has(t.id)) walk(t.id, depth + 1);
      });
    };
    walk("__root__", 0);
    return out;
  }, [childrenMap, collapsed]);
  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.task.id, i));
    return m;
  }, [rows]);

  const range = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    spans.forEach((s) => {
      min = Math.min(min, s.s);
      max = Math.max(max, s.e);
    });
    if (!Number.isFinite(min)) {
      min = Date.now();
      max = min + 30 * DAY;
    }
    const pad = scale === "hour" ? 6 * HOUR : scale === "day" ? 5 * DAY : scale === "week" ? 21 * DAY : 60 * DAY;
    const start = floorUnit(min - pad, botOf(scale));
    let end = nextUnit(floorUnit(max + pad, botOf(scale)), botOf(scale));
    const minSpan = Math.max(400, vpW - leftW) / ppm;
    if (end - start < minSpan) {
      end = nextUnit(floorUnit(start + minSpan + pad, botOf(scale)), botOf(scale));
    }
    return { start, end };
  }, [spans, scale, vpW, leftW, ppm]);
  const chartW = Math.max(Math.max(400, vpW - leftW), (range.end - range.start) * ppm);
  const totalH = Math.max(rows.length * rowH, 120);
  const xOf = useCallback((t: number) => (t - range.start) * ppm, [range.start, ppm]);

  const [topU, botU] = TIERS[scale];
  const ticks = useMemo(() => {
    const gen = (u: Unit) => {
      const arr: { t: number; next: number }[] = [];
      let t = floorUnit(range.start, u);
      let g = 0;
      while (t < range.end && g++ < 6000) {
        const n = nextUnit(t, u);
        arr.push({ t, next: n });
        t = n;
      }
      return arr;
    };
    return { top: gen(topU), bot: gen(botU) };
  }, [range, topU, botU]);

  const nonWork = useMemo(() => {
    if (scale !== "day" && scale !== "week") return [] as number[];
    const arr: number[] = [];
    let t = floorUnit(range.start, "day");
    let g = 0;
    while (t < range.end && g++ < 3000) {
      if (!isWorkday(t, calendar)) arr.push(t);
      t += DAY;
    }
    return arr;
  }, [range, scale, calendar]);

  // ---------- 关键路径（由最晚结束任务沿紧前链回溯） ----------
  const critical = useMemo(() => {
    const set = new Set<string>();
    const depSet = new Set<string>();
    if (!criticalOn) return { set, depSet };
    const leaves = tasks.filter((t) => (childrenMap.get(t.id) ?? []).length === 0);
    if (!leaves.length) return { set, depSet };
    let maxEnd = -Infinity;
    leaves.forEach((t) => {
      const e = spans.get(t.id)?.e ?? 0;
      if (e > maxEnd) maxEnd = e;
    });
    const visit = (id: string) => {
      if (set.has(id)) return;
      set.add(id);
      const me = spans.get(id);
      if (!me) return;
      const preds = depByTo.get(id) ?? [];
      let bestEnd = -Infinity;
      preds.forEach((d) => {
        const p = spans.get(d.from);
        if (p) bestEnd = Math.max(bestEnd, p.e);
      });
      preds.forEach((d) => {
        const p = spans.get(d.from);
        if (p && p.e >= bestEnd - 1) {
          depSet.add(d.id);
          visit(d.from);
        }
      });
    };
    leaves
      .filter((t) => (spans.get(t.id)?.e ?? 0) >= maxEnd - 1000)
      .forEach((t) => visit(t.id));
    const allCrit = Array.from(set);
    allCrit.forEach((id) => {
      const t = byId.get(id);
      if (t?.parentId) set.add(t.parentId);
    });
    return { set, depSet };
  }, [criticalOn, tasks, childrenMap, spans, depByTo, byId]);

  // ---------- 虚拟滚动 ----------
  const startRow = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const endRow = Math.min(rows.length, Math.ceil((scrollTop + vpH - HEADER_H) / rowH) + OVERSCAN);
  const visible = useMemo(() => rows.slice(startRow, endRow), [rows, startRow, endRow]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.clientHeight) setVpH(el.clientHeight);
    if (el.clientWidth) setVpW(el.clientWidth);
    const onScroll = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => setScrollTop(el.scrollTop));
    };
    const ro = new ResizeObserver(() => {
      setVpH(el.clientHeight);
      setVpW(el.clientWidth);
    });
    ro.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Ctrl / ⌘ + 滚轮 → 无级缩放
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => Math.min(8, Math.max(0.15, z * Math.exp(-e.deltaY * 0.0025))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ---------- 拖拽 ----------
  const startDrag = (e: ReactPointerEvent, id: string, mode: DragState["mode"]) => {
    if (readOnly) return;
    e.stopPropagation();
    const sp = spans.get(id);
    if (!sp) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ id, mode, originX: e.clientX, orig: sp, delta: 0 });
  };
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => setDrag((d) => (d ? { ...d, delta: (e.clientX - d.originX) / ppm } : d));
    const up = () => {
      setDrag((d) => {
        if (d && Math.abs(d.delta * ppm) > 2) {
          computeChanges(d).forEach((sp, id) => {
            onTaskChange?.(id, new Date(sp.s).toISOString(), new Date(sp.e).toISOString(), byId.get(id)?.progress);
          });
        }
        return null;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, ppm, computeChanges, onTaskChange, byId]);

  const localPoint = (clientX: number, clientY: number) => {
    const r = chartRef.current?.getBoundingClientRect();
    return r ? { x: clientX - r.left, y: clientY - r.top } : { x: 0, y: 0 };
  };
  const startLink = (e: ReactPointerEvent, id: string, x: number, y: number) => {
    if (readOnly) return;
    e.stopPropagation();
    const p = localPoint(e.clientX, e.clientY);
    setLink({ from: id, x0: x, y0: y, x: p.x, y: p.y });
  };
  useEffect(() => {
    if (!link) return;
    const move = (e: PointerEvent) => {
      const p = localPoint(e.clientX, e.clientY);
      setLink((l) => (l ? { ...l, x: p.x, y: p.y } : l));
    };
    const up = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const target = el?.closest("[data-gantt-task]")?.getAttribute("data-gantt-task");
      if (target && target !== link.from) onDependencyCreate?.(link.from, target);
      setLink(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [link, onDependencyCreate]);

  const changeScale = (s: GanttTimeScale) => {
    setZoom(1);
    setInnerScale(s);
    onTimeScaleChange?.(s);
  };

  const scrollToDate = useCallback(
    (iso: string) => {
      const el = scrollRef.current;
      if (!el) return;
      const t = Date.parse(iso);
      if (Number.isFinite(t)) el.scrollTo({ left: Math.max(0, xOf(t) - 100), behavior: "smooth" });
    },
    [xOf],
  );
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let min = Infinity;
    spans.forEach((s) => (min = Math.min(min, s.s)));
    if (Number.isFinite(min)) el.scrollLeft = Math.max(0, xOf(min) - 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  // ---------- 导出的 SVG 构建（SVG / PNG / PDF 共用，不受虚拟化窗口影响） ----------
  const buildExportSVG = useCallback((): { svg: string; w: number; h: number; c: Record<string, string> } | null => {
    const root = rootRef.current;
    if (!root) return null;
    const c = readColors(root);
    const w = leftW + chartW + 24;
    const h = HEADER_H + Math.min(rows.length, MAX_EXPORT_ROWS) * rowH + 24;
        const parts: string[] = [];
        parts.push(`<rect width="${w}" height="${h}" fill="${c.bg}"/>`);
        parts.push(`<rect x="0" y="0" width="${leftW}" height="${HEADER_H}" fill="${c.bg}" stroke="${c.border}"/>`);
        parts.push(`<text x="12" y="30" fill="${c.fg}" font-family="IBM Plex Sans, sans-serif" font-size="13">任务名称</text>`);
        parts.push(`<line x1="0" x2="${w}" y1="${HEADER_H}" y2="${HEADER_H}" stroke="${c.border}"/>`);
        // 时间刻度
        ticks.bot.forEach((t) => {
          const x = leftW + xOf(t.t);
          parts.push(`<line x1="${x}" x2="${x}" y1="${HEADER_H}" y2="${h}" stroke="${c.border}" stroke-opacity="0.7"/>`);
        });
        rows.slice(0, MAX_EXPORT_ROWS).forEach((row, i) => {
          const y = HEADER_H + i * rowH;
          const sp = effSpans.get(row.task.id);
          if (!sp) return;
          parts.push(`<line x1="0" x2="${w}" y1="${y + rowH}" y2="${y + rowH}" stroke="${c.border}" stroke-opacity="0.5"/>`);
          parts.push(`<text x="${10 + row.depth * 14}" y="${y + rowH / 2 + 4}" fill="${c.fg}" font-family="IBM Plex Sans, sans-serif" font-size="12">${esc(row.task.title)}</text>`);
          let cx = leftW + 4;
          cols.forEach((col) => {
            const val =
              col.key === "duration"
                ? fmtDuration(sp, scale)
                : col.key === "progress"
                  ? `${row.task.progress ?? 0}%`
                  : col.key === "assignee"
                    ? (row.task.assignee?.name ?? "—")
                    : col.key === "start"
                      ? fmtShort(row.task.start)
                      : col.key === "end"
                        ? fmtShort(row.task.end)
                        : (depByTo.get(row.task.id) ?? []).map((d) => d.from).join(",");
            parts.push(`<text x="${cx}" y="${y + rowH / 2 + 4}" fill="${c.muted}" font-family="IBM Plex Mono, monospace" font-size="11">${esc(String(val))}</text>`);
            cx += col.width;
          });
          const bx = leftW + 4 + xOf(sp.s);
          const bw = Math.max(3, xOf(sp.e) - xOf(sp.s));
          if (baselineOn && row.task.baseline) {
            const bs = Date.parse(row.task.baseline.start);
            const be = Date.parse(row.task.baseline.end);
            parts.push(`<rect x="${leftW + 4 + xOf(bs)}" y="${y + 5}" width="${Math.max(2, xOf(be) - xOf(bs))}" height="4" fill="${c.muted}" fill-opacity="0.55"/>`);
            parts.push(`<rect x="${bx}" y="${y + 12}" width="${bw}" height="${rowH - 18}" rx="2" fill="${colorFor(row.task.status, c)}" fill-opacity="0.32"/>`);
            parts.push(`<rect x="${bx}" y="${y + 12}" width="${bw * ((row.task.progress ?? 0) / 100)}" height="${rowH - 18}" rx="2" fill="${colorFor(row.task.status, c)}"/>`);
          } else {
            parts.push(`<rect x="${bx}" y="${y + 6}" width="${bw}" height="${rowH - 12}" rx="3" fill="${colorFor(row.task.status, c)}" fill-opacity="0.32"/>`);
            parts.push(`<rect x="${bx}" y="${y + 6}" width="${bw * ((row.task.progress ?? 0) / 100)}" height="${rowH - 12}" rx="3" fill="${colorFor(row.task.status, c)}"/>`);
          }
        });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join("")}</svg>`;
    return { svg, w, h, c };
  }, [leftW, chartW, rows, rowH, cols, ticks, effSpans, xOf, scale, baselineOn, depByTo]);

  // ---------- 导出 ----------
  const doExport = useCallback(
    (kind: "svg" | "png") => {
      setExporting(kind);
      try {
        const built = buildExportSVG();
        if (!built) {
          setExporting(null);
          return;
        }
        const { svg, w, h, c } = built;
        const name = `gantt-${new Date().toISOString().slice(0, 10)}`;
        if (kind === "svg") {
          const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${name}.svg`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
        } else {
          const img = new Image();
          const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          img.onload = () => {
            const cv = document.createElement("canvas");
            const maxH = 6000;
            const s = Math.min(1, maxH / h);
            cv.width = Math.round(w * s);
            cv.height = Math.round(h * s);
            const ctx = cv.getContext("2d");
            if (ctx) {
              ctx.fillStyle = c.bg;
              ctx.fillRect(0, 0, cv.width, cv.height);
              ctx.drawImage(img, 0, 0, cv.width, cv.height);
              const a = document.createElement("a");
              a.href = cv.toDataURL("image/png");
              a.download = `${name}.png`;
              a.click();
            }
            URL.revokeObjectURL(url);
            setExporting(null);
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            setExporting(null);
          };
          img.src = url;
          return;
        }
      } finally {
        if (kind === "svg") setExporting(null);
      }
    },
    [leftW, chartW, rows, rowH, cols, ticks, effSpans, xOf, scale, baselineOn, depByTo],
  );

  // PDF：把完整导出 SVG（不受虚拟化窗口影响）放进隐藏 iframe，触发系统打印 → 可另存为 PDF
  const doExportAsPDFFrame = useRef<(() => void) | null>(null);
  doExportAsPDFFrame.current = () => {
    const built = buildExportSVG();
    if (!built) return;
    setExporting("pdf");
    try {
      const frame = document.createElement("iframe");
      frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
      document.body.appendChild(frame);
      const doc = frame.contentDocument;
      if (!doc?.body) {
        frame.remove();
        setExporting(null);
        return;
      }
      doc.open();
      doc.write(`<!doctype html><html><head><title>gantt</title><style>@media print{html,body{margin:0;padding:0;background:${built.c.bg}}svg{display:block}}</style></head><body style="margin:0">${built.svg}</body></html>`);
      doc.close();
      const cw = frame.contentWindow;
      window.setTimeout(() => {
        cw?.focus();
        cw?.print();
        frame.remove();
        setExporting(null);
      }, 120);
    } catch {
      setExporting(null);
    }
  };
  const doExportRef = useRef(doExport);
  doExportRef.current = doExport;
  const scrollToDateRef = useRef(scrollToDate);
  scrollToDateRef.current = scrollToDate;

  useImperativeHandle(
    ref,
    () => ({
      exportSVG: () => doExportRef.current("svg"),
      exportPNG: () => doExportRef.current("png"),
      exportPDF: () => doExportAsPDFFrame.current?.(),
      scrollToDate: (iso: string) => scrollToDateRef.current(iso),
    }),
    [],
  );

  // ---------- 依赖连线 ----------
  const edgeVisible = useCallback(
    (dep: GanttDependency) => {
      const a = rowIndex.get(dep.from);
      const b = rowIndex.get(dep.to);
      if (a === undefined || b === undefined) return false;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return hi >= startRow - 1 && lo <= endRow + 1;
    },
    [rowIndex, startRow, endRow],
  );

  const depPath = useCallback(
    (dep: GanttDependency): string | null => {
      const fi = rowIndex.get(dep.from);
      const ti = rowIndex.get(dep.to);
      const fs = effSpans.get(dep.from);
      const ts = effSpans.get(dep.to);
      if (fi === undefined || ti === undefined || !fs || !ts) return null;
      const type = dep.type ?? "FS";
      const fromEnd = type === "FS" || type === "FF";
      const toEnd = type === "FF" || type === "SF";
      const fromMs = byId.get(dep.from)?.isMilestone;
      const toMs = byId.get(dep.to)?.isMilestone;
      const x1 = xOf(fromEnd ? fs.e : fs.s) + (fromMs ? (fromEnd ? 6 : -6) : 0);
      const x2 = xOf(toEnd ? ts.e : ts.s) + (toMs ? (toEnd ? 6 : -6) : 0);
      const y1 = fi * rowH + rowH / 2;
      const y2 = ti * rowH + rowH / 2;
      const G = 10;
      const out1 = fromEnd ? x1 + G : x1 - G;
      const in2 = toEnd ? x2 + G : x2 - G;
      const dir = y2 > y1 ? 1 : -1;
      if ((!toEnd && out1 <= in2) || (toEnd && !fromEnd && out1 >= in2)) return `M${x1},${y1} H${in2} V${y2} H${x2}`;
      if (fromEnd && toEnd) return `M${x1},${y1} H${Math.max(out1, in2)} V${y2} H${x2}`;
      const midY = y1 + dir * (rowH / 2);
      return `M${x1},${y1} H${out1} V${midY} H${in2} V${y2} H${x2}`;
    },
    [rowIndex, effSpans, byId, xOf, rowH],
  );

  const visibleDeps = useMemo(() => dependencies.filter(edgeVisible), [dependencies, edgeVisible]);

  const commitEdit = () => {
    if (!editing) return;
    const t = byId.get(editing.id);
    if (t) {
      if (editing.field === "progress") {
        const v = Math.max(0, Math.min(100, Math.round(Number(editing.value) || 0)));
        if (v !== (t.progress ?? 0)) onTaskEdit?.(t.id, { progress: v });
      } else if (editing.value.trim() && editing.value !== t[editing.field]) {
        onTaskEdit?.(t.id, editing.field === "title" ? { title: editing.value } : { assignee: editing.value });
      }
    }
    setEditing(null);
  };

  return (
    <div
      ref={rootRef}
      data-gantt-root
      className={cn("platform-gantt-root relative flex h-full min-h-0 flex-col overflow-hidden rounded border border-border bg-surface text-xs text-foreground", className)}
    >
      {/* 工具栏 */}
      <div className="flex h-9 shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-2">
        <div className="flex h-7 shrink-0 items-center rounded border border-border p-0.5">
          {SCALES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => changeScale(s.key)}
              className={cn("h-full rounded-sm px-2.5 text-xs transition-colors", scale === s.key ? "bg-primary text-primary-foreground" : "text-muted hover:bg-row-hover hover:text-foreground")}
            >
              {s.label}
            </button>
          ))}
        </div>
        <ToolBtn
          active={criticalOn}
          onClick={() => {
            setInnerCritical((v) => !v);
            onShowCriticalChange?.(!criticalOn);
          }}
          icon={<Route className="size-3.5" />}
        >
          关键路径
        </ToolBtn>
        <ToolBtn
          active={baselineOn}
          onClick={() => {
            setInnerBaseline((v) => !v);
            onShowBaselineChange?.(!baselineOn);
          }}
          icon={<ChevronsUpDown className="size-3.5" />}
        >
          基线对比
        </ToolBtn>
        <ToolBtn onClick={() => setCollapsed(new Set())} icon={<ChevronsUpDown className="size-3.5" />}>
          展开
        </ToolBtn>
        <ToolBtn onClick={() => setCollapsed(new Set(tasks.filter((t) => (childrenMap.get(t.id) ?? []).length).map((t) => t.id)))} icon={<ChevronsDownUp className="size-3.5" />}>
          折叠
        </ToolBtn>
        <ToolBtn onClick={() => scrollToDate(selectedTaskId && spans.get(selectedTaskId) ? byId.get(selectedTaskId)!.start : new Date().toISOString())} icon={<Crosshair className="size-3.5" />}>
          定位
        </ToolBtn>
        <div className="ml-auto flex items-center gap-3 text-muted">
          <span className="tabular-nums">{rows.length} 行 · 可视 {visible.length}</span>
          <span className="tabular-nums">×{zoom.toFixed(2)}</span>
          {readOnly && (
            <span className="flex items-center gap-1">
              <Lock className="size-3" /> 只读
            </span>
          )}
          {(Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]).map((k) => (
            <span key={k} className="flex items-center gap-1">
              <span className={cn("inline-block size-2 rounded-sm bg-current", STATUS_TEXT[k])} />
              {STATUS_LABEL[k]}
            </span>
          ))}
        </div>
      </div>

      {/* 单一滚动容器：左右上下绝对同步 */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto overscroll-contain">
        <div style={{ width: leftW + chartW, minWidth: "100%", minHeight: "100%" }} className="relative">
          {/* 表头 */}
          <div className="sticky top-0 z-30 flex border-b border-border bg-surface" style={{ height: HEADER_H }}>
            <div className="sticky left-0 z-10 flex shrink-0 items-end border-r border-border bg-surface pb-1.5" style={{ width: leftW }}>
              <div className="flex-1 pl-3 text-muted">任务名称</div>
              {cols.map((c) => (
                <div key={c.key} className="shrink-0 text-muted" style={{ width: c.width }}>
                  {c.label}
                </div>
              ))}
            </div>
            <svg width={chartW} height={HEADER_H} className="shrink-0 select-none">
              {ticks.top.map((t) => {
                const cellLeft = Math.max(0, xOf(t.t));
                const cellRight = xOf(t.next);
                const cellW = cellRight - cellLeft;
                if (cellW <= 0) return null;
                const showFull = cellW >= 90;
                const showShort = cellW >= 36;
                return (
                  <g key={`t${t.t}`}>
                    {xOf(t.t) > 0 && (
                      <line x1={xOf(t.t)} x2={xOf(t.t)} y1={0} y2={HEADER_H} className="stroke-border" />
                    )}
                    {showShort && (
                      <text x={cellLeft + 6} y={16} className="fill-foreground text-[11px] font-medium">
                        {unitLabel(t.t, topU, showFull)}
                      </text>
                    )}
                  </g>
                );
              })}
              <line x1={0} x2={chartW} y1={24} y2={24} className="stroke-border" />
              {ticks.bot.map((t) => {
                const w = (t.next - t.t) * ppm;
                const off = botU === "day" && !isWorkday(t.t, calendar);
                return (
                  <g key={`b${t.t}`}>
                    <line x1={xOf(t.t)} x2={xOf(t.t)} y1={24} y2={HEADER_H} className="stroke-border" />
                    {w > 14 && (
                      <text x={xOf(t.t) + w / 2} y={40} textAnchor="middle" className={cn("text-[11px]", off ? "fill-tone-danger" : "fill-muted")}>
                        {unitLabel(t.t, botU, false)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          {/* 主体 */}
          <div className="flex" style={{ height: totalH }}>
            {/* 左侧 WBS 表格（虚拟化 + 可拖拽分栏） */}
            <div className="sticky left-0 z-10 shrink-0 overflow-hidden border-r border-border bg-surface" style={{ width: leftW, height: totalH }}>
              <div className="relative" style={{ height: totalH }}>
                {visible.map((row, vi) => {
                  const gi = startRow + vi;
                  const { task, depth, hasChildren } = row;
                  const sp = effSpans.get(task.id);
                  const sel = task.id === selectedTaskId;
                  return (
                    <div
                      key={task.id}
                      data-gantt-task={task.id}
                      onMouseEnter={() => setHoverRow(task.id)}
                      onMouseLeave={() => setHoverRow(null)}
                      onClick={() => onTaskSelect?.(task.id)}
                      className={cn("absolute left-0 right-0 flex cursor-pointer items-center border-b border-border/60", sel ? "bg-primary/10" : hoverRow === task.id ? "bg-row-hover" : "")}
                      style={{ top: gi * rowH, height: rowH }}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-1" style={{ paddingLeft: 6 + depth * 14 }}>
                        {hasChildren ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCollapsed((c) => {
                                const n = new Set(c);
                                if (n.has(task.id)) n.delete(task.id);
                                else n.add(task.id);
                                return n;
                              });
                            }}
                            className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-row-hover hover:text-foreground"
                          >
                            {collapsed.has(task.id) ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                          </button>
                        ) : (
                          <span className="size-4 shrink-0" />
                        )}
                        {task.isMilestone ? <Diamond className="size-3 shrink-0 text-tone-warning" /> : <span className={cn("size-1.5 shrink-0 rounded-full bg-current", STATUS_TEXT[task.status ?? "pending"], critical.set.has(task.id) && "text-tone-danger")} />}
                        {editing?.id === task.id && editing.field === "title" ? (
                          <CellInput value={editing.value} onChange={(v) => setEditing({ ...editing, value: v })} onCommit={commitEdit} onCancel={() => setEditing(null)} />
                        ) : (
                          <span
                            onDoubleClick={(e) => {
                              if (readOnly) return;
                              e.stopPropagation();
                              setEditing({ id: task.id, field: "title", value: task.title });
                            }}
                            className={cn("truncate", hasChildren && "font-semibold", critical.set.has(task.id) && "text-tone-danger")}
                          >
                            {task.title}
                          </span>
                        )}
                      </div>
                      {cols.map((col) => {
                        const w = { width: col.width };
                        if (col.key === "progress") {
                          const editingNow = editing?.id === task.id && editing.field === "progress";
                          return (
                            <div key={col.key} style={w} className="shrink-0 pr-1.5">
                              {editingNow ? (
                                <CellInput value={editing.value} onChange={(v) => setEditing({ ...editing, value: v })} onCommit={commitEdit} onCancel={() => setEditing(null)} numeric />
                              ) : (
                                <div
                                  onDoubleClick={(e) => {
                                    if (readOnly) return;
                                    e.stopPropagation();
                                    setEditing({ id: task.id, field: "progress", value: String(task.progress ?? 0) });
                                  }}
                                  className="flex items-center gap-1"
                                >
                                  <span className="w-6 text-right font-mono tabular-nums">{task.progress ?? 0}</span>
                                  <span className="h-1 flex-1 overflow-hidden rounded-sm bg-border">
                                    <span className="block h-full bg-current" style={{ width: `${task.progress ?? 0}%` }} />
                                  </span>
                                </div>
                              )}
                            </div>
                          );
                        }
                        const editingNow = editing?.id === task.id && editing.field === (col.key as "assignee");
                        if (col.key === "assignee") {
                          return (
                            <div key={col.key} style={w} className="shrink-0">
                              {editingNow ? (
                                <CellInput value={editing.value} onChange={(v) => setEditing({ ...editing, value: v })} onCommit={commitEdit} onCancel={() => setEditing(null)} />
                              ) : (
                                <span
                                  onDoubleClick={(e) => {
                                    if (readOnly) return;
                                    e.stopPropagation();
                                    setEditing({ id: task.id, field: "assignee", value: task.assignee?.name ?? "" });
                                  }}
                                  className="block truncate px-1.5 text-muted"
                                >
                                  {task.assignee?.name ?? "—"}
                                </span>
                              )}
                            </div>
                          );
                        }
                            if (col.render) return (
                          <div key={col.key} style={w} className="shrink-0 truncate px-1.5">
                            {col.render(task)}
                          </div>
                        );
                        const val =
                          col.key === "duration"
                            ? sp
                              ? fmtDuration(sp, scale)
                              : "—"
                            : col.key === "start"
                              ? fmtShort(task.start)
                              : col.key === "end"
                                ? fmtShort(task.end)
                                : (depByTo.get(task.id) ?? [])
                                    .map((d) => d.from)
                                    .join(",");
                        return (
                          <div key={col.key} style={w} className="shrink-0 truncate px-1.5 font-mono tabular-nums text-muted">
                            {val}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                {/* 分栏拖拽把手 */}
                <div
                  onPointerDown={(e) => {
                    e.preventDefault();
                    const sx = e.clientX;
                    const sw = leftW;
                    const mv = (ev: PointerEvent) => setLeftW(Math.min(760, Math.max(240, sw + ev.clientX - sx)));
                    const up = () => {
                      window.removeEventListener("pointermove", mv);
                      window.removeEventListener("pointerup", up);
                    };
                    window.addEventListener("pointermove", mv);
                    window.addEventListener("pointerup", up);
                  }}
                  className="absolute right-0 top-0 z-20 h-full w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-primary/50"
                  title="拖拽调整分栏宽度"
                />
              </div>
            </div>

            {/* 右侧图表 */}
            <svg ref={chartRef} width={chartW} height={totalH} className={cn("shrink-0 select-none", drag && "cursor-grabbing")}>
              <defs>
                <marker id="gantt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" className="fill-muted" />
                </marker>
                <marker id="gantt-arrow-crit" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" className="fill-tone-danger" />
                </marker>
              </defs>
              {nonWork.map((t) => (
                <rect key={t} x={xOf(t)} y={0} width={DAY * ppm} height={totalH} className="fill-foreground/[0.035]" />
              ))}
              {ticks.bot.map((t) => (
                <line key={t.t} x1={xOf(t.t)} x2={xOf(t.t)} y1={0} y2={totalH} className="stroke-border/60" />
              ))}
              {visible.map((row, vi) => (
                <rect
                  key={row.task.id}
                  data-gantt-task={row.task.id}
                  x={0}
                  y={(startRow + vi) * rowH}
                  width={chartW}
                  height={rowH}
                  onMouseEnter={() => setHoverRow(row.task.id)}
                  onMouseLeave={() => setHoverRow(null)}
                  className={cn(row.task.id === selectedTaskId ? "fill-primary/10" : hoverRow === row.task.id ? "fill-row-hover" : "fill-transparent")}
                />
              ))}
              <line x1={0} x2={chartW} y1={1} y2={1} className="stroke-border/50" />
              {Date.now() > range.start && Date.now() < range.end && (
                <line x1={xOf(Date.now())} x2={xOf(Date.now())} y1={0} y2={totalH} strokeDasharray="3 3" className="stroke-tone-danger" />
              )}
              <g fill="none">
                {visibleDeps.map((dep) => {
                  const p = depPath(dep);
                  if (!p) return null;
                  const crit = critical.depSet.has(dep.id);
                  return <path key={dep.id} d={p} strokeWidth={crit ? 1.6 : 1} markerEnd={`url(#${crit ? "gantt-arrow-crit" : "gantt-arrow"})`} className={crit ? "stroke-tone-danger" : "stroke-muted/70"} strokeLinejoin="round" />;
                })}
              </g>
              {visible.map((row, vi) => {
                const task = row.task;
                const sp = effSpans.get(task.id);
                if (!sp) return null;
                const gi = startRow + vi;
                const y = gi * rowH;
                const x = xOf(sp.s);
                const w = Math.max(xOf(sp.e) - x, 3);
                const cy = y + rowH / 2;
                const sel = task.id === selectedTaskId;
                const crit = critical.set.has(task.id);
                const dragging = drag?.id === task.id || (preview?.has(task.id) ?? false);
                const hasBaseline =
                  baselineOn &&
                  !!task.baseline &&
                  !task.isMilestone &&
                  Number.isFinite(Date.parse(task.baseline.start)) &&
                  Number.isFinite(Date.parse(task.baseline.end));
                if (task.isMilestone) {
                  return (
                    <g key={task.id} data-gantt-task={task.id} onClick={() => onTaskSelect?.(task.id)} className="cursor-pointer">
                      <rect x={x - 6} y={cy - 6} width={12} height={12} transform={`rotate(45 ${x} ${cy})`} className={cn(crit ? "fill-tone-danger" : "fill-tone-warning", sel && "stroke-foreground")} strokeWidth={1.5} onPointerDown={(e) => startDrag(e, task.id, "move")} />
                      <text x={x + 12} y={cy + 4} className="fill-foreground text-[11px] font-medium">
                        {task.title}
                      </text>
                    </g>
                  );
                }
                if (row.hasChildren) {
                  return (
                    <g key={task.id} data-gantt-task={task.id} onClick={() => onTaskSelect?.(task.id)} className="cursor-pointer">
                      <path d={`M${x},${cy - 5} H${x + w} V${cy + 5} L${x + w - 5},${cy} H${x + 5} L${x},${cy + 5} Z`} className={cn(crit ? "fill-tone-danger" : "fill-foreground/70")} />
                    </g>
                  );
                }
                const status = task.status ?? "pending";
                const prog = Math.min(100, Math.max(0, task.progress ?? 0));
                const barY = hasBaseline ? y + rowH - rowH / 2 + 1 : y + 6;
                const barH = hasBaseline ? Math.max(8, rowH / 2 - 4) : rowH - 12;
                const barState = { selected: sel, critical: crit, progress: prog, dragging: drag?.id === task.id, status, rowHeight: barH };
                return (
                  <g
                    key={task.id}
                    data-gantt-task={task.id}
                    className={cn("group", readOnly ? "cursor-pointer" : "cursor-grab")}
                    onClick={() => onTaskSelect?.(task.id)}
                    opacity={dragging && drag?.id !== task.id ? 0.75 : 1}
                    onMouseEnter={(e) => {
                      if (!renderTooltip) return;
                      setTipTask(task);
                      setTipPos({ x: e.clientX, y: e.clientY });
                    }}
                    onMouseMove={(e) => renderTooltip && setTipPos({ x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setTipTask(null)}
                  >
                    {hasBaseline && task.baseline && (
                      <>
                        <rect x={xOf(Date.parse(task.baseline.start))} y={y + 4} width={Math.max(2, xOf(Date.parse(task.baseline.end)) - xOf(Date.parse(task.baseline.start)))} height={4} rx={2} className="fill-muted/60" />
                        <line x1={xOf(Date.parse(task.baseline.end))} x2={xOf(Date.parse(task.baseline.end))} y1={y + 3} y2={y + 10} className="stroke-muted" strokeWidth={1.5} />
                      </>
                    )}
                    <rect x={x} y={barY} width={w} height={barH} rx={3} className={cn(STATUS_FILL[status], "opacity-30")} onPointerDown={(e) => startDrag(e, task.id, "move")} />
                    {renderTaskBar ? (
                      <foreignObject x={x} y={barY} width={w} height={barH} className="pointer-events-none overflow-visible">
                        {renderTaskBar(task, barState)}
                      </foreignObject>
                    ) : (
                      <rect x={x} y={barY} width={(w * prog) / 100} height={barH} rx={3} className={cn(STATUS_FILL[status], "pointer-events-none")} />
                    )}
                    <rect x={x} y={barY} width={w} height={barH} rx={3} fill="none" strokeWidth={sel || crit ? 1.5 : 1} className={cn("pointer-events-none", crit ? "stroke-tone-danger" : sel ? "stroke-foreground" : dragging ? "stroke-primary" : "stroke-transparent")} strokeDasharray={dragging && drag?.id !== task.id ? "3 2" : undefined} />
                    {w > 54 && barH >= 10 && (
                      <text x={x + 6} y={barY + barH / 2 + 4} className="pointer-events-none fill-foreground text-[11px]">
                        {prog}%
                      </text>
                    )}
                    <text x={x + w + 8} y={cy + 4} className="pointer-events-none fill-muted text-[11px]">
                      {task.title}
                    </text>
                    {!readOnly && (
                      <>
                        <rect x={x - 2} y={y + 4} width={6} height={rowH - 8} className="cursor-ew-resize fill-transparent" onPointerDown={(e) => startDrag(e, task.id, "start")} />
                        <rect x={x + w - 4} y={y + 4} width={6} height={rowH - 8} className="cursor-ew-resize fill-transparent" onPointerDown={(e) => startDrag(e, task.id, "end")} />
                        <circle cx={x + w + 4} cy={cy} r={3.5} className="cursor-crosshair fill-surface stroke-primary opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={1.5} onPointerDown={(e) => startLink(e, task.id, x + w + 4, cy)} />
                      </>
                    )}
                  </g>
                );
              })}
              {drag && preview?.get(drag.id) && rowIndex.get(drag.id) !== undefined && (
                <DragHint x={xOf((preview.get(drag.id) as Span).s)} y={(rowIndex.get(drag.id) as number) * rowH} span={preview.get(drag.id) as Span} hour={scale === "hour"} cascaded={preview.size - 1} rowH={rowH} />
              )}
              {link && <path d={`M${link.x0},${link.y0} L${link.x},${link.y}`} className="stroke-primary" strokeDasharray="4 3" fill="none" markerEnd="url(#gantt-arrow)" />}
            </svg>
          </div>
        </div>
      </div>

      {exporting && <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded border border-border bg-surface px-3 py-1 text-xs shadow-sm">正在导出 {exporting.toUpperCase()}…</div>}
      {renderTooltip && tipTask && (
        <div
          className="pointer-events-none absolute left-0 top-0 z-40"
          style={{ transform: `translate(${tipPos.x + 14}px, ${tipPos.y + 14}px)` }}
          ref={(el) => {
            if (!el) return;
            const r = rootRef.current?.getBoundingClientRect();
            if (r) el.style.transform = `translate(${tipPos.x - r.left + 14}px, ${tipPos.y - r.top + 14}px)`;
          }}
        >
          {renderTooltip(tipTask)}
        </div>
      )}
    </div>
  );
}

function botOf(s: GanttTimeScale): Unit {
  return s === "hour" ? "day" : s === "week" ? "week" : s === "month" ? "month" : "day";
}
function fmtDuration(sp: Span, scale: GanttTimeScale): string {
  const h = (sp.e - sp.s) / HOUR;
  if (scale === "hour") return `${Math.round(h)}h`;
  const d = h / 24;
  return `${d % 1 ? d.toFixed(1) : Math.round(d)}d`;
}
function colorFor(status: GanttTask["status"], c: Record<string, string>): string {
  if (status === "completed") return c.success;
  if (status === "delayed") return c.danger;
  if (status === "in_progress") return c.primary;
  return c.muted;
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function CellInput({ value, onChange, onCommit, onCancel, numeric }: { value: string; onChange: (v: string) => void; onCommit: () => void; onCancel: () => void; numeric?: boolean }) {
  return (
    <input
      autoFocus
      defaultValue={value}
      inputMode={numeric ? "numeric" : undefined}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit();
        if (e.key === "Escape") onCancel();
        e.stopPropagation();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="h-6 w-full rounded-sm border border-primary bg-background px-1 text-xs text-foreground outline-none"
    />
  );
}

function fmt(t: number, hour: boolean) {
  const d = new Date(t);
  const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return hour ? `${md} ${String(d.getUTCHours()).padStart(2, "0")}:00` : md;
}

function DragHint({ x, y, span, hour, cascaded, rowH }: { x: number; y: number; span: Span; hour: boolean; cascaded: number; rowH: number }) {
  const text = `${fmt(span.s, hour)} → ${fmt(span.e, hour)}${cascaded > 0 ? ` · 级联 ${cascaded}` : ""}`;
  const w = text.length * 6.4 + 12;
  const ty = Math.max(y - 20, 0);
  return (
    <g className="pointer-events-none">
      <rect x={x} y={ty} width={w} height={18} rx={3} className="fill-foreground" />
      <text x={x + 6} y={ty + 13} className="fill-background text-[11px]">
        {text}
      </text>
      <line x1={x} x2={x} y1={ty + 18} y2={y + rowH} className="stroke-foreground" strokeDasharray="2 2" strokeWidth={0.5} />
    </g>
  );
}

function ToolBtn({ children, icon, onClick, active }: { children: ReactNode; icon: ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1 rounded border px-2 text-xs transition-colors",
        active ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-foreground hover:bg-row-hover",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
