# 与平台层集成（INTEGRATION）

> 面向 Go 平台 API 与前端调用方。给出 SRS §4/§6 的职责切分、调用方式（三种）、
> 任务状态机 ↔ 引擎状态的映射、幂等与 `problem_hash` 的用法、以及各错误码的落点。
> 引擎侧边界与契约字段语义见 [USAGE.md](USAGE.md)；本文只讲“怎么接”。

---

## 1. 职责切分（谁做什么）

```
React UI
  │  业务 CRUD / solve commands（只读计划、不直接写库）
Go 平台 API ────────> Snapshot Store / Authorization / Journal
  │
  ├─ ① 输入校验      → aps validate        （契约 + 语义 + 能力匹配）
  ├─ ② 提交任务      → aps solve-jobs      （不可变快照 + 策略 + 预算 + seed + 幂等键）
  ├─ ③ 候选结果      ← PlanSolution JSON
  ├─ ④ 独立核验      → aps verify          （生产级 verifier，必过）
  ├─ ⑤ 对比/解释     → aps compare / explain
  └─ ⑥ 审批 / 发布   → 平台层（授权、快照过期检查、journal、STALE_SNAPSHOT 权威拒绝）
```

**平台层必须负责**（引擎不做，也不该做）：

| 事项 | 说明 |
|------|------|
| 租户鉴权与隔离 | 引擎只做 `tenant_id` 一致性判定；“不泄漏任务存在性”由 API 层的查询过滤与 403/404 策略保证 |
| 快照生命周期 | 引擎只报 `SNAPSHOT_MISMATCH`；“过期 → 拒绝发布并返回 `STALE_SNAPSHOT`”由平台判定 |
| 审批与授权 | `propose` / `publish` 的权限、审批链、journal 事件 |
| 幂等 | `solveRequestId` 幂等键落在平台层（见 §4） |
| 并发/资源限额 | 服务端队列、最大并发、CPU/内存限额（引擎是纯计算进程） |
| 任务超时与取消回执 | 平台维护 `queued/running/completed/failed/cancelled`，超时不得长期停留 running |

---

## 2. 三种调用方式

### 2.1 子进程 + JSON（推荐起步）

```bash
# 校验
aps validate --problem /data/snapshots/<sid>.json --json
# 求解（把方案写到平台指定的结果目录）
aps solve --problem /data/snapshots/<sid>.json --out /results/<job>.json \
          --strategy lexicographic --time-limit-ms 10000 --seed 42 --profile native --json
# 核验（生产必做；退出码 0 = 合法，8 = 存在违约）
aps verify --problem /data/snapshots/<sid>.json --solution /results/<job>.json --json
# 对比与解释
aps compare --problem <sid>.json --baseline <approved>.json --solution <job>.json --json
aps explain --problem <sid>.json --solution <job>.json --operation ORD-001-CUT --json
```

约定：**退出码**是给调度器看的，**stdout 的 JSON** 是给业务看的；不要解析文本输出。

| 退出码 | 含义 | 平台动作 |
|--------|------|----------|
| 0 | 成功（含 `FEASIBLE`/`OPTIMAL`） | 进入核验/对比 |
| 2 | 用法错误 | 记录调用参数错误（属平台 bug） |
| 3 | `MODEL_INVALID` | 任务标记 `failed`，把字段级 `issues` 原样回给前端 |
| 4 | `INFEASIBLE`（带证书） | 任务 `completed` + 无解结论；前端展示证书 |
| 5 | `NO_SOLUTION_FOUND` / `UNKNOWN` | 任务 `completed`（未找到解），保留既有计划 |
| 6 | `UNSUPPORTED_CONSTRAINT` | 提示切换后端（wasm → native / native → CP-SAT） |
| 7 | `CANCELLED` | 任务 `cancelled`（返回 incumbent，须标注） |
| 8 | 校验发现违约 | 禁止发布；把 `violations` 回给前端定位 |

### 2.2 进程内库调用（C ABI / FFI）

`cargo build --release --lib` 产出 `libaps_engine`（`cdylib` 或 `rlib`）。C ABI 见 §3，
与 WASM 完全一致（同一份 `wasm_api.rs` 的导出集合）。适合平台与引擎同机、需要避免进程开销的场景。

