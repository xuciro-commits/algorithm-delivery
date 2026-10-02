# APS 平台级规划引擎 — 乙方交付包

包含：

- `APS-SRS.md`：需求说明书与合同验收范围。
- `mock/baseline.json`：基础完整车间场景（8 订单、24 工序、设备、人员、库存、日历与模具）。
- `mock/*.json`：由基础场景变更而来的故障、缺料、无解、稳定性场景。
- `contracts/plan-result.example.json`：统一求解结果格式。
- `tests/acceptance.json`：可机器读取的场景与验收断言。

所有数据均为 **Mock**，不代表真实车间。时间采用 ISO 8601 带时区的输入日期，在模型编译层转换为从规划起点开始的整数分钟。订单数量本版不拆分；每个工序的 `duration_min`、`materials` 均为整个订单批次的数据，严禁再次乘以订单 `quantity`。

建议：先跑通基准 OR-Tools 服务并获得可信解，再完成 Rust WASM 的局部调整，不要求乙方一开始重写 CP-SAT。
- `contracts/*.schema.json`：PlanProblem、PlanSolution、SolverCapabilities 的 JSON Schema 2020-12；JSON Schema 验证之外还必须做跨对象引用和语义验证。
- `generate_mock.py`：稳定地重新生成基础 Mock 和基准可行排程。
- `tests/baseline-feasible-witness.json`：构造性参考可行解（未做最优性证明）。
- `tests/verify_mock.py`：独立 Mock 与参考方案检查，附 7 组故意破坏的约束反例；仅作乙方开发时的测试参考，生产级 verifier 须由乙方以 Rust 实现。
- `tests/generate_benchmark.py`：24 / 240 / 2400 工序规模生成器（通过**相互独立的车间单元**复制；用于模型大小及 API 压测，**不能**作为复杂耦合排程难度基准）。

## 运行

```bash
python3 generate_mock.py
python3 contracts/make_schemas.py
python3 tests/verify_mock.py
python3 tests/generate_benchmark.py --operations 240 --out /tmp/aps-240.json
```

开发依赖：Python 3.10+；`verify_mock.py` 可选安装 `jsonschema` 以额外校验 JSON Schema。无须安装 OR-Tools，即可检查 Mock、构造性可行排程和故意破坏的解。**这些脚本并未运行 OR-Tools，也未证明参考方案最优**。
