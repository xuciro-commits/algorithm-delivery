# 性能与规模实测（BENCHMARKS）

> 本文记录**本交付件在给定机器上的实测数据与口径**。SRS §7 要求基准种子的可复现性，
> `tests/acceptance.json` 固定了规模 `[24, 240, 2400]` 与种子 `[42, 73, 2026]`。

## 1. 复现方式

```bash
cd aps/rust
cargo build --release
bash scripts/run_benchmarks.sh 3 2000          # 3 次/规模/种子，时间预算 2000 ms
# 原始 JSON 落在 target/bench/bench-<规模>-seed<种子>.json
```

- 24 工序 = `aps/mock/baseline.json` 本身；
- 240 / 2400 = 引擎 `benchgen` 生成（与 `aps/tests/generate_benchmark.py` **逐字节一致**，见 §4）；
- 每次运行 `--seed` 固定，结果**逐字节可复现**（同 seed/同参数/同输入）。

## 2. 实测环境

| 项 | 值 |
|----|----|
| CPU | Intel Xeon @ 2.60 GHz，2 vCPU |
| 内存 | 3.8 GiB |
| 系统 | Debian GNU/Linux 12 (bookworm) |
| 工具链 | rustc 1.88.0 (6b00bc388 2025-06-23) |
| 构建 | `--release`，`opt-level=3`、`lto=true`、`codegen-units=1`、`strip=debuginfo` |
| 依赖 | 0（无第三方 crate） |

> 说明：这是**交付沙箱**的通用虚拟机，不是生产服务器；数字用于回归对比，不构成 SLA。

## 3. 结果（每格 `runs=3` 的中位数/均值；预算 2000 ms）

| 规模(工序) | seed | 编译中位(ms) | 首解均值(ms) | 求解中位(ms) | 总计中位(ms) | 峰值内存(MB) | 状态 | 加权延期 | makespan | 下界 | 相对差距 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 24 | 42 | 0.1 | 0.1 | 2000.0 | 2000.7 | 0.34 | FEASIBLE | 0 | 1560 | 270 | 4.78 |
| 240 | 42 | 1.2 | 4.7 | 2000.2 | 2006.3 | 3.34 | FEASIBLE | 0 | 1590 | 270 | 4.89 |
| 2400 | 42 | 17.6 | 447.1 | 2228.1 | 2312.4 | 33.64 | FEASIBLE | 0 | 1590 | 270 | 4.89 |
| 24 | 73 | 0.2 | 0.1 | 2000.0 | 2000.8 | 0.34 | FEASIBLE | 0 | 1560 | 270 | 4.78 |
| 240 | 73 | 1.2 | 4.7 | 2000.1 | 2006.3 | 3.34 | FEASIBLE | 0 | 1590 | 270 | 4.89 |
| 2400 | 73 | 17.3 | 451.7 | 2252.0 | 2338.5 | 33.64 | FEASIBLE | 0 | 1590 | 270 | 4.89 |
| 24 | 2026 | 0.1 | 0.1 | 2000.0 | 2000.8 | 0.34 | FEASIBLE | 0 | 1560 | 270 | 4.78 |
| 240 | 2026 | 1.3 | 4.9 | 2000.1 | 2006.4 | 3.34 | FEASIBLE | 0 | 1590 | 270 | 4.89 |
| 2400 | 2026 | 17.7 | 446.1 | 2245.1 | 2322.4 | 33.64 | FEASIBLE | 0 | 1590 | 270 | 4.89 |

**读法**

- `编译`（PlanProblem → 内部模型）在 2400 工序下仍 < 20 ms；
- **首解**（构造阶段完成）240 工序约 5 ms，2400 工序约 0.45 s —— 这是用户等待的关键指标；
- `求解中位 ≈ 时间预算`：启发式会一直做 ruin & recreate / 重启直到预算耗尽或证明最优，
  这是设计行为，不是性能缺陷；**关注 `first_feasible_ms` 而不是 `solve_ms`**。
- 2400 工序的 `总计` 略超预算（+6% ~ +17%）：预算检查在规则/迭代/重启边界，
  单次构造/单轮左移不可抢占。需要硬实时请把预算按比例下调。
- 峰值内存 ≈ 14 KB/工序（0.34 MB@24 → 3.34 MB@240 → 33.6 MB@2400），线性可预测。

## 4. 与 Python 生成器的等价性（回归断言）

```bash
python3 ../tests/generate_benchmark.py --operations 240 --out /tmp/py240.json
cargo run --release -- --manifest-path Cargo.toml benchmark \
    --baseline ../mock/baseline.json --operations 240 --out /tmp/rs240.json
python3 - <<'PY'
import json
a=json.load(open('/tmp/py240.json')); b=json.load(open('/tmp/rs240.json'))
print(json.dumps(a,sort_keys=True)==json.dumps(b,sort_keys=True))   # True
PY
```

## 5. WASM 侧（wasm-light 档位）

| 项 | 值 |
|----|----|
| 产物 | `dist/aps_engine.wasm`，约 **576 KiB**（590234 字节，未做 wasm-opt） |
| 规模上限 | 600 工序（超出返回 `UNSUPPORTED_CONSTRAINT` + `SCALE_EXCEEDED`） |
| 24 工序首解 | 与 native 相同（同一份源码）；1 s 预算下总耗时 ≈ 1.03 s |
| 峰值内存 | 0.22 MB @ 24 工序（无 WASM 线性内存预分配浪费） |
| 时间来源 | 宿主注入 `env.aps_now_ms()`（`performance.now()`），否则时间指标不可用 |

浏览器端建议只做“局部调整 + 即时校验”，全局排程交给服务端 native 档位（SRS §0 定位）。

## 6. 已知的规模相关缺陷（已修复，留作回归）

| 缺陷 | 现象 | 修复 |
|------|------|------|
| JSON 解析退化 O(n²) | 2400 工序 PlanProblem（3.2 MB）解析 90 s，且不在 `total_ms` 计时区间内，表现为“命令很慢但指标很快” | `src/json.rs::parse_string` 不再对“剩余全文”反复做 `from_utf8`，改为仅解码当前字符；回归测试 `json::tests::parsing_large_document_stays_linear` |

修复后同一文档解析 **29 ms**（约 3000×），2400 工序全流程 `aps validate` 从约 90 s 降到 < 0.1 s。

## 7. 口径与免责

- 本基准使用 `tests/generate_benchmark.py` 的**独立车间单元复制**结构：它压测的是模型规模、
  序列化与 API 吞吐，**不能**作为耦合调度难度基准（该文件的注释同样声明了这一点）。
- 交付包不包含 OR-Tools 基线服务，`aps/README.md` 建议的“先获得可信 OR-Tools 基线再对比质量”
  不在本期 Rust 交付范围内；引擎给出的**弱下界**只用于诚实标注质量，不代表最优值。
- 同一规模下不同种子结果一致，说明实例结构（独立单元）对随机性不敏感；真实耦合车间请以现场数据复测。
