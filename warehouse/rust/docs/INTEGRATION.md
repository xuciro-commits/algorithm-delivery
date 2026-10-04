# 集成指南（业务系统 / 实验室 / 其它引擎）

三种集成方式，按耦合度从低到高：**CLI（进程）→ WASM（浏览器/Node）→ Rust 库（同进程）**。

## 1. 方式一：CLI（推荐给后端批处理）

```bash
warehouse solve --in problem.json --options options.json --out result.json
warehouse verify --in verify-doc.json --out report.json     # 独立核验
warehouse generate --scenario D04 --scale small --out problem.json
```

* 输入输出都是契约 JSON（`warehouse/contracts/*.schema.json`），可写进任何语言的流水线；
* 退出码即状态语义（§USAGE），便于 shell / 调度器判断；
* 大结果用 `--out` 写文件；stdout 只用来取 JSON 的场景（小规模）请配 `includeTimeline:false`。

### 业务系统接入的最小约定

1. **谁生成问题**：上游把拓扑、SKU、库存、任务、动态事件按契约组装；不要自己算库位数量；
2. **谁读结果**：读 `result`（方案）+ `metrics`（指标）+ `verification`（可交付性）；
   只有当 `verification.ok === true` 时才允许下游使用该方案；
3. **可复现**：把 `fingerprint` 存进业务库，便于"同一输入同一版本"的审计复算；
4. **拒绝假解**：`status ∈ {INFEASIBLE_PROVEN, NO_SOLUTION_FOUND, INVALID_INPUT, UNSUPPORTED, INTERNAL_ERROR}`
   一律不得进入执行环节。

## 2. 方式二：WASM（浏览器 / Node）

```js
import { createEngine } from './warehouse-worker.js';
const engine = await createEngine(new URL('./warehouse_engine.wasm', import.meta.url));
const { status, envelope } = engine.solve(problemText, { includeTimeline: true });
const { report } = engine.verify(JSON.stringify({ kind: 'asrs', problem, timeline: envelope.timeline }));
```

* 浏览器里必须放在 Web Worker 中（`installWorker` / `spawnSolver` 已封装）；
* wasm 档位上限由 `engine.capabilities()` 声明；面板应在生成场景前用它做拦截；
* 取消 = `terminate()` + 重建（`spawnSolver.cancel()`）；重建时传入主线程预编译的
  `WebAssembly.Module` 可省一次编译。

## 3. 方式三：Rust 库（同进程）

```rust
use warehouse_engine::{contract::parse_asrs_problem, asrs, engine};

let root = aps_engine::json::parse(&text)?;
let mut issues = warehouse_engine::errors::Issues::new();
let problem = parse_asrs_problem(&root, &mut issues);
let events = warehouse_engine::contract::parse_dynamic_events(&root);
let options = asrs::AsrsOptions::from_json(None);
let outcome = asrs::solve(&problem, &events, &options, &mut issues);
```

* 结果里的 `Json` 来自 `aps-engine::json`（自研、插入序稳定、`canonical()` 可复现）；
* 时间来自 `aps_engine::clock::now_ms()`（native 用 `Instant`，wasm 用宿主注入）；
* 峰值内存用 `aps_engine::alloc::peak_bytes()`（**不要**在依赖库里注册 `#[global_allocator]`，
  会与宿主冲突——本仓库踩过一次，记录在 `DELIVERY.md`）。

## 4. 与实验室（`lab/`）的集成

```
lab/scripts/sync-warehouse.mjs
  warehouse/rust/dist/warehouse_engine.wasm → lab/public/wasm/warehouse_engine.wasm
  warehouse/rust/web/warehouse-worker.js    → lab/src/vendor/warehouse-worker.js
  warehouse/mock/*.json                     → lab/public/mock/warehouse/*.json
  → lab/public/warehouse-manifest.json（sha256 + 字节数 + 引擎版本 + 场景数）
```

* 产物不入库（`.gitignore` 已覆盖 `lab/public/{wasm,mock}`、`lab/src/vendor`），
  与 aps / mapf / agv 一致；
* 面板只通过 `lab/src/core/warehouse/*` 访问引擎，不自己算指标；
* 场景选择器 / 规模档位来自 `engine.scenarios()`，与 CLI 同源。

## 5. 与其它引擎的边界

* 只复用 `aps-engine` 的**契约无关基础件**（JSON / SHA-256 / 时钟 / 内存统计）；
* 不共享 `agv` / `mapf` 的路径、调度、栅格结构——立库有自己的图与资源模型
  （巷道层内互斥、井道互斥、深位倒垛）；
* 若将来要做"AGV 在库前区接驳"的联合，走**契约级**集成：把 AGV 的到站时间作为
  立库任务的 `release_s` / 站台可达时间输入，由仓库侧重新求解，而不是共享内部状态。
