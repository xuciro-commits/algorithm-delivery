# MAPF 多机器人路径规划引擎 — 交付包

面向仓储 AGV / 多机器人调度场景的 **Multi-Agent Path Finding** 求解与核验交付件：
同一份零依赖 Rust crate 产出 native CLI `mapf` 与 `wasm32-unknown-unknown` 模块
（浏览器 Web Worker 直接调用），实现 **问题契约校验**、**ECBS/CBS + 优先搜索规划**、
**独立方案核验** 三件事。所有数据均为 Mock，不代表真实场地。

## 目录

- `mock/m01…m12.json`：14 个问题样例（基础 / 交叉 / 交换 / 走廊 / 环路 / 目标占用 /
  非法输入 / 能力外 / 不可达 / 紧预算 / 拥挤瓶颈 / 动态事件 / 篡改夹具 / 撤销恢复）。
  每个文件自带 `tags.{name,description,expect}`，实验室数据卡片直接读取。
- `contracts/*.schema.json`：`mapf-problem/1.0`、`mapf-solution/1.0`、`mapf-verify/1.0`、
  `mapf-capabilities/1.0`、`mapf-bench-manifest/1.0`（JSON Schema 2020-12，
  由 `contracts/make_schemas.py` 生成；字段与 `src/problem.rs` 白名单同源）。
- `rust/`：引擎本体（`src/` 15 模块 + `tests/acceptance.rs` 验收套件）。
- `rust/web/mapf-worker.js`：手写 C ABI 胶水（Worker 协议 / 取消 = terminate + 重建）。
- `rust/scripts/`：`build_wasm.sh`（可复现 wasm 构建）、`smoke_wasm.mjs`、
  `test_worker_cancel.mjs`、`check_contracts.py`（零依赖 schema 校验 + 引擎输出对照）。
- `bench/`：Moving AI 基准数据（maps/scen 共 533 KB，含 `UPSTREAM.md` 许可与引用、
  `gen_manifest.py`、`results/bench-2026-10-03.json` 全量结果）。
- 实验室装配：`lab/scripts/sync-mapf.mjs` + `lab/src/core/mapf/*` +
  `lab/src/modules/mapf/*`（`path-planning` 槽位从“待接入”变为可运行）。

## 运行

```bash
# 引擎（需要受限网络 Rust 工具链时先跑 aps/rust/toolchain/setup_rust.sh 同款安装）
cd rust
cargo build --release && cargo test --lib          # 单元 + 契约测试 21 项
./target/release/mapf acceptance                   # M01–M12 一键验收（14 案例）
./target/release/mapf solve ../mock/m09-crowded-bottleneck.json --out /tmp/s.json
./target/release/mapf verify ../mock/m11-tampered.json /tmp/s.json

# 契约符合性（36 项检查：mock/引擎输出/capabilities/manifest/对抗样例）
python3 contracts/make_schemas.py                  # 再生成 schema（改动字段后必跑）
python3 rust/scripts/check_contracts.py

# WASM + 冒烟 + 取消语义（本地与 CI 同一入口）
bash rust/scripts/build_wasm.sh                    # 末尾自动跑 smoke_wasm.mjs
node rust/scripts/test_worker_cancel.mjs

# 基准（Moving AI，约 65 s / 132 次求解）
cd rust && ./target/release/mapf bench --manifest ../bench/manifest.json \
    --out ../bench/results/bench-latest.json

# 实验室（同步产物 → 类型检查 → 构建）
cd ../lab
node scripts/sync-mapf.mjs && npm run typecheck && npx vite build
```

## 交付状态（本分支实测）

| 检查 | 结果 |
|---|---|
| `cargo test --lib` | 21/21 ✅ |
| `mapf acceptance`（M01–M12） | **14/14 ✅**（含 24 台瓶颈与动态事件重规划） |
| `check_contracts.py` | 36/36 ✅（含 M11 篡改必拒、对抗样例必拒） |
| WASM 冒烟（浏览器产物真跑） | ✅ OPTIMAL 语义一致 / 核验 / 指纹 / 能力声明 |
| Worker 取消语义（Node） | 10/10 ✅（即时取消 0.8s，重建恢复） |
| Moving AI 基准（5 家族 × 2–128 台） | 解出 115/132 = **87.1%**，核验失败 **0**（见 `bench/results/`） |

语义口径：4 邻接栅格、同步步进、单位时间代价；冲突=顶点/边交换/目标格占用；
`OPTIMAL` 仅在界证明成立（ECBS `w>1` 时也必须 LB 追平）；一切方案输出均经独立
verifier 交叉核验（`verified` 字段），基准以 `verification_failures=0` 为硬约束。

## 边界（与 SRS 口径一致）

- 本包解决**离散栅格、单位时间步**的 MAPF 与带快照冻结前缀的动态事件重规划；
  不做连续路径平滑、不建模动作时间/装卸、不做多目标 Pareto、不提供调度层
  （任务分配请见 AGV 调度模块的规划）。
- `wasm-light` 档位限额：≤120 台机器人 / ≤16384 格 / 预算 ≤120 s（native 不限）。

## 数据许可与引用

Moving AI 基准（`bench/`）来自 movingai.com，Open Data Commons Attribution License；
引用：Stern et al., *Multi-Agent Pathfinding: Definitions, Variants, and Benchmarks*,
SoCS 2019, pp. 151–158. 详见 `bench/UPSTREAM.md`。

## 后续（PR 计划内）

- `MAPF-SRS.md`（需求说明书）与 `rust/docs/{USAGE,MODEL-MATH,CONFORMANCE,INTEGRATION,BENCHMARKS,ERROR-CODES,CAPABILITIES}.md`；
- `mapf acceptance --report` 机器可读产物 + `mapf.yml`（CI：fmt/clippy/test/wasm/契约/基准快跑）。
