# Algorithm Delivery（算法交付与实验室）

本仓库用于独立管理算法模块的规格说明、接口契约、Mock 数据、验收工具与可运行演示。算法核心与主业务系统物理隔离；浏览器演示在本地运行算法，不依赖常驻业务后端。

## 这个仓库的设计思路

1. **规格先行、契约冻结**：每个算法先有 SRS，再有 JSON Schema 契约与 Mock，然后才是实现；
   `check_contracts.py` / 验收套件（S01–S08、M01–M12、A01–A16）跑在 CI 上，防止"实现偷偷改契约"。
2. **算法与业务系统物理隔离**：引擎是可以单独编译、单独验收、单独发版的 Rust 库 + CLI + WASM，
   不依赖常驻服务端；浏览器里跑的是同一份 WASM，不是"前端重写一遍算法"。
3. **一个站点、多套模型**：不对每个算法单独建演示站。各算法保留自己的问题结构与引擎，
   只共享"外壳"（导航、引擎状态条、错误边界）与**工业科技美术语言**（`lab/src/art`）。
4. **引擎是唯一真相**：指标、约束核验、路径、状态都取自引擎输出，前端不做二次计算，
   也不渲染占位假数据——没实现的算法就标"待接入"。
5. **生成物不入库**：WASM、Worker 胶水、Mock、模型副本都由 `npm run sync` 生成并有自检；
   仓库里只有单一来源（`*/rust`、`*/mock`、`lab/design/assets`）。
6. **能量化的约束都写成断言**：性能红线、透明策略、文档链接、JSX 配平都由
   `lab/scripts/*.mjs` 在 CI 里持续检查，避免"文档写一套、代码跑一套"。

## 文档地图（建议阅读顺序）

| 想了解 | 读这个 |
| --- | --- |
| 项目全貌与本地跑通 | 本文件 + [lab/README.md](lab/README.md) |
| 算法需求（规格） | [aps/APS-SRS.md](aps/APS-SRS.md)、[mapf/MAPF-SRS.md](mapf/MAPF-SRS.md)、[agv/AGV-SRS.md](agv/AGV-SRS.md)、[warehouse/WAREHOUSE-SRS.md](warehouse/WAREHOUSE-SRS.md) |
| 引擎怎么用、怎么集成 | `*/rust/docs/USAGE.md`、`*/rust/docs/INTEGRATION.md`、`*/rust/docs/CONFORMANCE.md` |
| 实验室怎么接新算法 | [lab/README.md §7](lab/README.md) |
| 常用命令（该跑什么） | 根目录 `make help` |
| 三维美术方向与落地记录 | [lab/design/README.md](lab/design/README.md)（索引）→ 方向 / 蓝图 / 落地台账 |
| 视觉验收现状（哪些结论没拿到） | [lab/design/VISUAL-ACCEPTANCE.md](lab/design/VISUAL-ACCEPTANCE.md) |
| 素材从哪来、许可如何 | [lab/design/assets/ASSET-REGISTER.md](lab/design/assets/ASSET-REGISTER.md) |

## 模块

### APS 高级计划与排程引擎

- 需求说明：[APS-SRS.md](aps/APS-SRS.md)
- 契约与 Mock：[aps/contracts/](aps/contracts/)、[aps/mock/](aps/mock/)
- Rust 引擎（native CLI + WebAssembly）：[aps/rust/](aps/rust/)
- 引擎使用手册：[USAGE.md](aps/rust/docs/USAGE.md)；需求追溯：[CONFORMANCE.md](aps/rust/docs/CONFORMANCE.md)

### MAPF 多机器人路径规划引擎

- 需求说明：[MAPF-SRS.md](mapf/MAPF-SRS.md)；可视化设计（M0）：[M0-VISUAL-LAB-DESIGN.md](mapf/M0-VISUAL-LAB-DESIGN.md)
- 契约与 Mock：[mapf/contracts/](mapf/contracts/)、[mapf/mock/](mapf/mock/)、基准数据 [mapf/bench/](mapf/bench/)
- Rust 引擎（native CLI + WebAssembly）：[mapf/rust/](mapf/rust/)
- 交付包说明：[mapf/README.md](mapf/README.md)

### AGV 多车调度引擎

- 需求说明：[AGV-SRS.md](agv/AGV-SRS.md)
- 契约与 Mock：[agv/contracts/](agv/contracts/)（problem/solution/verification/capabilities）、[agv/mock/](agv/mock/)（13 个固定样例）
- Rust 引擎（native CLI + WebAssembly）：[agv/rust/](agv/rust/)（复用 aps-engine 基础设施与 mapf-engine 联合路径内核，零第三方依赖）
- 交付包说明：[agv/README.md](agv/README.md)

