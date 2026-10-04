# 交付说明与验证现状（DEV 交接）

本文件是 `warehouse/` 交付的交接说明：**做了什么、在哪、怎么复跑、哪些结论还没拿到**。
"没拿到"的部分一律如实写在这里，不用"应该没问题"代替证据。

## 1. 交付物清单

| 交付物 | 位置 | 状态 |
| --- | --- | --- |
| 需求规格 | `warehouse/WAREHOUSE-SRS.md` | ✅ |
| Rust 核心（库位 / 立库 / 联合 / 验证 / 事件） | `warehouse/rust/src/**`（约 20k 行） | ✅ 本轮追加的改动已由 CI 重建通过（`2564dd3` 第 3 次运行第 9 步「构建（release）」success） |
| native CLI `warehouse` | `warehouse/rust/src/main.rs` | ✅ |
| wasm ABI + Worker 胶水 | `src/wasm_api.rs` + `web/warehouse-worker.js` | ✅ 沙箱内构建通过并冒烟（三域求解 + 独立核验 + 对抗样例 + 坏输入） |
| 契约 schema + 生成脚本 | `warehouse/contracts/**` | ✅ 生成一致（`make_schemas.py --check`） |
| Mock 问题文档 | `warehouse/mock/*.json`（4 份） | ✅ 由引擎自身生成，可解 |
| 脚本（构建 / 冒烟 / 契约） | `warehouse/rust/scripts/**` | ✅ `check_contracts.py` 51 项全过；`build_wasm.sh` 冒烟通过 |
| 实验室模块 | `lab/src/modules/{slotting,dense-asrs}/**` | ✅ 代码完成；本轮 `tsc --noEmit` 全仓通过、场景投影单测 `npm run test:warehouse:scenes` 20 项通过（都在本沙箱真跑过）；⏳ 未跑 `npm run build` / `test:render`（需要先 `npm run sync` 生成 vendor 产物） |
| 代码格式与语法 | `cargo fmt`（rustfmt 1.8.0 / Rust 1.88） | ✅ 全量格式化并 `cargo fmt --check` 干净；格式化器逐文件解析通过 = 无语法错误 |
| 静态检查（clippy） | `cargo clippy --all-targets -- -D warnings` | ✅ CI 实测通过（`2564dd3` 第 8 步 success）：本轮先因两处 `match { Some(v) => v, None => 默认值 }` 直通写法挂过一轮，改成 `.unwrap_or(...)` 后全绿 |
| CI 质量门 | `.github/workflows/warehouse-quality.yml` + `warehouse-rust.yml`（已接入 `lab.yml` / `release.yml`，只对改动过的引擎触发，**只验通过性**） | 🟡 部分：第 3 次运行里依赖审计 / rustfmt / clippy / release 构建 / 单元+集成+文档测试全部 success（含曾失败的那条联合核验用例）；该次运行在验收步骤被手动取消。此后**86 场景按族验收已按要求移出 CI**（负荷验证下沉到本地 `rust/scripts/verify_heavy.sh`），CI 只剩通过性门（见 §6c-3、§6c-4） |

## 2. 本沙箱内**已获得**的结论（可复现的原始命令）

> 时效说明：下面这些结论来自**本轮最终改动之前**的那次构建（源码当时能编译、命令真跑过）。
> 本节之后的 §6 所列改动（关联簇输出、倒垛图层、压力档、字段对齐、全量格式化等）**尚未编译**——
> 请先按 §3 的命令在目标机器上重建，再以那里的结果为准。

构建与自检：

```bash
export PATH=/opt/rust/bin:$PATH
cd warehouse/rust && cargo build --release        # 约 70–90 s（2 vCPU 沙箱）
./target/release/warehouse version
./target/release/warehouse capabilities
./target/release/warehouse scenarios | python3 -c "import json,sys;print(len(json.load(sys.stdin)))"   # 86
```

