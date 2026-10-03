# Algorithm Lab V2 组件设计（视觉方向确认后的实施蓝图）

> 前置：`VISUAL-DIRECTION.md`（方向）+ `concepts/*.png`（已确认概念图）。
> 本文定义组件结构、渲染管线、交互与性能约束，是三个实验室前端重做的实施基准。

## 1. 技术栈与新增依赖

| 层 | 技术 | 说明 |
|---|---|---|
| 3D 空间 | `three` + `@react-three/fiber` + `@react-three/drei` | 沙盘/相机/机器人/发光轨迹/空间拾取 |
| 2D 分析 | Canvas / SVG（现有体系升级） | 时间轴、甘特、指标曲线、对比表 |
| 状态 | React（现有） + zustand（仅 3D 场景状态桥） | 面板状态与场景状态解耦，避免每帧重渲染 |
| 算法 | Rust / WASM（不变） | Three.js 只做可视化，禁止编造路径 |

**性能红线**：`frameloop="demand"` 按需渲染；InstancedMesh（障碍/货架/节点）；
几何与材质复用；`dpr` 上限 2；离屏自动暂停。

**后处理的修订（2026-10，本轮审批后生效）**：原文"**不引入 postprocessing**"在执行中做了一次
**受控例外**——用户批准"允许受控 Bloom，但仅针对关键路径和状态灯，并且必须可关闭"。落地方式：

- 只用 `three` 自带的 `EffectComposer` + `UnrealBloomPass` + `OutputPass`，**不引入任何第三方后处理依赖**
  （`@react-three/postprocessing` 明令禁止，`audit-perf.mjs` 持续断言）；
- 泛光实现只允许存在于 `src/components/sandbox/ArtBloom.tsx` 一个文件；
- 阈值取高（模式 B 0.86 / 模式 C 0.72），只让越阈自发光参与，金属高光不糊；
- 模式 A（工业原貌）恒关；一键关闭后直接走 `gl.render(scene, camera)`，与改造前逐像素一致；
- 仍然禁止 SSAO / DOF / 描边后处理等"未审批"的额外通道。

"发光 = 双层 Line2（细亮核心 + 宽透明晕，additive）+ 自发光材质"仍是**路径与节点**的实现方式，
泛光只是在其上叠加的一层"越阈增益"，不是发光本身。

## 2. 目录结构

```
lab/src/components/sandbox/          # 共享 3D 原语（MAPF/AGV 复用，无算法语义）
  SandboxScene.tsx     Canvas 壳：按需渲染、灯光（柔和环境光+定向轮廓光）、深海军蓝雾
  IsoCamera.tsx        正交等距相机 + OrbitControls；「等距↔俯视」平滑插值 preset
  GroundPlate.tsx      有厚度倒角底板 + 细密工程网格（双色刻线）
  ObstacleField.tsx    障碍/建筑 InstancedMesh（倒角盒、石墨材质、底部假 AO 渐变）
  GlowPath.tsx         发光轨迹：drei <Line>(Line2) 双层描边 + 圆角拐点；
                       executed 亮 / planned 半透明虚线 / selected 强调 / 光流=与时间步绑定的 dashOffset
  GlowNode.tsx         发光节点：细环 Torus + 内核点 + 柔和外晕（取送点/事件点/当前位置）
  RobotUnit.tsx        MAPF 机器人：倒角盒 + 状态灯 + 选中环；位置=格心，离散步间受控插值
  AgvUnit.tsx          AGV 小车：车身/轮舱/载货托盘/警示灯/朝向轴（程序化几何，共享 geometry）
  StationPad.tsx       工作站泊位：发光垫面 + 容量灯条（占用/空闲）
  picking.ts           射线拾取 → 格坐标（编辑器事件桥，3D 与 2D 同一回调协议）
  theme.ts             色板转出（唯一来源在 src/art/tokens.ts：iceBlue/cyan/teal/violet/amber/coral + 石墨材质色）
lab/src/components/hud/              # 悬浮玻璃面板体系（三实验室共用）
  HudPanel.tsx / HudSection.tsx / StatChip.tsx / ToolButton.tsx / ModeTabs.tsx
lab/src/modules/mapf/Sandbox3D.tsx   # MAPF 面板装配：SceneDoc + solution → 沙盘
lab/src/modules/agv/Sandbox3D.tsx    # AGV 面板装配：场景/货架/工作站/小车/任务流
lab/src/modules/aps/Stage3D.tsx      # APS 生产单元平台 + 悬浮甘特玻璃板
```

