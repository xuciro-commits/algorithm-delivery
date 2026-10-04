# rust-warehouse（仓储优化套件引擎）

仓储库位优化 + 密集立库联合调度的 Rust 核心。
需求基准：[`../WAREHOUSE-SRS.md`](../WAREHOUSE-SRS.md)；溯源表：[`docs/CONFORMANCE.md`](docs/CONFORMANCE.md)。

```
src/
├── lib.rs            引擎元信息（名称 / 版本 / 规则集版本）
├── main.rs           CLI：solve / verify / generate / scenarios / acceptance / bench / diagnose / capabilities / codes / version
├── engine.rs         信封组装（指纹、指标、时间线、验证、退出码）
├── contract.rs       契约解析（拓扑 / SKU / 库存 / 任务 / 事件 / 三个问题域）
├── errors.rs         错误码、状态语义（10 个状态 + code()）、Issues
├── capabilities.rs   native / wasm-light 档位能力
├── scenario.rs       86 个标准场景（S/D/E/J/X）+ 规模档位 + 合成数据
├── acceptance.rs     验收套件（6 类判据 + shows: 现象断言）
├── bench.rs          10 个基准用例
├── verify.rs         独立验证的文档入口（slotting / asrs / joint）
├── joint.rs          联合优化闭环（库位 × 调度 × 反馈 + Pareto）
├── wasm_api.rs       wasm32 C ABI（wh_*）
├── util.rs           四舍五入 / 距离等小工具
├── wh/
│   ├── topology.rs   拓扑生成、库位推导、最短路（二叉堆 Dijkstra / 目标即停）
│   ├── routing.rs    路由模型、梯形速度曲线、库位成本、可达性
│   └── catalog.rs    SKU / 库存 / 订单合成
├── slotting/
│   ├── mod.rs        库位模型、目标与约束、指标
│   ├── strategies.rs 16 个算法名（8 个基础对照策略 + 元启发式）
│   ├── search.rs     ALNS / LNS / 禁忌 / 模拟退火 / 爬山
│   ├── multiobj.rs   NSGA-II + Pareto
│   ├── robust.rs     多情景鲁棒与稳定性
│   ├── dynamic.rs    事件驱动的动态再优化（搬迁预算）
│   └── verify.rs     库位方案的独立核验
└── asrs/
    ├── mod.rs        调度入口（含求解器自检汇总）
    ├── network.rs    运行网络、资源命名、时空预约表（位置桶索引）
    ├── solver.rs     推演核心（分配/排序/无冲突路径/交接/双指令/倒垛/事件）
    ├── timeline.rs   时间线结构（设备步骤 / 任务状态 / 缓存与库位状态）
    └── verify.rs     调度方案的独立核验（时间一致性 / 互斥 / 台账 / 深位）
```

## 构建与自检

```bash
export PATH=/opt/rust/bin:$PATH
cargo build --release                 # 零第三方依赖（仅仓库内 aps-engine 路径依赖）
./target/release/warehouse capabilities
./target/release/warehouse scenarios | python3 -c "import json,sys;print(len(json.load(sys.stdin)))"
bash scripts/build_wasm.sh            # → dist/warehouse_engine.wasm（+ Node 冒烟）
python3 scripts/check_contracts.py    # schema 防漂移 + mock + 输出 + 对抗样例
```

## 目录约定

| 目录 | 内容 |
| --- | --- |
| `docs/` | USAGE（命令与参数）/ INTEGRATION（三种集成方式）/ CONFORMANCE（需求追溯）/ MODEL-MATH（公式口径）/ DEPENDENCIES（SBOM）/ BENCHMARKS（基准与实测）/ DELIVERY（交接与验证现状） |
| `scripts/` | `build_wasm.sh`、`smoke_wasm.mjs`、`check_contracts.py` |
| `web/` | `warehouse-worker.js`（浏览器与 Node 通用，手写 C ABI 绑定） |
| `../contracts/` | 6 份 JSON Schema（由 `make_schemas.py` 生成，防漂移） |
| `../mock/` | 可直接求解的问题文档（引擎自身生成，供冒烟 / 契约 / 实验室） |

## 硬约束（改代码前必读）

1. 零第三方依赖；`cargo tree` 只应有两个包。
2. `std::time::Instant` 在 wasm32 上 panic —— 调试计时用 `engine::prof_now()`。
3. 库位由拓扑推导，**不要**把 `derive_locations` 放进任务循环（D16/D17 卡死的根因）。
4. 验证器独立：不调用求解器内部状态，只读契约与时间线。
5. 状态语义不得合并；只有给出证明才能声明 `INFEASIBLE_PROVEN` / `OPTIMAL_PROVEN`。
