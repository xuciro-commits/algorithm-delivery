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
