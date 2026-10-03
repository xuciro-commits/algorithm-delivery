# MAPF 基准（BENCHMARKS）

引擎：`rust-ecbs-cbs` v1.0.0 · profile=native · 语义 `mapf-rules/1.0`（4 邻接、同步步进、
单位时间、目标格占用、顶点/边交换冲突）。数据与复现约定见 `mapf/bench/UPSTREAM.md` 与
`mapf/bench/manifest.json`（每项带 sha256）。

- 数据源：Moving AI MAPF Benchmarks（Stern et al., SoCS 2019），Open Data Commons
  Attribution License，经 `mcapoor/MovingAI-MAPF-Benchmarks` 镜像按文件取回。
- 引用：R. Stern, N. Sturtevant, A. Felner, S. Koenig, H. Ma, T. Walker, J. Li, D. Atzmon,
  L. Cohen, T. Kumar, E. Boyarski, R. Barták. *Multi-Agent Pathfinding: Definitions,
  Variants, and Benchmarks*. SOCS 2019, pp. 151–158.

## 测试环境与产物

- 硬件：Intel Xeon @ 2.60 GHz · **2 vCPU** · 3.8 GiB RAM · x86_64 · Linux（Arena 沙箱，无独占保障）；
- 构建：`cargo build --release --locked`（rustc 1.8x，`opt-level=3` 默认），`seed=42`；
- **完整原始结果**随仓库发布：`mapf/bench/results/bench-2026-10-03.json`
  （132 行逐实例：状态/目标值/下界/差距/编译·求解·首解·核验各阶段耗时/展开数/峰值内存/
  `problem_hash`/`semantic_digest`），本文档所有数字均可由该文件复算；
- 未解决场景（17 次 UNKNOWN）在“UNKNOWN 归因”一节**逐格列出**，不做隐去处理。

## 运行方式

```bash
# 全量（5 家族 × 规模阶梯 × {soc, makespan} × {1 s, 5 s} = 132 次求解，约 65 s）
cd mapf/rust && cargo build --release
./target/release/mapf bench --manifest ../bench/manifest.json \
    --out ../bench/results/bench-2026-10-03.json

# 子集
./target/release/mapf bench --manifest ../bench/manifest.json --only maze-32-32-4 \
    --budgets 1000 --objective soc --out /tmp/b.json
```

固定 `seed=42`、`w=1.5`（ECBS 有界次优）、horizon=auto。结果文件为契约化 JSON
（`mapf-bench-manifest/1.0` 的清单驱动，行含 `semantic_digest`/`problem_hash`，可复核确定性）。

## 总览（2026-10-03，本沙箱 CPU）

| 指标 | 数值 |
|---|---|
| 求解次数 | 132（5 地图家族，机器人数 2–128） |
| 解出率 | **115 / 132 = 87.1%**（OPTIMAL 79，FEASIBLE 36） |
| UNKNOWN | 17（全部在 ≥32 台的密度格，预算内界未收敛——见下） |
| 核验失败 | **0**（每次求解的输出都经独立 verifier 交叉核验） |
| FEASIBLE 平均差距 | 1.100（最大 1.236，均低于声明的 w=1.5 上界） |
| 总耗时 | 64.7 s（单次最长 6 359 ms，empty-16-16 @128 台） |

## 按预算 × 目标

| 预算 | 目标 | 实例数 | 解出率 | OPTIMAL 率 | 均值耗时 ms |
|---|---|---|---|---|---|
| 1000 ms | makespan | 33 | 82% | 79% | 224 |
| 1000 ms | soc | 33 | 85% | 36% | 227 |
| 5000 ms | makespan | 33 | 91% | 88% | 752 |
| 5000 ms | soc | 33 | 91% | 36% | 757 |

**要点**：makespan 的 OPTIMAL 率远高于 soc——makespan 的上界（可行解）与下界都收敛更快；
soc 下界追平难，多数实例以 FEASIBLE + 有界差距交付。这正是 ECBS 的设计语义：**w>1 时
只有在 bounds 追平（LB = UB）才允许宣称 OPTIMAL**，否则报 FEASIBLE 并附差距（verifier 同规则）。

## 按地图 × 机器人数（合并 2 预算 × 2 目标，每格 4 次求解）

