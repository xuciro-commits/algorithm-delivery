## 验收结论：14/14 案例通过

| 案例 | 描述 | 检查 | 结果 |
|------|------|------|------|
| M01 | 单车基础（5×5 无障碍，对角 6 步） | 6 / 6 | ✅ |
| M02 | 交叉冲突（中心单元争用） | 3 / 3 | ✅ |
| M03 | 头对头走廊交换（侧袋让行） | 3 / 3 | ✅ |
| M04 | 窄通道排队（1 宽走廊 + 3 侧袋） | 2 / 2 | ✅ |
| M05 | 四车环形让行（2×2 同步旋转合法） | 4 / 4 | ✅ |
| M06 | 目标占用（等前车让位） | 3 / 3 | ✅ |
| M07 | 非法输入拒绝（重复起点 + 越界坐标） | 3 / 3 | ✅ |
| M07b | 能力外请求拒绝（对角移动） | 2 / 2 | ✅ |
| M08a | 不可达目标（孤立单元）⇒ INFEASIBLE | 4 / 4 | ✅ |
| M08b | 预算/扩展上限耗尽 ⇒ UNKNOWN | 3 / 3 | ✅ |
| M09 | 20+ 车竞争瓶颈（13×13，24 台） | 3 / 3 | ✅ |
| M10 | 动态障碍 + 目标变更 + 路径作废（t=2 快照） | 6 / 6 | ✅ |
| M11 | 篡改方案拒绝（墙侵入/顶点冲突/谎报 SOC） | 5 / 5 | ✅ |
| M12 | 运行中取消 → 恢复重解 | 3 / 3 | ✅ |

### M01 — 单车基础（5×5 无障碍，对角 6 步）
- [x] status=OPTIMAL（实际 Some("OPTIMAL")）
- [x] objective.value=6（实际 Some(6)）
- [x] soc=6（实际 Some(6)）
- [x] makespan=6（实际 Some(6)）
- [x] optimality_proven=true
- [x] verified=true（独立核验）

### M02 — 交叉冲突（中心单元争用）
- [x] status=OPTIMAL（实际 Some("OPTIMAL")）
- [x] soc=5（实际 Some(5)）
- [x] verified=true

### M03 — 头对头走廊交换（侧袋让行）
- [x] status∈{OPTIMAL,FEASIBLE}（实际 Some("OPTIMAL")）
- [x] soc≤12（实际 Some(11)）
- [x] verified=true（含边冲突=0 重算）

### M04 — 窄通道排队（1 宽走廊 + 3 侧袋）
- [x] status∈{OPTIMAL,FEASIBLE}（实际 Some("OPTIMAL")）
- [x] verified=true

### M05 — 四车环形让行（2×2 同步旋转合法）
- [x] status=OPTIMAL（实际 Some("OPTIMAL")）
- [x] soc=4（实际 Some(4)）
- [x] makespan=1（实际 Some(1)）
- [x] verified=true（环流未被误判为冲突）

### M06 — 目标占用（等前车让位）
- [x] status=OPTIMAL（实际 Some("OPTIMAL")）
- [x] soc=4（实际 Some(4)）
- [x] verified=true

### M07 — 非法输入拒绝（重复起点 + 越界坐标）
- [x] status=INVALID_INPUT（实际 Some("INVALID_INPUT")）
- [x] errors 含 E-ROBOT-DUP-START（实际 ["E-ROBOT-COORD-RANGE", "E-ROBOT-DUP-START", "E-ROBOT-DUP-GOAL"]）
- [x] errors 含 E-ROBOT-COORD-RANGE

### M07b — 能力外请求拒绝（对角移动）
- [x] status=UNSUPPORTED（实际 Some("UNSUPPORTED")）
- [x] errors 含 E-CAP-UNSUPPORTED-FEATURE（实际 ["E-CAP-UNSUPPORTED-FEATURE", "E-CAP-UNSUPPORTED-FEATURE"]）

### M08a — 不可达目标（孤立单元）⇒ INFEASIBLE
- [x] status=INFEASIBLE（实际 Some("INFEASIBLE")）
- [x] search.finish=exhausted（证明来源：穷尽而非超时）
- [x] robots 为空（INFEASIBLE 不携带路径）
- [x] objective.value=null（无解不声明目标值）

### M08b — 预算/扩展上限耗尽 ⇒ UNKNOWN
- [x] status=UNKNOWN（实际 Some("UNKNOWN")）
- [x] robots 为空（无在途合法方案可交付）
- [x] optimality_proven=false

### M09 — 20+ 车竞争瓶颈（13×13，24 台）
- [x] status∈{OPTIMAL,FEASIBLE}（实际 Some("FEASIBLE")）
- [x] robots=24（实际 Some(24)）
- [x] verified=true（全部方案通过独立核验）

### M10 — 动态障碍 + 目标变更 + 路径作废（t=2 快照）
- [x] status∈{OPTIMAL,FEASIBLE}（实际 Some("OPTIMAL")）
- [x] verified=true（含冻结前缀/快照一致性检查）
- [x] verify.checks 全部通过（含 snap/frozen）
- [x] dynamic.replan=true
- [x] dynamic.affected_agents≥1（实际 1）
- [x] frozen_prefix_covered≥3（实际 3）

### M11 — 篡改方案拒绝（墙侵入/顶点冲突/谎报 SOC）
- [x] verify.ok=false（实际 false）
- [x] violations 含 E-WALL-ENTRY（实际 ["E-WALL-ENTRY", "E-WALL-ENTRY", "E-CONFLICT-VERTEX", "E-OBJ-SOC", "E-OBJ-SOC"]）
- [x] violations 含 E-CONFLICT-VERTEX（实际 ["E-WALL-ENTRY", "E-WALL-ENTRY", "E-CONFLICT-VERTEX", "E-OBJ-SOC", "E-OBJ-SOC"]）
- [x] violations 含 E-OBJ-SOC（实际 ["E-WALL-ENTRY", "E-WALL-ENTRY", "E-CONFLICT-VERTEX", "E-OBJ-SOC", "E-OBJ-SOC"]）
- [x] M11 问题本体合法（status=Some("OPTIMAL")）

### M12 — 运行中取消 → 恢复重解
- [x] 取消后 status=CANCELLED（实际 Some("CANCELLED")）
- [x] 恢复后 status∈{OPTIMAL,FEASIBLE}（实际 Some("FEASIBLE")）
- [x] 恢复后 verified=true


