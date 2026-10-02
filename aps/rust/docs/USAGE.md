# aps-engine 使用手册

> 适用版本：`aps-engine 1.0.0`（Rust 1.88.0 验证）
> 对应契约：`PlanProblem v1` / `PlanSolution v1` / `SolverCapabilities v1`（见 `aps/contracts/`）
> 权威需求：`aps/APS-SRS.md`；数据背景与免责说明：`aps/README.md`

---

## 1. 它是什么、不做什么

| 范围 | 归属 |
|------|------|
| PlanProblem 契约解析、跨引用/语义校验（H01–H08 中的静态部分） | ✅ 本 crate |
| 启发式排程（构造 + 局部修复，可复现、带时间预算与取消） | ✅ 本 crate |
| **独立**方案核验（生产级 verifier，不共用求解器判断路径） | ✅ 本 crate |
| 方案对比（延期/准时/makespan/利用率/变更工序数）与工序级解释 | ✅ 本 crate |
| 24/240/2400 规模生成（与 Python 参考生成器等价） | ✅ 本 crate |
| 浏览器/Node 的 WASM 集成 | ✅ 本 crate 提供 `.wasm` + JS 胶水（见 §9） |
| React 前端、Go 平台 API、租户鉴权、快照生命周期、任务编排 | ❌ 平台层（Go/React） |
| 证明全局最优、替代 CP-SAT 的完整搜索 | ❌ 不在本期；仅提供**可验证的弱下界**与诚实状态 |

> 交付数据全部为 Mock。`duration_min` 与 `materials` 都是**整张订单批次**的值，任何调用方都**不得再乘以 `quantity`**。

---

## 2. 构建与安装

