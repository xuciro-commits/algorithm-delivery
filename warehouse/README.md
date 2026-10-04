# Warehouse Optimization Suite（仓储库位优化 + 密集立库联合调度）

本目录是需求 [`WAREHOUSE-SRS.md`](WAREHOUSE-SRS.md) 的交付实现：**同一份 Rust 核心**同时提供

* native CLI `warehouse`（求解 / 验证 / 生成 / 验收 / 基准 / 能力声明）；
* wasm32 模块 `warehouse_engine.wasm`（浏览器 Web Worker 内求解，与 CLI 同一份源码）；
* 实验室两个算法模块（`#slotting` 库位优化、`#dense-asrs` 密集立库），全部由引擎真实输出驱动。

```
warehouse/
├── WAREHOUSE-SRS.md          需求规格（本目录的权威）
├── rust/                     Rust 核心（lib + bin + wasm ABI + 脚本 + 文档）
│   ├── src/{slotting,asrs,joint,wh,verify,...}
│   ├── contracts/ ->  见 ../contracts
│   ├── scripts/{build_wasm.sh,smoke_wasm.mjs,check_contracts.py}
│   ├── web/warehouse-worker.js
│   └── docs/{USAGE,INTEGRATION,CONFORMANCE,MODEL-MATH,DEPENDENCIES,BENCHMARKS,DELIVERY}.md
├── contracts/*.schema.json   JSON 契约（draft-07，由 make_schemas.py 生成）
└── mock/*.json               可直接求解的问题文档（供冒烟 / 契约 / 实验室）
```

## 快速开始

```bash
# 1) 工具链（沙箱/受限网络：npm @rustbin 路线；官方 rustup 也可）
bash aps/rust/toolchain/setup_rust.sh /opt/rust 1.88.0 1
export PATH=/opt/rust/bin:$PATH

# 2) 构建（约 1 分钟；零第三方依赖，只有仓库内 aps-engine 路径依赖）
cd warehouse/rust && cargo build --release

# 3) 跑一个场景（结果写文件，stdout 保持纯 JSON）
./target/release/warehouse generate --scenario D04 --scale small --out /tmp/d04.json
./target/release/warehouse solve --in /tmp/d04.json --out /tmp/d04.out.json
python3 -c "import json;d=json.load(open('/tmp/d04.out.json'));print(d['status'], d['metrics']['tasksDone'], d['verification']['ok'])"

# 4) 引擎自检
./target/release/warehouse capabilities     # 档位能力与算法清单
./target/release/warehouse scenarios        # 86 个标准场景
./target/release/warehouse acceptance --ids D04 --out /tmp/acc.json
./target/release/warehouse bench            # 10 个基准用例（如实报告规模与用时）

# 5) WASM 产物 + 冒烟 + 契约
bash scripts/build_wasm.sh
python3 scripts/check_contracts.py
```

## 算法一句话

* **库位优化**：8 种基础对照策略 + ALNS/LNS/禁忌/模拟退火 + NSGA-II 多目标 + 多情景鲁棒 +
  动态再优化（受搬迁预算约束）；代价全部按真实设备运动学算。
* **密集立库调度**：任务分配/排序/无冲突路径（巷道层内互斥、井道互斥、站台与缓存容量、
  走廊会车）/交接/双指令/多深位倒垛/动态事件重调度；每步都有时空预约与阻塞留痕。
* **联合优化**：库位方案 → 真实调度 → 把拥堵、等待、倒垛反馈回库位模型 → 迭代；
  输出 rounds、comparison（随机 / ABC / 联合）、pareto（真实评估的非支配点）与可复算的联合目标。

## 与仓库其它模块的关系

| 关注点 | 做法 |
| --- | --- |
| 依赖 | 只复用 `aps/rust` 的**契约无关基础设施**（JSON / SHA-256 / 时钟 / 峰值内存），与 `agv → aps`、`mapf → aps` 一致 |
| 契约 | 与 `aps/` `mapf/` `agv/` 同方法论：`contracts/*.schema.json` 由脚本生成，`check_contracts.py` 离线校验 |
| WASM | 手写 C ABI（`src/wasm_api.rs`）+ `web/warehouse-worker.js`，与既有 worker 同一约定（取消 = terminate + 重建） |
| 实验室 | 只登记两个新模块，复用外壳、3D 原语与美术语言；不做前端重算 |

