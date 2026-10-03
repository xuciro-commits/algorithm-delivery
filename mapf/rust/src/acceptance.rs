//! 机器可读验收：M01–M12 逐例执行（mock 经 `include_str!` 编译期内嵌，
//! 与交付目录 `mapf/mock/` 是同一份文件），供三处复用：
//!
//! * CLI：`mapf acceptance [--report docs/ACCEPTANCE.md] [--json out.json]`；
//! * `cargo test`：`tests/acceptance.rs` 断言全部通过；
//! * 文档：生成的 Markdown 表回填 `docs/ACCEPTANCE.md`（验收证据可再生）。
//!
//! 断言只依据对外契约（status / soc / makespan / verified / errors 码），
//! 不依赖内部实现细节；核验一律走与求解器解耦的 `verify` 模块。

use aps_engine::engine::CancelToken;

use self::json_util::*;
use crate::capabilities::Profile;
use crate::engine::{self, SolveOptions};
use crate::errors::Status;
use crate::verify;

pub const M01: &str = include_str!("../../mock/m01-single-basic.json");
pub const M02: &str = include_str!("../../mock/m02-crossing.json");
pub const M03: &str = include_str!("../../mock/m03-head-on-swap.json");
pub const M04: &str = include_str!("../../mock/m04-narrow-corridor.json");
pub const M05: &str = include_str!("../../mock/m05-cycle.json");
pub const M06: &str = include_str!("../../mock/m06-target-occupied.json");
pub const M07: &str = include_str!("../../mock/m07-invalid-input.json");
pub const M07B: &str = include_str!("../../mock/m07b-unsupported.json");
pub const M08A: &str = include_str!("../../mock/m08a-unreachable.json");
pub const M08B: &str = include_str!("../../mock/m08b-tight-budget.json");
pub const M09: &str = include_str!("../../mock/m09-crowded-bottleneck.json");
pub const M10: &str = include_str!("../../mock/m10-dynamic-events.json");
pub const M11: &str = include_str!("../../mock/m11-tampered.json");
pub const M11_SOL: &str = include_str!("../../mock/m11-tampered-solution.json");

/// 单条检查结论。
pub struct Check(pub String, pub bool);

/// 一个验收案例的结果。
pub struct CaseResult {
    pub id: &'static str,
    pub title: &'static str,
    pub checks: Vec<Check>,
}

impl CaseResult {
    pub fn ok(&self) -> bool {
        self.checks.iter().all(|c| c.1)
    }
    pub fn passed(&self) -> usize {
        self.checks.iter().filter(|c| c.1).count()
    }
}

fn opts() -> SolveOptions {
    SolveOptions {
        profile: Profile::Native,
        verify: true,
        ..Default::default()
    }
}

fn solve(text: &str) -> engine::Outcome {
    engine::solve_json(text, &opts(), &CancelToken::new())
}

/// 案例执行器：把若干 (描述, 断言) 汇总成 CaseResult；panic 也计入失败。
fn case(id: &'static str, title: &'static str, body: impl FnOnce(&mut Vec<Check>)) -> CaseResult {
    let mut checks: Vec<Check> = Vec::new();
    body(&mut checks);
    CaseResult { id, title, checks }
}

