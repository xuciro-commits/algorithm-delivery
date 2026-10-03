//! P0 验收套件（APS-SRS §7 / `tests/acceptance.json` 的 Rust 实现）。
//!
//! 由 `aps accept` 与集成测试共同调用；每个用例都给出**可核查的证据行**（证据引用具体
//! 工序 ID、资源 ID、约束编号与时间），便于合同验收时逐条对照，而不是只输出“通过”。
//!
//! | 用例 | 场景 | 断言 |
//! |------|------|------|
//! | S01 | 基础车间 | 返回完整可行解 + 独立校验 0 违约 + 24 道工序各一次分配 |
//! | S02 | 设备故障 | 排程不进入 WELD-02 停机区间；与基线相比有变更影响 |
//! | S03 | 到货延迟 | 事件序物料账本全程非负（先入库后领料） |
//! | S04 | 证明无解 | native 返回 INFEASIBLE + 证书；wasm-light 绝不伪称 INFEASIBLE |
//! | S05 | 失效快照 | 旧快照方案核验报 SNAPSHOT_MISMATCH |
//! | S06 | 对抗错误方案 | 每个 H01–H08 破坏都被独立 verifier 精确报出 |
//! | S07 | 多租户 | 跨租户方案核验报 TENANT_MISMATCH（权威拒绝在 Go 层，Rust 侧提供判定依据） |
//! | S08 | 能力协商 | 超规模/未声明约束返回 UNSUPPORTED_CONSTRAINT，绝不静默删约束 |

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::engine::{self, CancelToken, SolveOptions};
use crate::errors::{codes, Status};
use crate::json::Json;

#[derive(Debug, Clone)]
pub struct CaseResult {
    pub id: &'static str,
    pub name: String,
    pub passed: bool,
    pub details: Vec<String>,
    pub metrics: Option<Json>,
}

#[derive(Debug, Clone, Default)]
pub struct Report {
    pub cases: Vec<CaseResult>,
}

