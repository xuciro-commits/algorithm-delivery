//! 独立的**物料账本事件重放**（H07）。
//!
//! 定位：本项目里 H07 有三个彼此独立的实现，互相交叉验证——
//!
//! | 实现 | 用途 | 依赖 |
//! |------|------|------|
//! | `schedule::ledger_violation` | 求解器内部自检（相对分钟，与排程数据结构同源） | `compile` / `schedule` |
//! | `verify::verify`（生产级校验器） | 对任意第三方方案做核验 | `model` + `datetime`，**不引用**求解器 |
//! | **本模块** | 验收套件（S03）与解释输出的事件重放，可直接吃 `PlanProblem` + `PlanSolution` | `model` + `verify::RawSolution` |
//!
//! 语义（与契约一致）：按时间升序重放；**同一时刻先入库后领料**；
//! 任一时刻余额 < 0 即为透支（`H07_STOCK_NEGATIVE`）。
//!
//! 单位：全部使用**绝对分钟**（由 ISO 字符串直接解析），不依赖规划起点的相对表示，
//! 因此对跨时区/跨天到货仍然成立。

use crate::errors::{codes, Violation};
use crate::model::{RawMaterial, RawProblem};
use crate::verify::RawSolution;

/// 账本事件类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    /// 入库（initial 另行作为期初余额，不在此列）
    Receipt,
    /// 领料（某工序开工时消耗）
    Consumption,
}

/// 账本事件。
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub at_min: i64,
    pub at_iso: String,
    pub kind: EventKind,
    pub material_id: String,
    pub qty: i64,
    /// 业务定位：到货记录或工序 ID
    pub label: String,
}

/// 透支明细（第一个出现的时刻）。
#[derive(Debug, Clone, PartialEq)]
pub struct Overdraft {
    pub material_id: String,
    pub at_min: i64,
    pub at_iso: String,
    pub balance: i64,
    pub qty: i64,
    pub label: String,
}

/// 按“先入库、后领料”的次序重放某物料：入库事件直接取 `mat.receipts`，
/// 领料事件由调用方提供（来自方案中的工序开工时刻）。返回首个透支。
fn replay_material(
    mat: &RawMaterial,
    consumptions: Vec<Event>,
    offset_min: i32,
) -> Option<Overdraft> {
    let mut events: Vec<Event> = mat
        .receipts
        .iter()
        .map(|r| Event {
            at_min: r.at_min,
            at_iso: r.at.clone(),
            kind: EventKind::Receipt,
            material_id: mat.id.clone(),
            qty: r.quantity,
            label: format!("到货 {}", r.at),
        })
        .collect();
    events.extend(consumptions);
    // (时间, 类型序：0=入库 1=领料) —— 同一时刻先入库后领料
    events.sort_by(|a, b| (a.at_min, kind_rank(a.kind)).cmp(&(b.at_min, kind_rank(b.kind))));
    let mut balance = mat.initial_quantity;
    for e in events {
        match e.kind {
            EventKind::Receipt => balance += e.qty,
            EventKind::Consumption => balance -= e.qty,
        }
        if balance < 0 {
            return Some(Overdraft {
                material_id: mat.id.clone(),
                at_min: e.at_min,
                at_iso: if e.at_iso.is_empty() {
                    crate::datetime::format_iso8601(e.at_min, offset_min)
                } else {
                    e.at_iso.clone()
                },
                balance,
                qty: e.qty,
                label: e.label.clone(),
            });
        }
    }
    None
}

fn kind_rank(k: EventKind) -> u8 {
    match k {
        EventKind::Receipt => 0,
        EventKind::Consumption => 1,
    }
}

/// 从问题与方案构造全部账本事件（不含 `initial_quantity` 期初余额）。
pub fn build_events(problem: &RawProblem, solution: &RawSolution) -> Vec<Event> {
    let mut events: Vec<Event> = Vec::new();
    for m in problem.materials.iter() {
        for r in m.receipts.iter() {
            events.push(Event {
                at_min: r.at_min,
                at_iso: r.at.clone(),
                kind: EventKind::Receipt,
                material_id: m.id.clone(),
                qty: r.quantity,
                label: format!("到货 {}", r.at),
            });
        }
    }
    // 工序 → 物料消耗：以问题里的定义为准，按方案的 start_at 落账
    for op in solution.operations.iter() {
        let Some(start) = op.start_min else {
            continue; // 时间非法由 H01 报告，这里不重复判罚
        };
        let materials = problem
            .orders
            .iter()
            .flat_map(|o| o.operations.iter())
            .find(|o| o.id == op.operation_id)
            .map(|o| o.materials.clone())
            .unwrap_or_default();
        for (mid, qty) in materials.iter() {
            events.push(Event {
                at_min: start,
                at_iso: op.start_at.clone(),
                kind: EventKind::Consumption,
                material_id: mid.clone(),
                qty: *qty,
                label: format!("工序 {}", op.operation_id),
            });
        }
    }
    events
}