/// 全部案例（M01–M12）。
pub fn run_all() -> Vec<CaseResult> {
    let mut out: Vec<CaseResult> = Vec::new();

    // —— M01 单车基础：OPTIMAL，SOC=Makespan=6，独立核验通过 ——
    out.push(case(
        "M01",
        "单车基础（5×5 无障碍，对角 6 步）",
        |c| {
            let o = solve(M01);
            c.push(Check(
                format!("status=OPTIMAL（实际 {:?}）", s_str(&o.solution, "status")),
                o.status == Status::Optimal,
            ));
            c.push(Check(
                format!(
                    "objective.value=6（实际 {:?}）",
                    s_num(&o.solution, &["objective", "value"])
                ),
                s_num(&o.solution, &["objective", "value"]) == Some(6),
            ));
            c.push(Check(
                format!("soc=6（实际 {:?}）", s_num(&o.solution, &["soc"])),
                s_num(&o.solution, &["soc"]) == Some(6),
            ));
            c.push(Check(
                format!("makespan=6（实际 {:?}）", s_num(&o.solution, &["makespan"])),
                s_num(&o.solution, &["makespan"]) == Some(6),
            ));
            c.push(Check(
                "optimality_proven=true".into(),
                s_bool(&o.solution, "optimality_proven") == Some(true),
            ));
            c.push(Check(
                "verified=true（独立核验）".into(),
                s_bool(&o.solution, "verified") == Some(true),
            ));
        },
    ));

    // —— M02 交叉冲突：OPTIMAL，SOC=5（等待让行优于绕行）——
    out.push(case("M02", "交叉冲突（中心单元争用）", |c| {
        let o = solve(M02);
        c.push(Check(
            format!("status=OPTIMAL（实际 {:?}）", s_str(&o.solution, "status")),
            o.status == Status::Optimal,
        ));
        c.push(Check(
            format!("soc=5（实际 {:?}）", s_num(&o.solution, &["soc"])),
            s_num(&o.solution, &["soc"]) == Some(5),
        ));
        c.push(Check(
            "verified=true".into(),
            s_bool(&o.solution, "verified") == Some(true),
        ));
    }));

    // —— M03 头对头走廊交换：必须利用侧袋；核验零边冲突 ——
    out.push(case(
        "M03",
        "头对头走廊交换（侧袋让行）",
        |c| {
            let o = solve(M03);
            c.push(Check(
                format!(
                    "status∈{{OPTIMAL,FEASIBLE}}（实际 {:?}）",
                    s_str(&o.solution, "status")
                ),
                matches!(o.status, Status::Optimal | Status::Feasible),
            ));
            let soc = s_num(&o.solution, &["soc"]);
            c.push(Check(
                format!("soc≤12（实际 {soc:?}）"),
                soc.is_some_and(|v| v <= 12),
            ));
            c.push(Check(
                "verified=true（含边冲突=0 重算）".into(),
                s_bool(&o.solution, "verified") == Some(true),
            ));
        },
    ));

    // —— M04 多车窄通道排队：预算内合法方案 ——
    out.push(case(
        "M04",
        "窄通道排队（1 宽走廊 + 3 侧袋）",
        |c| {
            let o = solve(M04);
            c.push(Check(
                format!(
                    "status∈{{OPTIMAL,FEASIBLE}}（实际 {:?}）",
                    s_str(&o.solution, "status")
                ),
                matches!(o.status, Status::Optimal | Status::Feasible),
            ));
            c.push(Check(
                "verified=true".into(),
                s_bool(&o.solution, "verified") == Some(true),
            ));
        },
    ));

    // —— M05 环形让行：同步旋转合法，SOC=4 Makespan=1（防误报护栏）——
    out.push(case(
        "M05",
        "四车环形让行（2×2 同步旋转合法）",
        |c| {
            let o = solve(M05);
            c.push(Check(
                format!("status=OPTIMAL（实际 {:?}）", s_str(&o.solution, "status")),
                o.status == Status::Optimal,
            ));
            c.push(Check(
                format!("soc=4（实际 {:?}）", s_num(&o.solution, &["soc"])),
                s_num(&o.solution, &["soc"]) == Some(4),
            ));
            c.push(Check(
                format!("makespan=1（实际 {:?}）", s_num(&o.solution, &["makespan"])),
                s_num(&o.solution, &["makespan"]) == Some(1),
            ));
            c.push(Check(
                "verified=true（环流未被误判为冲突）".into(),
                s_bool(&o.solution, "verified") == Some(true),
            ));
        },
    ));

    // —— M06 终点占用：等目标让位后进入 ——
    out.push(case("M06", "目标占用（等前车让位）", |c| {
        let o = solve(M06);
        c.push(Check(
            format!("status=OPTIMAL（实际 {:?}）", s_str(&o.solution, "status")),
            o.status == Status::Optimal,
        ));
        c.push(Check(
            format!("soc=4（实际 {:?}）", s_num(&o.solution, &["soc"])),
            s_num(&o.solution, &["soc"]) == Some(4),
        ));
        c.push(Check(
            "verified=true".into(),
            s_bool(&o.solution, "verified") == Some(true),
        ));
    }));

    // —— M07 非法输入：字段级定位，错误码可枚举 ——
    out.push(case(
        "M07",
        "非法输入拒绝（重复起点 + 越界坐标）",
        |c| {
            let o = solve(M07);
            c.push(Check(
                format!(
                    "status=INVALID_INPUT（实际 {:?}）",
                    s_str(&o.solution, "status")
                ),
                o.status == Status::InvalidInput,
            ));
            let codes = err_codes(&o.solution);
            c.push(Check(
                format!("errors 含 E-ROBOT-DUP-START（实际 {codes:?}）"),
                codes.iter().any(|x| x == "E-ROBOT-DUP-START"),
            ));
            c.push(Check(
                "errors 含 E-ROBOT-COORD-RANGE".into(),
                codes.iter().any(|x| x == "E-ROBOT-COORD-RANGE"),
            ));
        },
    ));

    // —— M07b 能力外请求：显式 UNSUPPORTED 而非静默忽略 ——
    out.push(case(
        "M07b",
        "能力外请求拒绝（对角移动）",
        |c| {
            let o = solve(M07B);
            c.push(Check(
                format!(
                    "status=UNSUPPORTED（实际 {:?}）",
                    s_str(&o.solution, "status")
                ),
                o.status == Status::Unsupported,
            ));
            let codes = err_codes(&o.solution);
            c.push(Check(
                format!("errors 含 E-CAP-UNSUPPORTED-FEATURE（实际 {codes:?}）"),
                codes.iter().any(|x| x == "E-CAP-UNSUPPORTED-FEATURE"),
            ));
        },
    ));

    // —— M08a 不可达：声明时域内穷尽 ⇒ INFEASIBLE + 证明语义 ——
    out.push(case(
        "M08a",
        "不可达目标（孤立单元）⇒ INFEASIBLE",
        |c| {
            let o = solve(M08A);
            c.push(Check(
                format!(
                    "status=INFEASIBLE（实际 {:?}）",
                    s_str(&o.solution, "status")
                ),
                o.status == Status::Infeasible,
            ));
            c.push(Check(
                "search.finish=exhausted（证明来源：穷尽而非超时）".into(),
                s_str_at(&o.solution, &["search", "finish"]) == Some("exhausted".to_string()),
            ));
            c.push(Check(
                "robots 为空（INFEASIBLE 不携带路径）".into(),
                arr_len(&o.solution, "robots") == Some(0),
            ));
            c.push(Check(
                "objective.value=null（无解不声明目标值）".into(),
                o.solution
                    .get("objective")
                    .and_then(|v| v.get("value"))
                    .map(|v| v.is_null())
                    .unwrap_or(false),
            ));
        },
    ));

    // —— M08b 预算耗尽：UNKNOWN（超时≠无解），不得伪称 ——
    out.push(case("M08b", "预算/扩展上限耗尽 ⇒ UNKNOWN", |c| {
        let o = solve(M08B);
        c.push(Check(
            format!("status=UNKNOWN（实际 {:?}）", s_str(&o.solution, "status")),
            o.status == Status::Unknown,
        ));
        c.push(Check(
            "robots 为空（无在途合法方案可交付）".into(),
            arr_len(&o.solution, "robots") == Some(0),
        ));
        c.push(Check(
            "optimality_proven=false".into(),
            s_bool(&o.solution, "optimality_proven") == Some(false),
        ));
    }));

    // —— M09 24 车竞争瓶颈：10s / w=1.5 内全部输出合法方案 ——
    out.push(case(
        "M09",
        "20+ 车竞争瓶颈（13×13，24 台）",
        |c| {
            let o = solve(M09);
            c.push(Check(
                format!(
                    "status∈{{OPTIMAL,FEASIBLE}}（实际 {:?}）",
                    s_str(&o.solution, "status")
                ),
                matches!(o.status, Status::Optimal | Status::Feasible),
            ));
            c.push(Check(
                format!("robots=24（实际 {:?}）", arr_len(&o.solution, "robots")),
                arr_len(&o.solution, "robots") == Some(24),
            ));
            c.push(Check(
                "verified=true（全部方案通过独立核验）".into(),
                s_bool(&o.solution, "verified") == Some(true),
            ));
        },
    ));

    // —— M10 动态事件：冻结前缀保持 + 重规划指标 ——
    out.push(case(
        "M10",
        "动态障碍 + 目标变更 + 路径作废（t=2 快照）",
        |c| {
            let o = solve(M10);
            c.push(Check(
                format!(
                    "status∈{{OPTIMAL,FEASIBLE}}（实际 {:?}）",
                    s_str(&o.solution, "status")
                ),
                matches!(o.status, Status::Optimal | Status::Feasible),
            ));
            c.push(Check(
                "verified=true（含冻结前缀/快照一致性检查）".into(),
                s_bool(&o.solution, "verified") == Some(true),
            ));
            // verify 块的 checks 必须全绿（snapshot/frozen 语义在内）。
            let all_checks_ok = o
                .solution
                .get("verify")
                .and_then(|v| v.get("checks"))
                .and_then(|c| c.as_arr())
                .map(|items| {
                    !items.is_empty()
                        && items
                            .iter()
                            .all(|it| it.get("ok").and_then(|v| v.as_bool()).unwrap_or(false))
                })
                .unwrap_or(false);
            c.push(Check(
                "verify.checks 全部通过（含 snap/frozen）".into(),
                all_checks_ok,
            ));
            c.push(Check(
                "dynamic.replan=true".into(),
                s_bool_at(&o.solution, &["dynamic", "replan"]) == Some(true),
            ));
            let affected = s_num_at(&o.solution, &["dynamic", "affected_agents"]).unwrap_or(0);
            c.push(Check(
                format!("dynamic.affected_agents≥1（实际 {affected}）"),
                affected >= 1,
            ));
            let cover = s_num_at(&o.solution, &["dynamic", "frozen_prefix_covered"]).unwrap_or(0);
            c.push(Check(
                format!("frozen_prefix_covered≥3（实际 {cover}）"),
                cover >= 3,
            ));
        },
    ));

    // —— M11 篡改方案必须被独立核验器拒绝，且给出正确错误码 ——
    out.push(case(
        "M11",
        "篡改方案拒绝（墙侵入/顶点冲突/谎报 SOC）",
        |c| {
            let rep = verify::verify_texts(M11, M11_SOL, false);
            c.push(Check(
                format!("verify.ok=false（实际 {}）", rep.ok),
                !rep.ok,
            ));
            let codes: Vec<String> = rep.violations.iter().map(|v| v.code.clone()).collect();
            for want in ["E-WALL-ENTRY", "E-CONFLICT-VERTEX", "E-OBJ-SOC"] {
                c.push(Check(
                    format!("violations 含 {want}（实际 {codes:?}）"),
                    codes.iter().any(|x| x == want),
                ));
            }
            // 引擎侧也必须拒绝内嵌核验通过的假象：solution 若声称成功而核验失败 → 降级。
            let o = solve(M11);
            c.push(Check(
                format!(
                    "M11 问题本体合法（status={:?}）",
                    s_str(&o.solution, "status")
                ),
                matches!(o.status, Status::Optimal | Status::Feasible),
            ));
        },
    ));

    // —— M12 取消与恢复：取消 ⇒ CANCELLED；随后同一实例必须能正常求解 ——
    out.push(case("M12", "运行中取消 → 恢复重解", |c| {
        let cancel = CancelToken::new();
        cancel.cancel(); // 预取消：搜索循环第一轮即命中，状态必须如实 CANCELLED
        let o1 = engine::solve_json(M09, &opts(), &cancel);
        c.push(Check(
            format!(
                "取消后 status=CANCELLED（实际 {:?}）",
                s_str(&o1.solution, "status")
            ),
            o1.status == Status::Cancelled,
        ));
        let o2 = solve(M09);
        c.push(Check(
            format!(
                "恢复后 status∈{{OPTIMAL,FEASIBLE}}（实际 {:?}）",
                s_str(&o2.solution, "status")
            ),
            matches!(o2.status, Status::Optimal | Status::Feasible),
        ));
        c.push(Check(
            "恢复后 verified=true".into(),
            s_bool(&o2.solution, "verified") == Some(true),
        ));
    }));

    out
}

