# 算法实验室（Algorithm Lab）

> Algorithm Delivery 项目的**统一算法实验 / 可视化 / 性能评测入口**。
> 所有算法（APS 排程、MAPF 路径规划、AGV 调度、库位优化、密集立库，以及库位×调度的联合优化）
> 都进这一个站点，**不为单个算法单独建演示网站**。
>
> 计算全部在浏览器内通过 WebAssembly 完成：不需要安装软件，也不依赖任何常驻服务端。
> 展示层是一套**工业科技美术语言**（C4D / Octane 视觉参考、Three.js / R3F 实时渲染），
> 三个实验室、三种视觉模式共用同一份几何与同一份真实算法数据。

当前六个可运行模块（没有待接入模块）：

| 模块 | 路由 | 说明 |
| --- | --- | --- |
| APS 生产排程 | `#aps` | 甘特 / 资源 / 核验 / 多次运行对比，求解在 Worker + WASM 内完成 |
| MAPF 路径规划 | `#path-planning` | 地图优先编辑器 + 时空回放 + 动态事件 + 运行对比 |
| AGV 多车调度 | `#agv-dispatch` | 地图编辑 + 任务相位回放 + 工作站容量 + 动态重调度汇总 |
| 库位优化 | `#slotting` | 货架/库位/周转热力 3D 沙盘 + 落位与搬迁图层 + **关联簇叠加** + 多目标分解 + 基线对比；**也吃 joint 实例** |
| 密集立库 | `#dense-asrs` | 巷道/提升机/穿梭车 3D + 真实设备时间线回放 + **倒垛/深位让位图层** + 冲突/缓冲 + 动态事件 |
| 三维实验室 | `#art-lab` | 英雄设备 / 透明厂房 / 算法观察三个实验室（模式 A/B/C） |

仓储优化的两个模块共用同一个 Rust 引擎（`warehouse-engine` → WASM），都支持 `kind=joint` 的
**联合优化**实例：库位侧给出"为什么放这儿"，调度侧用真实推演回答"这么放能省多少"，
两段结论各自通过独立验证器复核后才允许出现在界面上。

两个模块的公共约定（都来自引擎，不在前端硬编码）：

* **场景选择**：场景下拉框按族列出引擎的 86 个标准场景（`S/D/E/J/X`），选中后自动跟随该场景的默认规模；
  规模档位来自 `capabilities`（浏览器侧是 wasm-light 档：60k SKU / 300k 库位 / 20k 任务，超档如实返回
  `UNSUPPORTED`，不静默缩小问题）；也可以导入/粘贴任意契约问题 JSON。
* **参数开关**：算法（`capabilities.domains[*].algorithms`）、种子、时间预算、**双指令配对**
  （`dualCommand`）、**是否产出时间线**（`includeTimeline`）、**求解时内嵌核验**（`verify`）。
  引擎只实现 `reservation` 冲突策略；面板不会给出"看起来能选、其实没用"的旋钮。
* **三条必答问题**：库位侧读 `result.explanation[]`（topic/text/evidence），调度/联合侧读
  `result.explanation.{slotting,dispatch,reasons}`——文案里的数字都由引擎按本次推演指标生成。
* **改善幅度**：同实例换策略/指令模式再跑一次，用运行历史里的逐指标差异表（更好/更差方向）说话；
  跨规模不可比时运行对比会明确标出。
* **图层的数据来源写在代码注释里，也写在图例里**：库位侧的「关联簇叠加」读 `result.clusters.bySku`
  （引擎按订单共出库权重聚类，同簇同色；**前端不做二次聚类**，否则面板里的"N 个簇"会和画布打架）；
  「落位/搬迁」读 `result.assignment`（联合实例读 `result.slottingAssignment`，两者都是同一份库位求解器的输出）；
  密集立库的「倒垛/深位让位」读时间线 `locationStates` 里成对出现的两条状态迁移
  （让空 + 落位），按事件时刻在时间轴上累积出现。某一层没有数据时**不画占位几何**，文案如实写"这次没有"。
