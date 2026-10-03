# 算法实验室（Algorithm Lab）

> Algorithm Delivery 项目的**统一算法实验 / 可视化 / 性能评测入口**。
> 所有算法（APS，以及后续的路径规划、AGV 调度、库位优化、密集立库）都进这一个站点，
> **不为单个算法单独建演示网站**。

计算全部在浏览器内通过 WebAssembly 完成：不需要安装软件，也不依赖任何常驻服务端。

```
lab/
├── index.html                  入口页（单页应用）
├── src/
│   ├── core/                   与界面无关的核心：契约类型、模块注册表、纯逻辑（可被 Node 测试直接跑）
│   │   ├── types.ts            契约形状 + AlgorithmModule 模块接口
│   │   ├── registry.ts         模块注册表（重复 id 直接报错）
│   │   └── aps/                APS 专属逻辑：参数模型、运行记录、可视化转换、引擎适配、React 钩子
│   ├── components/             通用可视化：甘特图、指标卡、资源面板、核验面板、运行对比
│   ├── modules/                各算法模块（自带的引擎适配 + 可视化）
│   │   ├── aps/                第一阶段：APS 计划排程
│   │   └── index.ts            注册表装配
│   └── vendor/                 **自动生成**（勿手改）：aps-worker.js 的副本
├── public/                     **自动生成**：wasm、worker、engine-manifest.json、mock/基准数据
└── scripts/                    同步、构建校验、冒烟、Pages 子路径仿真
```

## 1. 快速开始

```bash
cd lab
npm install
npm run dev          # http://localhost:5173/ （默认 base=/algorithm-delivery/，见下方说明）
```

本地开发建议用根路径，避免每次都要输子路径：

```bash
LAB_BASE=/ npm run dev
```

一条命令跑完 CI 的完整链路（wasm 构建 → 同步 → 构建 → 全部测试 → Pages 仿真）：

```bash
npm run build:all            # 需要 aps/rust 的 Rust 工具链（见 aps/rust/toolchain/setup_rust.sh）
LAB_BASE=/ npm run build:all # 本地根路径版本
```

### 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` / `npm run preview` | 开发服务器 / 预览构建产物（都会先自动 `sync`） |
| `npm run sync` | 把 `aps/rust/dist/aps_engine.wasm`、`web/aps-worker.js`、`aps/mock/*.json` 同步进实验室，生成 `engine-manifest.json` |
| `npm run build` | 类型检查（tsc）+ 打包（vite） |
| `npm run test:core` | 核心冒烟：加载真实 WASM 求解，并断言实验室纯逻辑（30+ 项） |
| `npm run test:runner` | 运行器生命周期：取消（终止 Worker）→ 自动重建 → 再求解；`dispose()` |
| `npm run test:render` | 渲染冒烟：外壳/参数区/待接入模块/空态（SSR，无需浏览器） |
| `npm run test:dist` | 构建产物校验：子路径资源引用、清单 sha256 与产物一致、体积 |
| `npm run test:pages` | **Pages 子路径仿真**：把 dist 挂到 `/algorithm-delivery/` 下用真实 HTTP 跑一遍 |
| `npm run test:all` | 以上全部 |

## 2. 数据来源与“单一来源”原则

实验室**不维护任何引擎或数据的副本**。所有输入由 `scripts/sync-engine.mjs` 自动同步：

| 输入 | 来源 | 去向 |
| --- | --- | --- |
| WASM 产物 | `aps/rust/dist/aps_engine.wasm`（`scripts/build_wasm.sh` 构建，或 CI 里从正式 Release 下载） | `public/wasm/aps_engine.wasm` |
| JS 胶水 | `aps/rust/web/aps-worker.js` | `public/wasm/aps-worker.js` + `src/vendor/aps-worker.js` |
| Mock 场景 | `aps/mock/*.json` | `public/mock/` |
| 规模/竞争型基准 | `aps benchmark` CLI 现场生成（`LAB_BENCH_SIZES=240,c48,c96`） | `public/mock/bench-*.json` |
| 引擎版本/摘要 | 构建 CLI 的 `aps capabilities` 与产物自身 | `public/engine-manifest.json` |