### 仓储优化套件（库位优化 + 密集立库调度 + 联合优化）

- 需求说明：[WAREHOUSE-SRS.md](warehouse/WAREHOUSE-SRS.md)
- 契约与 Mock：[warehouse/contracts/](warehouse/contracts/)（problem/solve-result/verification/capabilities）、[warehouse/mock/](warehouse/mock/)（4 个可直接求解的问题文档）
- Rust 引擎（native CLI + WebAssembly）：[warehouse/rust/](warehouse/rust/)（零第三方依赖，复用 `aps/rust` 的契约无关基础设施）
- 交付与验证现状（含未完成项）：[warehouse/README.md](warehouse/README.md)、[DELIVERY.md](warehouse/rust/docs/DELIVERY.md)
- 两个实验室模块：`lab/src/modules/slotting/**`（库位优化）、`lab/src/modules/dense-asrs/**`（密集立库调度与联合优化）

### 统一算法实验室（Lab）

`lab/` 是预览、交互验证和比较各种算法的统一 Web 入口。每个算法保留自己的输入结构、计算引擎和可视化，不要求套用同一数学模型。目前 **APS 排程**、**MAPF 路径规划（Visual Lab：地图优先编辑器 + 时空回放 + 动态事件 + 运行对比）**、**AGV 调度（地图编辑 + 任务相位回放 + 工作站容量 + 动态重调度汇总）**、**库位优化（`#slotting`：热力图 + 关联簇 + 多深位剖面 + 搬迁轨迹 + 目标/对照表）**、**密集立库调度（`#dense-asrs`：设备时间线回放 + 冲突/倒垛留痕 + 联合闭环轮次 + Pareto）** 与 **三维实验室（`#art-lab`：英雄设备 / 透明厂房 / 算法观察三个实验室，模式 A 工业原貌 / B 工业科技艺术化 / C 算法观察）** 六个模块可运行（没有"待接入"模块）。

三维实验室建立在**已上传的工业模型**之上（`lab/design/assets/**` 只读，禁止覆盖），
通过 `npm run sync:assets` 同步 43 件入选模型到运行时目录；艺术化只改材质、可见性与分层透明，
不重建几何、不替换设备。三种视觉模式共用同一份几何与同一份真实算法数据。

- 实验室说明、开发与模块接入指南：[lab/README.md](lab/README.md)
- **在线预览地址（首次启用 Pages 并完成部署后）：** <https://xuciro-commits.github.io/algorithm-delivery/>
- APS 求解在浏览器 Web Worker 中通过 WASM 运行；导入的测试问题保存在当前浏览器，不会上传到服务器。

## 本地预览与完整验证

要求 Node.js 20+（CI 使用 Node 24）和 Rust 1.88（含 `wasm32-unknown-unknown` target）。受限网络环境可先运行仓库提供的工具链安装脚本，见 [Rust 使用手册](aps/rust/toolchain/setup_rust.sh)。

根目录的 `Makefile` 是“我现在该跑什么”的入口：`make help` 列出全部目标，迭代时常跑的是
`make static`（秒级：文档 + 美术契约 + 性能红线 + CI 工作流自检，不需要 Rust 与浏览器）。

```bash
# 一键构建引擎、同步演示数据、构建前端并执行实验室测试
bash lab/scripts/build-all.sh

# 本机开发预览（首次运行前需有可用的 APS WASM；上面的脚本会生成）
cd lab
LAB_BASE=/ npm run dev
```

访问 Vite 打印的本地地址。`LAB_BASE=/` 是本机根路径预览用；GitHub Pages 项目站点需要 `/algorithm-delivery/` 子路径，构建和部署流程会自动使用这个值并做 HTTP 子路径检查。

单独验证 APS 引擎：

```bash
cd aps/rust
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --release --locked
cargo test --release --test acceptance_suite -- --ignored  # S01–S08
python3 scripts/check_contracts.py
bash scripts/build_wasm.sh
node scripts/test_worker_cancel.mjs
```

单独验证仓储引擎（库位优化 / 密集立库调度 / 联合优化）：

```bash
cd warehouse/rust
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --release --locked                    # 端到端集成测试（生成→求解→独立核验→契约语义）
./target/release/warehouse acceptance --out /tmp/warehouse-acceptance.json   # 86 个标准场景
python3 scripts/check_contracts.py
bash scripts/build_wasm.sh                       # 末尾自动跑 ABI 冒烟（三域求解 + 对抗样例）
```