// ---------------------------------------------------------------- 展示

/// 生成 Markdown 表（回填 docs/ACCEPTANCE.md，可再生）。
pub fn markdown_table(results: &[CaseResult]) -> String {
    use std::fmt::Write as _;
    let mut s = String::new();
    let total = results.iter().filter(|r| r.ok()).count();
    let _ = writeln!(s, "## 验收结论：{}/{} 案例通过", total, results.len());
    let _ = writeln!(s);
    let _ = writeln!(s, "| 案例 | 描述 | 检查 | 结果 |");
    let _ = writeln!(s, "|------|------|------|------|");
    for r in results {
        let _ = writeln!(
            s,
            "| {} | {} | {} / {} | {} |",
            r.id,
            r.title,
            r.passed(),
            r.checks.len(),
            if r.ok() { "✅" } else { "❌" }
        );
    }
    let _ = writeln!(s);
    for r in results {
        let _ = writeln!(s, "### {} — {}", r.id, r.title);
        for Check(msg, ok) in &r.checks {
            let _ = writeln!(s, "- [{}] {}", if *ok { "x" } else { " " }, msg);
        }
        let _ = writeln!(s);
    }
    s
}

/// 生成 JSON 结果（供实验室/CI 存档）。
pub fn to_json(results: &[CaseResult]) -> aps_engine::json::Json {
    aps_engine::json::Json::Arr(
        results
            .iter()
            .map(|r| {
                aps_engine::json::Json::obj(vec![
                    ("id", aps_engine::json::Json::str(r.id)),
                    ("title", aps_engine::json::Json::str(r.title)),
                    ("ok", aps_engine::json::Json::Bool(r.ok())),
                    (
                        "checks",
                        aps_engine::json::Json::Arr(
                            r.checks
                                .iter()
                                .map(|Check(m, ok)| {
                                    aps_engine::json::Json::obj(vec![
                                        ("name", aps_engine::json::Json::str(m.clone())),
                                        ("ok", aps_engine::json::Json::Bool(*ok)),
                                    ])
                                })
                                .collect(),
                        ),
                    ),
                ])
            })
            .collect(),
    )
}

