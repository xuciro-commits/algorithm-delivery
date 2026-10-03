import { FileImage, FileText, Grid2X2, Rows3 } from "lucide-react";
import { cn } from "../../utils/cn";
import { DEFAULT_COLUMNS } from "./types";
import type { GanttColumn, GanttColumnKey, GanttHandle, GanttTimeScale } from "./types";
import { InsBtn, InsCheck, InsRow, InsSection, InsSeg, InsSlider, InsStat, InsToggle } from "../inspector-ui";

export interface GanttSettings {
  timeScale: GanttTimeScale;
  readOnly: boolean;
  showCritical: boolean;
  showBaseline: boolean;
  cascade: boolean;
  rowHeight: number;
  columns: GanttColumn[];
  workdays: number[];
  holidays: string[];
  /** 演示 / 消费侧：是否以 renderTaskBar 插槽接管任务条 */
  customBar?: boolean;
}

export const defaultGanttSettings: GanttSettings = {
  timeScale: "day",
  readOnly: false,
  showCritical: false,
  showBaseline: true,
  cascade: true,
  rowHeight: 28,
  columns: DEFAULT_COLUMNS,
  workdays: [1, 2, 3, 4, 5],
  holidays: [],
  customBar: false,
};

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const OPTIONAL: { key: GanttColumnKey; label: string; width: number }[] = [
  { key: "duration", label: "工期", width: 56 },
  { key: "assignee", label: "负责人", width: 84 },
  { key: "progress", label: "完成率", width: 68 },
  { key: "start", label: "开始", width: 54 },
  { key: "end", label: "结束", width: 54 },
  { key: "deps", label: "前置号", width: 78 },
];