验收（`--ids` 逐场景，沙箱内存限制下的推荐用法）：

| 范围 | 结果 |
| --- | --- |
| `D01–D24` | 全部 rc=0；`D16`（6 000 任务）3.2 s、`D17`（20 000 任务）约 50 s（峰值内存 ≈ 3.2 GB） |
| `E01–E14` | 全部 rc=0 |
| `J01–J12` | 12/12 通过（含 `J09` 的 `pareto` 判据） |
| `S01–S24` | 抽样通过；全量一次连续运行在沙箱内会超内存（见 §3） |
| `X01–X12` | 抽样通过（`X12` 对抗验证：篡改方案 `ok=false` 且报出违规） |

专项结论：

* 倒垛：`D04`（双深位）2 次倒垛、`D05`（三深位）17 次倒垛，`derivedTasksDone == relocationTasks`，
  完成数不把派生任务算进输入任务（此前的 138 = 120 + 18 已修正）；
* 冲突：`D06`/`D15` 在把跨巷道空驶拆成"本巷道 → 走廊/竖井 → 目标巷道"多段（每段一条资源）后，
  硬 `LANE_MUTUAL_EXCLUSION` 归零，两场景从 `INTERNAL_ERROR` 转为 `FEASIBLE`；
* 规模：D17 = 20 000 任务、615 台设备全部完成，`verification.ok=true`，`includeTimeline:false` 时
  结果文件 67 MB（含时间线 112 MB）；
* 契约：`python3 scripts/check_contracts.py` → **51 项全过**（`make_schemas.py --check` 一致、
  mock 与引擎输出逐条校验、`verification.ok=true`、篡改方案必须报具体违规、缺必填/坏 JSON → `INVALID_INPUT`、
  错误路径同样符合 `warehouse-solve-result`）；
* WASM：`bash scripts/build_wasm.sh` → `✓ WASM 冒烟通过`（库位 110 ms / 立库 80 ms / 联合 3.7 s，
  三域独立核验 `ok=true`；篡改时间线被拒；坏输入 `INVALID_INPUT`；Node 无 `Worker` 全局时跳过 Worker 路径，
  浏览器侧由 `lab` 的 sync 自检覆盖）；`createEngine()` 读出 `version="rust-warehouse/1.0.0"`、`abiVersion=1`；
* 基准（wasm-light 档，三域各一例）：`slotting-small` FEASIBLE 21.4 ms / 1380 次迭代 / 3.7 MB、
  `asrs-small` FEASIBLE 16.9 ms / 120 任务、`joint-small` FEASIBLE_WITH_BOUND 2 702 ms / 9.5 MB，
  三者 `verificationOk=true`（`bench` 的核验列取自信封里的 `verification`，不再默认填 true）。

## 3. 还没拿到结论的部分（请在目标机器上补跑）

CI 只验通过性（见 §6c-4），下面这些**负荷 / 视觉**项请在目标机器上跑——
大部分已经封成一条命令（根 README「本地重型验证（CI 不跑，请在本机跑）」是同一份清单）：

| 项 | 命令 | 说明 |
| --- | --- | --- |
| 86 个标准场景（按族：`slotting / dispatch / event / joint / stress`） | `bash scripts/verify_heavy.sh` | 逐族断言 `failed == 0`，五族跑完再断言总数 86；沙箱 2–4 GB 内存不足（`dispatch` 族单独跑约 138 s 通过），建议 ≥8 GB |
| 压力档 `X01` / `X02` | `FAMILIES=stress bash scripts/verify_heavy.sh` | 需求 §8 的 **150k SKU / 1.9M 库位** 规模档（占用率 55%）：规模、耗时与内存都要在本机实测 |
| 基准 10 用例 | `bash scripts/verify_heavy.sh --with-bench` | 含 `slotting-large` / `asrs-large`（D16 级 6 000 任务）/ `joint-medium`，数分钟；沙箱只跑了三域冒烟 |
| 实验室前端 | `cd lab && npm ci && npm run build && npm run test:all` | 类型检查 / 渲染冒烟 / 场景投影 / 产物与 Pages 子路径仿真 |
| 浏览器视觉验收 | `cd lab && npx playwright install --with-deps chromium && npm run test:visual` | Playwright 只覆盖 APS/MAPF/AGV；**两个新模块（`#slotting` / `#dense-asrs`）的视觉要点在根 README 的本地检查清单里**，请在浏览器里逐条核对 |
| CI 复核 | `gh run list --branch <branch>` 或 Actions 页面 | 通过性门（编译 / clippy / 测试 / 契约 / 基准冒烟 / WASM 冒烟）已在 CI 实跑过；负荷项在 CI 里**不会**再跑 |