同步时做**产物自检**：wasm 魔数、体积、清单 sha256、`aps_version()` 与元数据版本一致、
baseline 能解出 24 道工序、分析类导出可用。任何一项不满足就直接失败——**不会把坏产物发到 Pages**。

`public/wasm/`、`public/mock/`、`src/vendor/`、`engine-manifest.json` 都在 `.gitignore` 里，
因为它们是生成物；真正的来源只有一个：`aps/rust` 与 `aps/mock`。

## 3. 在实验室里做什么（APS 模块）

- **数据**：内置 Mock（基础车间 / 设备故障 / 到货延迟 / 无解场景）+ 规模与竞争型基准；
  也可以导入自己的 `PlanProblem` JSON（仅保存在浏览器内存与 `localStorage`，**不上传**）。
- **参数**：种子、求解时间预算、优化目标（lexicographic / makespan）、搜索规则
  （auto / priority-edd / wspt / spt / min-end / most-slack / random）、迭代上限、是否局部修复、
  以及严格核验开关；另有 4 个预设档位（快速 / 标准 / 深入 / 无规则对照）。
- **结果**：订单甘特图（按技能着色、交期虚线、可缩放、工序可点选）、资源使用与时间线、
  指标卡（首解时间 / 总耗时 / 峰值内存 / 目标值 / 下界 / 延期订单 / 状态）、原始输出。
- **核验**：调用引擎自带的**独立校验器** `aps_verify`，显示逐条违约/错误、代码与数量；
  实验室**不在前端重新实现约束检查**，前端只做分组与呈现（结论与 CLI、平台层完全一致）。
- **多次运行与对比**：每次运行都进列表；可任选两次比较“变更工序数 / 目标值 / 耗时 / 内存”，
  并显示方案指纹（同参数两次运行指纹相同 = 同一方案，体现引擎确定性）。
- **中断**：求解在 Worker 内**同步**执行，所以“取消”= 终止 Worker；界面上点“取消立即生效”，
  下次运行自动重建 Worker（不需要刷新页面）。

### 引擎版本可见性

顶部状态条显示**当前使用的引擎版本**，并且要求两处一致才显示“✓”：

1. 构建期清单 `engine-manifest.json`（含 wasm 大小与 sha256、来源标签 `source:` / `release:`）；
2. 运行时 `aps_capabilities()` 返回的版本（直接读 wasm 内嵌的 `CARGO_PKG_VERSION`）。

不一致会显式告警（例如手工替换了 wasm 却忘了重新生成清单）。

## 4. 构建与部署（全自动）

```
GitHub Actions: lab.yml
  push/PR（lab/**、aps/rust/web/**、aps/mock/** …）
    → 构建 WASM（或下载指定 Release 的产物）
    → npm ci → sync（自检）→ build（tsc + vite）
    → test:core / test:runner / test:dist / test:pages
    → 上传 **CI 临时 Artifact**（14 天）
    → push 到 main 时：部署到 GitHub Pages
```

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

## 5. 新增一个算法模块

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

- 模块之间不共享问题模型，只共享“外壳”（导航、引擎版本条、错误边界）；
- 不渲染占位假数据：未实现的算法就标 `planned`；
- 计算优先放在 WebAssembly/Worker 内，保证页面不卡、无需常驻服务器；
- 结果与指标以引擎输出为准，前端不重算目标值/约束（避免“两个真相”）。

## 6. 排障

| 现象 | 原因与处理 |
| --- | --- |
| 顶部状态条红色“引擎加载失败” | 多为 `dist/` 或 `public/` 缺文件：重新 `npm run sync`；若提示 404 且部署在子路径，检查 `LAB_BASE` |
| 状态条显示“⚠ 与构建期不一致” | wasm 被替换过但清单没重生成：重新 `npm run sync` |
| 页面提示“该产物不支持在线核验” | 用的是旧 WASM（缺少 `aps_verify` 等分析类导出）：`cd aps/rust && bash scripts/build_wasm.sh` |
| 求解按钮一直转，取消后恢复 | 正常：求解是同步的（Worker 内），取消靠终止 Worker；这是**设计行为**，见 `aps/rust/docs/INTEGRATION.md` |
| `npm run test:pages` 失败并报 404 | 构建产物与 base 不匹配：用同一个 `LAB_BASE` 重新 `npm run build` |