* **字段名以引擎输出为准**：任务轨迹里的设备/步骤 id 数组键名是 `devices`/`steps`，`deadline_s` 序列化成字符串，
  步骤的距离键名是 `distanceM`、推迟键名是 `delayedBy_s`、资源键名是 `resourceId`——
  类型定义与读取端都按引擎写，不按前端习惯改名（旧键名只作为兼容读取保留）。

```
lab/
├── index.html                  入口页（单页应用）
├── src/
│   ├── core/                   与界面无关的核心：契约类型、模块注册表、纯逻辑（可被 Node 测试直接跑）
│   │   ├── types.ts            契约形状 + AlgorithmModule 模块接口
│   │   ├── registry.ts         模块注册表（重复 id 直接报错）
│   │   ├── aps/                APS 专属逻辑：参数模型、运行记录、可视化转换、引擎适配、React 钩子
│   │   ├── mapf/               MAPF 引擎适配与类型（求解结果、动态块、运行记录）
│   │   ├── agv/                AGV 引擎适配与类型（车辆时间线、任务相位、核销汇总）
│   │   └── warehouse/          仓储引擎适配与类型（信封/时间线/场景/能力，Worker 生命周期）
│   ├── art/                    工业科技美术语言：令牌、材质预设、三种视觉模式、透明策略、装配层
│   │   ├── tokens.ts           颜色与语义令牌（石墨 / 冰蓝 / 青 / 银白 / 琥珀）
│   │   ├── materials.ts        MeshPhysicalMaterial / MeshStandardMaterial 预设（按角色选材质）
│   │   ├── modes.ts            模式 A/B/C 的数值表（曝光、雾、灯光、透明、泛光…）
│   │   ├── settings.ts         用户实时倍率与总开关（effectiveAlphaScales 唯一入口）
│   │   ├── roles.ts            部件 → 角色 → 透明策略（part-roles.json，95 条规则）
│   │   ├── EquipmentModel.tsx  单台设备装配（材质替换、强调、透明、LOD 级可见性）
│   │   ├── ArtFactoryHall.tsx  上传构件装配的厂房（柱/桁架/屋面/墙板/窗带/夹层）
│   │   ├── ArtAlgorithmOverlay.tsx / ArtOverlayLayer.tsx   算法空间语汇（路径、节点、状态、进度弧）
│   │   ├── ArtLightRig.tsx     HDRI 环境 + 主光 / 补光 / 轮廓光 + 接触阴影
│   │   └── ArtStage.tsx / SmoothOrbit.tsx                  舞台、跟随与补间镜头
│   ├── components/             通用可视化
│   │   ├── sandbox/            3D 原语（SandboxScene / 发光路径 / 发光节点 / 设备与机器人单元 /
│   │   │                       ArtBloom 受控泛光 / 障碍场 / 底板 / 拾取 / 主题）
│   │   ├── hud/                悬浮玻璃面板体系（HudPanel / HudSection / StatChip / ToolButton …）
│   │   ├── grid-map/           2D 轻量回退渲染器（低性能设备与 prefers-reduced-motion）
│   │   └── gantt/              甘特图（含独立 README）
│   ├── modules/                各算法模块（自带的引擎适配 + 可视化）
│   │   ├── aps/ mapf/ agv/     三个算法模块（面板 + 3D/2D 装配 + 运行历史）
│   │   ├── slotting/ dense-asrs/     仓储优化两个模块（面板 + 3D 沙盘 + 回放 + 运行历史）
│   │   └── warehouse-shared/         两个仓储模块共用的几何/回放/指标/核验组件
│   │   ├── art-lab/            三维实验室面板（HeroBench3D / FactorySandbox3D / playback / layout）
│   │   └── index.ts            注册表装配（含 planned 路线图条目）
│   └── vendor/                 **自动生成**（勿手改）：aps / mapf / agv 的 worker 副本
├── design/                     设计基准与素材（见 design/README.md；assets 只读）
├── public/                     **自动生成**：wasm、worker、manifest、mock/基准数据、models（上传模型副本）
└── scripts/                    同步、构建校验、冒烟、静态契约检查、Pages 子路径仿真、视觉验收
```

## 1. 快速开始

```bash
cd lab
npm ci               # 按 package-lock.json 安装锁定依赖（Node.js >= 20）
npm run dev          # http://localhost:5173/ （默认 base=/algorithm-delivery/，见下方说明）
```

