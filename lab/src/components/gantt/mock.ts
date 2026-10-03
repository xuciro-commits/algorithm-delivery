import type { GanttDependency, GanttTask } from "./types";

const d = (day: number, hour = 8) => new Date(Date.UTC(2026, 9, 1 + day, hour, 0, 0)).toISOString();

const shift = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86400000).toISOString();

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const TASKS: Omit<GanttTask, "baseline">[] = [
  { id: "P1", title: "产线 A 年度检修项目", start: d(0), end: d(30), status: "in_progress" },
  { id: "P1-1", parentId: "P1", title: "停机准备", start: d(0), end: d(6), status: "in_progress" },
  { id: "T1", parentId: "P1-1", title: "检修方案评审", start: d(0), end: d(2, 18), progress: 100, status: "completed", assignee: { name: "王工" } },
  { id: "T2", parentId: "P1-1", title: "备件采购入库", start: d(1), end: d(6, 18), progress: 60, status: "in_progress", assignee: { name: "李采购" } },
  { id: "M1", parentId: "P1-1", title: "停机令签发", start: d(7), end: d(7), isMilestone: true },
  { id: "P1-2", parentId: "P1", title: "机械检修", start: d(7), end: d(21), status: "pending" },
  { id: "T3", parentId: "P1-2", title: "主轴拆解与探伤", start: d(7), end: d(11, 18), progress: 20, status: "delayed", assignee: { name: "赵班长" } },
  { id: "T4", parentId: "P1-2", title: "轴承更换", start: d(12), end: d(15, 18), progress: 0, status: "pending", assignee: { name: "赵班长" } },
  { id: "T5", parentId: "P1-2", title: "液压系统保养", start: d(8), end: d(13, 18), progress: 10, status: "in_progress", assignee: { name: "孙技师" } },
  { id: "T6", parentId: "P1-2", title: "主轴回装与对中", start: d(16), end: d(20, 18), progress: 0, status: "pending", assignee: { name: "王工" } },
  { id: "P1-3", parentId: "P1", title: "电气与调试", start: d(14), end: d(30), status: "pending" },
  { id: "T7", parentId: "P1-3", title: "PLC 程序升级", start: d(14), end: d(19, 18), progress: 0, status: "pending", assignee: { name: "周电气" } },
  { id: "T8", parentId: "P1-3", title: "空载联调", start: d(21), end: d(24, 18), progress: 0, status: "pending", assignee: { name: "周电气" } },
  { id: "T9", parentId: "P1-3", title: "带料试产", start: d(25), end: d(28, 18), progress: 0, status: "pending", assignee: { name: "吴主管" } },
  { id: "M2", parentId: "P1-3", title: "复产验收", start: d(29), end: d(29), isMilestone: true },
  { id: "P2", title: "产线 B 工单排程", start: d(2), end: d(20), status: "in_progress" },
  { id: "T10", parentId: "P2", title: "WO-24017 批量冲压", start: d(2), end: d(8, 18), progress: 80, status: "in_progress", assignee: { name: "B 班" } },
  { id: "T11", parentId: "P2", title: "WO-24018 焊接总成", start: d(9), end: d(14, 18), progress: 0, status: "pending", assignee: { name: "C 班" } },
  { id: "T12", parentId: "P2", title: "WO-24019 涂装烘干", start: d(15), end: d(19, 18), progress: 0, status: "pending", assignee: { name: "D 班" } },
];

/** 演示数据：为每道工序附加计划基线（部分工序实际已延误） */
export const mockGanttTasks: GanttTask[] = TASKS.map((t) => {
  const delay = t.status === "delayed" ? 3 : t.id === "T2" ? 2 : 0;
  return { ...t, baseline: { start: shift(t.start, -delay), end: shift(t.end, -delay) } };
});

export const mockGanttDependencies: GanttDependency[] = [
  { id: "D1", from: "T1", to: "T2", type: "SS" },
  { id: "D2", from: "T2", to: "M1", type: "FS" },
  { id: "D3", from: "M1", to: "T3", type: "FS" },
  { id: "D4", from: "T3", to: "T4", type: "FS" },
  { id: "D5", from: "T4", to: "T6", type: "FS" },
  { id: "D6", from: "M1", to: "T5", type: "FS" },
  { id: "D7", from: "T6", to: "T8", type: "FS" },
  { id: "D8", from: "T7", to: "T8", type: "FS" },
  { id: "D9", from: "T8", to: "T9", type: "FS" },
  { id: "D10", from: "T9", to: "M2", type: "FS" },
  { id: "D11", from: "T10", to: "T11", type: "FS" },
  { id: "D12", from: "T11", to: "T12", type: "FS" },
];