/// 重放全部物料，返回所有透支（按物料、时间排序）。
pub fn overdrafts(problem: &RawProblem, solution: &RawSolution) -> Vec<Overdraft> {
    let events = build_events(problem, solution);
    let mut out: Vec<Overdraft> = Vec::new();
    for m in problem.materials.iter() {
        let consumptions: Vec<Event> = events
            .iter()
            .filter(|e| e.material_id == m.id && e.kind == EventKind::Consumption)
            .cloned()
            .collect();
        if let Some(od) = replay_material(m, consumptions, problem.meta.offset_min) {
            out.push(od);
        }
    }
    out
}

/// 生成 `H07_STOCK_NEGATIVE` 违约列表（以及未知物料的契约级违约）。
///
/// 未知物料（方案消耗了问题中不存在的物料）由 `verify` 负责报告；本函数只处理账本非负性，
/// 因此可以独立用于“给定问题的任意方案”的快速体检。
pub fn violations(problem: &RawProblem, solution: &RawSolution) -> Vec<Violation> {
    let mut out = Vec::new();
    for od in overdrafts(problem, solution) {
        let mut v = Violation::new(
            codes::H07_STOCK_NEGATIVE,
            "MATERIAL",
            format!(
                "物料 '{}' 在 {} 透支至 {}（本次领用 {}，来自 {}）",
                od.material_id, od.at_iso, od.balance, od.qty, od.label
            ),
        );
        v.resource_id = Some(od.material_id.clone());
        v.at = Some(od.at_iso.clone());
        v.details.push((
            "balance_after".into(),
            crate::json::Json::int(od.balance),
        ));
        v.details
            .push(("qty".into(), crate::json::Json::int(od.qty)));
        v.details
            .push(("event".into(), crate::json::Json::str(od.label)));
        out.push(v);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;
    use crate::model;

    fn load(rel: &str) -> (RawProblem, String) {
        let text =
            std::fs::read_to_string(format!("{}/../{}", env!("CARGO_MANIFEST_DIR"), rel)).unwrap();
        let j = json::parse(&text).unwrap();
        (model::parse_problem(&j).0.unwrap(), text)
    }

    fn parse_solution(text: &str) -> RawSolution {
        let j = json::parse(text).unwrap();
        crate::verify::parse_solution(&j).0.unwrap()
    }

    #[test]
    fn witness_has_no_overdraft_on_baseline() {
        let (problem, _) = load("mock/baseline.json");
        let witness = std::fs::read_to_string(format!(
            "{}/../tests/baseline-feasible-witness.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let solution = parse_solution(&witness);
        assert!(overdrafts(&problem, &solution).is_empty());
    }

    #[test]
    fn same_timestamp_receipt_is_consumed_after_arrival() {
        // 期初 0；10:00 到货 5；10:00 开工消耗 5 → 合法（先入库后领料）
        let mat = RawMaterial {
            id: "M".into(),
            initial_quantity: 0,
            receipts: vec![crate::model::RawReceipt {
                at: "2026-10-05T10:00:00-07:00".into(),
                at_min: 600,
                quantity: 5,
            }],
        };
        let ev = vec![Event {
            at_min: 600,
            at_iso: String::new(),
            kind: EventKind::Consumption,
            material_id: "M".into(),
            qty: 5,
            label: "工序 X".into(),
        }];
        assert_eq!(replay_material(&mat, ev, -420), None);

        // 若到货推迟到 10:01，同一领用就透支
        let mut mat_late = mat.clone();
        mat_late.receipts[0].at_min = 601;
        let ev2 = vec![Event {
            at_min: 600,
            at_iso: String::new(),
            kind: EventKind::Consumption,
            material_id: "M".into(),
            qty: 5,
            label: "工序 X".into(),
        }];
        assert!(replay_material(&mat_late, ev2, -420).is_some());
    }

    #[test]
    fn material_delay_scenario_is_event_ordered() {
        let (problem, _) = load("mock/material-delay.json");
        // 用 baseline 的参考解去核验到货延迟问题：喷涂被推迟，账本必须非负
        let witness = std::fs::read_to_string(format!(
            "{}/../tests/baseline-feasible-witness.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let solution = parse_solution(&witness);
        // 参考解是针对旧快照的，这里只关心账本；把快照对齐后重放
        let mut sol = solution.clone();
        sol.snapshot_id = problem.meta.snapshot_id.clone();
        let od = overdrafts(&problem, &sol);
        // 参考解在到货延迟下会提前领用 M-PAINT，因此应当检出透支（说明重放真的在看时间）
        assert!(
            od.iter().any(|o| o.material_id == "M-PAINT"),
            "应检出来料到货前的 M-PAINT 透支，实际 {:?}",
            od
        );
    }
}