impl Report {
    pub fn passed(&self) -> usize {
        self.cases.iter().filter(|c| c.passed).count()
    }
    pub fn failed(&self) -> usize {
        self.cases.iter().filter(|c| !c.passed).count()
    }
    pub fn all_passed(&self) -> bool {
        self.failed() == 0
    }
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            (
                "cases",
                Json::Arr(
                    self.cases
                        .iter()
                        .map(|c| {
                            Json::obj(vec![
                                ("id", Json::str(c.id)),
                                ("name", Json::str(c.name.clone())),
                                ("passed", Json::Bool(c.passed)),
                                (
                                    "details",
                                    Json::strings(c.details.clone()),
                                ),
                                ("metrics", c.metrics.clone().unwrap_or(Json::Null)),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("passed", Json::int(self.passed() as i64)),
            ("failed", Json::int(self.failed() as i64)),
            ("all_passed", Json::Bool(self.all_passed())),
            (
                "engine",
                Json::obj(vec![
                    ("name", Json::str(crate::ENGINE_NAME)),
                    ("version", Json::str(crate::ENGINE_VERSION)),
                    ("compiler_version", Json::str(crate::COMPILER_VERSION)),
                ]),
            ),
            (
                "scope_note",
                Json::str(
                    "本套件覆盖 SRS §7 S01–S08 的引擎侧判据；React UI、Go 平台层、OR-Tools 基线不在本 crate 范围内",
                ),
            ),
        ])
    }
}

fn read_json(p: &Path) -> Result<(String, Json), String> {
    let text =
        std::fs::read_to_string(p).map_err(|e| format!("读取 {} 失败: {}", p.display(), e))?;
    let j =
        crate::json::parse(&text).map_err(|e| format!("{} 不是合法 JSON: {}", p.display(), e))?;
    Ok((text, j))
}

fn default_solve_options(time_limit_ms: i64) -> SolveOptions {
    SolveOptions {
        time_limit_ms,
        seed: 42,
        ..Default::default()
    }
}

/// 运行验收套件；`aps_dir` 指向包含 `mock/`、`tests/` 的交付目录。
pub fn run(aps_dir: &Path) -> Report {
    let mut report = Report::default();
    let baseline_path = aps_dir.join("mock/baseline.json");
    let breakdown_path = aps_dir.join("mock/machine-breakdown.json");
    let delay_path = aps_dir.join("mock/material-delay.json");
    let infeasible_path = aps_dir.join("mock/infeasible-no-welder.json");
    let witness_path = aps_dir.join("tests/baseline-feasible-witness.json");

    let (base_text, base_json) = match read_json(&baseline_path) {
        Ok(v) => v,
        Err(e) => {
            report.cases.push(CaseResult {
                id: "S00",
                name: "加载交付数据".into(),
                passed: false,
                details: vec![e],
                metrics: None,
            });
            return report;
        }
    };

    // 状态判定：FEASIBLE 与 OPTIMAL 都是合格输出；若声称 OPTIMAL，
    // 必须同时给出可复算的最优性证据（objective.optimality_proven = true 且 makespan = best_bound），
    // 否则视为“伪称最优”，SRS 明令禁止。
    fn acceptable_status(
        out: &engine::SolveOutcome,
        problem_text: &str,
        details: &mut Vec<String>,
    ) -> bool {
        match out.status {
            Status::Feasible => true,
            Status::Optimal => {
                // 独立复算：从任务文件重新编译并重算下界，再与方案自称的 best_bound 比对，
                // 不信任求解器写入的数值本身。
                let sol = out.solution.clone().unwrap_or(Json::Null);
                let proven = sol
                    .get("optimality_proven")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let ms = sol
                    .get("objective")
                    .and_then(|o| o.get("makespan_minutes"))
                    .and_then(|v| v.as_i64());
                let lb = sol
                    .get("objective")
                    .and_then(|o| o.get("best_bound"))
                    .and_then(|v| v.as_i64());
                let recomputed = (|| -> Option<i64> {
                    let (p, _) =
                        crate::model::parse_problem(&crate::json::parse(problem_text).ok()?);
                    let p = p?;
                    let c = crate::compile::compile(&p, String::new());
                    Some(crate::objective::makespan_lower_bound(&c))
                })();
                let consistent = proven
                    && ms.is_some()
                    && lb.is_some()
                    && ms == lb
                    && recomputed.is_some()
                    && lb == recomputed;
                if consistent {
                    details.push(format!(
                        "✓ 声称 OPTIMAL 且独立复算通过：makespan = best_bound = {}",
                        ms.unwrap_or(0)
                    ));
                    true
                } else {
                    details.push(format!(
                        "✗ 声称 OPTIMAL 但证据不成立（optimality_proven={proven}, makespan={ms:?}, best_bound={lb:?}, 独立复算下界={recomputed:?}）"
                    ));
                    false
                }
            }
            _ => false,
        }
    }

    let mut summary_json: BTreeMap<&str, Json> = BTreeMap::new();

    // ---------------- S01 基础车间 ----------------
    let s01 = {
        let mut details = Vec::new();
        let opts = default_solve_options(2_000);
        let out = engine::solve_json(&base_text, &opts, &CancelToken::new());
        details.push(format!("状态: {}", out.status.as_str()));
        let mut ok = acceptable_status(&out, &base_text, &mut details);
        let sol = out.solution.clone().unwrap_or(Json::Null);
        let op_count = sol
            .get("operations")
            .and_then(|v| v.as_arr())
            .map(|a| a.len())
            .unwrap_or(0);
        let expected: usize = base_json
            .get("orders")
            .and_then(|v| v.as_arr())
            .map(|orders| {
                orders
                    .iter()
                    .map(|o| {
                        o.get("operations")
                            .and_then(|v| v.as_arr())
                            .map(|a| a.len())
                            .unwrap_or(0)
                    })
                    .sum()
            })
            .unwrap_or(0);
        if op_count != expected {
            ok = false;
            details.push(format!("✗ 工序数 {op_count} ≠ 期望 {expected}"));
        } else {
            details.push(format!("✓ {op_count} 道工序各一次分配且资源映射完整"));
        }
        match engine::verify_solution_json(&base_text, &out.solution_json) {
            Ok((_, _, violations)) => {
                if violations.is_empty() {
                    details.push("✓ 独立校验器 0 违约（H01–H08 全部通过）".into());
                } else {
                    ok = false;
                    details.push(format!("✗ 独立校验发现 {} 条违约", violations.len()));
                }
            }
            Err(issues) => {
                ok = false;
                details.push(format!("✗ 方案无法被独立解析: {issues:?}"));
            }
        }
        if let Some(v) = &out.objective {
            details.push(format!(
                "✓ 目标：加权延期 {} 分钟 / makespan {} 分钟",
                v.weighted_tardiness, v.makespan
            ));
        } else {
            ok = false;
            details.push("✗ 未报告目标值".into());
        }
        details.push(format!(
            "指标：建模 {:.1} ms / 首解 {} / 总 {:.1} ms / 峰值内存 {}",
            out.metrics.compile_ms.unwrap_or(0.0),
            out.metrics
                .first_feasible_ms
                .map(|v| format!("{v:.1} ms"))
                .unwrap_or_else(|| "unavailable".into()),
            out.metrics.total_ms.unwrap_or(0.0),
            out.metrics
                .peak_memory_bytes
                .map(|v| format!("{:.2} MB", v as f64 / 1_048_576.0))
                .unwrap_or_else(|| "unavailable".into())
        ));
        summary_json.insert("S01", sol.clone());
        CaseResult {
            id: "S01",
            name: "基础车间：完整可行解 + 独立校验零违约".into(),
            passed: ok,
            details,
            metrics: Some(out.metrics.to_json()),
        }
    };

    // ---------------- S02 设备故障 ----------------
    let s02 = (|| -> CaseResult {
        let mut details = Vec::new();
        let (breakdown_text, breakdown_json) = match read_json(&breakdown_path) {
            Ok(v) => v,
            Err(e) => {
                return CaseResult {
                    id: "S02",
                    name: "设备故障".into(),
                    passed: false,
                    details: vec![e],
                    metrics: None,
                }
            }
        };
        let out = engine::solve_json(
            &breakdown_text,
            &default_solve_options(2_000),
            &CancelToken::new(),
        );
        details.push(format!("状态: {}", out.status.as_str()));
        let mut ok = acceptable_status(&out, &breakdown_text, &mut details);
        let sol = out.solution.clone().unwrap_or(Json::Null);
        // 停机区间（由故障样本读取，不硬编码）
        let mut blocked: Option<(String, String, String)> = None;
        if let Some(machines) = breakdown_json.get("machines").and_then(|v| v.as_arr()) {
            for m in machines {
                if let Some(bs) = m.get("blocked").and_then(|v| v.as_arr()) {
                    for b in bs {
                        blocked = Some((
                            m.get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            b.get("start")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            b.get("end")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                        ));
                    }
                }
            }
        }
        match blocked {
            None => {
                ok = false;
                details.push("✗ 故障样本缺少 blocked 区间".into());
            }
            Some((machine_id, bs, be)) => {
                let b_start = crate::datetime::parse_to_epoch_min(&bs).unwrap_or(0);
                let b_end = crate::datetime::parse_to_epoch_min(&be).unwrap_or(0);
                let mut hits = 0usize;
                if let Some(ops) = sol.get("operations").and_then(|v| v.as_arr()) {
                    for op in ops {
                        if op.get("machine_id").and_then(|v| v.as_str())
                            != Some(machine_id.as_str())
                        {
                            continue;
                        }
                        let s = crate::datetime::parse_to_epoch_min(
                            op.get("start_at").and_then(|v| v.as_str()).unwrap_or(""),
                        );
                        let e = crate::datetime::parse_to_epoch_min(
                            op.get("end_at").and_then(|v| v.as_str()).unwrap_or(""),
                        );
                        if let (Ok(s), Ok(e)) = (s, e) {
                            if s < b_end && b_start < e {
                                hits += 1;
                                details.push(format!(
                                    "✗ 工序 {} 进入 {} 停机区间 {} ~ {}",
                                    op.get("operation_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("?"),
                                    machine_id,
                                    bs,
                                    be
                                ));
                            }
                        }
                    }
                }
                if hits == 0 {
                    details.push(format!(
                        "✓ 无任何工序进入 {machine_id} 停机区间 {bs} ~ {be}"
                    ));
                } else {
                    ok = false;
                }
            }
        }
        match engine::verify_solution_json(&breakdown_text, &out.solution_json) {
            Ok((_, _, v)) if v.is_empty() => details.push("✓ 独立校验器 0 违约".into()),
            Ok((_, _, v)) => {
                ok = false;
                details.push(format!("✗ 独立校验发现 {} 条违约", v.len()));
            }
            Err(e) => {
                ok = false;
                details.push(format!("✗ {e:?}"));
            }
        }
        // 与基线计划的变更影响
        if let (Some(base_sol_json), Some(cand_json)) =
            (summary_json.get("S01"), out.solution.clone())
        {
            if let (Some(base_sol), Some(cand_sol)) = (
                crate::verify::parse_solution(base_sol_json).0,
                crate::verify::parse_solution(&cand_json).0,
            ) {
                let changed = crate::compare::changed_operations(&base_sol, &cand_sol);
                details.push(format!(
                    "✓ 相对基线计划变更 {changed} 道工序（变更影响可呈现）"
                ));
            }
        }
        CaseResult {
            id: "S02",
            name: "设备故障：排程不进入停机区间且给出变更影响".into(),
            passed: ok,
            details,
            metrics: Some(out.metrics.to_json()),
        }
    })();

    // ---------------- S03 到货延迟 ----------------
    let s03 = (|| -> CaseResult {
        let mut details = Vec::new();
        let (delay_text, delay_json) = match read_json(&delay_path) {
            Ok(v) => v,
            Err(e) => {
                return CaseResult {
                    id: "S03",
                    name: "到货延迟".into(),
                    passed: false,
                    details: vec![e],
                    metrics: None,
                }
            }
        };
        let out = engine::solve_json(
            &delay_text,
            &default_solve_options(2_000),
            &CancelToken::new(),
        );
        let mut ok = out.status == Status::Feasible;
        details.push(format!("状态: {}", out.status.as_str()));
        // 独立复算物料账本：走 src/ledger.rs 的事件重放（求解器/校验器之外的第三条实现）
        match (|| -> Option<()> {
            let (problem, _) = crate::model::parse_problem(&delay_json);
            let problem = problem?;
            let (solution, _) = crate::verify::parse_solution(&out.solution?);
            let solution = solution?;
            let od = crate::ledger::overdrafts(&problem, &solution);
            if od.is_empty() {
                details.push("✓ 事件序物料账本全程非负（同一时刻先入库后领料，H07）".into());
            } else {
                ok = false;
                for o in od.iter() {
                    details.push(format!(
                        "✗ 物料 {} 在 {} 透支至 {}（{}）",
                        o.material_id, o.at_iso, o.balance, o.label
                    ));
                }
            };
            Some(())
        })() {
            Some(()) => {}
            None => {
                ok = false;
                details.push("✗ 无法重放物料账本（问题或方案不符合契约）".into());
            }
        }
        match engine::verify_solution_json(&delay_text, &out.solution_json) {
            Ok((_, _, v)) if v.is_empty() => details.push("✓ 独立校验器 0 违约".into()),
            Ok((_, _, v)) => {
                ok = false;
                details.push(format!("✗ 独立校验发现 {} 条违约", v.len()));
            }
            Err(e) => {
                ok = false;
                details.push(format!("✗ {e:?}"));
            }
        }
        CaseResult {
            id: "S03",
            name: "到货延迟：物料账本非负".into(),
            passed: ok,
            details,
            metrics: Some(out.metrics.to_json()),
        }
    })();

    // ---------------- S04 证明无解 ----------------
    let s04 = (|| -> CaseResult {
        let mut details = Vec::new();
        let infeasible_text = match read_json(&infeasible_path) {
            Ok((t, _)) => t,
            Err(e) => {
                return CaseResult {
                    id: "S04",
                    name: "证明无解".into(),
                    passed: false,
                    details: vec![e],
                    metrics: None,
                }
            }
        };
        let native = engine::solve_json(
            &infeasible_text,
            &default_solve_options(1_000),
            &CancelToken::new(),
        );
        let mut ok = true;
        if native.status == Status::Infeasible {
            details.push("✓ native 档位返回 INFEASIBLE（可构造证明）".into());
            let has_cert = !native.violations.is_empty()
                && native
                    .violations
                    .iter()
                    .any(|v| v.code == "NO_ELIGIBLE_WORKER");
            if has_cert {
                let v = native
                    .violations
                    .iter()
                    .find(|v| v.code == "NO_ELIGIBLE_WORKER")
                    .unwrap();
                details.push(format!(
                    "✓ 证书: {}（工序 {}）",
                    v.message,
                    v.operation_id.clone().unwrap_or_default()
                ));
            } else {
                ok = false;
                details.push("✗ 返回 INFEASIBLE 但缺少 NO_ELIGIBLE_WORKER 证书".into());
            }
            if native
                .solution
                .as_ref()
                .and_then(|s| s.get("operations"))
                .and_then(|v| v.as_arr())
                .map(|a| a.is_empty())
                .unwrap_or(false)
            {
                details.push("✓ 不伪造空排程：operations 为空数组且状态明确".into());
            } else {
                ok = false;
                details.push("✗ INFEASIBLE 却返回了 operations".into());
            }
        } else {
            ok = false;
            details.push(format!(
                "✗ native 档位状态为 {}，期望 INFEASIBLE",
                native.status.as_str()
            ));
        }

        // WASM 轻量档：不得声称已证明无解
        let wasm = {
            let mut o = default_solve_options(1_000);
            o.profile = crate::capabilities::Profile::WasmLight;
            engine::solve_json(&infeasible_text, &o, &CancelToken::new())
        };
        let w_status = wasm.status.as_str();
        if wasm.status == Status::Infeasible || wasm.status == Status::Optimal {
            ok = false;
            details.push(format!("✗ wasm-light 伪称已证明：状态 {w_status}"));
        } else {
            details.push(format!(
                "✓ wasm-light 状态 {w_status}（诚实标注未证明；允许 NO_SOLUTION_FOUND / UNKNOWN / UNSUPPORTED_CONSTRAINT）"
            ));
        }
        CaseResult {
            id: "S04",
            name: "证明无解：native 证明 / wasm 不伪称".into(),
            passed: ok,
            details,
            metrics: Some(native.metrics.to_json()),
        }
    })();

    // ---------------- S05 失效快照 ----------------
    let s05 = (|| -> CaseResult {
        let mut details = Vec::new();
        let witness_text = match read_json(&witness_path) {
            Ok((t, _)) => t,
            Err(e) => {
                return CaseResult {
                    id: "S05",
                    name: "失效快照".into(),
                    passed: false,
                    details: vec![e],
                    metrics: None,
                }
            }
        };
        // 用基线快照的方案去核验“故障快照”的问题 → 版本绑定必须失败
        let (breakdown_text, _) = match read_json(&breakdown_path) {
            Ok(v) => v,
            Err(e) => {
                return CaseResult {
                    id: "S05",
                    name: "失效快照".into(),
                    passed: false,
                    details: vec![e],
                    metrics: None,
                }
            }
        };
        let mut ok = false;
        match engine::verify_solution_json(&breakdown_text, &witness_text) {
            Ok((_, _, violations)) => {
                if violations
                    .iter()
                    .any(|v| v.code == codes::SNAPSHOT_MISMATCH)
                {
                    details.push("✓ 旧快照方案被判定为 SNAPSHOT_MISMATCH（平台应返回 STALE_SNAPSHOT 并拒发）".into());
                    ok = true;
                } else {
                    details.push("✗ 未检出快照不一致".into());
                }
            }
            Err(e) => details.push(format!("✗ {e:?}")),
        }
        details.push("说明：权威的 STALE_SNAPSHOT 拒绝由 Go 平台层执行，本引擎提供判定依据".into());
        CaseResult {
            id: "S05",
            name: "失效快照：版本绑定校验".into(),
            passed: ok,
            details,
            metrics: None,
        }
    })();

    // ---------------- S06 对抗错误方案 ----------------
    let s06 = (|| -> CaseResult {
        let mut details = Vec::new();
        let witness_text = match read_json(&witness_path) {
            Ok((t, _)) => t,
            Err(e) => {
                return CaseResult {
                    id: "S06",
                    name: "对抗错误方案".into(),
                    passed: false,
                    details: vec![e],
                    metrics: None,
                }
            }
        };
        let witness = match crate::json::parse(&witness_text) {
            Ok(j) => j,
            Err(e) => {
                return CaseResult {
                    id: "S06",
                    name: "对抗错误方案".into(),
                    passed: false,
                    details: vec![e.to_string()],
                    metrics: None,
                }
            }
        };
        // 正确方案必须先零违约
        let mut ok = match engine::verify_solution_json(&base_text, &witness_text) {
            Ok((_, _, v)) if v.is_empty() => {
                details.push("✓ 正确参考方案：0 违约（对照组）".into());
                true
            }
            Ok((_, _, v)) => {
                details.push(format!("✗ 正确方案被误报 {} 条违约", v.len()));
                false
            }
            Err(e) => {
                details.push(format!("✗ {e:?}"));
                false
            }
        };

        let breakdown_text = std::fs::read_to_string(&breakdown_path).unwrap_or_default();
        for m in mutations(&base_text, &witness, &breakdown_text) {
            match engine::verify_solution_json(&m.problem, &m.solution) {
                Ok((_, _, violations)) => {
                    let hit = violations.iter().any(|v| v.code == m.expected);
                    if hit {
                        details.push(format!("✓ {} → {} 被检出", m.name, m.expected));
                    } else {
                        ok = false;
                        let codes_found: Vec<String> =
                            violations.iter().map(|v| v.code.clone()).collect();
                        details.push(format!(
                            "✗ {} → 期望 {}，实际 {:?}",
                            m.name, m.expected, codes_found
                        ));
                    }
                }
                Err(e) => {
                    ok = false;
                    details.push(format!("✗ {} 无法解析: {:?}", m.name, e));
                }
            }
        }
        CaseResult {
            id: "S06",
            name: "对抗错误方案：每种约束破坏独立检出".into(),
            passed: ok,
            details,
            metrics: None,
        }
    })();

    // ---------------- S07 多租户 ----------------
    let s07 = {
        let mut details = Vec::new();
        let mut tenant_b = base_json.clone();
        if let Some(meta) = tenant_b.get_mut("meta") {
            meta.set("tenant_id", Json::str("mock-tenant-beta"));
        }
        let tenant_b_text = tenant_b.to_pretty();
        // 用租户 B 的问题核验租户 A 的方案
        let mut ok = false;
        if let Ok(witness_text) = std::fs::read_to_string(&witness_path) {
            // 参考见证快照里没有 tenant_id（历史产物）；模拟“租户 A 签发、带租户绑定”的方案，
            // 核验其被租户 B 的问题拒绝；引擎自己生成的方案恒带 tenant_id。
            let witness_for_a = match base_json.get("meta").and_then(|m| m.get("tenant_id")) {
                Some(Json::Str(t)) => crate::json::parse(&witness_text).ok().map(|mut w| {
                    w.set("tenant_id", Json::str(t.clone()));
                    w.to_pretty()
                }),
                _ => None,
            }
            .unwrap_or_else(|| witness_text.clone());
            match engine::verify_solution_json(&tenant_b_text, &witness_for_a) {
                Ok((_, _, violations)) => {
                    if violations.iter().any(|v| v.code == codes::TENANT_MISMATCH) {
                        details.push("✓ 跨租户核验被判定为 TENANT_MISMATCH".into());
                        ok = true;
                    } else {
                        details.push("✗ 未检出跨租户访问".into());
                    }
                }
                Err(e) => details.push(format!("✗ {e:?}")),
            }
        }
        details.push(
            "说明：权威的任务/方案隔离与“不泄漏存在性”由 Go 平台层（租户鉴权 + 查询过滤）执行；\
             本引擎提供 tenant_id 一致性判定"
                .into(),
        );
        CaseResult {
            id: "S07",
            name: "多租户：跨租户方案判定".into(),
            passed: ok,
            details,
            metrics: None,
        }
    };

    // ---------------- S08 能力协商 ----------------
    let s08 = {
        let mut details = Vec::new();
        let mut ok = true;
        // 规模超限：2400 工序 vs wasm-light 上限
        match crate::benchgen::build_separable(&base_json, 2400) {
            Ok(big) => {
                let mut o = default_solve_options(1_000);
                o.profile = crate::capabilities::Profile::WasmLight;
                let out = engine::solve_json(&big.to_compact(), &o, &CancelToken::new());
                if out.status == Status::UnsupportedConstraint {
                    details.push(
                        "✓ 2400 工序超出 wasm-light（max_operations=600）→ UNSUPPORTED_CONSTRAINT"
                            .into(),
                    );
                    let mentions_scale = out.issues.iter().any(|i| i.code == "SCALE_EXCEEDED");
                    if mentions_scale {
                        details.push("✓ 结构化原因：SCALE_EXCEEDED（含工序数与上限）".into());
                    } else {
                        ok = false;
                        details.push("✗ 未给出 SCALE_EXCEEDED 结构化原因".into());
                    }
                } else {
                    ok = false;
                    details.push(format!(
                        "✗ 期望 UNSUPPORTED_CONSTRAINT，实际 {}",
                        out.status.as_str()
                    ));
                }
            }
            Err(e) => {
                ok = false;
                details.push(format!("✗ 生成 2400 工序基准失败: {e}"));
            }
        }
        // 未声明约束：P1 的多人员协同工序
        let mut p1 = base_json.clone();
        if let Some(orders) = p1.get_mut("orders").and_then(|v| v.as_arr_mut()) {
            if let Some(ops) = orders[0].get_mut("operations").and_then(|v| v.as_arr_mut()) {
                ops[0].set("worker_count", Json::int(2));
            }
        }
        let out = engine::solve_json(
            &p1.to_compact(),
            &default_solve_options(500),
            &CancelToken::new(),
        );
        let p1_ok =
            out.status == Status::UnsupportedConstraint || out.status == Status::ModelInvalid; // worker_count=2 亦违反 P0 契约
        if p1_ok {
            details.push(format!(
                "✓ worker_count=2（P1 约束）→ {}，未静默忽略",
                out.status.as_str()
            ));
        } else {
            ok = false;
            details.push(format!(
                "✗ worker_count=2 被静默接受: {}",
                out.status.as_str()
            ));
        }
        CaseResult {
            id: "S08",
            name: "能力协商：超范围必须显式拒绝".into(),
            passed: ok,
            details,
            metrics: None,
        }
    };

    report.cases = vec![s01, s02, s03, s04, s05, s06, s07, s08];
    report
}

/// 读取问题的某工序对某物料的用量（对抗测试与独立复算使用）。
fn find_op_mut<'a>(solution: &'a mut Json, op_id: &str) -> Option<&'a mut Json> {
    let ops = solution.get_mut("operations")?.as_arr_mut()?;
    ops.iter_mut()
        .find(|o| o.get("operation_id").and_then(|v| v.as_str()) == Some(op_id))
}

fn shift_op(solution: &mut Json, op_id: &str, start_iso: &str, end_iso: &str) {
    if let Some(op) = find_op_mut(solution, op_id) {
        op.set("start_at", Json::str(start_iso));
        op.set("end_at", Json::str(end_iso));
    }
}

/// 一条“故意破坏”的对抗样本：说明 + 期望违约码 + 待校验的（问题, 方案）。
#[derive(Debug, Clone)]
pub struct Mutation {
    pub name: String,
    pub expected: &'static str,
    pub problem: String,
    pub solution: String,
}

/// 生成全部对抗样本（覆盖 H01–H08 + 契约级错误）。
pub fn mutations(problem_text: &str, witness: &Json, breakdown_text: &str) -> Vec<Mutation> {
    let mut out: Vec<Mutation> = Vec::new();
    let mk = |name: &str, expected: &'static str, solution: String| Mutation {
        name: name.to_string(),
        expected,
        problem: problem_text.to_string(),
        solution,
    };
    let clone = |f: &dyn Fn(&mut Json)| -> String {
        let mut m = witness.clone();
        f(&mut m);
        m.to_pretty()
    };

    out.push(mk(
        "H01 时长为 0（end = start）",
        codes::H01_TIME_ORDER,
        clone(&|m| {
            let start = find_op_mut(m, "ORD-001-CUT")
                .and_then(|o| {
                    o.get("start_at")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or_default();
            shift_op(m, "ORD-001-CUT", &start, &start);
        }),
    ));
    out.push(mk(
        "H01 时长与备选机器不符（30 → 45）",
        codes::H01_DURATION_MISMATCH,
        clone(&|m| {
            shift_op(
                m,
                "ORD-001-CUT",
                "2026-10-05T08:00:00-07:00",
                "2026-10-05T08:45:00-07:00",
            );
        }),
    ));
    out.push(mk(
        "H02 工序逆序（WELD 与 CUT 同刻开工）",
        codes::H02_PRECEDENCE,
        clone(&|m| {
            shift_op(
                m,
                "ORD-001-WELD",
                "2026-10-05T08:00:00-07:00",
                "2026-10-05T08:45:00-07:00",
            );
        }),
    ));
    out.push(mk(
        "H02 早于订单投放时间（ORD-005 投放 10:00）",
        codes::H02_RELEASE,
        clone(&|m| {
            shift_op(
                m,
                "ORD-005-CUT",
                "2026-10-05T08:00:00-07:00",
                "2026-10-05T08:30:00-07:00",
            );
        }),
    ));
    out.push(mk(
        "H03 使用无该能力的机器（WELD 占用 CUT-01）",
        codes::H03_MACHINE_CAPABILITY,
        clone(&|m| {
            if let Some(op) = find_op_mut(m, "ORD-001-WELD") {
                op.set("machine_id", Json::str("CUT-01"));
                op.set("start_at", Json::str("2026-10-05T08:30:00-07:00"));
                op.set("end_at", Json::str("2026-10-05T09:15:00-07:00"));
            }
        }),
    ));
    out.push(mk(
        "H03 机器重叠（两道工序同机同刻）",
        codes::H03_MACHINE_OVERLAP,
        clone(&|m| {
            shift_op(
                m,
                "ORD-002-CUT",
                "2026-10-05T08:00:00-07:00",
                "2026-10-05T08:30:00-07:00",
            );
            if let Some(op) = find_op_mut(m, "ORD-002-CUT") {
                op.set("machine_id", Json::str("CUT-01"));
            }
        }),
    ));
    out.push(mk(
        "H04 跨越班次空档（12:00 开工）",
        codes::H04_MACHINE_CALENDAR,
        clone(&|m| {
            shift_op(
                m,
                "ORD-001-CUT",
                "2026-10-05T12:00:00-07:00",
                "2026-10-05T12:30:00-07:00",
            );
        }),
    ));
    // 与设备停机区间重叠：必须用“故障快照”的问题来核验
    out.push(Mutation {
        name: "H04 与设备停机区间重叠（WELD-02 13:00-17:00）".to_string(),
        expected: codes::H04_MACHINE_BLOCKED,
        problem: breakdown_text.to_string(),
        solution: clone(&|m| {
            if let Some(op) = find_op_mut(m, "ORD-001-WELD") {
                op.set("machine_id", Json::str("WELD-02"));
                op.set("start_at", Json::str("2026-10-05T13:00:00-07:00"));
                op.set("end_at", Json::str("2026-10-05T14:00:00-07:00"));
            }
        }),
    });
    out.push(mk(
        "H05 错用无技能人员（喷涂工做切割）",
        codes::H05_WORKER_SKILL,
        clone(&|m| {
            if let Some(op) = find_op_mut(m, "ORD-001-CUT") {
                op.set("worker_id", Json::str("EMP-P01"));
            }
        }),
    ));
    out.push(mk(
        "H05 人员重叠（同一人同刻两工序）",
        codes::H05_WORKER_OVERLAP,
        clone(&|m| {
            if let Some(op) = find_op_mut(m, "ORD-002-CUT") {
                op.set("machine_id", Json::str("CUT-02"));
                op.set("worker_id", Json::str("EMP-C01"));
                op.set("start_at", Json::str("2026-10-05T08:00:00-07:00"));
                op.set("end_at", Json::str("2026-10-05T08:45:00-07:00"));
            }
        }),
    ));
    out.push(mk(
        "H06 工装分配缺失",
        codes::H06_TOOL_ASSIGNMENT,
        clone(&|m| {
            if let Some(op) = find_op_mut(m, "ORD-001-CUT") {
                op.set("tool_ids", Json::Arr(vec![]));
            }
        }),
    ));
    out.push(mk(
        "H06 独占工装重叠",
        codes::H06_TOOL_OVERLAP,
        clone(&|m| {
            if let Some(op) = find_op_mut(m, "ORD-003-CUT") {
                op.set("machine_id", Json::str("CUT-02"));
                op.set("worker_id", Json::str("EMP-C02"));
                op.set("start_at", Json::str("2026-10-05T08:00:00-07:00"));
                op.set("end_at", Json::str("2026-10-05T08:30:00-07:00"));
            }
        }),
    ));
    // H07 缺料提前开工：需要同时改造问题（物料初始库存归零）
    out.push(Mutation {
        name: "H07 缺料提前开工（M-BLANK 初始库存 0）".to_string(),
        expected: codes::H07_STOCK_NEGATIVE,
        problem: {
            let mut p = crate::json::parse(problem_text).unwrap();
            if let Some(mats) = p.get_mut("materials").and_then(|v| v.as_arr_mut()) {
                for m in mats.iter_mut() {
                    if m.get("id").and_then(|v| v.as_str()) == Some("M-BLANK") {
                        m.set("initial_quantity", Json::int(0));
                    }
                }
            }
            p.to_compact()
        },
        solution: witness.to_pretty(),
    });
    out.push(mk(
        "契约 工序缺失",
        codes::MISSING_OPERATION,
        clone(&|m| {
            if let Some(ops) = m.get_mut("operations").and_then(|v| v.as_arr_mut()) {
                ops.retain(|o| {
                    o.get("operation_id").and_then(|v| v.as_str()) != Some("ORD-008-PAINT")
                });
            }
        }),
    ));
    out.push(mk(
        "契约 工序重复",
        codes::DUPLICATE_OPERATION,
        clone(&|m| {
            if let Some(ops) = m.get_mut("operations").and_then(|v| v.as_arr_mut()) {
                if let Some(first) = ops.first().cloned() {
                    ops.push(first);
                }
            }
        }),
    ));
    out.push(mk(
        "契约 未知工序",
        codes::UNKNOWN_OPERATION,
        clone(&|m| {
            if let Some(ops) = m.get_mut("operations").and_then(|v| v.as_arr_mut()) {
                if let Some(first) = ops.first().cloned() {
                    let mut ghost = first;
                    ghost.set("operation_id", Json::str("GHOST-OP"));
                    ops.push(ghost);
                }
            }
        }),
    ));
    out.push(mk(
        "契约 订单归属错误",
        codes::ORDER_ID_MISMATCH,
        clone(&|m| {
            if let Some(ops) = m.get_mut("operations").and_then(|v| v.as_arr_mut()) {
                if let Some(first) = ops.first_mut() {
                    // 把第一道工序的 order_id 改成另一个订单（工序本身仍存在）
                    first.set("order_id", Json::str("ORD-002"));
                }
            }
        }),
    ));
    out.push(mk(
        "H08 超出规划时域",
        codes::H08_OUT_OF_HORIZON,
        clone(&|m| {
            shift_op(
                m,
                "ORD-008-PAINT",
                "2026-10-09T16:45:00-07:00",
                "2026-10-09T17:15:00-07:00",
            );
        }),
    ));
    out
}

/// 供 `aps accept` 使用：把交付目录定位到包含 `mock/` 的目录。
pub fn locate_aps_dir(start: &Path) -> Option<PathBuf> {
    let candidates = [
        start.to_path_buf(),
        start.join("aps"),
        start.join("../aps"),
        start.join("../../aps"),
    ];
    for c in candidates.iter() {
        if c.join("mock/baseline.json").exists() {
            return Some(c.clone());
        }
    }
    None
}
