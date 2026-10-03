## 验收结论：16/16 案例通过（native 档位；wasm-light 同样 16/16）

命令：`./target/release/agv acceptance --profile native --json docs/acceptance-results.json`

| 案例 | 描述 | 结果 | 证据 | 耗时 |
|------|------|------|------|------|
| A01 | 单车单任务 | ✅ | status=FEASIBLE verified=true completed=1; pickup_done=5 dropoff_done=11 | 0.505 ms |
| A02 | 单车多任务 | ✅ | status=FEASIBLE verified=true completed=3; tasks=3 done_markers=3 | 0.729 ms |
| A03 | 多车多任务 | ✅ | status=FEASIBLE verified=true completed=6 | 3.853 ms |
| A04 | 能力不满足拒配 | ✅ | status=INFEASIBLE reason=E-AGV-TASK-LEG-INFEASIBLE | 0.204 ms |
| A05 | 释放时刻等待 | ✅ | status=FEASIBLE verified=true completed=1; pickup_arrival=2 pickup_done=6（含释放等待） | 0.328 ms |
| A06 | 优先级（高优先先完成） | ✅ | status=FEASIBLE verified=true completed=2; hi_done=10 lo_done=22 | 0.566 ms |
| A07 | 工作站容量串行 | ✅ | status=FEASIBLE verified=true completed=2; station_service_intervals=[(4, 6), (7, 9)] | 0.787 ms |
| A08 | 对穿无冲突 | ✅ | status=FEASIBLE verified=true completed=2 | 0.606 ms |
| A09 | 同站多次服务 | ✅ | status=FEASIBLE verified=true completed=3 | 0.96 ms |
| A10 | 动态重调度：任务追加 | ✅ | status=FEASIBLE verified=true completed=3; total_completed=3 horizon=22 snapshot_t=3 | 1.891 ms |
| A11 | 动态重调度：车辆暂停改派 | ✅ | status=FEASIBLE verified=true completed=2 | 1.325 ms |
| A12 | 动态重调度：障碍重规划 | ✅ | status=FEASIBLE verified=true completed=1 | 0.966 ms |
| A13 | 预算诚实 | ✅ | status=FEASIBLE verified=true（未完成项均带原因码） | 1.02 ms |
| A14 | 篡改必拒 | ✅ | timeline 篡改→fail；metrics 造假→fail；干净解→pass | 1.038 ms |
| A15 | 指纹可复现 | ✅ | fingerprint=sha256:2c38962868efff38eb250d0d255751eff43576a55851a998a0b0d05b0effc9a6 | 1.513 ms |
| A16 | 取消与恢复 | ✅ | cancelled→CANCELLED；fresh→status=FEASIBLE verified=true completed=1 | 0.494 ms |

汇总：total=16 passed=16 failed=0；独立核验器（verify.rs）内嵌回填，`verified=true` 表示解通过全部 structure/timeline/dispatch 检查。

## 基准冒烟：3/3 通过（native 档位）

命令：`./target/release/agv bench --profile native --json docs/benchmark-results.json`

| 基准 | 规模 | 状态 | 完成任务 | MAPF 求解次数 | 耗时 | 预算 |
|------|------|------|----------|----------------|------|------|
| B01 | 8 车 20 任务（40×25） | ✅ FEASIBLE | 20/20 | 54 | 109.927 ms | 60000 ms |
| B02 | 动态重调度延迟（3 车 5 任务） | ✅ FEASIBLE | 5/5 | 19 | 4.361 ms | 30000 ms |
| B03 | 单站容量压力（6 车 2 泊位） | ✅ FEASIBLE | 6/6 | 18 | 3.96 ms | 60000 ms |