## 4. 已知限制（不是缺陷，是边界）

1. **内存**：20 000 任务的时间线约 4 000 万字符；`includeTimeline:false` 是批量场景的推荐设置。
   压力档（`stress`：150k SKU / 1.9M 库位，`X01`/`X02`）按需求 §8 生成**完整拓扑与派生库位**并如实报告
   规模；该档在验收里关闭信封内时间线与求解时核验，`verification` 字段写 null（不是"假装通过"）。
   真正的规模-资源结论请在目标机器上实测（本沙箱 2–4 GB 内存不足以给出结论）。
2. **时间**：`bench` 的极端档位在 2 vCPU 上需要分钟级；`budgetMs` 是软预算，超时按状态语义上报。
3. **wasm 档位**：wasm-light 上限（60k SKU / 300k 库位 / 20k 任务）由 `capabilities` 声明，
   超档返回 `UNSUPPORTED`——实验室页面据此提示，而不是静默降级。
4. **`pareto`**：是**权重网格采样 + 真实闭环评估 + 非支配筛选**，不是穷举前沿，
   `paretoNote` 里如实写明采样方式；不要对外表述为"完整 Pareto 前沿"。
5. **回放**：实验室时间线回放按引擎输出的步骤时间播放，不做插值猜测；设备位置在步骤之间线性插值，
   与 `timeline.devices[].steps[].from/to` 一致。

## 5. 工程约束（改动前请先读）

* **零第三方依赖**：只允许 `aps-engine` 路径依赖（`cargo tree` 应只有 2 个包）；
  新增依赖会破坏 SBOM 审计与 wasm 体积约束；
* **`std::time::Instant` 在 wasm32 上会 panic**：调试计时一律走 `engine::prof_now()/profile_enabled()`；
* **库位一律由拓扑推导**：不要在契约里加"库位数"字段；不要把 `derive_locations` 放进任务循环
  （D16/D17 的原始卡死根因就是它）；
* **验证器独立**：`src/verify.rs` 与 `src/asrs/verify.rs` 只读契约与时间线，不得调用求解器内部状态；
* **不要在验收里放宽断言**：`shows:` 失败说明功能缺失，先查求解器。

## 6. 最终一轮追加（本轮）

本轮只做"写完代码 + 语法级检查"，不做编译/测试（沙箱性能受限，构建与验收由目标机器执行）。
**`cargo fmt`（含全量格式化）通过 = 每个源文件都能被 rustfmt 解析，即没有语法错误；编译期错误仍未排除。**

1. **关联簇（affinity cluster）成为一等输出**：`SlottingOutcome` 新增 `cluster_of_sku`（按 SKU 索引对齐
   `Affinity.cluster_of`），信封里库位解与联合解都带 `result.clusters = {count, bySku, note}`；
   实验室的「关联簇叠加」图层直接读它（**前端不重聚类**，否则解释里的"N 个簇"会和画布不一致）。
2. **密集立库新增「倒垛/深位让位」图层**：数据来自时间线 `locationStates` 里成对出现的
   "让空 + 落位"状态迁移，按事件时刻在时间轴累积出现；没有数据就不画（不搞占位几何）。