/** Gantt 配置面板（Renderer 的成对面板）。只抛 onChange，不改传入值。 */
export function GanttInspector({
  value,
  onChange,
  gantt,
  stats,
  className,
}: {
  value: GanttSettings;
  onChange: (patch: Partial<GanttSettings>) => void;
  /** 已挂载渲染端的命令句柄（ref.current），用于导出等操作 */
  gantt?: GanttHandle | null;
  stats?: { rows: number; deps: number; rendered?: number };
  className?: string;
}) {
  const toggleColumn = (col: { key: GanttColumnKey; label: string; width: number }, on: boolean) => {
    const has = value.columns.some((c) => c.key === col.key);
    if (on && !has) onChange({ columns: [...value.columns, col] });
    if (!on && has) onChange({ columns: value.columns.filter((c) => c.key !== col.key) });
  };

  return (
    <div className={cn("platform-gantt-inspector h-full overflow-auto bg-surface", className)}>
      <InsSection title="渲染 Renderer">
        <InsRow label="时间刻度">
          <InsSeg
            value={value.timeScale}
            onChange={(v) => onChange({ timeScale: v })}
            options={[
              { key: "hour", label: "时" },
              { key: "day", label: "日" },
              { key: "week", label: "周" },
              { key: "month", label: "月" },
            ]}
          />
        </InsRow>
        <InsRow label="只读模式">
          <InsToggle checked={value.readOnly} onChange={(v) => onChange({ readOnly: v })} label="只读" />
        </InsRow>
        <InsRow label="关键路径高亮">
          <InsToggle checked={value.showCritical} onChange={(v) => onChange({ showCritical: v })} label="关键路径" />
        </InsRow>
        <InsRow label="计划 vs 实际基线">
          <InsToggle checked={value.showBaseline} onChange={(v) => onChange({ showBaseline: v })} label="基线" />
        </InsRow>
        <InsRow label="前置延期级联推移">
          <InsToggle checked={value.cascade} onChange={(v) => onChange({ cascade: v })} label="级联" />
        </InsRow>
        <InsRow label="行高密度">
          <InsSlider value={value.rowHeight} min={24} max={36} step={2} onChange={(v) => onChange({ rowHeight: v })} suffix="px" />
        </InsRow>
        <InsRow label="任务条插槽（renderTaskBar）">
          <InsToggle checked={value.customBar ?? false} onChange={(v) => onChange({ customBar: v })} label="插槽" />
        </InsRow>
      </InsSection>

      <InsSection title="WBS 表格列" hint="勾选 / 排序">
        <div className="flex gap-1">
          <InsBtn onClick={() => onChange({ columns: value.columns.filter((c) => c.key === "duration") })} disabled={value.columns.length <= 1}>
            <Grid2X2 className="size-3" /> 精简
          </InsBtn>
          <InsBtn onClick={() => onChange({ columns: DEFAULT_COLUMNS })}>
            <Rows3 className="size-3" /> 默认
          </InsBtn>
        </div>
        {OPTIONAL.map((col) => (
          <InsCheck key={col.key} label={`${col.label} · ${col.width}px`} checked={value.columns.some((c) => c.key === col.key)} onChange={(v) => toggleColumn(col, v)} />
        ))}
        <p className="pt-1 text-[11px] leading-4 text-muted">双击表体单元格可就地编辑标题 / 负责人 / 完成率，仅触发 onTaskEdit。</p>
      </InsSection>

      <InsSection title="工作日历" hint="拖拽吸附">
        <div className="flex gap-0.5">
          {WEEK.map((d, i) => (
            <button
              key={d}
              type="button"
              onClick={() => {
                const set = new Set(value.workdays);
                if (set.has(i)) set.delete(i);
                else set.add(i);
                onChange({ workdays: [...set].sort() });
              }}
              className={cn("h-7 flex-1 rounded-sm border text-[11px]", value.workdays.includes(i) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted hover:bg-row-hover")}
            >
              {d}
            </button>
          ))}
        </div>
        <InsRow label="节假日">
          <input
            type="date"
            onChange={(e) => e.target.value && onChange({ holidays: [...new Set([...value.holidays, e.target.value])] })}
            className="h-7 rounded-sm border border-border bg-background px-1.5 text-xs text-foreground"
          />
        </InsRow>
        <div className="flex flex-wrap gap-1">
          {value.holidays.map((h) => (
            <button key={h} type="button" onClick={() => onChange({ holidays: value.holidays.filter((x) => x !== h) })} className="rounded-sm border border-border px-1 py-0.5 font-mono text-[10px] text-muted hover:border-tone-danger/50 hover:text-tone-danger">
              {h.slice(5)} ✕
            </button>
          ))}
          {value.holidays.length === 0 && <span className="text-[11px] text-muted">未设置，日期选择后自动加入</span>}
        </div>
      </InsSection>

      <InsSection title="导出 Export">
        <div className="flex gap-1">
          <InsBtn disabled={!gantt} onClick={() => gantt?.exportSVG()}>
            <FileText className="size-3.5" /> SVG 矢量
          </InsBtn>
          <InsBtn disabled={!gantt} onClick={() => gantt?.exportPNG()}>
            <FileImage className="size-3.5" /> PNG 高清
          </InsBtn>
          <InsBtn disabled={!gantt} onClick={() => gantt?.exportPDF()}>
            <FileText className="size-3.5" /> PDF 打印
          </InsBtn>
        </div>
        <p className="text-[11px] leading-4 text-muted">SVG 导出全部行（上限 1,200 行 / 500 条依赖），PNG 自动缩放到 6,000px 以内，PDF 打开系统打印对话框。</p>
      </InsSection>

      <InsSection title="运行遥测">
        {stats ? (
          <>
            <InsStat k="任务行（含折叠）" v={String(stats.rows)} />
            <InsStat k="依赖连线" v={String(stats.deps)} />
            <InsStat k="虚拟化窗口" v={stats.rendered ? `${stats.rendered} 行` : "自动 30–50 行"} />
          </>
        ) : (
          <InsStat k="状态" v="等待数据" />
        )}
      </InsSection>
    </div>
  );
}