单独验证 MAPF 引擎：

```bash
cd mapf/rust
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --release --locked
./target/release/mapf acceptance          # M01–M12 一键验收
python3 scripts/check_contracts.py
bash scripts/build_wasm.sh                # 末尾自动跑 ABI 冒烟
node scripts/test_worker_cancel.mjs
```

单独验证 AGV 引擎：

```bash
cd agv/rust
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --release --locked
./target/release/agv acceptance           # A01–A16 一键验收
./target/release/agv bench                # B01–B03 基准
python3 scripts/check_contracts.py        # 45 项契约符合性（schema 防漂移 + verify 报告 + 对抗样例）
bash scripts/build_wasm.sh                # 末尾自动跑 ABI 冒烟
node scripts/test_worker_cancel.mjs
```

### 本地重型验证（CI 不跑，请在本机跑）

GitHub 托管 runner 只比开发沙箱大一点点（约 4 vCPU / 8 GB），所以 **CI 只验“通过性”**：
编译、格式、静态检查（clippy `-D warnings`）、单元与集成测试、契约符合性、WASM ABI 冒烟
——用例都是 tiny/small 档，几分钟出结论。**“负荷 / 规模”验证与真实浏览器视觉验收一律在本地跑**
（下面的命令可以直接交给本机 AI 执行）：

```bash
# 仓储：86 个标准场景按族验收 + 契约符合性
#   实测（2 vCPU 沙箱）：slotting 族 ≈8 s、event 族 ≈1 s、joint 族 ≈68 s；
#   dispatch 族与 stress 族（X01/X02 = 150k SKU / 1.9M 库位）文档大、求解需要 ≥8 GB 内存，
#   沙箱跑不完，请在本机跑（36 GB 足够）。生成侧已优化：X01 出题 13 s / 344.9 MB（原先十几分钟还不结束）。
bash warehouse/rust/scripts/verify_heavy.sh
# 再加全量基准（10 个 case，native 档；含 slotting-large / asrs-large / joint-medium，数分钟）
bash warehouse/rust/scripts/verify_heavy.sh --with-bench
# 只补某一族（例如需求 §8 的压力档 X01/X02 = 150k SKU / 1.9M 库位）
FAMILIES=stress bash warehouse/rust/scripts/verify_heavy.sh

# 仓储：Rust 单元 / 集成 / 文档测试（CI 里跑的是同一条命令）
cd warehouse/rust && cargo test --release --locked

# 实验室：构建 + 全量前端检查（类型检查、渲染冒烟、场景投影、Pages 子路径仿真）
# 与 CI 的 build-lab 是同一条命令（CI 也会跑），本机再跑一遍是为了留一份本地基线
cd lab && npm ci && npm run test:all

# 实验室：真实浏览器视觉验收（Playwright Chromium，最贵的一步；只覆盖 APS/MAPF/AGV 三个面板）
cd lab && npx playwright install --with-deps chromium && npm run test:visual
```

两个新增仓储模块（`#slotting` 库位优化、`#dense-asrs` 密集立库调度）**不在 Playwright 视觉脚本里**，
请在本地浏览器按下面的清单人工确认（也可以截图 + 控制台日志交给本机 AI 判读）：

| 检查点 | 期望 |
| --- | --- |
| `#slotting` 初屏 | 立体货架与深位剖面按工业比例、材质与光照渲染；空态不报错、不白屏 |
| `#slotting` 跑一次求解 | 热力图 / 关联簇 / 落位 / 搬迁四个图层可开关；颜色与位置全部来自引擎输出（`heat`、`clusters`、`assignment`），前端不重算 |
| `#slotting` 时间轴与运行对比 | 多次运行进入历史，diff 行标出更好 / 更差；数值与参数区的引擎指标一致 |
| `#dense-asrs` 初屏 | 巷道 / 提升机 / 桁架 / 输送线按工业比例排布，设备与深位库位可见 |
| `#dense-asrs` 跑一次求解 | 设备时间线可回放（1×–8×）、任务轨迹按 `tasks[].devices` 点亮、冲突与倒垛留痕成对出现 |
| 联合（J 场景） | 轮次与 Pareto 图来自引擎真实评估；核验面板默认展开两段独立重算的数字 |
| 美术模式 | `#art-lab` 的模式 A（工业原貌）/ B（工业科技艺术化）/ C（算法观察）对两个新模块同样生效，切换不丢数据 |

