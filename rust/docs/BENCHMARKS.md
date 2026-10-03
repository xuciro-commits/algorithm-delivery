# 性能与规模实测（BENCHMARKS）

> 本文记录**本交付件在给定机器上的实测数据与口径**。SRS §7 要求基准种子的可复现性，
> `tests/acceptance.json` 固定了规模 `[24, 240, 2400]` 与种子 `[42, 73, 2026]`。

## 1. 复现方式

```bash
cd aps/rust
cargo build --release
bash scripts/run_benchmarks.sh 3 2000          # 3 次/规模/种子，时间预算 2000 ms
# 原始 JSON 落在 target/bench/bench-<规模>-seed<种子>.json

# 资源竞争型基准（本版新增，见 §4）
rust/target/release/aps benchmark --baseline ../mock/baseline.json \
    --operations 384 --coupled --seed 42 --out /tmp/coupled-384.json
rust/target/release/aps solve --problem /tmp/coupled-384.json \
    --strategy makespan --time-limit-ms 8000 --out /tmp/coupled-384-plan.json
```

- 24 工序 = `aps/mock/baseline.json` 本身；
- 240 / 2400 = 引擎 `benchgen::build_separable` 生成（与 `aps/tests/generate_benchmark.py`
  **逐字节一致**，见 §6）；
- 竞争型 = 引擎 `benchgen::build_coupled` 生成（共享资源，见 §4）；
- 每次运行 `--seed` 固定；同一 seed + 同一参数 + 同一输入下**方案指纹**可复现
  （`aps fingerprint` 计算，见 USAGE §7；完整的方案 JSON 含运行期 `metrics`，
  故不承诺整份 JSON 逐字节相同）。

## 2. 实测环境

| 项 | 值 |
|----|----|
| CPU | Intel Xeon @ 2.60 GHz，2 vCPU |
| 内存 | 3.8 GiB |
| 系统 | Debian GNU/Linux 12 (bookworm) |
| 工具链 | rustc 1.88.0 (6b00bc388 2025-06-23) |
| 构建 | `--release`，`opt-level=3`、`lto=true`、`codegen-units=1`、`strip=debuginfo` |
| 依赖 | 0（无第三方 crate；不依赖 OR-Tools 或任何外部求解器） |

> 说明：这是**交付沙箱**的通用虚拟机，不是生产服务器；数字用于回归对比，不构成 SLA。

## 3. 规模与内存压测（可分离结构，`runs=3` 中位数，预算 2000 ms）

| 规模(工序) | seed | 编译中位(ms) | 首解均值(ms) | 求解中位(ms) | 总计中位(ms) | 峰值内存(MB) | 状态 | 加权延期 | makespan | 下界 | 相对差距 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 24 | 42 | 0.1 | 0.1 | 4.7 | 5.7 | 0.34 | OPTIMAL | 0 | 1560 | 1560 | 0.00 |
| 240 | 42 | 1.2 | 5.0 | 2000.3 | 2009.3 | 3.34 | FEASIBLE | 0 | 1590 | 1560 | 0.02 |
| 2400 | 42 | 18.0 | 458.8 | 2298.8 | 2389.4 | 33.64 | FEASIBLE | 0 | 1590 | 1560 | 0.02 |
| 24 | 73 | 0.1 | 0.1 | 131.0 | 131.9 | 0.34 | OPTIMAL | 0 | 1560 | 1560 | 0.00 |
| 240 | 73 | 1.2 | 4.9 | 2000.2 | 2007.9 | 3.34 | FEASIBLE | 0 | 1590 | 1560 | 0.02 |
| 2400 | 73 | 17.8 | 489.3 | 2333.6 | 2425.8 | 33.64 | FEASIBLE | 0 | 1590 | 1560 | 0.02 |
| 24 | 2026 | 0.2 | 0.1 | 24.7 | 25.5 | 0.34 | OPTIMAL | 0 | 1560 | 1560 | 0.00 |
| 240 | 2026 | 1.7 | 5.0 | 2000.2 | 2009.5 | 3.34 | FEASIBLE | 0 | 1590 | 1560 | 0.02 |
| 2400 | 2026 | 17.1 | 454.3 | 2253.9 | 2342.2 | 33.64 | FEASIBLE | 0 | 1590 | 1560 | 0.02 |

**读法**