### 2.1 标准环境（可访问 crates.io / static.rust-lang.org）

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.88.0
rustup target add wasm32-unknown-unknown        # 需要构建 WASM 时
cd aps/rust && cargo build --release && cargo test --release
```

### 2.2 受限网络环境（沙箱/内网，无法访问 rust-lang 官方源）

本仓库提供 `toolchain/setup_rust.sh`，它从 **npm registry** 的 `@rustbin/*` 预编译包安装工具链
（`rustc` / `cargo` / `rust-std` / `wasm32-unknown-unknown`），装到 `/opt/rust`：

```bash
sudo bash aps/rust/toolchain/setup_rust.sh                 # 安装 x86_64 + wasm32 两个 target
export PATH=/opt/rust/bin:$PATH
export CARGO_HOME=${CARGO_HOME:-$HOME/.cargo}              # 也可指向任意可写目录
cd aps/rust && cargo build --release
```

脚本是幂等的；重装只需再跑一次（详见脚本头部注释）。

### 2.3 构建产物

| 命令 | 产物 | 说明 |
|------|------|------|
| `cargo build --release` | `target/release/aps` | native CLI |
| `cargo build --release --lib` | `target/release/libaps_engine.rlib` | 可嵌入其他 Rust 程序 |
| `bash scripts/build_wasm.sh` | `dist/aps_engine.wasm` | wasm32-unknown-unknown 模块（crate-type 含 cdylib） |

本 crate **零第三方依赖**（`Cargo.toml` 无 `[dependencies]`），因此离线环境只要装好工具链即可构建。

---

## 3. 输入 / 输出契约速览

### 3.1 输入：PlanProblem v1（节选）

```jsonc
{
  "schema_version": "plan-problem/1.0",
  "meta": { "tenant_id": "mock-tenant-alpha", "snapshot_id": "snapshot-baseline-v1",
            "timezone": "America/Los_Angeles",
            "horizon": { "start": "2026-10-05T08:00:00-07:00", "end": "2026-10-09T17:00:00-07:00" },
            "resolution_min": 15 },
  "machines": [ { "id": "CUT-01", "capabilities": ["cut"],
                  "available": [ { "start": "...", "end": "..." } ],
                  "blocked":   [ { "start": "...", "end": "..." } ] } ],
  "workers":  [ { "id": "EMP-W01", "skills": ["weld"], "qualifications": ["cert-weld"],
                  "available": [...], "blocked": [...] } ],
  "tools":    [ { "id": "DIE-SHARED-01", "capacity": 1 } ],          // capacity 恒为 1
  "materials":[ { "id": "M-PAINT", "initial_qty": 8,
                  "receipts": [ { "at": "2026-10-06T08:00:00-07:00", "qty": 10 } ] } ],
  "orders":   [ { "id": "ORD-001", "priority": 3, "quantity": 2,
                  "release_at": "2026-10-05T08:00:00-07:00", "due_at": "2026-10-06T16:00:00-07:00",
                  "operations": [ { "id": "ORD-001-CUT", "skill": "cut",
                                    "worker_qualifications": ["cert-cut"],
                                    "alternatives": [ { "machine_id": "CUT-01", "duration_min": 30 },
                                                       { "machine_id": "CUT-02", "duration_min": 45 } ],
                                    "worker_count": 1,                         // 恒为 1（P1）
                                    "tool_ids": ["DIE-SHARED-01"],
                                    "materials": [ { "material_id": "M-BLANK", "qty": 2 } ],
                                    "predecessors": [] } ] } ],
  "objective": { "strategy": "lexicographic", "phases": ["weighted_tardiness", "makespan"],
                 "time_limit_ms": 10000, "seed": 42 }
}
```

统一约束语义（与 SRS §3 一致，实现见 `src/verify.rs` 与 `src/compile.rs`）：

- **H01** 工序时长取所选 alternative；时间必须是整数分钟、`end > start`；
- **H02** 前驱 `end ≤ 后继 start`；首工序 `start ≥ release_at`；
- **H03** 备选机器必须有对应能力，且同机不重叠；
- **H04** 每道工序必须**完整落在某个可用窗口内**，不得跨越交接班空档或 `blocked` 区间（不可抢占）；
- **H05** 人员需具备技能 + 全部资格，同一人员不得重叠；
- **H06** 工具在工序全区间独占；未分配即违约（不得静默忽略）；
- **H07** 物料账本按事件序非负：同一时刻**先入库后领料**；
- **H08** 所有工序都必须落在规划时域内、且一道都不能少。

### 3.2 输出：PlanSolution v1

```jsonc
{
  "schema_version": "plan-solution/1.0",
  "id": "rust-heuristic-42-84a251f2ed5e",
  "tenant_id": "mock-tenant-alpha",
  "snapshot_id": "snapshot-baseline-v1",
  "problem_hash": "sha256:84a251f2…",
  "engine": "rust-heuristic", "engine_version": "1.0.0", "compiler_version": "plan-compiler-rust-1.0",
  "status": "FEASIBLE",
  "optimality_proven": false,
  "verified": true,
  "violations": [],
  "options": { "strategy": "lexicographic", "time_limit_ms": 2000, "seed": 42,
               "profile": "native", "rule": "auto", "repair": true },
  "objective": { "strategy": "lexicographic", "weighted_tardiness_minutes": 0,
                 "makespan_minutes": 1560, "total_tardiness_minutes": 0,
                 "max_tardiness_minutes": 0, "late_orders": 0,
                 "best_bound": 270, "relative_gap": 4.7778 },
  "metrics": { "compile_ms": 0.2, "first_feasible_ms": 0.1, "solve_ms": 2000.0,
               "verify_ms": 0.2, "peak_memory_bytes": 349209, "total_ms": 2000.8,
               "time_metrics_available": true },
  "operations": [ { "order_id": "ORD-001", "operation_id": "ORD-001-CUT",
                    "machine_id": "CUT-01", "worker_id": "EMP-C01", "tool_ids": ["DIE-SHARED-01"],
                    "start_at": "2026-10-05T08:00:00-07:00",
                    "end_at": "2026-10-05T08:30:00-07:00" } ]
}
```

- `problem_hash` 是 `PlanProblem` 的**规范化 JSON**（键按字节序排序、整数值浮点归一为整数）的 SHA-256；
  平台可用它判定“方案是否针对当前问题”以及缓存命中。
- `verified=true` 表示本方案已通过**同一 crate 内的独立校验器**（`src/verify.rs`）复核，且引擎自检一致；
  自检不过时会退化为 `status=UNKNOWN` 且 `verified=false`（宁可拒收，不放过）。

### 3.3 状态语义（契约枚举，不许含糊）

| 状态 | 何时返回 | 平台应如何处理 |
|------|----------|----------------|
| `MODEL_INVALID` | 契约/语义/规模校验失败（含 `worker_count>1` 等 P1 越界） | 拒绝，回报字段级 `issues` |
| `UNSUPPORTED_CONSTRAINT` | 档位不支持的规模或特性（如 wasm-light 超 `max_operations`） | 拒绝或改走 native；**绝不静默忽略约束** |
| `INFEASIBLE` | **仅**当可构造无解证明（资格死角、工序在任何窗口都放不下、物料总供给不足） | 可据此停线/上报，属确定性结论 |
| `OPTIMAL` | 加权延期 = 0 **且** makespan 达到有效下界（`optimality_proven=true`） | 可作为最优方案发布 |
| `FEASIBLE` | 找到可行解但未证明最优（`optimality_proven=false`） | 可发布；`objective.best_bound/relative_gap` 给出质量参考 |
| `NO_SOLUTION_FOUND` | 搜索穷尽（无时间预算限制）仍未找到可行解，且无证明可用 | 人工复核/放宽约束，**不得**当作无解 |
| `UNKNOWN` | 时间预算耗尽、被取消、或引擎自检失败 | 保留既有方案，不要自动覆盖 |
| `CANCELLED` | 协作式取消（返回取消前的 incumbent，violations 中带 `CANCELLED_WITH_INCUMBENT` 警告） | 保留 incumbent，等待重排 |

### 3.4 能力声明 SolverCapabilities v1

```bash
aps capabilities --profile native --json
```

| 档位 | 约束 | `max_operations` | 证明最优 | 证明无解 | 支持取消 | 适用 |
|------|------|------------------|----------|----------|----------|------|
| `native` | H01–H08 | 20000 | 仅当达到有效下界 | ✅（可构造证明的类型） | ✅ | 服务端/桌面 |
| `wasm-light` | H01–H08 | 600 | ❌ | ❌（诚实返回 `NO_SOLUTION_FOUND`/`UNSUPPORTED_CONSTRAINT`） | ✅（协作式） | 浏览器 Web Worker 局部调整 |

平台必须在派发任务前读取能力声明并在 UI 上区分 `OPTIMAL/FEASIBLE/UNKNOWN`（SRS §4）。

---

## 4. CLI 完整用法

退出码：`0` 成功 / `2` 用法错误 / `3` 契约非法 / `4` 已证明无解 / `5` 未找到解或未知 / `6` 能力不匹配 / `7` 已取消 / `8` 校验发现违约。
所有子命令都支持 `--json`（稳定的契约 JSON 输出，便于 CI 断言）。

### 4.1 `validate` — 只校验，不求解

```bash
aps validate --problem mock/baseline.json --json
# {"valid":true,"issues":[],"summary":{"orders":8,"operations":24,"errors":0,"warnings":0}}
```

校验分成两层：JSON 语法/结构（`MODEL_INVALID` 字段级报错）+ 跨对象语义
（未知机器/人员/工具/物料、备选缺失、日历不可容纳、时间逆序、超时域、P1 越界等）。

### 4.2 `solve` — 排程

```bash
aps solve --problem mock/baseline.json --out /tmp/plan.json --time-limit-ms 2000
aps solve --problem mock/baseline.json --strategy makespan --seed 7 --rule wspt --no-repair
aps solve --problem mock/baseline.json --cancel-after-ms 300 --json   # 演示协作式取消
```

参数（未给时取 `PlanProblem.objective` 中的默认值）：

| 参数 | 含义 |
|------|------|
| `--strategy lexicographic\|makespan` | 字典序（先最小化加权延期，再压缩 makespan）或纯 makespan |
| `--time-limit-ms N` | 时间预算；到点返回 incumbent |
| `--seed N` | 随机种子；**同 seed + 同参数 = 完全可复现** |
| `--rule auto\|priority-edd\|wspt\|spt\|min-end\|most-slack\|random` | 构造规则；`auto` 跑全部规则取最优 |
| `--no-repair` | 关闭局部修复（只做多规则构造，用于对照/回归） |
| `--max-iterations N` | 局部修复迭代上限（0=只受时间限制） |
| `--profile native\|wasm-light` | 能力档位（超范围会显式返回 `UNSUPPORTED_CONSTRAINT`） |
| `--cancel-after-ms N` | N 毫秒后触发取消（演示“可终止”，返回 incumbent） |
| `--out FILE` / `--json` | 写出方案文件 / 把方案打印到 stdout |

### 4.3 `verify` — 独立核验（生产级 verifier）

```bash
aps verify --problem mock/baseline.json --solution /tmp/plan.json
# ✓ 方案合法：独立校验器未发现任何违约（H01–H08 全部通过）

aps verify --problem mock/baseline.json --solution tests/baseline-feasible-witness.json --json
```

核验与求解**完全解耦**：`src/verify.rs` 不引用 `src/solver/*`，只依赖问题模型与内部只读时间线。
它会检出快照/租户绑定不一致、工序缺失/重复/未知、时间非法、机器能力、日历空档（含 `blocked`）、
人员技能/资格、工具独占、物料透支等，并给出 `code/message/operation_id/resource_id/at` 定位。

### 4.4 `compare` — 统一口径的方案对比

```bash
aps compare --problem mock/baseline.json \
            --baseline tests/baseline-feasible-witness.json \
            --solution /tmp/plan.json --json
```

统一口径（与前端/KPI 保持一致，实现在 `src/compare.rs`）：

- 订单完成时间 = 该订单所有工序 `end_at` 的最大值；
- 延期 = `max(0, 完成时间 − due_at)`；加权延期 = `Σ priority × 延期`；
- makespan = `max(end_at) − 规划起点`；
- 机器/人员利用率 = `Σ 占用分钟 / Σ 可用分钟`（`available` 合并后扣除 `blocked`，并裁剪到时域内）；
- `changed_operations` = 与基准相比三元组 `(machine_id, worker_id, start_at)` 任一不同的工序数。

### 4.5 `explain` — 为什么这道工序排在这里

```bash
aps explain --problem mock/baseline.json --solution /tmp/plan.json --operation ORD-001-CUT
```

输出该工序的备选机器与所选时长、能力/资格判定、所在可用窗口、工装与物料账本轨迹、
前驱/后继时间、以及“谁占了这台机器/这个人”（`blocking_resources`，用于回答“为什么不能更早”）。
`--json` 输出可直接给前端做逐条渲染。

### 4.6 `benchmark` / `bench` — 规模与性能

```bash
aps benchmark --baseline mock/baseline.json --operations 240  --out /tmp/b240.json
aps benchmark --baseline mock/baseline.json --operations 2400 --out /tmp/b2400.json
aps bench --problem /tmp/b2400.json --runs 3 --time-limit-ms 2000 --seed 42 --json
```

`aps benchmark` 与 `aps/tests/generate_benchmark.py` **输出逐字节一致**（键序与数值类型均一致），
规模必须是 24 的整数倍（= 若干互相独立的车间单元 `CELL###__` 复制），用于 API/序列化/规模压测，
**不能**当作耦合调度难度基准。实测数据见 `docs/BENCHMARKS.md`。

### 4.7 `accept` — 一键验收

```bash
cd aps && aps accept          # 跑 S01–S08，7×24 秒内完成
aps accept --json > /tmp/accept.json
```

覆盖内容：

| 用例 | 判据 |
|------|------|
| S01 基础车间 | FEASIBLE、24 道工序齐全、独立校验 0 违约、目标值可读 |
| S02 设备故障 | 无工序进入 `WELD-02` 停机区间，且给出相对基线的变更工序数 |
| S03 到货延迟 | 事件序物料账本全程非负 |
| S04 无解 | native 返回 `INFEASIBLE` + `NO_ELIGIBLE_WORKER` 证明且 `operations=[]`；wasm-light 不伪称 |
| S05 失效快照 | 旧快照方案核验报 `SNAPSHOT_MISMATCH`（权威拒绝在 Go 层） |
| S06 对抗方案 | 17 组故意破坏各自被精确检出（H01–H08 + 契约级） |
| S07 多租户 | 租户 A 的方案在租户 B 的问题上核验报 `TENANT_MISMATCH` |
| S08 能力协商 | 2400 工序超出 wasm-light 上限 → `UNSUPPORTED_CONSTRAINT`+`SCALE_EXCEEDED` |

---

## 5. 算法说明（怎么排的、为什么可信）

1. **编译**（`compile.rs`）：ISO 时间 → 相对分钟；`available` 合并去重、扣除 `blocked` 得到可落位窗口；
   建全局拓扑序（含跨订单前置）；预计算“资格死角”等可构造无解证明。
2. **构造**（`solver/dispatch.rs`）：按规则生成订单投放顺序（优先级/EDD/WSPT/SPT/最早完工/最松弛/随机），
   逐单按拓扑序取**最早可行落位**（候选机器 × 合格人员的所有可用窗口锚点做可行性判定）。
3. **局部修复**（`solver/repair.rs`）：按延期贡献挑选受害者做 **ruin & recreate**（整单移除后重插），
   周期性 **左移紧致化**，停滞后退火为随机重启；所有接受都要求目标严格变好且完整可行，否则整体回滚。
4. **目标与下界**（`objective.rs`）：字典序 `(加权延期, makespan)`；下界为拓扑递推的
   “单工序最宽松条件下最早完工”的最大值（忽略机器/人员/工装/物料竞争，取最短时长，含 `blocked` 空档）。
5. **最优性声明**：只有 `加权延期 = 0（理论下界）且 makespan = 有效下界` 才返回 `OPTIMAL`
   并置 `optimality_proven=true`；否则一律 `FEASIBLE` + `best_bound/relative_gap`。
   档位一致性：`wasm-light` 声明 `can_prove_optimal=false`，因此即使本轮恰好达到下界也只报告
   `FEASIBLE`（引擎会在说明中注明“已证明最优但档位不报告”，需要 `OPTIMAL` 请使用 native）。
   例如 `mock/baseline.json` 的最优 makespan 受 M-PAINT 到货约束，实际为 1560 分钟，
   但弱下界只有 270，因此引擎**诚实地**报告 `FEASIBLE`（相对差距 4.78）而非伪称最优。
6. **自检 + 独立复核**：结果先过求解器内部一致性自检（完整性/重叠/物料），再由独立校验器逐条核验；
   任一步失败 → `UNKNOWN` + `verified=false`。
7. **时间预算与取消是协作式的**：在规则/迭代/重启边界检查。单次构造或单轮左移不抢占，
   因此 2400 规模下 `solve_ms` 可能略超 `time_limit_ms`（实测约 +8%，见实测表）。

---

## 6. 复现与回归

```bash
# 单元 + 集成测试（约 25 秒）
cargo test --release

# 完整 S01–S08 验收（等价于 aps accept，约 1 分钟）
cargo test --release --test acceptance_suite -- --ignored --nocapture

# Rust 与 Python 的基准生成器对齐（逐字节一致）
python3 ../tests/generate_benchmark.py --operations 240 --out /tmp/py240.json
aps benchmark --baseline ../mock/baseline.json --operations 240 --out /tmp/rs240.json
python3 -c "import json;a=json.load(open('/tmp/py240.json'));b=json.load(open('/tmp/rs240.json'));print(json.dumps(a,sort_keys=True)==json.dumps(b,sort_keys=True))"

# 既有 Python 参考检查（乙方开发期参考，非生产 verifier）
cd .. && python3 tests/verify_mock.py
```

---

## 7. 常见问题（FAQ）

**Q1 为什么小实例也只返回 `FEASIBLE`？**
因为 `OPTIMAL` 只有在**达到可验证下界**时才允许返回。弱下界通常远低于真实最优，
所以引擎宁可用 `best_bound/relative_gap` 描述质量，也不伪造最优。

**Q2 `duration_min` 要不要乘 `quantity`？**
不要。本版契约中工序时长与物料消耗都按“整张订单批次”给定（`aps/README.md` 明确警告）。

**Q3 浏览器端为什么拒绝 2400 工序？**
`wasm-light` 能力声明 `max_operations=600`。超限时返回 `UNSUPPORTED_CONSTRAINT` + `SCALE_EXCEEDED`
（含实际值与上限），而不是静默丢弃约束或给出不可信结果。这是 SRS §4/§10 的硬性要求。

**Q4 时间预算为什么会被“用满”？**
启发式会持续做 ruin & recreate / 重启，直到预算耗尽或证明最优；这是设计行为。
若只要首解，关注指标里的 `first_feasible_ms`。

**Q5 峰值内存怎么统计的？**
crate 内置统计分配器（`src/alloc.rs`，全局分配器，native/wasm 都生效）。
把本 crate 作为 `rlib` 嵌入且宿主另有全局分配器时，删掉 `lib.rs` 的 `#[global_allocator]` 即可（其余统计自动降级为 0）。

**Q6 时区怎么处理？**
输入必须是带时区的 ISO 8601；编译期统一换算为“规划起点开始的整数分钟”，
输出再按起点时区还原 ISO 字符串。跨时区车间请在平台层统一为同一时区后再下发。

**Q7 能和 Go 平台层怎么对接？**
两种方式：① 子进程调用 `aps`，用 `--json` 读契约 JSON；② 把 `libaps_engine` 编入 C ABI/FFI。
WASM 方式见下节。租户鉴权、快照生命周期、任务状态机、`STALE_SNAPSHOT` 的权威拒绝在 Go 层实现。

---

## 8. 独立性与安全边界（验收关注点）

- **求解器与校验器不共享判断路径**：`verify.rs` 不 import `solver`；`compile.rs` 与 `ledger.rs` 各自实现账本。
- **负例数据**：S06 的 17 组变异覆盖每一条 H 约束；`aps/tests/verify_mock.py` 的 7 组反例作为交叉验证。
- **不伪造结论**：无解必须带证书；最优必须有下界依据；超范围必须显式拒绝。
- **可复现**：同 `seed` + 同参数 + 同输入 → 逐字节相同的方案 JSON（测试 `repair_never_worsens_objective` 等）。

---

## 9. WASM 集成（浏览器 Web Worker）

构建：

```bash
bash scripts/build_wasm.sh          # 产出 dist/aps_engine.wasm
```

ABI（`src/wasm_api.rs`，无 wasm-bindgen，纯 C ABI）：

| 导出 | 签名 | 说明 |
|------|------|------|
| `aps_alloc` | `(len: usize) -> *mut u8` | 申请缓冲，JS 侧写入 UTF-8 JSON |
| `aps_free` | `(ptr, len)` | 释放 |
| `aps_solve` | `(ptr, len) -> i32` | 求解；返回状态码 `1=OPTIMAL … 8=CANCELLED`（0=参数错误） |
| `aps_result_ptr` / `aps_result_len` | `-> *const u8` / `-> usize` | 读取结果 JSON |
| `aps_cancel` | `()` | 置取消标志（WASM 单线程，建议直接 `worker.terminate()`） |
| `aps_version` / `aps_peak_memory_bytes` | | 版本串 / 峰值内存 |

最小 JS 胶水见 `web/aps-worker.js`：

```js
import init, { solve } from './aps-worker.js';
self.onmessage = async (e) => {
  const result = await solve(e.data.problemText);   // 自动走 wasm-light 档位
  self.postMessage(result);
};
```

注意：wasm-light 档位不证明最优/无解，且 `max_operations=600`；浏览器端建议只做
“局部调整 + 即时校验”，全局排程交给服务端 native 档位（与 SRS §0 的定位一致）。

---

## 10. 目录与文件

```
aps/rust/
├── Cargo.toml                 # 零依赖；lib(rlib+cdylib) + bin(aps)
├── README.md                  # 本 crate 的 30 秒上手
├── src/                       # 引擎源码（§见 README 表格）
├── tests/
│   ├── engine_integration.rs  # 端到端集成测试（快，随 cargo test 运行）
│   └── acceptance_suite.rs    # S01–S08（#[ignore]，cargo test -- --ignored）
├── docs/
│   ├── USAGE.md               # 本文
│   ├── BENCHMARKS.md          # 24/240/2400 实测与口径
│   └── CONFORMANCE.md         # SRS 需求 → 代码/测试 对照表
├── toolchain/setup_rust.sh    # 受限网络的工具链安装（可复现）
├── scripts/build_wasm.sh      # WASM 构建（可复现）
├── scripts/run_benchmarks.sh  # 一键复现 24/240/2400 结果
└── web/aps-worker.js          # Web Worker 胶水（C ABI）
```