### 2.3 浏览器 WASM

`dist/aps_engine.wasm` + `web/aps-worker.js`，在 Web Worker 内运行；档位固定 `wasm-light`
（`max_operations=600`，不证明最优/无解）。**服务端任务不受页面关闭影响**（SRS §5 要求）：
浏览器只做预览与局部调整，正式计划必须走服务端 native。

---

## 3. 请求/响应映射（SRS §6 端点）

| API 端点 | 引擎动作 | 关键请求字段 | 落库/返回 |
|----------|----------|--------------|-----------|
| `POST …/problems/validate` | `aps validate` | 快照引用（或内联 PlanProblem） | `valid` + `issues[]`（字段路径 + 代码） |
| `POST …/solve-jobs` | `aps solve`（排队执行） | `snapshotId`、`strategy`、`timeLimitMs`、`seed`、`engine`、`solveRequestId`(幂等键) | `jobId`；作业行记录 `problem_hash`、`engine_version` |
| `GET …/solve-jobs/{id}` | —（读作业行） | — | `queued/running/completed/failed/cancelled` + 指标 + 结果引用 |
| `POST …/solve-jobs/{id}:cancel` | `aps solve --cancel-after-ms`（演示）或进程组信号 | — | `cancelled` 回执（含 incumbent 与 `CANCELLED_WITH_INCUMBENT` 警告） |
| `POST …/solutions/verify` | `aps verify` | 快照 + 方案 | `valid` + `violations[]`（`code/operation_id/resource_id/at`），HTTP 200/422 |
| `POST …/solutions/{id}:propose` | `aps compare`（生成对比材料） | 基线方案 ID、候选方案 ID | 待审批计划（无业务落地副作用） |
| `POST …/plans/{id}:publish` | —（平台权威判定） | `snapshotId`（条件发布） | 成功 → 新计划 + journal；过期 → `STALE_SNAPSHOT` + 受影响资源/订单 |

`contracts/plan-result.example.json` 是统一返回格式的**样例**：引擎输出与它逐字段一致
（`docs/CONFORMANCE.md` 有自动检查脚本 `scripts/check_contracts.py`）。

### 3.1 作业状态 ↔ 引擎状态

| 平台作业态 | 触发条件 | 引擎状态 / 退出码 |
|------------|----------|-------------------|
| `queued` | 已受理未开跑 | — |
| `running` | 进程已启动 | —（可通过 metrics 轮询首解时间） |
| `completed` | 引擎正常结束 | `OPTIMAL` / `FEASIBLE` / `INFEASIBLE` / `NO_SOLUTION_FOUND`（0/4/5） |
| `failed` | 输入非法或引擎内部错误 | `MODEL_INVALID` / `UNSUPPORTED_CONSTRAINT` / `UNKNOWN`（3/6/5） |
| `cancelled` | 取消或超时 | `CANCELLED`（7），带 incumbent 标注 |

> `UNKNOWN` 的双重含义：既表示“预算耗尽（可能有好解）”，也表示“自检失败（`verified=false`，必须拒收）”。
> 平台应读 `verified` 字段区分：`verified=false` → `failed` 且不允许发布。

---

## 4. 幂等、缓存与审计

- **幂等键**：平台把 `solveRequestId` 与 `(problem_hash, strategy, time_limit_ms, seed, engine_version, profile)` 绑定；
  同键重复提交直接返回既有 `jobId`（引擎是无状态纯函数，可安全重放）。
- **`problem_hash`**：引擎对**规范化 JSON**（键按字节序排序、整数值浮点归一）取 SHA-256。
  平台可用它判定“方案是否针对当前问题”、缓存命中和审计追溯（SRS §4 要求记录 `problem_hash`）。
- **审计字段**：引擎把 `engine`/`engine_version`/`compiler_version`/`options`/`metrics` 全部写入方案，
  平台只需原样入库即可满足“可审计”。