- `编译`（PlanProblem → 内部模型）在 2400 工序下仍 < 20 ms；
- **首解**（构造阶段完成）240 工序约 5 ms，2400 工序约 0.45 s —— 这是用户等待的关键指标；
- `求解中位 ≈ 时间预算`：启发式会一直做 ruin & recreate / 重启，直到**证明最优**、
  预算耗尽或迭代上限；证明最优会**提前结束**（24 工序行 4.7 ms 即返回 `OPTIMAL` 就是这种情况），
  这是设计行为，不是性能缺陷；**关注 `first_feasible_ms` 而不是 `solve_ms`**。
- 2400 工序的 `总计` 略超预算（+6% ~ +19%）：预算检查在规则/迭代/重启边界，
  单次构造/单轮左移不可抢占。需要硬实时请把预算按比例下调。
- 峰值内存 ≈ 14 KB/工序（0.34 MB@24 → 3.34 MB@240 → 33.6 MB@2400），线性可预测。
- **下界**：24/240/2400 三档均为 1560 分钟（瓶颈为喷涂机 + M-PAINT 到货门槛，见 §5），
  因此 24 工序实例给出 `OPTIMAL`（差距 0.00），240/2400 的 `relative_gap` 为 0.02。

## 4. 资源竞争型基准（`--coupled`，共享资源 + 到货速率高于产能）

`generate_benchmark.py` 与 `benchgen::build_separable` 复制的是**相互独立的车间单元**
（单元之间不共享任何机器/人员/工装/物料），只能压测规模与内存。为回答“**有资源争夺时求解质量如何**”，
本版新增 `benchgen::build_coupled`：

- 机器/人员/工装**不复制**，全部订单共用同一套资源（喷涂仅 1 台、人员 8 名）；
- 日历按产能估算扩展到足够的工作日：**周一至周五 08:00–12:00、13:00–17:00**，
  `horizon_end` = 最后一个可用窗口的结束时刻；
- 订单按轮次（每轮 8 张，即基线的工艺路线）投放，**投放间隔 = 单轮瓶颈工时的 60%**，
  即到货速率 ≈ 1.67 × 产能 → 队列持续累积、相邻轮次争抢同一批资源；
- 物料库存/到货按轮数放大（保证不可行不是由缺料造成）。

实测（`--strategy makespan`，预算 8000 ms，seed 42）：

| 订单数 | 工序数 | 状态 | makespan | 下界 | 相对差距 | 总计(ms) | 峰值内存(MB) |
|---|---|---|---|---|---|---|---|
| 8 | 24 | **OPTIMAL** | 1560 | 1560 | 0.0000 | 4.4 | 0.3 |
| 24 | 72 | FEASIBLE | 2925 | 1920 | 0.5234 | 8002 | 0.7 |
| 48 | 144 | FEASIBLE | 5790 | 4740 | 0.2215 | 8004 | 1.3 |
| 96 | 288 | FEASIBLE | 13470 | 13200 | 0.0205 | 8007 | 2.4 |
| 192 | 576 | FEASIBLE | 30585 | 26460 | 0.1559 | 8013 | 4.7 |
| 384 | 1152 | FEASIBLE | 61020 | 56700 | 0.0762 | 8027 | 9.4 |

**读法（重要，避免过度解读）**

- 全部差距为正 → 下界有效（下界高于可行解即为无效，属严重缺陷，已用测试封堵）；
- 规模越大差距越小（1152 工序 7.6%，288 工序 2.1%）：大实例的 makespan 由**产能+日历**主导，
  三者下界能刻画；小实例（24/48 订单）的 makespan 主要来自**前置关系与班次空档的相互牵制**，
  当前下界未建模，因此差距偏大（最大 52%）——这是**下界的弱点**，不是“解很差”的证明；
- 基线 24 工序实例（8 订单）已能**证明最优**：`OPTIMAL`、`optimality_proven=true`、差距 0.00。

## 5. 下界与最优性证据（三类有效下界）

`best_bound` = 以下三者取大（`src/objective.rs`，每条都有独立有效性论证与测试）：

| 下界 | 建模内容 | 放松掉的约束 |
|------|----------|--------------|
| `path_lower_bound` | 拓扑路径递推、订单 `release_at`、单机可用窗口、`blocked` 停机空档 | 机器/人员/工装/物料竞争、时长选择耦合 |
| `capacity_lower_bound` | 按“技能+资格+机器池”分组做产能推理，并纳入**物料到货门槛的 0/1 背包** | 人员、日历、前置关系、时长选择 |
| `flow_lower_bound` | 投放节奏 × 机器**日历**可用分钟（按各机器自己的窗口累加） | 人员、工装、物料、前置关系、时长选择 |

关键正确性要点（曾写错并被测试抓住，保留记录）：