> CI 的 `lab-visual-acceptance.yml`（Playwright）只覆盖原有的 APS / MAPF / AGV 三个面板，
> 且默认只在 `main` 与手动触发时运行；分支与 PR 不跑浏览器验收。

实验室静态检查（不需要 Rust、不需要浏览器，受限环境也能跑；含三维美术契约、性能红线、文档一致性）：

```bash
cd lab
npm run test:static
```

实验室前端全量测试（场景内核 / 回放时钟 / 运行历史 / AGV 集成 / AGV 动态 / APS 产线映射 / 渲染 / 产物 / Pages 子路径）：

```bash
cd lab
npm run test:all
```

### 每次新增 Lab 后如何上线

1. 按 [lab/README.md §5](lab/README.md#5-新增一个算法模块) 添加模块，并提交改动。
2. 发起 Pull Request：GitHub Actions 会构建并执行质量检查，但**不会**把 PR 预览发布到正式站点。
3. PR 合并到 `main` 后，`lab.yml` 自动构建并部署 GitHub Pages —— 而且**只跑改动到的那一段**：
   质量门先做一次改动检测，只有改动过的引擎才重跑格式化/Clippy/验收；没改动的引擎只做一次
   （带缓存的）产物构建，供 Lab 打包使用。因此新增 Lab 或只改一个引擎时，不必再等四个引擎全跑一遍。
4. 也可以手动按需跑：仓库 **Actions → Algorithm Lab → Run workflow**，用输入项自由组合，例如
   `engines=warehouse` 只跑仓储质量门、`lab=on` 只构建与测试 Lab、`visual=on` 强制跑真实 WebGL
   验收、`deploy=on` 只做一次 Pages 部署（可以不跑质量门）；需要时再填 `engine_tag` 指定正式引擎版本。
   单个引擎的质量门也可以直接在 **Actions → aps-rust / mapf-rust / agv-rust / warehouse-rust → Run workflow** 里独立触发。

构建链路包括 APS Rust/WASM 质量门、Node 依赖安装、引擎与 Mock 同步、版本/哈希/产物自检、前端构建、实验室测试、Pages 子路径 HTTP 仿真，全部成功后才部署。Pull Request 的构建产物是保留 14 天的临时 Artifact；它不是正式 Release，也不会自动部署。

### 首次启用 Pages（只需设置一次）

在 GitHub 仓库打开 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**。之后合并到 `main` 即自动部署，无需手动上传 `dist/`，也不需要配置个人令牌或新增 Secrets。工作流使用受限的 `GITHUB_TOKEN` 权限发布页面。

站点地址为 <https://xuciro-commits.github.io/algorithm-delivery/>。Pages 的项目站点位于 `/algorithm-delivery/` 子路径；Vite 的 `base`、WASM、Worker、清单和 Mock 资源都按该路径构建，并在部署前由 `npm run test:pages` 验证。

> 如果刚合并首次配置后页面尚未出现，请先确认 Pages 的 Source 已设为 **GitHub Actions**，再到 **Actions** 查看 `lab.yml` 是否完成；只有构建、测试和部署都成功后站点才会更新。

## CI 工作流

设计原则是**改了哪里跑哪里、部署按需跑**：

1. **触发收敛**：每个工作流的 `push` / `pull_request` 都带 `paths`，无关改动不会启动。
2. **模块级分流**：`lab.yml` 先跑一个 `changes` job（对推送/PR 做真实 `git diff`，手动触发时
   也可用 `engines` 输入直接指定），只有改动过的引擎才跑质量门；没改动的引擎只做一次带缓存的
   产物构建（wasm + CLI），让 Lab 仍能完整打包——不重复跑测试与验收。
3. **部署按需**：Pages 部署只在"与配置/产物相关的改动"落到 `main` 时触发（`lab.yml` 本身就带
   路径过滤），也可以在 **Actions → Algorithm Lab → Run workflow** 里用 `deploy=on` 单独跑一次部署。
4. **手动可拆**：所有主链路工作流都支持 `workflow_dispatch`，可以只跑一个引擎的质量门、只构建
   Lab、只跑视觉验收或只做发布；`release.yml` 还支持 `dry_run=yes` 干跑与 `engines=` 只构建单引擎。
5. **只做通过性、不做负荷**：CI 里的用例都是 tiny/small 档（编译 / 格式 / clippy `-D warnings` /
   单元与集成测试 / 契约符合性 / WASM ABI 冒烟），几分钟内出结论。**86 个标准场景按族验收、
   全量基准、真实浏览器视觉验收属于负荷与视觉验证，只在本地跑**（命令见上一节
   “本地重型验证”）。四个引擎质量门因此都把 `timeout-minutes` 收到 20。
6. **失败可读**：四个质量门的 clippy 步骤失败时会附加一条 `::error::` 注释（短格式诊断、截断 20 KB），
   Actions 汇总页与 PR 上直接可见，不必再下载整份日志。

所有 job 都设了 `timeout-minutes`；真实浏览器视觉验收是**最贵的一步，CI 里默认不跑**（main 也是只构建 + 按需部署），
要跑就手动 `-f visual=on`（失败时原因会打成 `::error::` 注解，见下），本地跑同一份命令更快：
action 全部使用支持 Node 24 的版本。

- [aps-rust.yml](.github/workflows/aps-rust.yml)、[mapf-rust.yml](.github/workflows/mapf-rust.yml)、[agv-rust.yml](.github/workflows/agv-rust.yml)：**非 main / 非 arena 分支**上的兜底质量门（main 与 PR 已由 lab.yml 覆盖）。
- [aps-quality.yml](.github/workflows/aps-quality.yml)：格式、Clippy、Rust 测试、S01–S08、契约、WASM 与 Worker 取消回归。
- [mapf-rust.yml](.github/workflows/mapf-rust.yml)：MAPF 代码变更时运行可复用 Rust 质量门。
- [mapf-quality.yml](.github/workflows/mapf-quality.yml)：格式、Clippy、Rust 测试、M01–M12 验收、契约、基准快跑、WASM 与 Worker 取消回归。
- [agv-rust.yml](.github/workflows/agv-rust.yml)：AGV 代码变更时运行可复用 Rust 质量门。
- [agv-quality.yml](.github/workflows/agv-quality.yml)：格式、Clippy、Rust 测试、A01–A16 验收、45 项契约符合性、B01–B03 基准、WASM 与 Worker 取消回归。
- [warehouse-rust.yml](.github/workflows/warehouse-rust.yml)：仓储引擎代码变更时运行可复用 Rust 质量门。
- [warehouse-quality.yml](.github/workflows/warehouse-quality.yml)：格式、Clippy、release 构建、Rust 测试（含端到端集成测试）、契约符合性、三维基准冒烟（3 例）、WASM 构建与 ABI 冒烟——**只验通过性**；86 个标准场景按族验收已移出 CI，改由本地 `bash warehouse/rust/scripts/verify_heavy.sh` 执行（负荷验证：`dispatch` 族峰值约 3.2 GB）。
- [lab.yml](.github/workflows/lab.yml)：唯一主链路 —— 改动检测（只对改动过的引擎跑质量门）→ 构建/测试 Lab（Node 24）→ 按需部署 Pages。PR、迭代分支与 main 都只做构建与检查（不上传预览产物、不自动跑浏览器验收）；浏览器视觉验收只在手动 `-f visual=on` 时跑，手动触发还可单独跑某一段（`engines` / `lab` / `visual` / `deploy`）。
- [lab-visual-acceptance.yml](.github/workflows/lab-visual-acceptance.yml)：独立 Ubuntu/Playwright Chromium 视觉验收（**仅手动 `visual=on`**），消费同一次 production build，采集 APS/MAPF/AGV WebGL 截图、console 日志和实际引擎状态（30 天 Artifact，浏览器缓存复用）；失败时把日志首尾各 20 KB 打成 `::error::` 注解，原因在 Actions 页面/PR/API 上直接可读。
- [release.yml](.github/workflows/release.yml)：推送 `v*` 标签后构建正式多平台产物（APS/MAPF/AGV/Warehouse 的 CLI 与 WASM），所有目标成功后才创建 Release，并附 SHA-256 校验文件。也可手动触发：填 `tag=v1.0.0` 按该标签源码构建、`engines=warehouse` 只构建单个引擎（此时不上传 Release，避免发出不完整产物）、`dry_run=yes` 只验证构建链路。

### 创建正式 Release

先确认要发布的版本已合并到 `main`，再推送版本标签：

```bash
git checkout main
git pull --ff-only origin main
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

`release.yml` 会先跑 APS 质量门，再分别构建 Linux x86-64、Linux ARM64、macOS ARM64 与 WASM。**任何一个目标失败都不会创建 Release**；全部成功后才上传压缩包、`VERSION.txt` 和 `SHA256SUMS`。Lab 工作流手动选择 `engine_tag` 时，可使用该 Release 的 wasm 与 Linux x86-64 CLI。

更多实验室运行、数据来源、测试命令和新增算法规范见 [lab/README.md](lab/README.md)。
