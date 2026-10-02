# Algorithm Delivery (算法外包交付仓库)

本项目为独立的算法外包交付与验收仓库，用于集中管理各类独立算法模块（排程、求解、寻路、运筹优化等）的规格说明（SRS）、接口契约（Contracts）、Mock 数据集与验收测试工具。

**本项目与主业务系统物理隔离，作为纯算法交付件独立演进与版本管理。**

---

## 模块目录

### 1. [APS 高级计划与排程引擎](aps/README.md) (`aps/`)
- **需求说明书 (SRS)**：[APS-SRS.md](aps/APS-SRS.md)
  - 核心定义：`PlanProblem v1`、`PlanSolution v1`、`SolverCapabilities v1` 领域中立规划契约
  - 交付边界：React 工作台甘特图、OR-Tools CP-SAT 求解后端、Rust WASM/Native 独立校验与局部启发式
- **接口契约**：[contracts/](aps/contracts/)（JSON Schema 2020-12 与求解示例）
- **基准场景与 Mock**：[mock/](aps/mock/)（车间基准 baseline、故障、缺料、无解、稳定性等场景）
- **自动化验收与反例测试**：[tests/](aps/tests/)（结构合法性、参考可行解、7组约束破坏反例、规模压测生成器）

---

## 快速运行与测试

进入对应模块目录运行验证脚本：

```bash
cd aps
python3 generate_mock.py
python3 contracts/make_schemas.py
python3 tests/verify_mock.py
python3 tests/generate_benchmark.py --operations 240 --out /tmp/aps-240.json
```