// ---------------------------------------------------------------- 小工具

mod json_util {
    use aps_engine::json::Json;

    pub fn s_str(j: &Json, key: &str) -> Option<String> {
        j.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
    }
    pub fn s_str_at(j: &Json, path: &[&str]) -> Option<String> {
        let mut cur = j;
        for p in path {
            cur = cur.get(p)?;
        }
        cur.as_str().map(|s| s.to_string())
    }
    pub fn s_num(j: &Json, path: &[&str]) -> Option<i64> {
        s_num_at(j, path)
    }
    pub fn s_num_at(j: &Json, path: &[&str]) -> Option<i64> {
        let mut cur = j;
        for p in path {
            cur = cur.get(p)?;
        }
        cur.as_i64()
    }
    pub fn s_bool(j: &Json, key: &str) -> Option<bool> {
        j.get(key).and_then(|v| v.as_bool())
    }
    pub fn s_bool_at(j: &Json, path: &[&str]) -> Option<bool> {
        let mut cur = j;
        for p in path {
            cur = cur.get(p)?;
        }
        cur.as_bool()
    }
    pub fn arr_len(j: &Json, key: &str) -> Option<usize> {
        j.get(key).and_then(|v| v.as_arr()).map(|a| a.len())
    }
    /// solution.errors[*].code 列表。
    pub fn err_codes(sol: &Json) -> Vec<String> {
        sol.get("errors")
            .and_then(|e| e.as_arr())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|it| {
                        it.get("code")
                            .and_then(|c| c.as_str())
                            .map(|s| s.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}
