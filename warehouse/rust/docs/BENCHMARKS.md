# 基准（如实报告规模、质量与资源）

基准用例固定 10 个，覆盖三域与三档规模；**不允许缩小问题后声称原始规模**——
每个用例都记录实际规模、实际用时、峰值内存与完成数。

```bash
./target/release/warehouse bench --out /tmp/bench.json
./target/release/warehouse bench --case D16 --tier large --out /tmp/bench-d16.json
```

| 用例 | 族 | 关注点 |
| --- | --- | --- |
| S01 / S03 | 库位 | 基础策略与 ALNS 的质量/用时；对照矩阵是否显著 |
| D01 / D03 | 调度 | 单深位与多深位的基础调度；冲突与倒垛计数 |
| D16 | 调度（large） | 6 000 任务：完成率、完工时间、每任务计算成本 |
| J01 / J05 | 联合 | 闭环收益与提升机瓶颈；对比矩阵是否稳定 |
| X02 | 压力 | 2M 库位的拓扑推导与派生耗时（只做推导，如实标注） |
| X12 | 对抗 | 篡改方案必须被验证器拦下 |

判据（硬门，`bench` 会据此退码）：

* 输出结构：`{ count, tier, notes[], rows[] }`，每个 `row` 带
  `name / domain / scale / status / runtimeMs / locations / skus / loadUnits / tasks /
  iterations / peakMemoryBytes / objective / verificationOk / pass / note`；
* `pass` 的定义（`bench::row_is_pass`）：报了有解（`OPTIMAL_PROVEN` / `FEASIBLE_WITH_BOUND` /
  `FEASIBLE` / `CANCELLED`）就必须 `verificationOk = true`；`UNSUPPORTED` 是如实报告超档，
  不计失败；其它状态一律算失败；
* 任一行 `pass = false` ⇒ 进程退 `3`（与 `acceptance` 同口径），CI 直接红灯。

CI 只跑三域冒烟（`--case slotting-small,asrs-small,joint-small --tier wasm-light`，秒级）；
含 D16/D17 级规模的全量基准请在目标机器上跑。

## 参考数字（2 vCPU / ~4 GB 沙箱，release 构建）

| 用例 | 规模 | 用时 | 说明 |
| --- | --- | --- | --- |
| D01 small | 120 任务 / 336 库位 / 5 设备 | 约 15 ms | 全部完成，独立核验通过 |
| D04 small | 120 任务 / 336 库位 / 5 设备 | 约 80 ms | 2 次倒垛（`relocationTasks=2`） |
| D05 small | 120 任务 / 504 库位 / 5 设备 | 约 250 ms | 17 次倒垛、67 次受堵移动 |
| D16 medium | 900 任务 | 约 0.3 s | 全部完成 |
| D16 large | 6 000 任务 / 30 设备 | 约 3.2 s（求解 2.1 s） | `includeTimeline:false` 时结果 268 MB→无时间线 |
| D17 extreme | 20 000 任务 / 615 设备 | 约 50 s（求解 42 s / 核验 9 s） | 峰值内存 ≈ 3.2 GB；结果 112 MB（含时间线） |

> 这些数字来自**本沙箱实测**（记录在 `docs/DELIVERY.md`）。
> 换机器请重新测量，并在报告里写实际值；不要复用上表数字当作新环境的结论。
