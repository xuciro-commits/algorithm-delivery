# Algorithm Delivery（算法交付与实验室）

本仓库用于独立管理算法模块的规格说明、接口契约、Mock 数据、验收工具与可运行演示。算法核心与主业务系统物理隔离；浏览器演示在本地运行算法，不依赖常驻业务后端。

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

### 统一算法实验室（Lab）

`lab/` 是预览、交互验证和比较各种算法的统一 Web 入口。每个算法保留自己的输入结构、计算引擎和可视化，不要求套用同一数学模型。目前 **APS 排程**、**MAPF 路径规划（Visual Lab：地图优先编辑器 + 时空回放 + 动态事件 + 运行对比）** 与 **AGV 调度（地图编辑 + 任务相位回放 + 工作站容量 + 动态重调度汇总）** 三个模块可运行；库位优化和密集立库会先以“待接入”标记展示，不显示虚构结果。

- 实验室说明、开发与模块接入指南：[lab/README.md](lab/README.md)
- **在线预览地址（首次启用 Pages 并完成部署后）：** <https://xuciro-commits.github.io/algorithm-delivery/>
- APS 求解在浏览器 Web Worker 中通过 WASM 运行；导入的测试问题保存在当前浏览器，不会上传到服务器。

## 本地预览与完整验证

要求 Node.js 20+ 和 Rust 1.88（含 `wasm32-unknown-unknown` target）。受限网络环境可先运行仓库提供的工具链安装脚本，见 [Rust 使用手册](aps/rust/toolchain/setup_rust.sh)。

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

实验室前端全量测试（场景内核 / 回放时钟 / 运行历史 / AGV 集成 / 渲染 / 产物 / Pages 子路径）：

```bash
cd lab
npm run test:all
```

### 每次新增 Lab 后如何上线

1. 按 [lab/README.md §5](lab/README.md#5-新增一个算法模块) 添加模块，并提交改动。
2. 发起 Pull Request：GitHub Actions 会构建并执行质量检查，但**不会**把 PR 预览发布到正式站点。
3. PR 合并到 `main` 后，`lab.yml` 自动构建并部署 GitHub Pages。对 `lab/**`、`aps/**` 或相关工作流的修改都会触发；因此新增 Lab 或更新引擎后会重新发布整个实验室。
4. 也可以在仓库 **Actions → Algorithm Lab → Run workflow** 手动运行发布工作流（选择 `main` 分支；需要时填写 `engine_tag` 指定正式引擎版本）。

构建链路包括 APS Rust/WASM 质量门、Node 依赖安装、引擎与 Mock 同步、版本/哈希/产物自检、前端构建、实验室测试、Pages 子路径 HTTP 仿真，全部成功后才部署。Pull Request 的构建产物是保留 14 天的临时 Artifact；它不是正式 Release，也不会自动部署。

### 首次启用 Pages（只需设置一次）

在 GitHub 仓库打开 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**。之后合并到 `main` 即自动部署，无需手动上传 `dist/`，也不需要配置个人令牌或新增 Secrets。工作流使用受限的 `GITHUB_TOKEN` 权限发布页面。

站点地址为 <https://xuciro-commits.github.io/algorithm-delivery/>。Pages 的项目站点位于 `/algorithm-delivery/` 子路径；Vite 的 `base`、WASM、Worker、清单和 Mock 资源都按该路径构建，并在部署前由 `npm run test:pages` 验证。

> 如果刚合并首次配置后页面尚未出现，请先确认 Pages 的 Source 已设为 **GitHub Actions**，再到 **Actions** 查看 `lab.yml` 是否完成；只有构建、测试和部署都成功后站点才会更新。

## CI 工作流

- [aps-rust.yml](.github/workflows/aps-rust.yml)：APS 代码变更时运行可复用 Rust 质量门。
- [aps-quality.yml](.github/workflows/aps-quality.yml)：格式、Clippy、Rust 测试、S01–S08、契约、WASM 与 Worker 取消回归。
- [mapf-rust.yml](.github/workflows/mapf-rust.yml)：MAPF 代码变更时运行可复用 Rust 质量门。
- [mapf-quality.yml](.github/workflows/mapf-quality.yml)：格式、Clippy、Rust 测试、M01–M12 验收、契约、基准快跑、WASM 与 Worker 取消回归。
- [agv-rust.yml](.github/workflows/agv-rust.yml)：AGV 代码变更时运行可复用 Rust 质量门。
- [agv-quality.yml](.github/workflows/agv-quality.yml)：格式、Clippy、Rust 测试、A01–A16 验收、45 项契约符合性、B01–B03 基准、WASM 与 Worker 取消回归。
- [lab.yml](.github/workflows/lab.yml)：构建/测试 Lab（含 MAPF/AGV 场景内核与集成测试）；合并到 `main` 后发布 Pages。
- [release.yml](.github/workflows/release.yml)：推送 `v*` 标签后构建正式多平台产物（APS/MAPF/AGV 的 CLI 与 WASM），所有目标成功后才创建 Release，并附 SHA-256 校验文件。

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
