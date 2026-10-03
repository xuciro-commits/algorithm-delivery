# Gantt：工业排程甘特图（Phase 2）

自研纯 SVG 渲染 + 虚拟滚动。左右两侧共用一个滚动容器（表头与任务树均 sticky），横纵滚动绝对同步。

```tsx
const ref = useRef<GanttHandle>(null);

<Gantt
  ref={ref}
  tasks={tasks}                 // 可含 baseline 计划基线
  dependencies={deps}
  timeScale={settings.timeScale}
  showCritical={settings.showCritical}   // 受控：Inspector 双向驱动
  showBaseline={settings.showBaseline}
  columns={settings.columns}             // 左侧表格自定义列
  rowHeight={settings.rowHeight}
  calendar={{ workdays, holidays }}
  selectedTaskId={sel}
  onTaskSelect={setSel}
  onTaskChange={(id, s, e) => ...}       // 拖拽结束（级联推移的后续任务各自回调）
  onTaskEdit={(id, patch) => ...}        // 行内双击编辑
  onDependencyCreate={(from, to) => ...}
  onTimeScaleChange={setScale}
  onShowCriticalChange={(v) => ...}      // 受控时工具栏开关请求
/>
```

| 能力 | 实现 |
| --- | --- |
| 纵向虚拟滚动 | 只渲染可视窗口 ±5 行（overscan），3,000 行同样是 30–50 行 DOM；滚动用 rAF 节流 |
| WBS 多列表格 | `columns` 自定义（工期 / 开始 / 结束 / 负责人 / 完成率 / 前置号），双击单元格就地编辑，仅回调 `onTaskEdit` |
| 分栏拖拽 | 左表右缘的竖直把手可拖动（240–760px），左侧 `overflow-hidden` 防溢出 |
| 基线对比 | `task.baseline` 细灰条（计划）+ 彩色条（实际进度），`showBaseline` 开关 |
| 关键路径 | 由最晚结束任务沿紧前链回溯并高亮 |
| 拖拽 & 吸附 | 整条 / 两端手柄拖拽，按刻度吸附并跳过非工作日与节假日，前置延期级联推移后续任务 |
| 依赖连线 | FS/SS/FF/SF，直角折线 + 箭头，回折时从行间缝隙避让 |
| 无级缩放 | **Ctrl / ⌘ + 滚轮**（非被动监听）连续缩放 0.15×–8× |
| 导出 | `ref.exportSVG()` / `ref.exportPNG()`：自建 SVG 字符串，CSS 变量烘焙为十六进制色；SVG 全量（≤1,200 行），PNG 自动缩放到 6,000px 内 |
| 错误降级 | 非法时间戳会被过滤（`Number.isFinite` 判定），缺数据行直接跳过，不整页白屏 |

- `mock.ts`：`mockGanttTasks`（含基线的演示集）、`createStressGantt(3000, 500)`（种子可复现的压测集，60 个工序组 × ~49 子工序 + 500 条依赖）。
- 受控原则：组件不修改传入的 `tasks / dependencies`，拖拽与编辑只发事件。