3. **压力档 `stress`（150k SKU / 1.9M 库位）**：`X01`/`X02` 从 `extreme` 提到该档，占用率 55%；
   验收的 `scale-honesty` 判据随之绑到 SRS 数字（`X01` SKU ≥ 150 000、`X02` 库位 ≥ 1 500 000），
   避免"把规模调小再报告小数字"也能过关。
4. **`--scale` 显式校验**：未知档位报 `VALUE_RANGE`（字段路径 `scale`，列出可用档位），
   不再静默回退到 `small`。
5. **联合核验文档路由**：`verify` 对 `{kind:"joint", slotting:{…}, asrs:{…}, timeline, solution}`
   分别把两段交给各自独立验证器（`slotting_root` / `asrs_root` / `events_for`），
   任何一段不过就是整份不过，报告里分段给出重算指标。
6. **前端字段与引擎对齐**：任务轨迹的 `devices` / `steps`（不是 `deviceIds` / `stepIds`）、
   `deadline_s` 为字符串、步骤键名 `distanceM` / `delayedBy_s` / `resourceId`；
   类型定义改为按引擎输出描述（旧键名只作兼容读取），并修掉"任务标记退化成库位索引"的静默降级。
7. **画布读得懂联合解**：库位画布的落位来源改为 `result.assignment ?? result.slottingAssignment`，
   联合实例（`kind=joint`）的三维落位图层不再为空。
8. **AS/RS 的 `explanation.dispatch` 文案整理**（去掉拼接留下的多余空格），内容不变：全部取自本次推演指标。
9. **全量 `cargo fmt`**：仓库此前并非 rustfmt 干净，CI 的 `cargo fmt --check` 必然失败；
   本轮全量格式化后 `--check` 干净（约 28 个文件被重排，纯格式变更）。
10. **联合核验覆盖两段**（`verify.rs::compose_joint_verification`）：信封里的 `verification` 不再是
    "只有调度段"，而是库位段（选定最优轮后补一次独立核验）+ 调度段（求解时已核验）合成；
    两段的**重算块与独立指标块都按 `{slotting, asrs}` 给出**（求解时报告的 `checked` 块由
    `recomputed_block` / `independent_metrics_block` 归一到契约形状，含逐设备忙时与
    `busyShare`），任一段落空都不算通过，没有时间线时在 `notes` 里明说"调度段未核验"。
    `rounds[].verified` 的语义收窄为"该轮调度段是否通过核验"，且关掉核验时如实为 `false`（此前是 `!verify`，即"没验也算过"）。
11. **前端两个新图层的投影层单测**：`lab/scripts/test-warehouse-scenes.mjs`（新增 `npm run test:warehouse:scenes`，
    已并入 `test:post-build`）= 20 项断言，覆盖落位来源、关联簇过滤/配色/透传、倒垛成对配对与显示上限、
    任务轨迹设备来自 `tasks[].devices`。**纯 Node + esbuild，不需要 Rust/WASM**，本轮在沙箱内实跑通过。
12. **前端类型检查实跑通过**：`lab` 下 `tsc --noEmit`（TypeScript 5.9）退出码 0——
    修掉了 12 个此前就存在的类型错误（缺 `vendor/warehouse-worker.d.ts`、`scenarios()` 返回类型写成数组、
    `scales` 归属、`HEAT_LIFT` 未定义、未使用的导入/变量、`relocationTasks ?? null`）。
    未跑的是 `vite build`（需要 `npm run sync`）与 `test:render`。

## 6b. 前一轮的新增/变更（源码已落，沙箱内**未**重新构建验证）

沙箱的构建/测试预算耗尽后，以下改动只做到"源码 + 文档一致"，**请在目标机器上
`cargo build --release && bash scripts/build_wasm.sh && cd ../lab && npm run build` 之后再下结论**：

