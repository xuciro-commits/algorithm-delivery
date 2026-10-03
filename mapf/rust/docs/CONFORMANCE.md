# 契约符合性（Conformance）

五份 JSON Schema 2020-12（`mapf/contracts/`，由 `make_schemas.py` 与引擎白名单同源生成）：

| 文档 | 版本 | 生产者 → 消费者 |
|---|---|---|
| `mapf-problem.schema.json` | `mapf-problem/1.0` | 集成方 → 引擎输入（whitelist：未知字段即拒绝） |
| `mapf-solution.schema.json` | `mapf-solution/1.0` | 引擎 → 集成方（**含错误路径**：INVALID_INPUT/UNSUPPORTED 输出也符合同一 schema） |
| `mapf-verify.schema.json` | `mapf-verify/1.0` | verifier → 任何人（`mapf verify` 独立输出；求解输出内嵌同构 `verify` 块） |
| `mapf-capabilities.schema.json` | `mapf-capabilities/1.0` | `mapf capabilities` / WASM `mapf_capabilities()` |
| `mapf-bench-manifest.schema.json` | `mapf-bench-manifest/1.0` | 基准清单（`gen_manifest.py` 生成，bench 子命令消费） |

## 符合性等级（对外承诺）

1. **输入**：通过 `mapf-problem/1.0` 的文档，引擎保证进入求解（超限除外——以
   `E-CAP-*` 结构化拒绝，绝不静默截断）；未通过者返回逐条 `errors[]`（code/path/message，
   见 ERROR-CODES.md），永不 panic、永不部分求解。
2. **输出**：`mapf solve` 的 stdout/`--out` **恒**符合 `mapf-solution/1.0`；
   `robots[].path` 与 `arrival/steps` 自洽；`verified=true` 当且仅当独立 verifier 全过。
3. **语义版本**：schema_version 是文档的一部分——新增字段属兼容演化，删除/改类型/
   改语义必须升版本号；引擎对不认识的 `schema_version` 报 `E-MAPF-SCHEMA` 而非猜测。

## 校验器与测试

- `python3 mapf/rust/scripts/check_contracts.py` —— 零依赖（内置 schema 子集解释器），
  36 项断言：五 schema 自洽、13 个 mock 全部符合 problem/1.0、引擎对 m01/m02/m05/m10
  的真实输出符合 solution/1.0 且 `verified=true`、错误路径（m07/m07b）符合契约、
  两档 capabilities 符合契约、bench manifest 符合契约、四组对抗样例必须被拒绝、
  M11 篡改方案必须被 verifier 拒绝（错误码集合断言）。CI 每 PR 必跑。
- **JSON Schema 之外的语义校验**由 `src/problem.rs` 白名单 + `src/verify.rs` 双层完成
  （schema 管形状，引擎管语义：唯一性、可达性、快照一致性、界证明合法性）。
- 独立复算：任何人可对 `(problem, solution)` 跑 `mapf verify`（或 CLI 之外自行实现
  verifier——规则以 MODEL-MATH.md §2/§3/§6 为准绳），不信任求解器输出是验收前提。

## 兼容性说明（实现自由度）

- `notes`、`metrics.*`、`search.*` 为诊断块：消费者不得据其做业务判定；
- `errors[].message` 为人类文本（中文），**不参与**机器判定——机器判定用 `code`；
- 指纹（`semantic_digest`/`fingerprint`）跨版本不承诺相等（引擎版本变化即变），
  同版本内承诺确定性；`problem_hash` 绑定问题本体，供幂等与审计。