- **字节级确定性**：同一 `(problem, options, seed)` → 逐字节相同的方案 JSON（服务端单线程启发式）。
  跨引擎（CP-SAT vs Rust）不要求一致，只比较合法性与目标值（SRS §4 明确）。

---

## 5. 指标口径（前后端必须一致）

| 指标 | 字段 | 口径 |
|------|------|------|
| 建模耗时 | `metrics.compile_ms` | PlanProblem → 内部模型（不含 JSON 解析？**含**，见下注） |
| 首解时间 | `metrics.first_feasible_ms` | 从求解开始到首次得到完整可行排程 |
| 总求解耗时 | `metrics.solve_ms` | 含构造 + 局部修复，受时间预算约束（可能略超，见下） |
| 峰值内存 | `metrics.peak_memory_bytes` | 引擎进程内统计分配器峰值（WASM 侧为线性内存峰值） |
| 验证耗时 | `metrics.verify_ms` | 独立校验器耗时（SRS §4 要求单列） |
| 总耗时 | `metrics.total_ms` | 建模 + 求解 + 校验 + 序列化 |
| 时间可用性 | `metrics.time_metrics_available` | 浏览器无法采集时间时为 `false`，此时各耗时字段为 `null` |
| 解质量 | `objective.best_bound` / `relative_gap` | 弱下界与相对差距；**不代表最优性证明** |
| 是否可发布 | `verified` + `violations` | `verified=true` 且零 error 级违约才可进入审批 |

注：`compile_ms` 从“字节流解析”之后开始计（进程启动与文件 I/O 不计）；
`time_limit_ms` 是**协作式预算**，在规则/迭代/重启边界检查，故 `solve_ms` 可能超出预算约 10%（2400 工序实测）。

---

## 6. 错误码落点速查

| 场景 | 引擎返回 | 平台建议 HTTP |
|------|----------|----------------|
| 字段缺失/类型错/未知引用/P1 越界 | `MODEL_INVALID` + `issues[]`（`$.orders[0].release_at` 形式） | 422 |
| 规模/特性超出引擎能力 | `UNSUPPORTED_CONSTRAINT` + `SCALE_EXCEEDED` | 409 或 422（附可用后端） |
| 无解且可构造证明 | `INFEASIBLE` + 证书（`NO_ELIGIBLE_WORKER` 等） | 200（业务结论）+ 前端展示证书 |
| 预算内未找到解 | `NO_SOLUTION_FOUND` / `UNKNOWN` | 200（业务结论），保留既有计划 |
| 自检失败 | `UNKNOWN` + `verified=false` + `ENGINE_SELF_CHECK` | 500，禁止发布 |
| 快照不一致 | `SNAPSHOT_MISMATCH` | 409 `STALE_SNAPSHOT`（平台权威码） |
| 跨租户 | `TENANT_MISMATCH` | 404/403（不得泄漏存在性） |
| 取消 | `CANCELLED` + `CANCELLED_WITH_INCUMBENT`（警告级） | 200 作业态 `cancelled` |

---

## 7. 最小 Go 侧伪代码

```go
// 1) 校验
out, code := runAps("validate", "--problem", snapshotPath, "--json")
if code == 3 { return unprocessable(out) }

// 2) 幂等 + 提交
key := hash(solveRequestId, problemHash, strategy, seed, engineVersion)
if job := store.FindByKey(key); job != nil { return job.ID }

// 3) 求解（带超时；超时发 SIGTERM 并标记 cancelled）
res := runApsWithTimeout(ctx, timeLimit+grace,
    "solve", "--problem", snapshotPath, "--out", resultPath,
    "--strategy", strategy, "--seed", seed, "--time-limit-ms", limit, "--json")

// 4) 核验（必做；不等于“求解器自检”）
v, vcode := runAps("verify", "--problem", snapshotPath, "--solution", resultPath, "--json")
if vcode == 8 { job.Fail(v); return conflict(v) }

// 5) 入库（含 problem_hash / engine_version / options / metrics），随后进入审批
job.Complete(resultPath, v)
```

要点：**永不**把 `unknown`/`failed` 的求解结果直接发布；**永不**跳过第 4 步；
**永不**在平台层自行“修好”违约方案——违约必须回到用户或重新求解。
