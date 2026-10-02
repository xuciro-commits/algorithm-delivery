# Algorithm Delivery (算法外包交付仓库)

本项目为独立的算法外包交付与验收仓库，用于集中管理各类独立算法模块（排程、求解、寻路、运筹优化等）的规格说明（SRS）、接口契约（Contracts）、Mock 数据集与验收测试工具。

**本项目与主业务系统物理隔离，作为纯算法交付件独立演进与版本管理。**

---

## 模块目录

### 1. [APS 高级计划与排程引擎](aps/README.md) (`aps/`)
- **需求说明书 (SRS)**：[APS-SRS.md](aps/APS-SRS.md)
  - 核心定义：`PlanProblem v1`、`PlanSolution v1`、`SolverCapabilities v1` 领域中立规划契约
  - 交付边界：React 工作台甘特图、OR-Tools CP-SAT 求解后端、Rust WASM/Native 独立校验与局部启发式
- **接口契约**：[contracts/](aps/contracts/)（JSON Schema 2020-12 与求解示例）
- **基准场景与 Mock**：[mock/](aps/mock/)（车间基准 baseline、故障、缺料、无解、稳定性等场景）
- **自动化验收与反例测试**：[tests/](aps/tests/)（结构合法性、参考可行解、7组约束破坏反例、规模压测生成器）
- **Rust 算法引擎（交付实现）**：[rust/](aps/rust/)（native CLI `aps` + WASM，零第三方依赖）
  - 使用手册：[USAGE.md](aps/rust/docs/USAGE.md)｜实测：[BENCHMARKS.md](aps/rust/docs/BENCHMARKS.md)｜需求对照：[CONFORMANCE.md](aps/rust/docs/CONFORMANCE.md)
  - 一键验收：`cd aps/rust && cargo build --release && cd .. && rust/target/release/aps accept`（覆盖 S01–S08）

---

## 快速运行与测试

进入对应模块目录运行验证脚本：

```bash
cd aps
python3 generate_mock.py
python3 contracts/make_schemas.py
python3 tests/verify_mock.py
python3 tests/generate_benchmark.py --operations 240 --out /tmp/aps-240.json
```

Rust 算法引擎（SRS §9 交付实现，native + WASM 同源）：

```bash
cd aps/rust
cargo build --release && cargo test --release     # 54 单元 + 8 集成测试
cd .. && rust/target/release/aps accept           # S01–S08 一键验收（8/8 通过）
rust/target/release/aps solve --problem mock/baseline.json --out /tmp/plan.json --time-limit-ms 2000
rust/target/release/aps verify  --problem mock/baseline.json --solution /tmp/plan.json
bash rust/scripts/build_wasm.sh                   # 产出 dist/aps_engine.wasm + Node 冒烟
```

> 受限网络（无法访问 crates.io / static.rust-lang.org）请先执行 `bash aps/rust/toolchain/setup_rust.sh`；
> 完整命令、契约字段语义、状态码与 FAQ 见 [aps/rust/docs/USAGE.md](aps/rust/docs/USAGE.md)。
