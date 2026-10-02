# aps-engine — APS 排程算法引擎（Rust）

`aps-engine` 是本交付包中 **Rust 算法核心** 的实现：同一个 crate 同时产出

- **native CLI** `aps`（Linux/macOS/Windows 均可编译，无第三方依赖）；
- **wasm32-unknown-unknown 模块**（浏览器 Web Worker 直接调用，无 `wasm-bindgen` 依赖）。

它负责 SRS 中的三件事：**模型编译/校验**、**启发式求解**、**独立方案核验**；
React 前端、Go 平台层、OR-Tools 质量基线不在本 crate 范围内（见 `docs/USAGE.md` 的边界说明）。

## 30 秒上手

```bash
cd aps/rust
cargo build --release                      # 需要 Rust 1.75+（本交付在 1.88.0 上验证）
cd ..
cargo run --release --manifest-path rust/Cargo.toml -- \
    solve --problem mock/baseline.json --out /tmp/plan.json --time-limit-ms 2000
./rust/target/release/aps verify --problem mock/baseline.json --solution /tmp/plan.json
./rust/target/release/aps accept           # 一键跑 SRS §7 的 S01–S08 验收
```

> 构建产物路径取决于 `CARGO_TARGET_DIR`；上例假设默认的 `rust/target/`。
> 受限网络环境（无法访问 crates.io / static.rust-lang.org）请先看 `toolchain/setup_rust.sh`。

## 目录

| 路径 | 内容 |
|------|------|
| `src/lib.rs` | crate 根：模块清单、引擎标识、峰值内存全局分配器 |
| `src/model.rs` / `src/validate.rs` / `src/compile.rs` | PlanProblem v1 契约解析、语义校验、编译为内部模型 |
| `src/solver/` | 构造式多规则启发式（`dispatch.rs`）+ 局部修复（`repair.rs`） |
| `src/objective.rs` | 目标口径（加权延期 → makespan）与**有效下界** |
| `src/verify.rs` | **独立校验器**：不复用求解器路径，逐条核验 H01–H08 |
| `src/engine.rs` | 编译→求解→自检→独立复核→状态映射 的完整管线 |
| `src/compare.rs` / `src/explain.rs` | 方案对比（统一口径）与工序级解释 |
| `src/acceptance.rs` | S01–S08 验收套件（`aps accept`） |
| `src/benchgen.rs` | 与 `tests/generate_benchmark.py` 等价的 24/240/2400 规模生成器 |
| `src/ledger.rs` | 物料账本事件重放（编译期与核验期使用的独立实现） |
| `src/wasm_api.rs` | WASM 导出的 C ABI（`wasm32` 目标下编译） |
| `tests/` | 端到端集成测试 + 完整验收套件（`--ignored`） |
| `docs/` | `USAGE.md` 使用手册、`MODEL-MATH.md` 建模与约束对照、`INTEGRATION.md` 平台集成、`BENCHMARKS.md` 实测、`CONFORMANCE.md` 需求对照、`DEPENDENCIES.md` 依赖/许可证/SBOM |
| `toolchain/`、`scripts/`、`web/` | 可复现工具链安装、构建/基准/契约检查脚本、WASM/Web Worker 胶水 |

## 质量门（本地可复现，CI 同款）

```bash
cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings   # 质量门
cargo test --release                                   # 57 单元 + 11 集成测试
cargo test --release --test acceptance_suite -- --ignored   # S01–S08（约 6 s）
python3 scripts/check_contracts.py                     # 契约符合性（30 项，零依赖）
bash scripts/build_wasm.sh                             # WASM + Node 冒烟
```

CI：`.github/workflows/aps-rust.yml`（依赖审计 → 测试 → 验收 → 契约检查 → WASM 冒烟 → 产物上传）。

## 命令速查

```bash
aps validate      --problem mock/baseline.json --json
aps capabilities  --profile native|wasm-light --json
aps solve         --problem mock/baseline.json --out plan.json [--strategy lexicographic|makespan]
                  [--time-limit-ms 2000] [--seed 42] [--rule auto|priority-edd|wspt|spt|min-end|most-slack|random]
                  [--profile native|wasm-light] [--no-repair] [--max-iterations N] [--cancel-after-ms N]
aps verify        --problem mock/baseline.json --solution plan.json --json
aps compare       --problem mock/baseline.json --baseline ref.json --solution plan.json [--solution ...] --json
aps explain       --problem mock/baseline.json --solution plan.json --operation ORD-001-CUT
aps benchmark     --baseline mock/baseline.json --operations 240 --out /tmp/b240.json
aps bench         --problem /tmp/b240.json --runs 3 --time-limit-ms 2000 --seed 42 --json
aps accept        [--dir ..] [--json]
```

完整说明（字段语义、状态码、算法原理、WASM 集成、FAQ）见 **[docs/USAGE.md](docs/USAGE.md)**。
