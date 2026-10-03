import type { ReactNode, Ref } from "react";
import type { GanttAccessors } from "./Accessors";

export type GanttTimeScale = "hour" | "day" | "week" | "month";

export interface GanttTask {
  id: string;
  title: string;
  /** ISO 时间戳，如 "2026-10-01T08:00:00Z" */
  start: string;
  /** ISO 时间戳 */
  end: string;
  /** 进度 0 ~ 100 */
  progress?: number;
  status?: "pending" | "in_progress" | "completed" | "delayed";
  parentId?: string;
  assignee?: { name: string; avatar?: string };
  isMilestone?: boolean;
  /** 计划基线（原始计划），用于计划 vs 实际对比 */
  baseline?: { start: string; end: string };
}

export interface GanttDependency {
  id: string;
  from: string;
  to: string;
  type: "FS" | "SS" | "FF" | "SF";
}

export interface GanttCalendar {
  /** 工作日（0=周日 … 6=周六），默认 [1,2,3,4,5] */
  workdays?: number[];
  /** 节假日 "YYYY-MM-DD" (UTC) */
  holidays?: string[];
}

export type GanttColumnKey = "duration" | "start" | "end" | "progress" | "assignee" | "deps";

/** 左侧 WBS 表格列（由 Inspector 配置）。render 可完全接管单元格渲染。 */
export interface GanttColumn {
  key: GanttColumnKey;
  label: string;
  width: number;
  /** 自定义单元格渲染（拿到归一化后的任务，返回任意 React 节点） */
  render?: (task: GanttTask) => ReactNode;
}

/** renderTaskBar 拿到的状态 */
export interface GanttTaskBarState {
  selected: boolean;
  critical: boolean;
  progress: number;
  dragging: boolean;
  status: NonNullable<GanttTask["status"]>;
  rowHeight: number;
}

/** 渲染端对外暴露的命令句柄（供 Inspector / 宿主调用导出与定位） */
export interface GanttHandle {
  exportSVG: () => void;
  exportPNG: () => void;
  /** 打开系统打印对话框（可另存为 PDF） */
  exportPDF: () => void;
  scrollToDate: (iso: string) => void;
}

export interface GanttProps<T = GanttTask> {
  /** 直接模式：归一化后的任务（与 data 二选一） */
  tasks?: GanttTask[];
  /** 访问器模式：任意业务行数据（与 tasks 二选一） */
  data?: T[];
  /** 访问器：完整传入以便一次性映射；也可用下方独立 props 逐字段覆盖 */
  accessors?: GanttAccessors<T>;
  getTaskId?: (d: T) => string;
  getTitle?: (d: T) => string;
  getStartTime?: (d: T) => string;
  getEndTime?: (d: T) => string;
  getProgress?: (d: T) => number | undefined;
  getStatus?: (d: T) => GanttTask["status"];
  getParentId?: (d: T) => string | undefined;
  getAssignee?: (d: T) => GanttTask["assignee"];
  getMilestone?: (d: T) => boolean | undefined;
  getBaseline?: (d: T) => GanttTask["baseline"];

  dependencies?: GanttDependency[];
  timeScale?: GanttTimeScale;
  readOnly?: boolean;
  selectedTaskId?: string;
  className?: string;
  ref?: Ref<GanttHandle>;
  calendar?: GanttCalendar;
  /** 级联推移，默认 true */
  cascade?: boolean;
  /** 关键路径高亮（受控，未传则组件内部管理） */
  showCritical?: boolean;
  /** 计划 vs 实际基线（受控，未传则组件内部管理） */
  showBaseline?: boolean;
  columns?: GanttColumn[];
  /** 行高 24 ~ 36 */
  rowHeight?: number;

  // ---- UI 插槽（Slots） ----
  /** 自定义任务条：返回任意 React 节点（可带头像/徽章/按钮），渲染在 SVG foreignObject 中 */
  renderTaskBar?: (task: GanttTask, state: GanttTaskBarState) => ReactNode;
  /** 自定义悬停气泡：返回任意 React 节点 */
  renderTooltip?: (task: GanttTask) => ReactNode;

  // ---- 事件（只抛回调，不改 props） ----
  onTaskEdit?: (taskId: string, patch: { title?: string; assignee?: string; progress?: number }) => void;
  onTaskSelect?: (taskId: string) => void;
  onTaskChange?: (taskId: string, start: string, end: string, progress?: number) => void;
  onDependencyCreate?: (from: string, to: string) => void;
  onTimeScaleChange?: (scale: GanttTimeScale) => void;
  /** 受控时工具栏的开关请求（Inspector 双向驱动） */
  onShowCriticalChange?: (show: boolean) => void;
  onShowBaselineChange?: (show: boolean) => void;
}

export const DEFAULT_COLUMNS: GanttColumn[] = [
  { key: "duration", label: "工期", width: 56 },
  { key: "assignee", label: "负责人", width: 84 },
  { key: "progress", label: "完成率", width: 68 },
];