## 验证现状（诚实说明）

本仓库在受限沙箱（2 vCPU / ~4 GB）中开发。下面严格区分"**已经在沙箱里跑出结论**"与
"**还没拿到结论、请在目标机器上补跑**"——没有证据的话不写在这里。

### 已经跑通（复跑命令见 `rust/docs/DELIVERY.md`）

| 项 | 结论 |
| --- | --- |
| native 构建 | `cargo build --release` 通过（2 vCPU 沙箱约 70–90 s） |
| 契约符合性 | `python3 scripts/check_contracts.py` → **51 项全过**：6 份 schema 与生成脚本零漂移、mock 逐条校验、引擎输出符合 `warehouse-solve-result`、`verification.ok=true`、篡改方案必须报出具体违规、坏输入必须 `INVALID_INPUT` |
| WASM | `bash scripts/build_wasm.sh` 通过：库位 `FEASIBLE` ≈110 ms、立库 `FEASIBLE` ≈80 ms、联合 `FEASIBLE_WITH_BOUND` ≈3.7 s，三域独立核验 `ok=true`；篡改时间线被拒；坏输入 → `INVALID_INPUT`；`createEngine(dist/warehouse_engine.wasm)` 读出 `version="rust-warehouse/1.0.0"`、`abiVersion=1` |
| 场景验收（逐场景） | `D01–D24` 全部 rc=0（`D16` 6 000 任务 3.2 s；`D17` 20 000 任务约 58 s，峰值内存 ≈3.2 GB）、`E01–E14` 全过、`J01–J12` 全过（含 `J09` 的 Pareto 判据）、`X12` 对抗验证 |
| 代码格式与语法 | `cargo fmt --check` 干净（最终一轮做了全量格式化）：rustfmt 能逐个文件解析，等价于一次全仓语法检查 |
| 基准 | `bench --tier wasm-light` 三个域各一例，`verificationOk=true`（`slotting-small` 21 ms / `asrs-small` 17 ms / `joint-small` 2.7 s） |

### 还没拿到结论（请在目标机器上补跑，命令照抄即可）

| 项 | 命令 | 说明 |
| --- | --- | --- |
| 全量 86 场景一次连续运行 | `./target/release/warehouse acceptance --out /tmp/acc.json` | 沙箱 2–4 GB 内存不足（`dispatch` 族单独跑约 138 s）；建议 ≥8 GB。CI 里改按族跑（见 `warehouse-quality.yml`） |
| Rust 测试（含端到端集成测试） | `cargo test --release --locked` | 本轮新增 `tests/engine_pipeline.rs`（生成 → 求解 → 独立核验 → 契约语义 → 不支持取值必须 `UNSUPPORTED`），沙箱未执行 |
| 实验室前端 | `cd lab && npm ci && npm run sync && npm run build && npm run test:render` | 两个新模块的代码已完成，未经构建/渲染验证 |
| 浏览器视觉验收 | `lab/scripts/visual-acceptance.mjs` | 只覆盖 APS/MAPF/AGV 三个面板的 Playwright 场景，仓储两个模块尚未纳入 |
| 静态检查（clippy） | `cargo clippy --all-targets --locked -- -D warnings` | 需要完整编译，沙箱预算不足；`cargo fmt --check` 已干净，但 clippy 结论未拿到 |
| 压力档 `X01` / `X02` | `./target/release/warehouse acceptance --ids X01,X02 --out /tmp/x.json` | 最终一轮把这两例对齐到需求 §8 的 150k SKU / 1.9M 库位压力档（占用率 55%）：规模、用时与内存都要在目标机器上实测（建议 ≥8 GB） |

最终一轮只写了代码与文档，**没有在沙箱里重新编译**：`cargo fmt --check` 干净（= 无语法错误），
但编译期错误、clippy 结论、压力档的实测数据都还没有——请在目标机器上按上面的命令补齐，
`rust/docs/DELIVERY.md` §6 列出了这一轮到底改了什么。

细节与"怎么复跑"见 [`rust/docs/DELIVERY.md`](rust/docs/DELIVERY.md)。