- 物料领料是“**开工即领、不退回**”，因此只有“投放时刻 ≥ R”的工时才能计入 `[R, makespan]` 的流量下界；
  若误用“投放 ≤ R 的工时之和”，会得到**高估**的下界（甚至高于可行解）。
  回归：`objective::tests::material_bound_never_exceeds_brute_force_optimum`
  （单机 + 多订单 + 到货门槛，DFS 枚举全部交错得**真实最优**，要求 下界 ≤ 真实最优 ≤ 引擎解，80 个随机实例）；
- 三条下界在竞争型实例上分别不得高于可行解：
  `benchgen::tests::coupled_is_schedulable_and_bounds_are_valid_at_scale`（8/16/24/48 订单）；
- `aps accept` 的 S01/S02 会在**独立重算**下界后，才接受求解器声称的 `OPTIMAL`。

## 6. 与 Python 生成器的等价性（回归断言）

```bash
python3 ../tests/generate_benchmark.py --operations 240 --out /tmp/py240.json
rust/target/release/aps benchmark --baseline ../mock/baseline.json \
    --operations 240 --out /tmp/rs240.json
python3 - <<'PY'
import json
a=json.load(open('/tmp/py240.json')); b=json.load(open('/tmp/rs240.json'))
print(json.dumps(a,sort_keys=True)==json.dumps(b,sort_keys=True))   # True
PY
```

（`--coupled` 是**新增**的独立生成器，与 Python 版**故意不同**：Python 版及其移植只做可分离结构。）

## 7. WASM 侧（wasm-light 档位）

| 项 | 值 |
|----|----|
| 产物 | `dist/aps_engine.wasm`，约 **618 KiB**（632599 字节，未做 wasm-opt） |
| SHA-256 | `4bd21858e4cb5ee1269c8226a24421ae9d6158c50b38f2b961c9943bdbebf16a` |
| 规模上限 | 600 工序（超出返回 `UNSUPPORTED_CONSTRAINT` + `SCALE_EXCEEDED`） |
| 24 工序求解 | 与 native 同一份源码；1 s 预算下约 40 ms 即返回（内部达到下界即提前结束），档位按能力声明只报 `FEASIBLE` |
| 峰值内存 | 0.22 MB @ 24 工序（无 WASM 线性内存预分配浪费） |
| 装载路径 | 字节码 / 预编译 `WebAssembly.Module` / URL 三种路径均有 Node 冒烟覆盖（`scripts/smoke_wasm.mjs`）|
| 时间来源 | 宿主注入 `env.aps_now_ms()`（`performance.now()`），否则时间指标不可用 |

wasm-light 档位的 `can_prove_optimal=false`：即使内部已达到下界，也只报 `FEASIBLE`，
不会向浏览器伪称 `OPTIMAL`（`scripts/test_worker_cancel.mjs` 与冒烟测试均覆盖该口径）。

浏览器端建议只做“局部调整 + 即时校验”，全局排程交给服务端 native 档位（SRS §0 定位）。

## 8. 已知的规模相关缺陷（已修复，留作回归）

| 缺陷 | 现象 | 修复 |
|------|------|------|
| JSON 解析退化 O(n²) | 2400 工序 PlanProblem（3.2 MB）解析 90 s，且不在 `total_ms` 计时区间内，表现为“命令很慢但指标很快” | `src/json.rs::parse_string` 不再对“剩余全文”反复做 `from_utf8`，改为仅解码当前字符；回归测试 `json::tests::parsing_large_document_stays_linear` |
| 日历生成把周日当工作日 | 竞争型生成器用 `wd < 5` 判定工作日，而序数为“周日=0”，导致日历变成**周日–周四**（机器/人员一致，模型合法但与文档不符） | 改为 `(1..=5)` 判定周一至周五，并在生成器测试中断言所有窗口落在周一至周五 |

修复后同一文档解析 **29 ms**（约 3000×），2400 工序全流程 `aps validate` 从约 90 s 降到 < 0.1 s。

## 9. 口径与免责

- **不使用 OR-Tools**（按最新要求，需要的算法全部自研）：本交付件零第三方依赖，
  质量证据来自 §5 的有效下界与 §4 的竞争型基准，而不是“与成熟求解器对比”。
- 可分离基准（§3）压测的是模型规模、序列化与 API 吞吐，**不能**作为耦合调度难度基准；
  需要质量口径请用 `--coupled`（§4），并注意 §4 中“下界在中小规模偏弱”的说明。
- 同一规模下不同种子的可分离实例结果一致（结构对随机性不敏感）；竞争型实例对种子更敏感，
  复现请固定 `--seed`。
- 真实耦合车间请以现场数据复测；本文件的数字不构成 SLA，也不代表已证明所有实例的最优性。
