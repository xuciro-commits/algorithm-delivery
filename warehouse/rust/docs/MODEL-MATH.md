# 模型与数学口径（可复算）

本文件给出引擎里所有进入**指标与目标函数**的公式。任何指标都必须是下文某个公式的取值，
并且验证器会用同一公式重算一遍——**不存在"另外一套估算口径"**。

## 1. 运动学

梯形/三角速度曲线（含加减速段），`v` 为额定速度，`a` 为加速度：

```
d_acc   = v² / (2a)                    # 加（减）速段距离
若 d ≥ 2·d_acc：t = 2·(v/a) + (d − 2·d_acc)/v
否则：           t = 2·√(d/a)
```

设备速度修正：巷道内载货 `v_eff = v · loaded_speed_factor`（默认 0.7–0.92），
降级事件再乘 `speed_factor`（`verify` 里下限 0.05，防止把降速当成 0 速）。
层间提升：`t = change_level_s · |Δlevel|`（提升机分档时间由 `motion.change_level_s` 给出）。
搬运动作（取货/放货）：`transfer_s`；站台/缓存交接：`handover_s`。

**指标里的距离**：`travelMeters` = Σ 步骤 `distance_m`；`energyKwh` = Σ(`m · k_m + k_move`)。
不含"欧氏直线"——欧氏只出现在设备指派打分（`deadhead / speed`），不进入上报指标。

## 2. 时空预约与互斥

资源：`LANE:{aisle}:L{level}`（巷道层内，容量 1）、`SHAFT:{device}`（井道，容量 1）、
`CORRIDOR:L{level}:{a}-{b}`（同层横向通道，容量 = 通道 `capacity`，>1 允许会车）、
`STATION:{id}`（容量 = 站台缓存）、`BUFFER:{id}`（容量 = 缓存位）、`LINK:{link}`（按链路容量）。

预约检查（位置桶索引，桶宽 0.25 m）：对步骤 `[start, end]` 与区间 `[p_lo, p_hi]`，
若同资源上存在其他设备的预约满足

```
entry.end_s > start + ε   且   [entry.p_lo, entry.p_hi] ∩ [p_lo, p_hi] ≠ ∅
```

则 `start = entry.end_s`（取最大值），阻塞者记入 `conflicts[]`，
`blockedMoves += 1`，推迟量累加进 `delayed_by_s`。
区间比较前必须 `min/max` 归一（车可以朝任意方向走；不归一会把"从远到近"判成不相交，
从而漏掉真实冲突——2026-10 修的就是这条）。

死锁预防：等待边构成环时不再排队，记 `deadlocksPrevented += 1` 并换设备/换序。

## 3. 库位优化目标

设 `u` 为货物单元，`l` 为其库位，`f_u` 为周转频次（次/天），`t(l, station)` 为按 §1 计算的
单向时间，`S` 为服务站台集合：

```
日运行时间  T_layout = Σ_u f_u · min_{s ∈ S} [ t(l_u → s) + handover_s + t(s → l_u) ] · 2 / 2
巷道负载    load_a  = Σ_{u : aisle(l_u)=a} f_u          ；Gini(load) 越小越均衡
关联相邻性  affinity = Σ_{(u,v) ∈ 关联对} c_uv / (1 + d(l_u, l_v))
倒垛代价    rc = Σ_{深位占用} 预计倒垛次数 × (取放时间 + 落位时间)
搬迁代价    mc = Σ_{m ∈ migrations} (位移时间 + 设备占用)
拥堵项      cc = congestion_scale · Σ_{a} max(0, load_a − q_a)²（q_a 为该巷道容量参考）
```

总目标（权重可配，方向可正可负）：`min w₁·T_layout + w₂·Gini + w₃·rc + w₄·mc + w₅·cc − w₆·affinity`。
`congestion_scale` 初值 1.0，由联合闭环按 §5 更新。

**约束**：库位容量与可用性、`can_serve_location`（设备可服务巷道/层）、区域与温区兼容、
冻结/封闭、危险品隔离、搬迁预算（件数 / 设备秒数）。违背即 hard violation。

## 4. 启发式

* **ALNS**：`destroy` ∈ {random, worst, Shaw(关联), cluster, column}；`repair` ∈ {greedy, regret-2}；
  接受准则 SA 式：`Δ ≤ 0` 或 `rand() < exp(−Δ/T)`，`T` 按退火率衰减；算子权重按成功率自适应。
* **禁忌搜索**：期约 `tabu_tenure`，频率惩罚压重复动作，特赦准则（优于历史最优即接受）。
* **NSGA-II**：快速非支配排序 + 拥挤度距离 + (μ+λ) 精英选择，种群 8–64、代数 4–200（契约可配）。
* **鲁棒**：情景集 `{需求扰动, 设备降级, 库位冻结}`；目标取 `mean + λ·(worst − mean)`；
  输出 `stabilitySeeds`（多种子重跑的目标值集合）。

搜索预算：墙钟 `budget_ms`（软预算）+ `max_iterations`。实际迭代数与耗时写进 `search`，不虚报。

## 5. 联合闭环

```
round r:  congestion_scale_r = clamp(1 + feedback, 0.2, 6.0)
          slotting(problem | congestion_scale_r) → assignment_r
          schedule(assignment_r) → 实测 {makespan, conflicts, mean_wait, relocations}
          conflict_pressure = min(1, conflicts·0.05 + mean_wait/120)
          feedback ← 0.4·feedback + 0.6·conflict_pressure        （EMA）
联合目标  J = T_layout · w_travel + makespan · 0.5 + (makespan / tasks_done) · 60
                + conflicts · 5 + relocations · 30
```

`rounds[]` 记录每轮的实测值与 `J`；最优轮次进入结果。
`comparison`：随机储位 / ABC 分区 / 联合优化 **在同一调度器与同一预算口径下**各跑一次调度，
比较完工时间、冲突、行驶米数等。

**Pareto（J09）**：权重网格 `{(2.0,0.2), (1.0,1.0), (0.5,2.0), (0.2,3.0)}`（travel × throughput）
各做一次真实闭环评估，再按 `(库位日运行时间, 完工时间, 冲突 + 5×倒垛)` 三目标做非支配筛选。
这是**采样前沿**，不是穷举前沿，`paretoNote` 里写明。

## 6. 验证器重算清单

`verify` 独立重算并与上报值比对：步骤数与设备集合、每步时间（含 `*0.85` 容差下限、
上界 `travel_time·1.35 + transfer + handover + change_level`）、
makespan、行驶米数、能耗、任务完成/未服务数、冲突数、
资源互斥（巷道/井道/站台/缓存）、故障窗口与冻结/封闭、库存台账守恒、深位顺序。
不一致 → violation（hard 即使结果失效，soft 仅告警）。
