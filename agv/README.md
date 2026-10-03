# AGV 多车调度引擎 — 交付包

面向仓储 AGV 场景的 **任务分配 + 联合路径 + 工作站容量 + 动态重调度** 求解与核验交付件：
同一份零第三方依赖 Rust crate（复用 `aps-engine` 基础设施与 `mapf-engine` 联合路径内核，
均为仓库内路径依赖）产出 native CLI `agv` 与 `wasm32-unknown-unknown` 模块（浏览器
Web Worker 直接调用），实现 **问题契约校验**、**insertion-ls 调度（MAPF 内核联合路径）**、
**独立方案核验** 三件事。所有数据均为 Mock，不代表真实场地。

## 目录

- `AGV-SRS.md`：需求规格（问题模型 / 硬约束 §2.6 / 优化目标 §2.7 / 验收 §7 / 动态 §4）。
- `mock/a01…a13 + warehouse-b01.json`：13 个固定样例（单车单任务 / 多车多任务 / 释放等待 /
  优先级 / 工作站容量 / 走廊对穿 / 同站多次服务 / 动态任务追加 / 动态车辆暂停 /
  动态障碍重规划 / 紧预算 / 仓储综合）。每个文件自带 `tags.{name,description,expect}`，
  实验室数据卡片直接读取；`agv mocks` 命令从引擎确定性再生成（单一事实来源）。
- `contracts/*.schema.json`：`agv-dispatch-problem/1.0`、`agv-dispatch-solution/1.0`、
  `agv-dispatch-verification/1.0`、`agv-dispatch-capabilities/1.0`
  （JSON Schema 2020-12，由 `contracts/make_schemas.py --out` 生成，支持防漂移比对）。
- `rust/`：引擎本体（调度 / MAPF 集成 / 动态展开 / 指标 / 独立核验器 / 验收套件）。
- `rust/web/agv-worker.js`：手写 C ABI 胶水（Worker 协议 / 取消 = terminate + 重建 /
  verify / fingerprint / capabilities 分析导出）。
- `rust/scripts/`：`build_wasm.sh`（可复现 wasm 构建 + ABI 冒烟）、`smoke_wasm.mjs`、
  `test_worker_cancel.mjs`、`check_contracts.py`（45 项零依赖 schema 校验 + 引擎输出对照）。
- `rust/docs/`：`ACCEPTANCE.md`（A01–A16 验收结论 + 基准表）、
  `acceptance-results.json`、`benchmark-results.json`（机器可读）。
- 实验室装配：`lab/scripts/sync-agv.mjs` + `lab/src/core/agv/*` +
  `lab/src/modules/agv/*`（`agv-dispatch` 槽位从“待接入”变为可运行）。

## 状态语义（ABI 状态码）

`1=FEASIBLE 2=PARTIAL 3=UNKNOWN 4=INFEASIBLE 5=INVALID_INPUT 6=UNSUPPORTED 7=CANCELLED 0=ABI 错误`；
时钟由宿主注入 `env.aps_now_ms`（预算诚实，可测）。

## 核验报告（agv-dispatch-verification/1.0）

```
{ schema_version, mode: "full"|"full+strict", ruleset_version, ok,
  counts: {total, passed, failed},
  checks: [{name: "<group>/<check>", ok}],
  violations: [{code: "E-…", constraint, severity, message, vehicles?, tasks?, at_step?, cell?}],
  recomputed: {completed_tasks, flow_time_total, makespan} | null }
```

`ok=true` 当且仅当全部检查通过；失败项逐条出现在 `violations`（SRS §2.6 的 1–9 逐条 +
时间线连续性 / 障碍 / 顶点边冲突 / 站容量 / 指标复算）。**MAPF 验证通过 ≠ AGV 验证通过：
两层分别报告**（`plan.vehicles[].timeline` 逐格时间线由本核验器独立重演）。

## 运行

```bash
cd rust
cargo build --release && cargo test --lib     # 单元 + 验收套件（29 项，含 A01–A16）
./target/release/agv acceptance               # A01–A16 一键验收（16 案例）
./target/release/agv bench                    # B01–B03 基准（B01 8 车 20 任务 40×25）
./target/release/agv solve ../mock/a10-dynamic-task-add.json --out /tmp/s.json
./target/release/agv verify ../mock/a10-dynamic-task-add.json /tmp/s.json
./target/release/agv mocks --out ../mock      # 确定性再生成 mock（单一事实来源）

# 契约符合性（45 项：schema 防漂移 / 13 mock / 引擎输出 / verify 报告 / 对抗样例）
python3 ../contracts/make_schemas.py          # 再生成 schema（改动字段后必跑）
python3 scripts/check_contracts.py

# WASM + 冒烟 + 取消语义（本地与 CI 同一入口）
bash scripts/build_wasm.sh                    # 末尾自动跑 smoke_wasm.mjs
node scripts/test_worker_cancel.mjs

# 实验室（同步产物 → 类型检查 → 构建 → AGV 集成测试）
cd ../lab
npm run sync:agv && npm run typecheck && npx vite build
npm run test:agv        # 场景内核 + 13 mock roundtrip + 真实 WASM 集成断言
```

## 质量门（CI）

`agv-rust.yml` → `agv-quality.yml`（对 aps/mapf 同一方法论）：SBOM 最小审计（仅
aps-engine/mapf-engine 路径依赖，第三方 = 0）→ rustfmt → clippy -D warnings →
release 测试 → A01–A16 验收 → 契约符合性 → B01–B03 基准 → WASM 构建 + ABI 冒烟 →
Worker 取消/终止/重建回归 → 产物上传（供 Lab 与 Release 使用）。
