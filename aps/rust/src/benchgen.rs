//! 规模基准生成器（等价移植 `tests/generate_benchmark.py`）。
//!
//! 用法与 Python 版本完全一致：由 `mock/baseline.json` 复制出 N/24 个**相互独立的车间单元**，
//! 单元内 ID 前缀为 `CELL001__` 等。它的用途是**模型大小 / 序列化 / 内存压测**，
//! **不能**当作“复杂耦合排程难度”的基准（与 Python 版本注释一致）。
//!
//! 移植后可用 `tests/benchgen_parity.rs` 与 Python 输出做逐字段比对（见 `aps accept`）。

use crate::json::Json;

/// 生成 N 工序的可分离基准（N 必须是 24 的倍数）。
pub fn build_separable(baseline: &Json, operations: usize) -> Result<Json, String> {
    if operations == 0 || operations % 24 != 0 {
        return Err(format!(
            "工序数必须是 24 的倍数（当前 {operations}），与 generate_benchmark.py 保持一致"
        ));
    }
    let cells = operations / 24;
    let mut z = baseline.clone();
    if let Some(meta) = z.get_mut("meta") {
        meta.set(
            "snapshot_id",
            Json::str(format!("benchmark-{operations}-separable-seed42")),
        );
    }

    let base_machines = baseline
        .get("machines")
        .and_then(|v| v.as_arr())
        .ok_or("基线缺少 machines")?
        .to_vec();
    let base_workers = baseline
        .get("workers")
        .and_then(|v| v.as_arr())
        .ok_or("基线缺少 workers")?
        .to_vec();
    let base_tools = baseline
        .get("tools")
        .and_then(|v| v.as_arr())
        .ok_or("基线缺少 tools")?
        .to_vec();
    let base_materials = baseline
        .get("materials")
        .and_then(|v| v.as_arr())
        .ok_or("基线缺少 materials")?
        .to_vec();
    let base_orders = baseline
        .get("orders")
        .and_then(|v| v.as_arr())
        .ok_or("基线缺少 orders")?
        .to_vec();

    let mut machines: Vec<Json> = Vec::new();
    let mut workers: Vec<Json> = Vec::new();
    let mut tools: Vec<Json> = Vec::new();
    let mut materials: Vec<Json> = Vec::new();
    let mut orders: Vec<Json> = Vec::new();

    for idx in 0..cells {
        let prefix = format!("CELL{:03}", idx + 1);
        let nid = |id: &str| -> String { format!("{prefix}__{id}") };

        for m in base_machines.iter() {
            let mut m = m.clone();
            if let Some(id) = m.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                m.set("id", Json::str(nid(&id)));
            }
            machines.push(m);
        }
        for w in base_workers.iter() {
            let mut w = w.clone();
            if let Some(id) = w.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                w.set("id", Json::str(nid(&id)));
            }
            workers.push(w);
        }
        for t in base_tools.iter() {
            let mut t = t.clone();
            if let Some(id) = t.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                t.set("id", Json::str(nid(&id)));
            }
            tools.push(t);
        }
        for mat in base_materials.iter() {
            let mut mat = mat.clone();
            if let Some(id) = mat
                .get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
            {
                mat.set("id", Json::str(nid(&id)));
            }
            materials.push(mat);
        }
        for order in base_orders.iter() {
            let mut o = order.clone();
            if let Some(id) = o.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                o.set("id", Json::str(nid(&id)));
            }
            if let Some(ops) = o.get_mut("operations").and_then(|v| v.as_arr_mut()) {
                for op in ops.iter_mut() {
                    if let Some(id) = op.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                        op.set("id", Json::str(nid(&id)));
                    }
                    if let Some(preds) = op.get_mut("predecessors").and_then(|v| v.as_arr_mut()) {
                        for p in preds.iter_mut() {
                            if let Some(pid) = p.as_str().map(|s| s.to_string()) {
                                *p = Json::str(nid(&pid));
                            }
                        }
                    }
                    if let Some(alts) = op.get_mut("alternatives").and_then(|v| v.as_arr_mut()) {
                        for a in alts.iter_mut() {
                            if let Some(mid) = a
                                .get("machine_id")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                            {
                                a.set("machine_id", Json::str(nid(&mid)));
                            }
                        }
                    }
                    if let Some(tl) = op.get_mut("tools").and_then(|v| v.as_arr_mut()) {
                        for t in tl.iter_mut() {
                            if let Some(tid) = t.as_str().map(|s| s.to_string()) {
                                *t = Json::str(nid(&tid));
                            }
                        }
                    }
                    if let Some(Json::Obj(fields)) = op.get_mut("materials") {
                        let renamed: Vec<(String, Json)> =
                            fields.iter().map(|(k, v)| (nid(k), v.clone())).collect();
                        *fields = renamed;
                    }
                }
            }
            orders.push(o);
        }
    }

    z.set("machines", Json::Arr(machines));
    z.set("workers", Json::Arr(workers));
    z.set("tools", Json::Arr(tools));
    z.set("materials", Json::Arr(materials));
    z.set("orders", Json::Arr(orders));
    Ok(z)
}