1. **不支持取值必须显式拒绝**（`src/asrs/mod.rs::unsupported_policy_requests`）：
   契约里带有 `conflictPolicy / allowYield / reschedulePolicy / crossLevelTransfer /
   rollingHorizon_s / simulationHorizon_s`（问题侧）与 `conflictPolicy / allowYield /
   horizonSeconds`（求解选项侧）这些策略位，引擎只实现了其中一种组合
   （`reservation` 时空预约 + 允许等待 + 动态事件先落地 + 不截断时域）。
   给出别的取值时返回 `UNSUPPORTED` 并在 `issues[]` 里指出字段路径——不静默忽略。
2. **AS/RS 结果新增 `explanation`**（`{dispatch, reasons, note}`）：三条必答问题里的
   "为什么设备按这个顺序运行"，数值全部取自本次真实推演的指标（完工、吞吐、冲突、倒垛、双指令配对、预约数）。
3. **联合优化透传两个实验室开关**：`dualCommand`（单/双指令配对）与 `includeTimeline`
   （是否产出逐步骤时间线）现在真的会传到联合内部的调度段，而不是被忽略。
4. **`bench` 的核验列改为读信封**：以前 slotting 分支直接填 `true`（等于没有闸门），
   现在从 `verification.ok` 读，缺失即判未通过。
5. **`slotting` 的核验开关在 UI 上可见**：`SlottingSolveOptions` 的默认值改为
   `verify = true`（与 `options_from_json` 的默认口径一致），关掉后需单独跑"重新核验"才可交付。
6. **契约新增端到端集成测试** `tests/engine_pipeline.rs`（生成 → 求解 → 独立核验 → 状态语义 →
   同种子复现 → 不支持取值必须 `UNSUPPORTED`），并修掉了 `lib.rs` 里那段引用已不存在 API 的文档示例
   （`cargo test` 会编译文档示例，不修会直接挂）。
7. **CI**：新增 `warehouse-quality.yml` / `warehouse-rust.yml`，并接入 `lab.yml`
   （构建 Lab 前先过仓储质量门）与 `release.yml`（发布 Warehouse CLI 与 WASM）。

## 6c. CI 首跑之后的修复（本轮）

CI 首跑 `cargo test --release --locked`：8/9 通过，`joint_verification_covers_both_halves`
在 `tests/engine_pipeline.rs:290` 失败（`recomputed.asrs = null`）。本轮按这条失败做了两件事。

### 1) 联合核验报告的键名归一（真 bug，已修）

* **根因**：调度段的核验在**求解时**就完成了，报告形状是契约 `warehouse-verification/1.0`
  的 `{ok, violations, checked}`；库位段是选定最优轮后补跑的，形状是
  `{kind, ok, violations, recomputed, independentMetrics, notes}`。
  `compose_joint_verification` 只用 `recomputed` 取值，于是调度段那一半静默变成 `null`——
  信封仍然写着 `ok = true`，前端与验收看到的却是"只有库位段有数字"。
* **修复**（`src/verify.rs`）：新增两个归一函数，只改键名、不重算、不造数——
  * `recomputed_block`：优先 `recomputed`，退到求解时报告的 `checked`；
  * `independent_metrics_block`：优先 `independentMetrics`，否则把 `checked.deviceBusySeconds`
    换算成同样的 `{deviceBusySeconds, busyShare}` 形状（`busyShare` 的分母是**验证器重放的**
    时间线长度，不是求解器的 makespan）。
  两段都取不到时仍返回 `null`——缺失要显式暴露，不许拿空对象糊过去。
* **顺带补齐数据源**（`src/asrs/mod.rs::verification_json`）：求解时报告的 `checked` 里增加
  `deviceBusySeconds`（逐设备忙时，由验证器自己重放时间线算出），这样联合报告的调度段
  也能给出 `independentMetrics`，与库位段口径一致。
