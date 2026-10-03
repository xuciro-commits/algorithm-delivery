# 集成手册（CLI / Rust / 浏览器 / 实验室）

## 1. 服务端 / 边缘进程（native CLI）

```bash
mapf solve job.json --out sol.json          # 契约化 JSON in/out，进程退出码恒 0（除非 I/O 错）
mapf verify job.json sol.json --strict      # 业务侧可只信 verify（独立复核，含 problem_hash 绑定）
```

推荐编排：**提交 → solve → verify → 下发**。执行前现场再 verify 一次可拦截
“排队期间地图/任务被改”的过期方案（`problem_hash` 不一致即 `E-HASH-MISMATCH`）。

## 2. Rust 宿主

依赖内部路径 crate（无第三方）：`mapf-engine = { path = "mapf/rust" }`

```rust
use mapf_engine::engine::{self, CancelToken, SolveOptions};
use mapf_engine::problem::Objective;

let cancel = CancelToken::new();          // 跨线程 cancel() 即协作式中断 → CANCELLED
let opts = SolveOptions {
    objective: Some(Objective::Makespan),
    time_limit_ms: Some(2000),
    w: Some(1.2),
    seed: Some(42),
    verify: true,
    ..Default::default()
};
let outcome = engine::solve_json(problem_text, &opts, &cancel);
// outcome.status / outcome.solution_json（始终符合 mapf-solution/1.0）
```

要点：不要绕过 `problem::parse` 构造内部结构；`solve_json` 不 panic 是接口承诺，
任何异常输入以 `errors[]` 返回。

## 3. 浏览器（Web Worker）

产物：`mapf_engine.wasm`（`bash mapf/rust/scripts/build_wasm.sh`，CI 由 mapf-quality 构建）
+ 胶水 `mapf/rust/web/mapf-worker.js`（手写 C ABI，无 wasm-bindgen）。

```js
import { spawnSolver } from './mapf-worker.js';
const wasm = new WebAssembly.Module(await (await fetch('mapf_engine.wasm')).arrayBuffer());
const solver = spawnSolver(new URL('./mapf-worker.js', import.meta.url), { wasm });

const r = await solver.solve(problemText, { objective: 'soc', time_limit_ms: 3000, suboptimality_factor: 1.5 });
// r.solution 已解析；r.raw 是引擎原文 —— 指纹与核验必须用 r.raw（重序列化会破坏指纹）
solver.cancel();          // 即时取消 = terminate + 自动重建（同步求解不可被消息打断）
solver.dispose();         // 组件卸载
```

`options` 支持键：`time_limit_ms / seed / suboptimality_factor / planner / objective / verify / solution_id`。
能力档位：wasm 内固定 `wasm-light`（`solver.capabilities()` 自描述；超限输入得到
`E-CAP-LIMIT-*` 的 INVALID_INPUT，而非半途崩溃）。

## 4. 实验室（GitHub Pages）

装配链（`lab/scripts/sync-mapf.mjs`，单一来源、杜绝手改副本）：

```
mapf/rust/dist/mapf_engine.wasm ─┬→ lab/public/wasm/mapf_engine.wasm
mapf/rust/web/mapf-worker.js ────┼→ lab/public/wasm/mapf-worker.js   （Worker 入口）
                                 └→ lab/src/vendor/mapf-worker.js    （主线程胶水，.d.ts 在库内）
mapf/mock/m*.json（问题文件）─────→ lab/public/mock/ + mapf-manifest.json（sha256 清单）
```

- `npm run sync`（prebuild/predev 自动）= `sync-engine.mjs && sync-mapf.mjs`；
  sync-mapf 在构建期用 vendored 胶水**真跑** m01（OPTIMAL & soc=6 & verified）才放行；
- 模块注册：`lab/src/modules/mapf/`（id `path-planning`，status ready）；
  面板 = 数据集卡片 + 参数区 + 时空回放 Canvas + 指标/核验带（`useMapfEngine` 挂 Worker 生命周期）；
- 部署校验：`npm run test:dist`（两引擎 wasm 与清单 sha256 对齐）与
  `npm run test:pages`（子路径仿真中，页面同源字节实例化两引擎并各自求解一单）。

## 5. CI 与 Release

- 质量门：`.github/workflows/mapf-quality.yml`（fmt / clippy -D warnings / test /
  acceptance --json 全过 / 契约 / 基准快跑硬门 / wasm 冒烟 / 取消回归 →
  artifact `mapf-engine-artifacts`）；
- 触发器：`mapf-rust.yml`（push/PR paths 含 mapf 与 aps/rust）；`lab.yml` 依赖
  `mapf-quality` 并把其产物装配进 Pages 构建；
- 正式 Release（`v*` tag）：`mapf-linux-x86_64-unknown-linux-gnu.tar.gz`、
  `mapf-linux-aarch64-unknown-linux-gnu.tar.gz`、`mapf-engine-wasm32-unknown-unknown.wasm`
  与 APS 产物同批发布（统一 SHA256SUMS）。

## 6. 故障排查

| 症状 | 定位 |
|---|---|
| 浏览器报 “缺 mapf_alloc/mapf_solve” | 用了旧 wasm：重跑 build_wasm.sh（胶水按导出名探测） |
| `wasm 产物魔数不是 \0asm` | 下载被 HTML 兜底页污染（Pages base 配置） |
| Worker 握手超时 | `public/wasm/mapf-worker.js` 未被 sync 装配（先 npm run sync:mapf） |
| solve 返回 ABI_ERROR | 输入不是 UTF-8 JSON 文本（胶水层错误，未到引擎） |
| 结果 `verified:false` 且状态 UNKNOWN | 引擎输出未过自检（属引擎缺陷）——带 `problem_hash` 上报并附 raw |