/// 生成**资源竞争型（coupled）**基准：所有订单共享同一套机器/人员/工装/物料，
/// 而不是像 `build_separable` 那样复制出互不相干的车间单元。
///
/// 与 Python 版 `generate_benchmark.py` 的关系：那个生成器（及其 Rust 移植）刻意做成
/// “可分离”，用于模型大小与序列化压测；本函数补上**真正的资源争夺**，
/// 用于观察求解质量（makespan / 相对差距 / 变更影响），两者用途不同、输出不同。
///
/// 设计要点：
/// * 以 `mock/baseline.json` 的 8 个订单为模板整轮复制到 `orders` 个订单（`orders` 为 8 的倍数），
///   订单 ID 前缀 `J0001__`，跨订单前置关系同步改写；
/// * 机器/人员/工装**不复制**，全部订单共用（这是竞争来源：喷涂仅 1 台、人员共 8 名）；
/// * 资源可用窗口按“产能估算”扩展到足够的工作日（周一至周五 08–12、13–17），
///   估算方法：对每个技能取 `总工作量 / min(合格机器数, 合格人员数)` 的最大值，×1.5 裕量；
/// * 物料库存/到货按轮数放大（保证“整批消耗”语义下可行）；
/// * `horizon_end` 取最后一个可用窗口的结束时间；
/// * 投放/交期按轮次平移（每轮 = 估算的单轮工作日数），使各轮订单的交期松紧与基线一致，
///   同时相邻轮次在时间上重叠 → 真实竞争。
pub fn build_coupled(baseline: &Json, orders: usize, seed: u64) -> Result<Json, String> {
    if orders == 0 || orders % 8 != 0 {
        return Err(format!(
            "订单数必须是 8 的倍数（当前 {orders}），以便整轮复制基线工艺路线"
        ));
    }
    let mut z = baseline.clone();
    let arr = |name: &str| -> Result<Vec<Json>, String> {
        baseline
            .get(name)
            .and_then(|v| v.as_arr())
            .map(|v| v.to_vec())
            .ok_or_else(|| format!("基线缺少 {name}"))
    };
    let base_machines = arr("machines")?;
    let base_workers = arr("workers")?;
    let base_tools = arr("tools")?;
    let base_materials = arr("materials")?;
    let base_orders = arr("orders")?;
    if base_orders.is_empty() {
        return Err("基线 orders 为空".to_string());
    }

    let rounds = orders / 8;
    const DAY: i64 = 1440;
    const OFFSET: i32 = -420; // 基线时区 America/Los_Angeles（PDT）
    const WORK_MIN_PER_DAY: i64 = 480; // 08–12 + 13–17

    let start_iso = baseline
        .get("meta")
        .and_then(|m| m.get("horizon_start"))
        .and_then(|v| v.as_str())
        .unwrap_or("2026-10-05T08:00:00-07:00")
        .to_string();
    let start_min = crate::datetime::parse_to_epoch_min(&start_iso)
        .map_err(|e| format!("horizon_start 无法解析: {e}"))?;
    // 本地日序（用于按“工作日”生成窗口）
    let start_local_day = (start_min + OFFSET as i64).div_euclid(DAY);
    // 1970-01-01 是周四 → 周日=0 的星期序号（0=周日, 1=周一, …, 6=周六）
    let weekday_of = |local_day: i64| -> i64 { (local_day + 4).rem_euclid(7) };
    // 工作日 = 周一..周五（注意：周日=0，故不能用 wd < 5，否则会把周日算成工作日）
    let is_workday = |local_day: i64| -> bool { (1..=5).contains(&weekday_of(local_day)) };

    // ---- 产能估算：每种技能的“单轮工作量 / 可用资源数” ----
    let machine_has = |m: &Json, sk: &str| -> bool {
        m.get("capabilities")
            .and_then(|v| v.as_arr())
            .map(|caps| caps.iter().any(|c| c.as_str() == Some(sk)))
            .unwrap_or(false)
    };
    let worker_has = |w: &Json, sk: &str| -> bool {
        w.get("skills")
            .and_then(|v| v.as_arr())
            .map(|sk2| sk2.iter().any(|c| c.as_str() == Some(sk)))
            .unwrap_or(false)
    };

    // 单轮工作量（取每道工序最短备选时长）
    let mut work: Vec<(String, i64)> = Vec::new();
    for o in base_orders.iter() {
        for op in o
            .get("operations")
            .and_then(|v| v.as_arr())
            .unwrap_or(&[])
            .iter()
        {
            let sk = op
                .get("skill")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let dur = op
                .get("alternatives")
                .and_then(|v| v.as_arr())
                .map(|alts| {
                    alts.iter()
                        .filter_map(|a| a.get("duration_min").and_then(|v| v.as_i64()))
                        .min()
                        .unwrap_or(0)
                })
                .unwrap_or(0);
            match work.iter_mut().find(|(s, _)| s == &sk) {
                Some((_, w)) => *w += dur,
                None => work.push((sk, dur)),
            }
        }
    }
    // 每个技能所需跨度（分钟）→ 工作日
    let mut days_needed: i64 = 1;
    for (sk, dur) in work.iter() {
        let m = base_machines
            .iter()
            .filter(|x| machine_has(x, sk))
            .count()
            .max(1) as i64;
        let w = base_workers
            .iter()
            .filter(|x| worker_has(x, sk))
            .count()
            .max(1) as i64;
        let span = dur * rounds as i64 / m.min(w);
        let days = (span as f64 / WORK_MIN_PER_DAY as f64 * 1.5).ceil() as i64 + 1;
        days_needed = days_needed.max(days);
    }
    let span_days = days_needed.clamp(2, 120);
    // 投放间隔：刻意取“单轮瓶颈工时”的 60%，即**到货速率高于产能**，
    // 于是队列会持续累积、相邻轮次必须争抢同一批资源 —— 这才是真正的资源竞争基准。
    // （若按每轮产能投放，各轮互不干扰，makespan 只反映日历而非竞争，失去意义。）
    let per_round_bottleneck = work
        .iter()
        .map(|(sk, dur)| {
            let m = base_machines
                .iter()
                .filter(|x| machine_has(x, sk))
                .count()
                .max(1) as i64;
            let w = base_workers
                .iter()
                .filter(|x| worker_has(x, sk))
                .count()
                .max(1) as i64;
            dur / m.min(w)
        })
        .max()
        .unwrap_or(WORK_MIN_PER_DAY);
    let shift_min = (per_round_bottleneck * 3 / 5).max(15);
    // 总时域 = 最后一轮投放时刻 + 产能跨度（再留 1 天余量），保证末轮订单可排程
    let days_needed = ((shift_min * (rounds as i64 - 1) + span_days * DAY) / DAY + 1).min(400);

    // ---- 生成工作日窗口（周一至周五 08–12、13–17） ----
    let mut windows: Vec<Json> = Vec::new();
    let mut cursor = start_local_day;
    let mut made = 0i64;
    let mut last_end_local = 0i64;
    while made < days_needed {
        if is_workday(cursor) {
            let base = cursor * DAY;
            for (a, b) in [(480i64, 720i64), (780, 1020)] {
                // 08:00+1... 实际为 480=08:00, 720=12:00, 780=13:00, 1020=17:00
                windows.push(Json::obj(vec![
                    (
                        "start",
                        Json::str(crate::datetime::format_iso8601(
                            base + a - OFFSET as i64,
                            OFFSET,
                        )),
                    ),
                    (
                        "end",
                        Json::str(crate::datetime::format_iso8601(
                            base + b - OFFSET as i64,
                            OFFSET,
                        )),
                    ),
                ]));
                last_end_local = base + b;
            }
            made += 1;
        }
        cursor += 1;
    }
    let horizon_end_min = last_end_local - OFFSET as i64;

    let rooms = |list: Vec<Json>| -> Vec<Json> {
        list.into_iter()
            .map(|mut r| {
                r.set("available", Json::Arr(windows.clone()));
                r
            })
            .collect()
    };

    z.set("machines", Json::Arr(rooms(base_machines.clone())));
    z.set("workers", Json::Arr(rooms(base_workers.clone())));
    z.set("tools", Json::Arr(base_tools.clone()));

    // ---- 物料：库存与到货按轮数放大（略留裕量） ----
    let mut materials: Vec<Json> = Vec::new();
    for m in base_materials.iter() {
        let mut m = m.clone();
        let scale = |v: i64| -> i64 { (v * rounds as i64 * 11) / 10 + rounds as i64 };
        if let Some(q) = m.get("initial_quantity").and_then(|v| v.as_i64()) {
            m.set("initial_quantity", Json::int(scale(q)));
        }
        if let Some(rs) = m.get_mut("receipts").and_then(|v| v.as_arr_mut()) {
            for r in rs.iter_mut() {
                if let Some(q) = r.get("quantity").and_then(|v| v.as_i64()) {
                    r.set("quantity", Json::int(scale(q)));
                }
                if let Some(at) = r.get("at").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                    if let Ok(min) = crate::datetime::parse_to_epoch_min(&at) {
                        r.set(
                            "at",
                            Json::str(crate::datetime::format_iso8601(min, OFFSET)),
                        );
                    }
                }
            }
        }
        materials.push(m);
    }
    z.set("materials", Json::Arr(materials));

    // ---- 订单：整轮复制模板，ID 加 J####__ 前缀，跨订单前置同步改写 ----
    let mut orders_json: Vec<Json> = Vec::new();
    for round in 0..rounds {
        // 第 round 轮投放/交期按固定间隔平移（间隔 < 单轮产能 → 队列累积）
        let shift_local = round as i64 * shift_min;
        for (i, tpl) in base_orders.iter().enumerate() {
            let prefix = format!("J{:04}", round * 8 + i + 1);
            let nid = |id: &str| -> String { format!("{prefix}__{id}") };
            let mut o = tpl.clone();
            if let Some(id) = o.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                o.set("id", Json::str(nid(&id)));
            }
            for (field, base) in [
                (
                    "release_at",
                    o.get("release_at")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                ),
                (
                    "due_at",
                    o.get("due_at")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                ),
            ] {
                if let Some(iso) = base {
                    if let Ok(m) = crate::datetime::parse_to_epoch_min(&iso) {
                        o.set(
                            field,
                            Json::str(crate::datetime::format_iso8601(m + shift_local, OFFSET)),
                        );
                    }
                }
            }
            if let Some(ops) = o.get_mut("operations").and_then(|v| v.as_arr_mut()) {
                for op in ops.iter_mut() {
                    if let Some(id) = op.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                        op.set("id", Json::str(nid(&id)));
                    }
                    if let Some(preds) = op.get_mut("predecessors").and_then(|v| v.as_arr_mut()) {
                        for p in preds.iter_mut() {
                            if let Some(pid) = p.as_str().map(|s| s.to_string()) {
                                *p = Json::str(nid(&pid));
                            }
                        }
                    }
                    // 机器/人员/工装/物料保持基线 ID（共享资源 → 资源竞争）
                }
            }
            orders_json.push(o);
        }
    }
    z.set("orders", Json::Arr(orders_json));

    if let Some(meta) = z.get_mut("meta") {
        meta.set(
            "snapshot_id",
            Json::str(format!("benchmark-{orders}-coupled-seed{seed}")),
        );
        meta.set("horizon_start", Json::str(start_iso.clone()));
        meta.set(
            "horizon_end",
            Json::str(crate::datetime::format_iso8601(horizon_end_min, OFFSET)),
        );
    }
    Ok(z)
}