* **测试加强**（`tests/engine_pipeline.rs`）：除 `recomputed.{slotting, asrs}` 外，再断言
  `independentMetrics.{slotting, asrs}` 都是对象——防止将来有人把归一逻辑删掉。

### 2) CI 改成"改了哪里跑哪里、部署按需、可手动拆开跑"

| 工作流 | 本轮改动 |
| --- | --- |
| `lab.yml` | 新增 `changes` job：对推送/PR 做 `git diff` 判定 `aps / mapf / agv / warehouse / lab` 谁变了，**只对改动过的引擎跑质量门**；没改动的引擎只做一次带缓存的产物构建（wasm + CLI），Lab 仍能完整打包。`workflow_dispatch` 新增 `engines` / `lab` / `visual` / `deploy` 输入，可以只跑任意一段（例如只做一次 Pages 部署） |
| `release.yml` | 新增 `workflow_dispatch`：`tag`（按该标签源码构建）、`engines`（只构建单个引擎，此时**不**发布 Release，避免发出不完整产物）、`dry_run`（只验证构建链路）；所有构建 job 的 `checkout` 改为按 `RELEASE_REF` 取标签 |
| `*-rust.yml`（aps/mapf/agv/warehouse） | 保留"其它分支兜底"的路径过滤，并在注释里写明可手动独立触发单个引擎的质量门 |

> 触发总原则：每个工作流的 `push` / `pull_request` 都带 `paths`；job 之间用 `changes` 的
> 输出做**模块级分流**；部署只在与配置/产物相关的改动落到 `main`（或手动 `deploy=on`）时执行。
> 工作流自身的约定仍由 `lab/scripts/check-workflows.mjs` 断言（本轮已在沙箱内实跑通过）。

四个质量门（`aps-quality.yml` / `mapf-quality.yml` / `agv-quality.yml` / `warehouse-quality.yml`）
的 clippy 步骤顺带改了失败时的可读性：以前只能把整份运行日志下载下来翻，现在失败会把
`--message-format=short` 的诊断压成一条 `::error::` 注释（`%25/%0D/%0A` 转义、截断 20 KB），
在 Actions 汇总页/PR 上直接可见；诊断本体仍然完整留在步骤输出里。

### 3) 三次运行的实际结果（CI 实跑记录，非推测）

| 运行 | 结果 | 说明 |
| --- | --- | --- |
| 第 1 次（`b420409`） | 「单元 / 集成 / 文档测试」失败 | `joint_verification_covers_both_halves` 报 `recomputed.asrs = null`；其余步骤（依赖审计 / rustfmt / clippy / release 构建）全过 |
| 第 2 次（`ec1bf79`） | 「静态检查（clippy -D warnings）」失败 | rustfmt 通过，说明新代码语法与格式没问题；clippy 挂在本轮新写的两处 `match … { Some(v) => v, None => <默认值> }` 直通写法（clippy 归为 `manual_unwrap_or` 一类），而仓库其余部分一律走 `.unwrap_or(...)` |
| 第 3 次（`2564dd3`） | 第 8 步「静态检查（clippy）」**成功** → 第 9 步「构建（release）」**成功** → 第 10 步「单元 / 集成 / 文档测试」**成功** | 上面两条修复都被 CI 实测确认：**连同那次曾经失败的联合核验用例在内，测试链路已经绿过一次**。第 11 步「86 个标准场景验收（按族运行）」在运行中被**手动取消**（GitHub 记录：`The run was canceled by @xuciro-commits.`），所以第 12–15 步（契约符合性 / 基准冒烟 / WASM 冒烟 / 产物上传）仍是「本次未跑」 |

要单独补跑某一段（`engines` 支持 `auto|all|none|aps|mapf|agv|warehouse`）：

