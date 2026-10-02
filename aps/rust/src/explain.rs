//! 单工序约束依据解释（APS-SRS §5.2：“选中工序查看其全部约束依据”）。
//!
//! 输出该工序的：备选机器与时长、实际机器与能力校验、人员技能/资格、工装、物料到货与消耗、
//! 前后置工序、所在可用窗口、以及 H01–H08 的逐条核验结论。
//! 数据来自**独立校验器**的解析结果，因此与前端展示的逻辑一致。

use std::collections::BTreeMap;

use crate::errors::{Severity, Violation};
use crate::json::Json;
use crate::model::RawProblem;
use crate::verify::{parse_minutes, RawSolution};

/// 生成解释 JSON；`operation_id` 不存在时返回带 `error` 字段的对象。
pub fn explain_operation(
    problem: &RawProblem,
    solution: &RawSolution,
    operation_id: &str,
) -> Json {
    let op_row = solution
        .operations
        .iter()
        .find(|o| o.operation_id == operation_id);
    let (order, spec) = match problem
        .orders
        .iter()
        .find_map(|o| o.operations.iter().find(|op| op.id == operation_id).map(|op| (o, op)))
    {
        Some(v) => v,
        None => {
            return Json::obj(vec![
                ("operation_id", Json::str(operation_id.to_string())),
                (
                    "error",
                    Json::str("问题模型中不存在该工序 ID".to_string()),
                ),
            ])
        }
    };

    let (start, end, machine_id, worker_id, tools) = match op_row {
        Some(r) => (
            r.start_min,
            r.end_min,
            Some(r.machine_id.clone()),
            Some(r.worker_id.clone()),
            r.tool_ids.clone(),
        ),
        None => (None, None, None, None, Vec::new()),
    };

    let iso = |m: Option<i64>| match m {
        Some(v) => Json::str(crate::datetime::format_iso8601(v, problem.meta.offset_min)),
        None => Json::Null,
    };

    let machine_obj = |id: &str| -> Json {
        match problem.machines.iter().find(|m| m.id == id) {
            None => Json::Null,
            Some(m) => {
                let containing = match start {
                    Some(s) => m
                        .available
                        .iter()
                        .find(|w| w.start_min <= s && w.end_min >= end.unwrap_or(s))
                        .map(|w| {
                            Json::obj(vec![
                                ("start", Json::str(w.start.clone())),
                                ("end", Json::str(w.end.clone())),
                            ])
                        })
                        .unwrap_or(Json::Null),
                    None => Json::Null,
                };
                Json::obj(vec![
                    ("id", Json::str(m.id.clone())),
                    ("capabilities", Json::strings(m.capabilities.clone())),
                    ("capability_ok", Json::Bool(m.capabilities.iter().any(|c| c == &spec.skill))),
                    ("containing_window", containing),
                    (
                        "blocked_count",
                        Json::int(m.blocked.len() as i64),
                    ),
                ])
            }
        }
    };

    let worker_obj = match worker_id.as_deref() {
        None => Json::Null,
        Some(wid) => match problem.workers.iter().find(|w| w.id == wid) {
            None => Json::Null,
            Some(w) => Json::obj(vec![
                ("id", Json::str(w.id.clone())),
                ("skills", Json::strings(w.skills.clone())),
                ("qualifications", Json::strings(w.qualifications.clone())),
                (
                    "skill_ok",
                    Json::Bool(w.skills.iter().any(|s| s == &spec.skill)),
                ),
                (
                    "missing_qualifications",
                    Json::strings(
                        spec.qualifications
                            .iter()
                            .filter(|q| !w.qualifications.iter().any(|wq| wq == *q))
                            .cloned()
                            .collect::<Vec<_>>(),
                    ),
                ),
            ]),
        },
    };

    // 物料：到货时刻与本次消耗后的余额轨迹
    let mut material_items: Vec<Json> = Vec::new();
    for (mat_id, qty) in spec.materials.iter() {
        match problem.materials.iter().find(|m| m.id == *mat_id) {
            None => material_items.push(Json::obj(vec![
                ("id", Json::str(mat_id.clone())),
                ("error", Json::str("物料不存在")),
            ])),
            Some(m) => {
                let mut events: Vec<(i64, u8, i64)> = m
                    .receipts
                    .iter()
                    .map(|r| (r.at_min, 0u8, r.quantity))
                    .collect();
                for op in solution.operations.iter() {
                    if let (Some(s), Some(_)) = (op.start_min, op.end_min) {
                        for (mid, q) in spec_of(problem, &op.operation_id)
                            .map(|s| s.materials.clone())
                            .unwrap_or_default()
                        {
                            if mid == *mat_id {
                                events.push((s, 1, q));
                            }
                        }
                    }
                }
                events.sort_by_key(|e| (e.0, e.1));
                let mut stock = m.initial_quantity;
                let mut trace: Vec<Json> = Vec::new();
                for (t, kind, q) in events {
                    if kind == 0 {
                        stock += q;
                    } else {
                        stock -= q;
                    }
                    if kind == 1 && stock < 0 {
                        trace.push(Json::obj(vec![
                            (
                                "at",
                                Json::str(crate::datetime::format_iso8601(
                                    t,
                                    problem.meta.offset_min,
                                )),
                            ),
                            ("action", Json::str("领料")),
                            ("quantity", Json::int(q)),
                            ("balance", Json::int(stock)),
                            ("shortfall", Json::Bool(true)),
                        ]));
                        break;
                    }
                }
                material_items.push(Json::obj(vec![
                    ("id", Json::str(m.id.clone())),
                    ("initial_quantity", Json::int(m.initial_quantity)),
                    (
                        "receipts",
                        Json::Arr(
                            m.receipts
                                .iter()
                                .map(|r| {
                                    Json::obj(vec![
                                        ("at", Json::str(r.at.clone())),
                                        ("quantity", Json::int(r.quantity)),
                                    ])
                                })
                                .collect(),
                        ),
                    ),
                    ("required_quantity", Json::int(*qty)),
                    ("negative_after", Json::Bool(!trace.is_empty())),
                    ("trace", Json::Arr(trace)),
                ]));
            }
        }
    }

    // 前后置
    let preds: Vec<Json> = spec
        .predecessors
        .iter()
        .map(|p| {
            let row = solution.operations.iter().find(|o| &o.operation_id == p);
            Json::obj(vec![
                ("operation_id", Json::str(p.clone())),
                (
                    "end_at",
                    row.map(|r| iso(r.end_min)).unwrap_or(Json::Null),
                ),
                (
                    "satisfied",
                    Json::Bool(match (start, row.and_then(|r| r.end_min)) {
                        (Some(s), Some(pe)) => s >= pe,
                        _ => false,
                    }),
                ),
            ])
        })
        .collect();
    let succs: Vec<Json> = problem
        .orders
        .iter()
        .flat_map(|o| o.operations.iter())
        .filter(|o| o.predecessors.iter().any(|p| p == &spec.id))
        .map(|o| {
            let row = solution.operations.iter().find(|r| r.operation_id == o.id);
            Json::obj(vec![
                ("operation_id", Json::str(o.id.clone())),
                (
                    "start_at",
                    row.map(|r| iso(r.start_min)).unwrap_or(Json::Null),
                ),
            ])
        })
        .collect();

    // 该工序的违约（来自独立校验器）
    let all = crate::verify::verify(problem, solution);
    let violations: Vec<&Violation> = all
        .iter()
        .filter(|v| v.operation_id.as_deref() == Some(operation_id))
        .collect();

    Json::obj(vec![
        ("operation_id", Json::str(spec.id.clone())),
        ("order_id", Json::str(order.id.clone())),
        ("skill", Json::str(spec.skill.clone())),
        ("qualifications", Json::strings(spec.qualifications.clone())),
        (
            "alternatives",
            Json::Arr(
                spec.alternatives
                    .iter()
                    .map(|a| {
                        Json::obj(vec![
                            ("machine_id", Json::str(a.machine_id.clone())),
                            ("duration_min", Json::int(a.duration_min)),
                            (
                                "chosen",
                                Json::Bool(machine_id.as_deref() == Some(a.machine_id.as_str())),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("chosen_machine", Json::opt_str(machine_id.clone())),
        ("chosen_machine_detail", Json::Null),
        (
            "machine",
            machine_id
                .as_deref()
                .map(|m| machine_obj(m))
                .unwrap_or(Json::Null),
        ),
        ("worker", worker_obj),
        ("tool_ids", Json::strings(tools)),
        ("required_tools", Json::strings(spec.tools.clone())),
        ("materials", Json::Arr(material_items)),
        ("predecessors", Json::Arr(preds)),
        ("successors", Json::Arr(succs)),
        ("start_at", iso(start)),
        ("end_at", iso(end)),
        (
            "duration_min",
            match (start, end) {
                (Some(s), Some(e)) => Json::int(e - s),
                _ => Json::Null,
            },
        ),
        (
            "order_window",
            Json::obj(vec![
                ("release_at", Json::str(order.release_at.clone())),
                ("due_at", Json::str(order.due_at.clone())),
                ("priority", Json::int(order.priority)),
                ("quantity", Json::int(order.quantity)),
            ]),
        ),
        (
            "violations",
            Json::Arr(violations.iter().map(|v| v.to_json()).collect()),
        ),
        (
            "verified_ok",
            Json::Bool(violations.is_empty() && op_row.is_some()),
        ),
        (
            "checked_constraints",
            Json::strings(vec!["H01", "H02", "H03", "H04", "H05", "H06", "H07", "H08"]),
        ),
    ])
}

fn spec_of<'a>(
    problem: &'a RawProblem,
    operation_id: &str,
) -> Option<&'a crate::model::RawOperation> {
    problem
        .orders
        .iter()
        .flat_map(|o| o.operations.iter())
        .find(|op| op.id == operation_id)
}

/// 文本形式（CLI 展示）。
pub fn format_explain(j: &Json) -> String {
    let mut s = String::new();
    let g = |k: &str| j.get(k).cloned().unwrap_or(Json::Null);
    s.push_str(&format!(
        "工序 {}（订单 {}）\n",
        g("operation_id").as_str().unwrap_or("?"),
        g("order_id").as_str().unwrap_or("?")
    ));
    s.push_str(&format!(
        "  时间: {} → {}（{} 分钟）\n",
        g("start_at").as_str().unwrap_or("-"),
        g("end_at").as_str().unwrap_or("-"),
        g("duration_min").as_i64().unwrap_or(0)
    ));
    s.push_str(&format!(
        "  技能: {}  资格: {}\n",
        g("skill").as_str().unwrap_or("-"),
        json_list(&g("qualifications"))
    ));
    if let Some(alts) = g("alternatives").as_arr() {
        let list: Vec<String> = alts
            .iter()
            .map(|a| {
                format!(
                    "{}{}",
                    a.get("machine_id").and_then(|v| v.as_str()).unwrap_or("?"),
                    if a.get("chosen").and_then(|v| v.as_bool()).unwrap_or(false) {
                        "*"
                    } else {
                        ""
                    }
                )
            })
            .collect();
        s.push_str(&format!("  备选机器（* = 选中）: {}\n", list.join(", ")));
    }
    if j.get("machine").and_then(|v| v.as_obj()).is_some() {
        s.push_str(&format!(
            "  机器: {}  能力校验: {}\n",
            g("machine").get("id").and_then(|v| v.as_str()).unwrap_or("-"),
            if g("machine")
                .get("capability_ok")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                "通过（H03）"
            } else {
                "不通过（H03）"
            }
        ));
        if g("machine")
            .get("containing_window")
            .and_then(|v| v.as_obj())
            .is_some()
        {
            s.push_str(&format!(
                "  所在可用窗口: {} → {}\n",
                g("machine")
                    .get("containing_window")
                    .and_then(|v| v.get("start"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("-"),
                g("machine")
                    .get("containing_window")
                    .and_then(|v| v.get("end"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("-")
            ));
        }
    }
    if j.get("worker").and_then(|v| v.as_obj()).is_some() {
        s.push_str(&format!(
            "  人员: {}  技能: {}  资格缺失: {}\n",
            g("worker").get("id").and_then(|v| v.as_str()).unwrap_or("-"),
            json_list(&g("worker").get("skills").cloned().unwrap_or(Json::Null)),
            json_list(
                &g("worker")
                    .get("missing_qualifications")
                    .cloned()
                    .unwrap_or(Json::Null)
            )
        ));
    }
    s.push_str(&format!(
        "  工装: 需求 {} / 分配 {}\n",
        json_list(&g("required_tools")),
        json_list(&g("tool_ids"))
    ));
    if let Some(mats) = g("materials").as_arr() {
        for m in mats {
            s.push_str(&format!(
                "  物料 {}: 需求量 {}，初始 {}，到货 {}，是否透支 {}\n",
                m.get("id").and_then(|v| v.as_str()).unwrap_or("-"),
                m.get("required_quantity")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                m.get("initial_quantity")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                m.get("receipts")
                    .and_then(|v| v.as_arr())
                    .map(|a| a.len())
                    .unwrap_or(0),
                if m
                    .get("negative_after")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    "是（H07 违约）"
                } else {
                    "否"
                }
            ));
        }
    }
    s.push_str(&format!(
        "  前置工序: {}  后续工序: {}\n",
        json_field_list(&g("predecessors"), "operation_id", "end_at"),
        json_field_list(&g("successors"), "operation_id", "start_at")
    ));
    s.push_str(&format!(
        "  订单窗口: 投放 {} / 交期 {}（优先级 {}）\n",
        g("order_window")
            .get("release_at")
            .and_then(|v| v.as_str())
            .unwrap_or("-"),
        g("order_window")
            .get("due_at")
            .and_then(|v| v.as_str())
            .unwrap_or("-"),
        g("order_window")
            .get("priority")
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
    ));
    let vs = g("violations");
    match vs.as_arr() {
        Some(list) if list.is_empty() => {
            s.push_str("  核验结论: H01–H08 全部通过（独立校验器）\n")
        }
        Some(list) => {
            s.push_str(&format!("  核验结论: {} 条违约\n", list.len()));
            for v in list {
                s.push_str(&format!(
                    "    [{}] {}\n",
                    v.get("code").and_then(|c| c.as_str()).unwrap_or("?"),
                    v.get("message").and_then(|c| c.as_str()).unwrap_or("")
                ));
            }
        }
        None => {}
    }
    s
}

fn json_list(v: &Json) -> String {
    match v.as_arr() {
        Some(a) if !a.is_empty() => a
            .iter()
            .map(|x| x.as_str().unwrap_or("?").to_string())
            .collect::<Vec<_>>()
            .join(", "),
        _ => "—".to_string(),
    }
}

fn json_field_list(v: &Json, id_key: &str, time_key: &str) -> String {
    match v.as_arr() {
        Some(a) if !a.is_empty() => a
            .iter()
            .map(|x| {
                format!(
                    "{}@{}",
                    x.get(id_key).and_then(|c| c.as_str()).unwrap_or("?"),
                    x.get(time_key).and_then(|c| c.as_str()).unwrap_or("-")
                )
            })
            .collect::<Vec<_>>()
            .join(", "),
        _ => "—".to_string(),
    }
}

/// 供 UI 使用的“为什么不能更早”诊断：返回该工序之前被占用的资源与时段。
pub fn blocking_resources(problem: &RawProblem, solution: &RawSolution, operation_id: &str) -> Json {
    let (start, machine_id, worker_id, tools) = match solution
        .operations
        .iter()
        .find(|o| o.operation_id == operation_id)
    {
        Some(r) => (
            r.start_min.unwrap_or(0),
            r.machine_id.clone(),
            r.worker_id.clone(),
            r.tool_ids.clone(),
        ),
        None => return Json::Null,
    };
    let mut conflicts: BTreeMap<String, Vec<(i64, i64, String)>> = BTreeMap::new();
    for op in solution.operations.iter() {
        if op.operation_id == operation_id {
            continue;
        }
        let (s, e) = match (op.start_min, op.end_min) {
            (Some(s), Some(e)) => (s, e),
            _ => continue,
        };
        if e > start {
            continue; // 只关心“占住位置”的工序
        }
        let mut tags: Vec<String> = Vec::new();
        if op.machine_id == machine_id {
            tags.push(format!("机器 {}", machine_id));
        }
        if op.worker_id == worker_id {
            tags.push(format!("人员 {}", worker_id));
        }
        for t in op.tool_ids.iter() {
            if tools.contains(t) {
                tags.push(format!("工装 {}", t));
            }
        }
        for tag in tags {
            conflicts.entry(tag).or_default().push((
                s,
                e,
                op.operation_id.clone(),
            ));
        }
    }
    let items: Vec<Json> = conflicts
        .into_iter()
        .map(|(res, mut list)| {
            list.sort();
            Json::obj(vec![
                ("resource", Json::str(res)),
                (
                    "occupied",
                    Json::Arr(
                        list.iter()
                            .rev()
                            .take(5)
                            .map(|(s, e, op)| {
                                Json::obj(vec![
                                    ("operation_id", Json::str(op.clone())),
                                    (
                                        "start",
                                        Json::str(crate::datetime::format_iso8601(
                                            *s,
                                            problem.meta.offset_min,
                                        )),
                                    ),
                                    (
                                        "end",
                                        Json::str(crate::datetime::format_iso8601(
                                            *e,
                                            problem.meta.offset_min,
                                        )),
                                    ),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ])
        })
        .collect();
    Json::Arr(items)
}

/// 便捷：判断某工序是否通过全部核验（前端打勾用）。
pub fn operation_ok(problem: &RawProblem, solution: &RawSolution, operation_id: &str) -> bool {
    let violations = crate::verify::verify(problem, solution);
    !violations.iter().any(|v| {
        v.operation_id.as_deref() == Some(operation_id) && v.severity == Severity::Error
    })
}

/// 供 CLI 使用：解析“相对分钟”文本（如 `+2h`）——此处仅保留 ISO 解析。
pub fn parse_iso(text: &str) -> Option<i64> {
    parse_minutes(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;

    fn load(rel: &str) -> crate::model::RawProblem {
        let text =
            std::fs::read_to_string(format!("{}/../{}", env!("CARGO_MANIFEST_DIR"), rel)).unwrap();
        let j = json::parse(&text).unwrap();
        crate::model::parse_problem(&j).0.unwrap()
    }

    #[test]
    fn explain_witness_operation() {
        let p = load("mock/baseline.json");
        let sj = json::parse(
            &std::fs::read_to_string(format!(
                "{}/../tests/baseline-feasible-witness.json",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap(),
        )
        .unwrap();
        let sol = crate::verify::parse_solution(&sj).0.unwrap();
        let j = explain_operation(&p, &sol, "ORD-001-CUT");
        assert_eq!(j.get("operation_id").unwrap().as_str(), Some("ORD-001-CUT"));
        assert_eq!(
            j.get("machine").unwrap().get("capability_ok").unwrap().as_bool(),
            Some(true)
        );
        assert_eq!(j.get("verified_ok").unwrap().as_bool(), Some(true));
        let text = format_explain(&j);
        assert!(text.contains("ORD-001-CUT"));
        assert!(text.contains("核验结论"));
        let blocking = blocking_resources(&p, &sol, "ORD-002-CUT");
        assert!(blocking.as_arr().is_some());
    }

    #[test]
    fn unknown_operation_reports_error() {
        let p = load("mock/baseline.json");
        let sj = json::parse(
            &std::fs::read_to_string(format!(
                "{}/../tests/baseline-feasible-witness.json",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap(),
        )
        .unwrap();
        let sol = crate::verify::parse_solution(&sj).0.unwrap();
        let j = explain_operation(&p, &sol, "NO-SUCH-OP");
        assert!(j.get("error").is_some());
    }

    #[test]
    fn error_codes_are_exported() {
        assert!(crate::errors::codes::H01_DURATION_MISMATCH.starts_with("H01"));
    }
}