## 3. 渲染管线与时间语义

- **按需渲染**：任何状态变化（回放 tick、选择、编辑）→ `invalidate()`；静止场景 0 GPU 负载。
- **离散时间红线**：动画只推进「步内插值系数 frac ∈ [0,1)」与「光流 dashOffset」，
  机器人位置 = `lerp(timeline[t], timeline[t+1], frac)`——视觉平滑但绝不越过引擎算出的步；
  服务中/等待中状态用脉冲环表达，不做位移。
- **重规划语义**：动态重解后旧路径保留为暗色幽灵（低透明度），新路径以新光色展开；
  受影响区域加珊瑚红局部光效/半透明覆盖层。

## 4. 编辑器交互升级（2D/3D 通用协议）

- 指针捕获（pointer capture）+ 移动去重 → **笔画级撤销**（一笔障碍 = 1 个历史步）；
- 工具光标（画笔/擦除/放置/禁止）；右键 = 擦除；悬停幽灵预览（放置前半透明）；
- 放置类工具点击空格落位，非法格红色脉冲 + 原因提示（复用 precheck 错误码）；
- 3D 模式同一回调协议：`onCellDown/onCellMove/onCellUp/onHover(cell|null)`。

## 5. AGV 补齐功能（本轮打回的缺口）

1. **运行中动态事件**（回放至 T 时刻进入「动态调度」模式）：
   - 操作：暂停/恢复车辆（点选）、新增任务（取/送点拾取）、取消任务、改优先级、画障碍（T 生效）；
   - 事件面板：时间戳 + 类型 + 定位（点击聚焦地图局部光效）；
   - 执行重调度 = 构造 `dynamic` 块：
     `snapshot.vehicles[id] = {pos, phase, task, path: timeline[0..T]}`
     `snapshot.tasks[id] = {status, assignee, pickup_dock, dropoff_dock, *arrival, *done}`（从当前解投影）
     `events[]`（task_add/task_cancel/task_priority/vehicle_pause/vehicle_resume/obstacle_add/obstacle_remove）
     → 引擎重解（WASM）→ 旧计划幽灵 + `solution.dynamic` 汇总面板（affected_vehicles /
     planned_moves_after_snapshot / semantic_digest）+ 前后指标对比。
2. **多策略对比**：RunRecord{algorithm, time_limit_ms, seed, status, metrics 子集, fingerprint,
   problem_hash, at}；历史列表（上限 20）任选两条 → 指标 diff 表（better/worse 方向语义）；
   与 MAPF runs.ts 同构、独立实现（AGV 指标集不同）。
3. **任务参数完整编辑**：pickup_service / dropoff_service / release_step / due_step / priority /
   required_capability；工作站容量编辑；车辆 capabilities 编辑。

## 6. APS 重构要点

- 生产单元 3D 平台（等距，石墨材质 + 状态灯）+ **悬浮甘特玻璃板**（Lane = 机器/资源，
  发光条 = 工序，颜色 = 订单/产品族），细发光连线（机器 ↔ 时间条）表达指派关系；
- 指标区：StatChip 行 + SVG 曲线（makespan/负荷利用率）；对比实验 = 并列窗口 + 统一指标表；
- 保留全部现有求解/核验逻辑与 Worker 生命周期，仅替换表现层。

## 7. 2D 轻量模式（兜底）

现有 `grid-map` Canvas 渲染器升级为 V2 深色主题（同色板 + 双层光晕线条 + 圆角拐点 +
chevron 流向），与 3D 共用 `theme.ts` 与交互协议；面板提供 3D/2D 切换，默认 3D，
`prefers-reduced-motion` 或低性能（FPS 采样）自动降级提示。

## 8. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| R1 | 设计系统（tokens + 悬浮面板体系）+ 应用壳 | 三模块统一换肤，视觉基调达标 |
| R2 | sandbox 3D 原语全量 + 2D 渲染器 V2 升级 | 原语 storybook 式自测 + tsc/test 绿 |
| R3 | MAPF：Sandbox3D 装配 + 编辑器交互升级 | 全部既有 M1 功能在 3D 下可用，测试绿 |
| R4 | AGV：沙盘 + 动态事件运行时 + 多策略对比 + 任务全参数 | AGV 缺口三项全闭合，测试绿 |
| R5 | APS：3D 生产单元 + 悬浮甘特 | 既有 APS 功能无损迁移 |
| R6 | 性能（按需渲染/实例化审计）+ 全量测试 + CI | test:all 绿；60fps 回放（中端设备） |