```bash
# 只补仓储这一段（含 86 场景按族验收）：其余三个引擎与 Lab/视觉/部署都不会跑
gh workflow run lab.yml --ref <branch> -f engines=warehouse -f lab=off -f visual=off -f deploy=off
# 四个引擎全跑一遍，但不动 Lab/部署
gh workflow run lab.yml --ref <branch> -f engines=all -f lab=off -f visual=off -f deploy=off
```

第 11 步是这套门里最吃内存/时间的一段（`stress` 族按需求 §8 生成 150k SKU / 1.9M 库位，
`dispatch` 族 20k 任务，CI runner 只比开发沙箱大一点），所以按要求做了下面的职责调整。

### 4) CI 只做"通过性"，重活全部下沉到本地（本轮）

* **移出 CI**：`warehouse-quality.yml` 里的「86 个标准场景按族验收」整步删除（连同产物清单里的
  5 份 `acceptance-*.json`）。留在门里的是**通过性**用例：依赖审计、rustfmt、clippy、
  release 构建、`cargo test --release`（单元/集成/文档，用例都是 tiny 档）、契约符合性 51 项、
  基准冒烟 3 例、WASM 构建 + ABI 冒烟。
* **下沉后的入口**：新增 `warehouse/rust/scripts/verify_heavy.sh`——
  `bash scripts/verify_heavy.sh`（按族验收 + 契约）、`--with-bench`（再加 10 个基准用例）、
  `FAMILIES=stress`（只跑压力档）、`WAREHOUSE_BIN=...`（用别的二进制）。
  逐族断言 `failed == 0`；五族都跑时才断言总数 86（只跑子集不做这个断言）。
  （脚本逻辑在本沙箱用桩二进制实测过通过 / 子集 / 失败 / 参数错误四条路径。）
* **超时收紧**：四个引擎质量门 `timeout-minutes` 由 40/75 统一收到 **20**，
  release 之外的重活不会再挂住 runner。
* **失败可读性**：四个质量门的 clippy 步骤失败时把 `--message-format=short` 的诊断压成一条
  `::error::` 注释（`%25/%0D/%0A` 转义、截断 20 KB），Actions 汇总页/PR 直接可见。
* **文档同步**：根 README 新增「本地重型验证（CI 不跑，请在本机跑）」小节（含命令与
  两个新模块的视觉检查清单），`warehouse/README.md`、`lab/README.md` 与本文档 §3 对齐同一份清单。

### 5) 顺手修掉的两个 Lab 侧问题（本轮，都会卡住 CI 的 Lab 构建）

一轮静态检查把 Lab 里两处**会让 `npm run test:post-build` 直接失败**的问题找了出来：

1. **`lab/scripts/audit-perf.mjs` 第 7 条规则漏判 JSX 简写**：它只认 `active=`，把两个新模块
   （`<SandboxScene … active>`，等价于 `active={true}`）报成"没有显式传 active"。
   代码本身是合规的（简写同样是作者显式写下的），是规则的正则太窄——已改成 `\bactive\b`，
   两种写法都算显式。
2. **密集立库画布顺手做成了真正的按需渲染**：`Asrs3D` 新增 `active` prop，由
   `DenseAsrsPanel` 传 `active={clock.playing}`（与 MAPF / AGV / APS 同一约定：不播放就不常驻 GPU，
   暂停 / 拖动时间轴时仍按需重绘）。库位画布保持常驻，并在注释里写明原因——它是静态布局 +
   脉动高亮，没有回放时钟，脉动需要连续帧；组件只在模块挂载期间存在，切走即卸载。

改完在这台沙箱里实跑：`node lab/scripts/audit-perf.mjs` → ✓（扫描 136 个源文件）、
`esbuild` 解析全部 `lab/src/**/*.ts(x)` → 退出码 0、`check-workflows` / `check-docs` → ✓。
（`test-art` 需要先 `npm run sync:assets` 生成 `public/models/art-manifest.json`；沙箱没跑同步，
所以它只报这两条"缺生成物"，CI 里 sync 之后不会出现。）