本地开发建议用根路径，避免每次都要输子路径：

```bash
LAB_BASE=/ npm run dev
```

根目录有 `Makefile` 作为"我现在该跑什么"的入口（`make help` 看全部）：
`make static`（秒级的静态检查）、`make dev`、`make test`、`make engine-aps|mapf|agv`、`make ci`。

一条命令跑完 CI 的完整链路（wasm 构建 → 同步 → 构建 → 全部测试 → Pages 仿真）：

```bash
npm run build:all            # 需要 aps/rust 的 Rust 工具链（见 aps/rust/toolchain/setup_rust.sh）
LAB_BASE=/ npm run build:all # 本地根路径版本
```

## 2. 三个实验室与三维美术系统

`#art-lab` 是**同一座厂房**的三块观察面，不是三套模型：几何、材质、灯光、算法数据全部共用。

| 实验室 | 看什么 | 关键实现 |
| --- | --- | --- |
| **01 英雄设备** | 单台设备艺术化重构与部件级核对（默认 CNC 加工中心，可换 6 台英雄设备、5 组对照视图、5 个机位） | `modules/art-lab/HeroBench3D.tsx` |
| **02 透明厂房** | 分层透明与空间关系：厂房构件 + 29 处产线设备 + 地坪分区 | `art/ArtFactoryHall.tsx`、`modules/art-lab/FactorySandbox3D.tsx` |
| **03 算法观察** | 真实解的空间回放：APS/MAPF/AGV 引擎输出 + 跟随镜头 + 进度弧 | `art/ArtAlgorithmOverlay.tsx`、`modules/art-lab/playback.ts` |

**三种视觉模式**（同一份几何与数据，只换视觉配置；参数正值见 `src/art/modes.ts`）：

| | 模式 A 工业原貌 | 模式 B 工业科技艺术化（默认） | 模式 C 算法观察 |
| --- | --- | --- | --- |
| 用途 | 核对原始结构 / 布局 | 主目标：冷色工业材质 + 选择性透明 + 柔和渐变照明 | 弱化次要结构，强化路径、节点、状态与事件 |
| 材质 | 原始 glTF 材质 | 石墨 / 冰蓝 / 青 / 银白 + 少量琥珀，按角色分材质 | 同 B，次要对象降对比 |
| 建筑层 | 不透明、保留屋面 | 默认隐藏屋面 + 分层透明 | 更彻底弱化 |
| 泛光 | **恒关** | 受控（仅越阈自发光，可一键关闭） | 受控（更强一点） |

要点与红线：

- **不重做几何**：`design/assets/**` 只读，运行时由 `sync-assets.mjs` 复制到 `public/models/**`；
  艺术化只改材质、可见性与分层透明，不改顶点、不重建网格。
- **不做全局统一透明**：唯一入口是 `art/roles.ts` + `part-roles.json`（95 条规则）——
  屋面 0.10 / 建筑结构 0.14 / 玻璃 0.26 / 设备外壳 0.42 / 地坪隐藏，
  内部机构（frame、graphite、machined、drive、robot、conveyor、cargo、vessel）**永不透明**；
  透明件统一 `renderOrder = 12` + `depthWrite = false`，有效 α ≤ 0.02 直接隐藏，避免穿透噪点。
- **不把模型统一涂蓝**：`tokens.ts` / `materials.ts` 按部件角色分材质，保留材料与结构对比。
- **不做全模型线框 / 密集发光网格**：发光只出现在路径、节点、状态灯；
  受控泛光只在 `components/sandbox/ArtBloom.tsx`（three 自带 EffectComposer + UnrealBloomPass + OutputPass），
  不引入第三方后处理依赖，关闭时直接走 `gl.render`。
- **算法可视化只来自真实引擎输出**：路径、节点、状态光、进度弧、事件标记全部由
  AGV / MAPF / APS 的 WASM 结果投影而来；没有结果时显示空叠加层，不用装饰动画充数。
  步内插值只发生在绘制阶段，面板同时显示"当前步 / +x 步内插值"。
- **性能红线**（`npm run audit:perf` 持续断言）：`dpr ≤ 2`；`frameloop` 只在 `active` 时 `always`；
  `useFrame` 内零分配；发光线为两层细线；障碍场与底坪实例化。