/** 访问器模式演示数据：字段名与组件无关（order_no / planned_start / completion_rate…），直接由宿主映射消费 */
export interface RawOrder {
  order_no: string;
  order_name: string;
  planned_start: string;
  planned_end: string;
  completion_rate?: number;
  order_status?: GanttTask["status"];
  parent_no?: string;
  owner?: string;
  is_gate?: boolean;
  plan_start?: string;
  plan_end?: string;
}

export const mockRawOrders: RawOrder[] = mockGanttTasks.map((t) => ({
  order_no: t.id,
  order_name: t.title,
  planned_start: t.start,
  planned_end: t.end,
  completion_rate: t.progress,
  order_status: t.status,
  parent_no: t.parentId,
  owner: t.assignee?.name,
  is_gate: t.isMilestone,
  plan_start: t.baseline?.start,
  plan_end: t.baseline?.end,
}));

export interface StressGantt {
  tasks: GanttTask[];
  dependencies: GanttDependency[];
}

/**
 * 极端压测：默认 3,000 道工序 / 500 条依赖链。
 * 结构：60 个工序组（根）× 每组 ~49 道子工序，种子随机、结果可复现。
 */
export function createStressGantt(taskCount = 3000, depCount = 500): StressGantt {
  const r = rng(20261001);
  const groups = 60;
  const names = ["冲压", "焊装", "涂装", "总装", "机加", "热处理", "装配", "检测", "包装", "转运"];
  const owners = ["王工", "李采购", "赵班长", "孙技师", "周电气", "吴主管", "郑工", "冯技师"];
  const tasks: GanttTask[] = [];
  const leaves: string[][] = [];
  const base = Date.UTC(2026, 0, 5);

  for (let g = 0; g < groups; g++) {
    const gid = `G${String(g).padStart(3, "0")}`;
    const gStart = base + g * 36 * 3600000;
    const per = Math.floor((taskCount - groups) / groups);
    const kids: string[] = [];
    let cursor = gStart;
    for (let i = 0; i < per; i++) {
      const id = `${gid}-T${String(i).padStart(3, "0")}`;
      const durH = (2 + Math.floor(r() * 20)) * 3600000;
      const start = cursor;
      const end = start + durH;
      cursor = end + (r() > 0.7 ? 8 * 3600000 : 0);
      const p = Math.floor(r() * 101);
      const delay = r() > 0.85 ? 1 + Math.floor(r() * 3) : 0;
      tasks.push({
        id,
        title: `${names[g % names.length]}工序 ${gid.slice(1)}-${String(i).padStart(2, "0")}`,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        progress: p,
        status: p >= 100 ? "completed" : delay ? "delayed" : p > 0 ? "in_progress" : "pending",
        parentId: gid,
        assignee: { name: owners[Math.floor(r() * owners.length)] },
        isMilestone: i === per - 1 && r() > 0.7,
        baseline: { start: new Date(start - delay * 86400000).toISOString(), end: new Date(end - delay * 86400000).toISOString() },
      });
      kids.push(id);
    }
    const kidsEnd = kids.length ? Date.parse(tasks[tasks.length - 1].end) : gStart + 86400000;
    tasks.push({
      id: gid,
      title: `${String.fromCharCode(65 + (g % 26))} 区 · ${names[g % names.length]}工序组 ${g + 1}`,
      start: new Date(gStart).toISOString(),
      end: new Date(kidsEnd).toISOString(),
      status: "in_progress",
      assignee: { name: owners[g % owners.length] },
    });
    leaves.push(kids);
  }

  const deps: GanttDependency[] = [];
  // 组内串行链
  leaves.forEach((kids) => {
    for (let i = 1; i < kids.length && deps.length < depCount - groups; i++) {
      deps.push({ id: `DX${deps.length}`, from: kids[i - 1], to: kids[i], type: i % 7 === 0 ? "SS" : "FS" });
    }
  });
  // 跨组关键链
  let n = 0;
  while (deps.length < depCount && n < leaves.length - 1) {
    const a = leaves[n];
    const b = leaves[n + 1];
    if (a.length && b.length) {
      deps.push({ id: `DG${deps.length}`, from: a[a.length - 1], to: b[0], type: "FS" });
      deps.push({ id: `DG${deps.length}`, from: a[Math.floor(a.length / 2)], to: b[Math.floor(b.length / 2)], type: "FS" });
    }
    n++;
  }
  return { tasks, dependencies: deps };
}