/// 统计工序数（用于校验）。
pub fn count_operations(problem: &Json) -> usize {
    problem
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
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn baseline() -> Json {
        let text = std::fs::read_to_string(format!(
            "{}/../mock/baseline.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        crate::json::parse(&text).unwrap()
    }

    #[test]
    fn builds_expected_scale() {
        let base = baseline();
        let p = build_separable(&base, 240).unwrap();
        assert_eq!(count_operations(&p), 240);
        assert_eq!(
            p.get("meta").unwrap().get("snapshot_id").unwrap().as_str(),
            Some("benchmark-240-separable-seed42")
        );
        let machines = p.get("machines").unwrap().as_arr().unwrap();
        assert_eq!(machines.len(), 5 * 10);
        assert_eq!(
            machines[0].get("id").unwrap().as_str(),
            Some("CELL001__CUT-01")
        );
        // 单元之间完全独立（前缀不同）
        assert_eq!(
            machines[5].get("id").unwrap().as_str(),
            Some("CELL002__CUT-01")
        );
        let orders = p.get("orders").unwrap().as_arr().unwrap();
        assert_eq!(orders.len(), 8 * 10);
        let op0 = &orders[0].get("operations").unwrap().as_arr().unwrap()[0];
        assert_eq!(
            op0.get("materials")
                .unwrap()
                .get("CELL001__M-BLANK")
                .unwrap()
                .as_i64(),
            Some(2)
        );
    }

    #[test]
    fn coupled_shares_resources_and_covers_horizon() {
        let base = baseline();
        let p = build_coupled(&base, 48, 42).unwrap();
        assert_eq!(count_operations(&p), 144);
        // 资源不复制：机器/人员与基线同 ID（这是“竞争”的来源）
        let machines = p.get("machines").unwrap().as_arr().unwrap();
        assert_eq!(machines.len(), base_machines_len(&base));
        assert_eq!(machines[0].get("id").unwrap().as_str(), Some("CUT-01"));
        // 时域必须覆盖全部资源窗口的最后结束时刻
        let end = p
            .get("meta")
            .unwrap()
            .get("horizon_end")
            .unwrap()
            .as_str()
            .unwrap()
            .to_string();
        let end_min = crate::datetime::parse_to_epoch_min(&end).unwrap();
        for m in machines.iter() {
            for w in m.get("available").unwrap().as_arr().unwrap() {
                let we =
                    crate::datetime::parse_to_epoch_min(w.get("end").unwrap().as_str().unwrap())
                        .unwrap();
                assert!(we <= end_min, "资源窗口 {we} 超出时域结束 {end_min}");
                // 日历必须是周一至周五（周日=0 的序号 1..=5；曾误用 wd<5 把周日算成工作日）
                let start = w.get("start").unwrap().as_str().unwrap();
                // 约定：local = epoch_min + offset_min（offset = -420），故减 420 得本地日
                let days =
                    (crate::datetime::parse_to_epoch_min(start).unwrap() - 420).div_euclid(1440);
                let wd = (days + 4).rem_euclid(7);
                assert!(
                    (1..=5).contains(&wd),
                    "{start} 落在非工作日（星期序号 {wd}），日历应为周一至周五"
                );
            }
        }
        // 订单 ID 唯一且带轮次前缀
        let orders = p.get("orders").unwrap().as_arr().unwrap();
        assert_eq!(orders.len(), 48);
        assert_eq!(
            orders[0].get("id").unwrap().as_str(),
            Some("J0001__ORD-001")
        );
        assert_eq!(
            orders[47].get("id").unwrap().as_str(),
            Some("J0048__ORD-008")
        );
        // 相邻轮次在时间上重叠（后一轮投放早于前一轮交期）→ 存在真实竞争
        let rel = |i: usize| {
            crate::datetime::parse_to_epoch_min(
                orders[i].get("release_at").unwrap().as_str().unwrap(),
            )
            .unwrap()
        };
        let due = |i: usize| {
            crate::datetime::parse_to_epoch_min(orders[i].get("due_at").unwrap().as_str().unwrap())
                .unwrap()
        };
        assert!(
            rel(8) < due(0),
            "第 2 轮投放 {} 应早于第 1 轮交期 {}（否则各轮互不干扰，失去竞争意义）",
            rel(8),
            due(0)
        );
    }

    #[test]
    fn coupled_requires_multiple_of_eight() {
        let base = baseline();
        assert!(build_coupled(&base, 12, 42).is_err());
        assert!(build_coupled(&base, 0, 42).is_err());
        assert!(build_coupled(&base, 16, 42).is_ok());
    }

    #[test]
    fn coupled_is_schedulable_and_bounds_are_valid_at_scale() {
        // 竞争实例必须可排程，且三类下界（路径 / 产能+物料 / 日历流量）不得高于可行解，
        // 否则说明下界无效（会导致“伪称最优”，SRS 明令禁止）。
        let base = baseline();
        for (orders, seed) in [(8usize, 7u64), (16, 7), (24, 11), (48, 3)] {
            let p = build_coupled(&base, orders, seed).unwrap();
            let (problem, issues) = crate::model::parse_problem(&p);
            let problem =
                problem.unwrap_or_else(|| panic!("{orders} 订单实例契约非法：{issues:?}"));
            let c = crate::compile::compile(&problem, "h".to_string());
            let mut best: Option<i64> = None;
            for rule in [
                crate::solver::Rule::PriorityEdd,
                crate::solver::Rule::Wspt,
                crate::solver::Rule::MostSlack,
            ] {
                let mut rng = crate::solver::Rng::new(seed);
                if let Some(s) = crate::solver::dispatch::dispatch(&c, rule, &mut rng) {
                    if let Some(v) = crate::objective::evaluate(&c, &s) {
                        best = Some(best.map_or(v.makespan, |b: i64| b.min(v.makespan)));
                    }
                }
            }
            let best = best.unwrap_or_else(|| panic!("{orders} 订单竞争实例应可排程"));
            let path = crate::objective::path_lower_bound(&c);
            let cap = crate::objective::capacity_lower_bound(&c);
            let flow = crate::objective::flow_lower_bound(&c);
            let lb = crate::objective::makespan_lower_bound(&c);
            for (name, value) in [("路径", path), ("产能+物料", cap), ("日历流量", flow)]
            {
                assert!(
                    value <= best,
                    "{orders} 订单：{name}下界 {value} 高于可行解 {best} → 下界无效"
                );
            }
            assert_eq!(
                lb,
                path.max(cap).max(flow),
                "{orders} 订单：总下界应为三者取大"
            );
        }
    }

    fn base_machines_len(b: &Json) -> usize {
        b.get("machines")
            .and_then(|v| v.as_arr())
            .map(|a| a.len())
            .unwrap_or(0)
    }

    #[test]
    fn rejects_bad_sizes() {
        let base = baseline();
        assert!(build_separable(&base, 23).is_err());
        assert!(build_separable(&base, 0).is_err());
        assert!(build_separable(&base, 24).is_ok());
    }

    #[test]
    fn scales_up_to_2400() {
        let base = baseline();
        let p = build_separable(&base, 2400).unwrap();
        assert_eq!(count_operations(&p), 2400);
        assert_eq!(p.get("orders").unwrap().as_arr().unwrap().len(), 800);
    }
}