- **单一来源**：色板只有 `src/art/tokens.ts` 一处（`components/sandbox/theme.ts` 只是转出）；
  运行历史 / 方案对比的公共骨架只有 `src/core/runs/` 一处（MAPF 与 AGV 各自的指标集留在自己模块里）。
  这两条由 `test-art-system.mjs` 断言，防止再长出第二份。

设计依据与冲突时的权威来源见 [`design/README.md`](design/README.md)；
每轮落地记录与审批台账见 [`design/ART-PIPELINE.md`](design/ART-PIPELINE.md)；
真实浏览器验收流程与当前状态见 [`design/VISUAL-ACCEPTANCE.md`](design/VISUAL-ACCEPTANCE.md)。

## 3. 常用脚本

> 新增 npm 脚本时请在本文档补一行：`npm run check:docs` 会断言"README 覆盖全部脚本"，
> 漏写会让 CI 直接失败（这是刻意的——文档漂移比多写一行更贵）。

同步与开发（`predev` / `prebuild` / `prepreview` 会自动先跑一次 `npm run sync`）：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` / `npm run preview` | 开发服务器 / 预览构建产物（都会先自动 `sync`） |
| `npm run sync` | 把 APS/MAPF/AGV + 仓储（Warehouse）引擎的 wasm、Worker 胶水与 Mock 同步进实验室，生成各自的 `*-manifest.json` 与能力快照 |
| `npm run sync:aps` / `npm run sync:mapf` / `npm run sync:agv` / `npm run sync:warehouse` | 只同步其中一个引擎 |
| `npm run sync:assets` | 把 `design/assets` 里入选的 43 件上传模型同步到 `public/models` 并生成 `art-manifest.json` |
| `npm run build` | 类型检查（tsc `--noEmit`）+ 打包（vite） |
| `npm run typecheck` | 只做类型检查（需要 `npm i` 后的 typescript） |
| `npm run build:all` | 构建三引擎 WASM → 同步 → 构建 → 全量 Lab 检查 → Pages 仿真 |

> 所有检查脚本都是纯 Node（`.mjs`），没有测试框架依赖。新脚本请用共享外壳
> `scripts/lib/harness.mjs`（`check / note / warn / finish`，退出码与汇总格式统一），
> 不要再手写一遍 `failures` 数组与 `process.exit(1)`。

测试与审计（**前五项不需要浏览器 / 不需要 Rust**，可在受限环境直接跑）：

| 命令 | 作用 |
| --- | --- |
| `npm run test:art` | 三维美术系统静态契约：相对 import 可达、导出存在、无未使用 import、模式与透明策略自洽、滑杆确实被消费、泛光只在授权文件、JSX 标签配平、清单与磁盘一致 |
| `npm run audit:perf` | 性能红线审计：按需渲染、dpr、受控泛光四条约束、实例化、每帧零分配 |
| `npm run audit:models` | 472 件上传资产的结构审查（材质、层级、部件可分离性、透明策略命中） |
| `npm run check:docs` | 文档一致性：相对链接可达、设计文档索引完整、生成物未被提交、README 覆盖全部脚本 |
| `npm run check:workflows` | CI 工作流自检：YAML 结构、job 超时、触发范围收敛、action 是否支持 Node 24 |
| `npm run test:static` | 上面第 1、2、3、8 条的组合（文档 + 工作流 + 美术契约 + 性能红线，秒级） |
| `npm run test:imports` | 不依赖 Rust/WASM：内置数据回退、PlanProblem 导入与标准 JSSP/FJSP 格式适配 |
| `npm run test:core` | 核心冒烟：加载真实 WASM 求解，并断言实验室纯逻辑（30+ 项） |
| `npm run test:runner` | 运行器生命周期：取消（终止 Worker）→ 自动重建 → 再求解；`dispose()` |
| `npm run test:render` | 渲染冒烟：外壳/参数区/MAPF Visual Lab 与 AGV/库位/立库面板骨架/空态（SSR，无需浏览器） |
| `npm run test:grid` | 网格视口：2D 适配 / 缩放上下限 / 格↔像素互逆 / LOD 档位（含“极小地图不得被放大成巨框”的回归） |
| `npm run test:mapf:scene` | MAPF 场景内核：命令撤销栈、预检逐错误码、序列化白名单、14 mock roundtrip、动态块构造与预检拦截 |
| `npm run test:mapf:playback` | MAPF 回放时钟：seek/暂停/限速不变式（曾抓出 dt 毫秒未除 1000 的真 bug） |
| `npm run test:mapf:runs` | MAPF 运行历史：RunRecord 投影、指纹分组、diffRuns 对比方向语义 |
| `npm run test:agv` | AGV Lab：场景内核 + 14 mock roundtrip + **真实 WASM 集成**（求解断言、独立核验、确定性、篡改必拒） |
| `npm run test:agv:dynamic` | AGV 动态重调度：快照构造、事件块、重解后的汇总与指标对比 |
| `npm run test:aps:line` | APS 产线装配：问题 → 设备/工位映射 → 三维舞台数据（不渲染） |
| `npm run test:warehouse:scenes` | 仓储两个模块的场景投影（纯 Node + esbuild，不需要 Rust/WASM）：落位来源（`assignment` / `slottingAssignment`）、**关联簇叠加**（只画 ≥0 的簇、同簇同色、引擎没给就不画）、**倒垛/深位让位图层**（成对的"让空 + 落位"才算一次，入库状态迁移不算、缺落位格留 null、显示上限 400 但总数如实）、任务轨迹的设备取自 `tasks[].devices` |
| `npm run test:dist` | 构建产物校验：子路径资源引用、清单 sha256 与产物一致、体积 |
| `npm run test:pages` | **Pages 子路径仿真**：把 dist 挂到 `/algorithm-delivery/` 下用真实 HTTP 跑一遍 |
| `npm run test:visual` | Playwright Chromium 检查真实 production WebGL 场景、HDRI、非黑屏、相机交互和真实引擎结果；需已构建的 dist 与 `npx playwright install --with-deps chromium`，产出九张图及 JSON/HTML/console Artifact |
| `npm run test:post-build` | CI 质量门用的完整列表（静态检查 + 全部 Lab 检查，构建之后执行） |
| `npm run test:all` | `npm run build` + `npm run test:post-build`（要求已有 Rust WASM 产物；视觉检查在独立 Actions job 运行） |

## 4. 数据来源与"单一来源"原则

**算法侧**：引擎与构建期规模基准以 Rust 源码 / Mock 为单一来源，由 `sync-*.mjs` 同步；
四个小型 Mock JSON 另由前端直接导入，作为 manifest/WASM 不可用时的离线数据目录（不是手工维护的副本）。

| 输入 | 来源 | 去向 |
| --- | --- | --- |
| WASM 产物 | `aps/rust/dist/aps_engine.wasm`（`scripts/build_wasm.sh` 构建，或 CI 从正式 Release 下载） | `public/wasm/aps_engine.wasm` |
| JS 胶水 | `aps/rust/web/aps-worker.js`（MAPF / AGV 同构） | `public/wasm/*-worker.js` + `src/vendor/*` |
| Mock 场景 | `aps/mock/*.json`、`mapf/mock/*`、`agv/mock/*`、`warehouse/mock/*` | `public/mock/`（四个领域**共用**） |
| 规模/竞争型基准 | `aps benchmark` CLI 现场生成（`LAB_BENCH_SIZES=240,c48,c96`） | `public/mock/bench-*.json` |
| 引擎版本/摘要 | 构建 CLI 的 `capabilities` 与产物自身 | `public/*-manifest.json` |

**素材侧**：`design/assets/**`（上传资产，**只读**）→ `art-lab-selection.json`（入选 43 件）
→ `public/models/**` + `art-manifest.json`。`sync-assets.mjs --check` 会交叉校验
"清单 ↔ 选择表 ↔ 磁盘 GLB ↔ 透明规则覆盖"，任何不一致直接失败。

同步时做**产物自检**：wasm 魔数、体积、清单 sha256、`aps_version()` 与元数据版本一致、
baseline 能解出 24 道工序、分析类导出可用。任何一项不满足就直接失败——**不会把坏产物发到 Pages**。

`public/wasm/`、`public/mock/`、`public/models/`、`src/vendor/`、`*-manifest.json` 都在 `.gitignore` 里，
因为它们是生成物；真正的来源只有一份：`*/rust`、`*/mock` 与 `design/assets`。

`public/mock/` 是**四个领域共用**的目录，文件名里看不出来自哪个域（仓储的 `asrs-*.json` 与 AGV 的 `a*`
前缀就撞过：`test-agv-problem.mjs` 曾按 `/^[aw]/` 挑 AGV mock，把 AS/RS 文档一起扫了进来，直接把
`npm run test:post-build` 跑挂）。因此**判断一份 mock 属于哪个领域一律按内容**
（`schema_version` / 字段形状），不要按文件名前缀；确需按名字收敛时，务必同时加一条"反向护栏"，
保证该命名空间下的文件都被选中过。

## 5. 在实验室里做什么（APS 模块）

- **数据**：基础车间 / 设备故障 / 到货延迟 / 无解四个内置场景直接打包在页面里；即使
  `engine-manifest.json` 或 WASM 未加载，仍可选择、查看案例与参数。引擎清单只补充规模基准。
- **公开标准集**：可导入 FJSPLib / Brandimarte FJSP 文本（`.fjs` / `.fjsp` / `.txt`），以及
  OR-Library `jobshop1` JSSP 单例或集合文件（`.jsp` / `.jssp` / `.txt`）；OR-Library 集合每个
  `instance NAME` 会成为单独案例。标准文本单文件上限 2 MiB、100 个实例 / 50,000 道工序；一次最多选择 5 个文件。界面提供公开来源链接，第三方数据不会被无许可复制进仓库。
- **格式适配边界**：作业工序顺序、候选机器和加工时长映射到 `PlanProblem`；机器编号按来源规则
  转成 `M01...`。APS 额外需要的人员以"每台机器一个通用人员"建模，采用连续可用日历；不补造
  工装、物料、技能、班次或交期约束。导入后的标准基准以 makespan 为目标，不能把该映射称为
  对原始基准的完整等价复刻。当前浏览器档位单个实例最多 600 道工序；PlanProblem JSON 超出实际引擎能力上限时可查看但不能运行。
- **自有数据**：也可以导入自己的 `PlanProblem` JSON（单文件最多 2 MiB；最近 5 个实例仅保存在
  浏览器内存与 `localStorage`，**不上传**）。标准集合中超出最近 5 个的实例仅在当前页面会话有效。
- **参数**：种子、求解时间预算、优化目标（lexicographic / makespan）、搜索规则
  （auto / priority-edd / wspt / spt / min-end / most-slack / random）、迭代上限、是否局部修复，
  以及严格核验开关；另有 4 个预设档位（快速 / 标准 / 深入 / 无规则对照）。
- **结果**：订单甘特图（按技能着色、交期虚线、可缩放、工序可点选）、资源使用与时间线、
  指标卡（首解时间 / 总耗时 / 峰值内存 / 目标值 / 下界 / 延期订单 / 状态）、原始输出。
- **核验**：调用引擎自带的**独立校验器** `aps_verify`，显示逐条违约/错误、代码与数量；
  实验室**不在前端重新实现约束检查**，前端只做分组与呈现（结论与 CLI、平台层完全一致）。
- **多次运行与对比**：每次运行都进列表；可任选两次比较"变更工序数 / 目标值 / 耗时 / 内存"，
  并显示方案指纹（同参数两次运行指纹相同 = 同一方案，体现引擎确定性）。
- **中断**：求解在 Worker 内**同步**执行，所以"取消"= 终止 Worker；界面上点"取消立即生效"，
  下次运行自动重建 Worker（不需要刷新页面）。

MAPF 与 AGV 模块同样遵循"引擎唯一真相"：结果、指标、核验都取自对应引擎，
前端只做投影与呈现（MAPF：地图编辑 / 时空回放 / 动态事件 / 运行对比；AGV：任务相位 / 工作站容量 / 动态重调度汇总）。

### 引擎版本可见性

顶部状态条显示**当前使用的引擎版本**，并且要求两处一致才显示"✓"：

1. 构建期清单 `engine-manifest.json`（含 wasm 大小与 sha256、来源标签 `source:` / `release:`）；
2. 运行时 `aps_capabilities()` 返回的版本（直接读 wasm 内嵌的 `CARGO_PKG_VERSION`）。

不一致会显式告警（例如手工替换了 wasm 却忘了重新生成清单）。

## 6. 构建与部署（全自动）

```
GitHub Actions: lab.yml + lab-visual-acceptance.yml
  push（main / arena/**）或 PR（lab/**、*/rust/web/**、*/mock/** …，且工作流自带 paths 过滤）
    → changes：对本次推送/PR 做 git diff，判定 aps / mapf / agv / warehouse / lab 谁变了
    → 只对"变了"的引擎跑 Rust 质量门（main 与 arena/** 由 lab.yml 统一触发，
      其它分支由 *-rust.yml 兜底，避免同一套门跑两遍）
    → 没变的引擎：本地构建一次产物（wasm + CLI，走 cargo 缓存），不重复跑测试
    → npm ci → sync（自检）→ build（tsc + vite）        # runner 使用 Node 24
    → npm run test:post-build（静态检查 + 全部 Lab 检查 + Pages 仿真）
    → 仅 main / 手动触发：上传 `lab-preview`（14 天）→ 独立 Ubuntu Playwright job
      消费同一份 dist，真实 WebGL + 引擎运行检查，上传视觉 Artifact（30 天）
    → 与配置/产物相关的改动落到 main（或手动 deploy=on）时：部署到 GitHub Pages
```

迭代优先：PR 与迭代分支不跑真实浏览器验收（它最贵），需要时手动触发 `lab.yml`；
所有 job 都有 `timeout-minutes` 上限（引擎质量门 20 分钟），避免挂死占用 runner。工作流本身的约定由
`npm run check:workflows` 断言（Node 24 版 action、触发范围收敛、超时）。

**CI 只验通过性，负荷与真实视觉验收在本机跑。** GitHub 托管 runner 约 4 vCPU / 8 GB，
所以 CI 里只做：编译 / 格式 / clippy / 单元与集成测试 / 契约符合性 / WASM ABI 冒烟 / Lab 打包与
纯 Node 检查（`npm run test:post-build`）。下面这些属于重活，请在本机执行（命令与逐项检查清单见
根 [README「本地重型验证」](../README.md#本地重型验证ci-不跑请在本机跑)）：

| 重活 | 命令 | CI 里的替代（轻） |
| --- | --- | --- |
| 仓储 86 场景按族验收 + 全量基准 | `bash warehouse/rust/scripts/verify_heavy.sh [--with-bench]` | 不跑（负荷验证） |
| 真实浏览器视觉验收（Playwright） | `cd lab && npx playwright install --with-deps chromium && npm run test:visual` | CI 里**默认不跑**（main 也一样），只在手动 `-f visual=on` 时运行；只覆盖 APS/MAPF/AGV；失败时原因会打成 `::error::` 注解 |
| 新增两个仓储模块的视觉确认 | 浏览器打开 `#slotting` / `#dense-asrs` / `#art-lab` 按清单核对 | 不跑（见根 README 的检查清单） |
| Lab 全量前端检查 | `cd lab && npm run test:all`（= build + test:post-build） | 同一份 `test:post-build` 会在 CI 跑 |

手动触发的输入（`lab.yml`，都在 Actions → Algorithm Lab → Run workflow）：

| 输入 | 取值 | 说明 |
| --- | --- | --- |
| `engines` | `auto` / `all` / `none` / 单个引擎名 | 质量门跑哪些；`auto` 用 git diff 检测，也可以只跑一个引擎 |
| `lab` | `auto` / `on` / `off` | 是否构建并测试 Lab（`auto` = 有相关改动才跑） |
| `visual` | `auto` / `on` / `off` | 真实 WebGL 验收（`auto` = 仅 main） |
| `deploy` | `auto` / `on` / `off` | `on` = 本次立刻部署一次 Pages（可只跑部署这一件事） |
| `engine_tag` | `v1.0.0` | 用某个正式 Release 的引擎产物构建 Lab |

- **子路径**：GitHub Pages 项目站点在 `https://<owner>.github.io/algorithm-delivery/`，
  因此 `vite.config.ts` 的 `base` 默认就是 `/algorithm-delivery/`，页面里所有资源
  （wasm、worker、清单、Mock 数据）都通过 `import.meta.env.BASE_URL` 解析。
  `npm run test:pages` 会在部署前把这个子路径真实跑一遍。
- **Version 对应关系**：默认每次提交都用**当次源码构建的 WASM**（实验室与源码一一对应）；
  在 Actions 里手动触发 `lab` 工作流并填 `engine_tag=v1.0.0`，则会从该正式 Release
  下载 WASM 产物再部署，此时实验室展示的就是那个版本的引擎。
- **正式 Release**：由 `release.yml` 在 `v*` 标签上触发，产出 Linux x86-64 / Linux ARM64 /
  macOS ARM64 / WebAssembly 四个平台产物 + `SHA256SUMS` + 版本信息；任一平台构建失败则
  **不发布**（publish job 依赖全部构建成功）。

## 7. 新增一个算法模块

各算法**保留自己的问题结构、计算引擎与可视化**，不强行统一到同一数学模型。
接入只需要三步：

```ts
// 1) src/modules/<id>/index.ts —— 自带面板（props 由模块自己定义）
export const myModule: AlgorithmModule = {
  id: 'path-planning',
  name: '路径规划',
  tagline: '栅格/路网上的最短路径与避障',
  category: '运动规划',
  status: 'ready',            // 或 'planned'（只在首页显示路线图，不渲染假数据）
  problemKind: '你的数据结构（JSON schema 路径）',
  engine: '你的引擎（WASM / 纯 TS）',
  Panel: MyPanel,             // React 组件
};

// 2) src/modules/index.ts —— 注册（重复 id 会直接报错）
registerModule(myModule);

// 3) 需要 WASM 时：在 scripts/sync-engine.mjs 里把你自己的产物加进同步清单，
//    并用 `import.meta.env.BASE_URL` 拼 URL 加载（保证子路径部署可用）。
```

约定（来自需求与本次设计）：

- 模块之间不共享问题模型，只共享"外壳"（导航、引擎版本条、错误边界）与**美术语言**（`src/art`）；
- 不渲染占位假数据：未实现的算法就标 `planned`；
- 计算优先放在 WebAssembly/Worker 内，保证页面不卡、无需常驻服务器；
- 结果与指标以引擎输出为准，前端不重算目标值/约束（避免"两个真相"）；
- 要上三维舞台时，用 `components/sandbox` 的原语与 `src/art` 的模式，不要自己写一套灯光与材质。

## 8. 排障

| 现象 | 原因与处理 |
| --- | --- |
| 顶部状态条红色"引擎加载失败" | 多为 `dist/` 或 `public/` 缺文件：重新 `npm run sync`；若提示 404 且部署在子路径，检查 `LAB_BASE` |
| 顶部长期黄色"正在加载" | manifest / wasm 请求有 12 秒超时，Worker 握手有 8 秒超时；超时后会转为可重试错误。内置案例与数据选择不依赖引擎加载 |
| 状态条显示"⚠ 与构建期不一致" | wasm 被替换过但清单没重生成：重新 `npm run sync` |
| 页面提示"该产物不支持在线核验" | 用的是旧 WASM（缺少 `aps_verify` 等分析类导出）：`cd aps/rust && bash scripts/build_wasm.sh` |
| 三维实验室里模型缺失 / 报 404 | `public/models/` 未生成：`npm run sync:assets`；若报清单不一致，用 `npm run sync:assets -- --check` 定位 |
| 三维场景偏亮 / 偏暗 / 透明过度 | 顶栏视觉模式（A/B/C）与"透明厂房 / 泛光"开关优先；再调面板里的建筑层与外壳透明倍率。模式 A 恒为原貌，用户设置不会破坏它的语义 |
| 求解按钮一直转，取消后恢复 | 正常：求解是同步的（Worker 内），取消靠终止 Worker；这是**设计行为**，见 `aps/rust/docs/INTEGRATION.md` |
| `npm run test:pages` 失败并报 404 | 构建产物与 base 不匹配：用同一个 `LAB_BASE` 重新 `npm run build` |
| `npm run check:docs` 报素材链接缺失 | `design/assets/README.md` 列了磁盘上没有的 GLB（上传素材未齐）：补齐下载或重新生成清单，见 `design/README.md` |