| 地图 | 2 | 4 | 8 | 16 | 32 | 64 | 128 |
|---|---|---|---|---|---|---|---|
| empty-8-8 | 4/4 (0ms) | 4/4 (0ms) | 4/4 (1ms) | 4/4 (3ms) | **0/4** (3687ms) | — | — |
| empty-16-16 | 4/4 (0ms) | 4/4 (1ms) | 4/4 (2ms) | 4/4 (8ms) | 4/4 (24ms) | 4/4 (208ms) | **0/4** (3630ms) |
| maze-32-32-4 | 4/4 (4ms) | 4/4 (1ms) | 4/4 (5ms) | 4/4 (9ms) | 4/4 (43ms) | 4/4 (244ms) | 2/4 (1755ms) |
| room-32-32-4 | 4/4 (1ms) | 4/4 (1ms) | 4/4 (3ms) | 4/4 (8ms) | 4/4 (44ms) | 4/4 (312ms) | 2/4 (1873ms) |
| warehouse-10-20-10-2-1 | 4/4 (4ms) | 4/4 (6ms) | 4/4 (13ms) | 4/4 (37ms) | 4/4 (195ms) | 3/4 (1038ms) | **0/4** (3013ms) |

规律：≤16 台时全家族 100% 解出、中位耗时毫秒级；64 台仍强（empty/maze/room 全解）；
128 台只有走廊结构宽松的 maze/room 能偶发命中（其 54 Makespan 上界很快找到，SOC 下界未收敛）。

## 耗时 Top 10

| 实例 | 目标 | 预算 | 状态 | 耗时 ms | SOC | Makespan | HL/LL 展开 |
|---|---|---|---|---|---|---|---|
| empty-16-16-even-1:128 | makespan | 5000 | UNKNOWN | 6359 | – | – | 48544 / 3 146 431 |
| empty-8-8-even-1:32 | makespan | 5000 | UNKNOWN | 6238 | – | – | 182910 / 4 160 435 |
| empty-16-16-even-1:128 | soc | 5000 | UNKNOWN | 6146 | – | – | 40336 / 3 516 014 |
| empty-8-8-even-1:32 | soc | 5000 | UNKNOWN | 6109 | – | – | 159819 / 3 781 169 |
| warehouse-10-20-10-2-1-even-1:128 | soc | 5000 | UNKNOWN | 5012 | – | – | 0 / 1 947 409 |
| warehouse-10-20-10-2-1-even-1:128 | makespan | 5000 | UNKNOWN | 5011 | – | – | 0 / 1 964 559 |
| room-32-32-4-even-1:128 | soc | 5000 | FEASIBLE | 2815 | 3727 | 54 | 0 / 159 283 |
| maze-32-32-4-even-1:128 | soc | 5000 | FEASIBLE | 2672 | 3188 | 52 | 0 / 140 774 |
| room-32-32-4-even-1:128 | makespan | 5000 | OPTIMAL | 2640 | 3727 | 54 | 0 / 159 283 |
| maze-32-32-4-even-1:128 | makespan | 5000 | OPTIMAL | 2331 | 3188 | 52 | 0 / 140 774 |

## 已知行为与后续方向

1. **密度悬崖**：empty-8-8@32 与 empty-16-16@128 是官方数据中著名的“全开放 + 高密度”
   最难格——开放空间里交换型冲突组合爆炸。当前单点改进方向：LL 侧重用父约束解
   （residual network / A* 复用）与 HL 的优先级剪枝（PIBT 兜底一个可行层）。
2. **warehouse 的 HL=0 展开**：ECBS 首轮 FOCAL 命中即出界（LL 独自消化冲突）——高吞吐
   仓库图的走廊结构让首选解已接近界内。
3. `verification_failures=0` 是硬约束：任何一次“引擎自报 OPT/FEASIBLE 而 verifier 拒绝”
   都会让基准判定为不通过（CI 中 bench 步骤 exit≠0）。
4. 17 次 UNKNOWN 全部为预算语义（未证最优且未在预算内找到界内可行解），不是崩溃；
   无 INVALID_INPUT（转换层对退化起终对的“跳过并记录在 `benchmark.conversion`”策略
   使上游数据的 6 处 `start==goal` 行不再毒化实例）。

## 数据文件

- `mapf/bench/manifest.json` —— 基准清单（家族、规模阶梯、预算；契约
  `mapf-bench-manifest/1.0`，由 `gen_manifest.py` 再生成）；
- `mapf/bench/results/bench-2026-10-03.json` —— 本表全部数字的来源（rows/summary）；
- `mapf/bench/maps/`、`mapf/bench/scen/` —— 上游数据 + 每文件 sha256（见清单）。

> 环境说明：以上测自本文“测试环境”一节声明的沙箱机器（共享 vCPU）。CI/本地复跑时耗时列会变，
> 解出率与核验结论不应变——若变了，优先怀疑确定性/种子处理而非机器差异。
