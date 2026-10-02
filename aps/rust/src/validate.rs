//! 交叉引用与语义校验（JSON Schema 之外的**跨对象校验**，APS-SRS §1 “可机器读取的断言”）。
//!
//! 交付包明确要求：“JSON Schema 验证之外还必须做跨对象引用和语义验证”。
//! 本模块覆盖：
//!
//! * ID 唯一性（订单、机器、人员、工装、物料、工序）；
//! * 引用完整性（备选机器 / 工装 / 物料 / 前置工序必须存在）；
//! * 工艺依赖为有向无环图（检测环并给出环上工序）；
//! * 时间分辨率对齐（duration 必须对齐；窗口未对齐时给出警告并按“外扩取整”编译）；
//! * 时域一致性（工序必须能落在 horizon 内）。

use std::collections::BTreeMap;

use crate::errors::Issue;
use crate::model::RawProblem;

/// 业务 ID → 数组下标的确定性索引（BTreeMap 保证遍历顺序稳定，避免哈希随机化影响复现）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProblemIndex {
    pub machines: BTreeMap<String, usize>,
    pub workers: BTreeMap<String, usize>,
    pub tools: BTreeMap<String, usize>,
    pub materials: BTreeMap<String, usize>,
    pub orders: BTreeMap<String, usize>,
    /// 工序 ID → (订单下标, 工序下标)
    pub operations: BTreeMap<String, (usize, usize)>,
}

/// 构建索引（不校验，仅填表；重复 ID 保留首个）。
pub fn build_index(p: &RawProblem) -> ProblemIndex {
    let mut idx = ProblemIndex::default();
    for (i, m) in p.machines.iter().enumerate() {
        idx.machines.entry(m.id.clone()).or_insert(i);
    }
    for (i, w) in p.workers.iter().enumerate() {
        idx.workers.entry(w.id.clone()).or_insert(i);
    }
    for (i, t) in p.tools.iter().enumerate() {
        idx.tools.entry(t.id.clone()).or_insert(i);
    }
    for (i, m) in p.materials.iter().enumerate() {
        idx.materials.entry(m.id.clone()).or_insert(i);
    }
    for (i, o) in p.orders.iter().enumerate() {
        idx.orders.entry(o.id.clone()).or_insert(i);
        for (j, op) in o.operations.iter().enumerate() {
            idx.operations.entry(op.id.clone()).or_insert((i, j));
        }
    }
    idx
}

fn check_unique(issues: &mut Vec<Issue>, ids: &[String], path_prefix: &str) {
    let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
    for (i, id) in ids.iter().enumerate() {
        if let Some(first) = seen.get(id.as_str()) {
            issues.push(Issue::error(
                "DUPLICATE_ID",
                format!("{}[{}]", path_prefix, i),
                format!("ID '{}' 与下标 {} 处重复", id, first),
            ));
        } else {
            seen.insert(id.as_str(), i);
        }
    }
}

/// 校验并返回问题集合（errors + warnings）。`errors` 非空即 `MODEL_INVALID`。
pub fn validate(p: &RawProblem) -> Vec<Issue> {
    let mut issues: Vec<Issue> = Vec::new();

    check_unique(
        &mut issues,
        &p.machines.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
        "$.machines",
    );
    check_unique(
        &mut issues,
        &p.workers.iter().map(|w| w.id.clone()).collect::<Vec<_>>(),
        "$.workers",
    );
    check_unique(
        &mut issues,
        &p.tools.iter().map(|t| t.id.clone()).collect::<Vec<_>>(),
        "$.tools",
    );
    check_unique(
        &mut issues,
        &p.materials.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
        "$.materials",
    );
    check_unique(
        &mut issues,
        &p.orders.iter().map(|o| o.id.clone()).collect::<Vec<_>>(),
        "$.orders",
    );
    let all_op_ids: Vec<String> = p
        .orders
        .iter()
        .flat_map(|o| o.operations.iter().map(|op| op.id.clone()))
        .collect();
    check_unique(&mut issues, &all_op_ids, "$.orders[*].operations");

    let index = build_index(p);
    let res = p.meta.resolution_min;

    // ---- 时间分辨率对齐 ----
    for (i, m) in p.machines.iter().enumerate() {
        for (kind, list) in [("available", &m.available), ("blocked", &m.blocked)] {
            for (j, iv) in list.iter().enumerate() {
                if (iv.start_min - p.meta.horizon_start_min) % res != 0
                    || (iv.end_min - p.meta.horizon_start_min) % res != 0
                {
                    issues.push(Issue::warning(
                        "WINDOW_NOT_ALIGNED",
                        format!("$.machines[{}].{}[{}]", i, kind, j),
                        format!(
                            "机器日历窗口未对齐 {} 分钟分辨率，编译时按可用方向外扩取整（不放大可用时间）",
                            res
                        ),
                    ));
                }
            }
        }
    }
    for (i, w) in p.workers.iter().enumerate() {
        for (kind, list) in [("available", &w.available), ("blocked", &w.blocked)] {
            for (j, iv) in list.iter().enumerate() {
                if (iv.start_min - p.meta.horizon_start_min) % res != 0
                    || (iv.end_min - p.meta.horizon_start_min) % res != 0
                {
                    issues.push(Issue::warning(
                        "WINDOW_NOT_ALIGNED",
                        format!("$.workers[{}].{}[{}]", i, kind, j),
                        format!("人员日历窗口未对齐 {} 分钟分辨率，编译时按可用方向外扩取整", res),
                    ));
                }
            }
        }
    }

    // ---- 引用完整性 + 工序级语义 ----
    for (oi, order) in p.orders.iter().enumerate() {
        for (pi, op) in order.operations.iter().enumerate() {
            let path = format!("$.orders[{}].operations[{}]", oi, pi);
            for (ai, alt) in op.alternatives.iter().enumerate() {
                if !index.machines.contains_key(&alt.machine_id) {
                    issues.push(Issue::error(
                        "UNKNOWN_REFERENCE",
                        format!("{}.alternatives[{}].machine_id", path, ai),
                        format!("备选机器 '{}' 不存在", alt.machine_id),
                    ));
                }
                if alt.duration_min % res != 0 {
                    issues.push(Issue::error(
                        "DURATION_NOT_ALIGNED",
                        format!("{}.alternatives[{}].duration_min", path, ai),
                        format!(
                            "duration_min={} 未对齐 resolution_min={}（所有持续时间必须对齐）",
                            alt.duration_min, res
                        ),
                    ));
                }
                if alt.duration_min > p.meta.horizon_len_min() {
                    issues.push(Issue::error(
                        "RANGE_VIOLATION",
                        format!("{}.alternatives[{}].duration_min", path, ai),
                        "工序时长超过规划时域长度，不可能排入 horizon",
                    ));
                }
                if let Some(mi) = index.machines.get(&alt.machine_id) {
                    let machine = &p.machines[*mi];
                    if !machine.capabilities.iter().any(|c| c == &op.skill) {
                        issues.push(Issue::error(
                            "CAPABILITY_MISMATCH",
                            format!("{}.alternatives[{}].machine_id", path, ai),
                            format!(
                                "机器 '{}' 能力集 {:?} 不含本工序所需能力 '{}'（H03）",
                                alt.machine_id, machine.capabilities, op.skill
                            ),
                        ));
                    }
                }
            }
            for (ti, tool) in op.tools.iter().enumerate() {
                if !index.tools.contains_key(tool) {
                    issues.push(Issue::error(
                        "UNKNOWN_REFERENCE",
                        format!("{}.tools[{}]", path, ti),
                        format!("工装 '{}' 不存在", tool),
                    ));
                }
            }
            for (mat, _) in op.materials.iter() {
                if !index.materials.contains_key(mat) {
                    issues.push(Issue::error(
                        "UNKNOWN_REFERENCE",
                        format!("{}.materials.{}", path, mat),
                        format!("物料 '{}' 不存在", mat),
                    ));
                }
            }
            for (di, pred) in op.predecessors.iter().enumerate() {
                if !index.operations.contains_key(pred) {
                    issues.push(Issue::error(
                        "UNKNOWN_REFERENCE",
                        format!("{}.predecessors[{}]", path, di),
                        format!("前置工序 '{}' 不存在", pred),
                    ));
                }
            }
        }
    }

    // ---- 工艺依赖无环 ----
    if let Some(cycle) = find_cycle(p) {
        issues.push(Issue::error(
            "PRECEDENCE_CYCLE",
            "$.orders[*].operations[*].predecessors",
            format!("工艺依赖存在环：{}（H02 要求工序 DAG）", cycle.join(" → ")),
        ));
    }

    issues
}

/// 使用 Kahn 拓扑排序检测环；返回环上工序（用于定位）。
pub fn find_cycle(p: &RawProblem) -> Option<Vec<String>> {
    let index = build_index(p);
    let mut indeg: BTreeMap<&str, usize> = BTreeMap::new();
    let mut succs: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for order in p.orders.iter() {
        for op in order.operations.iter() {
            indeg.entry(op.id.as_str()).or_insert(0);
            succs.entry(op.id.as_str()).or_default();
        }
    }
    for order in p.orders.iter() {
        for op in order.operations.iter() {
            for pred in op.predecessors.iter() {
                if !index.operations.contains_key(pred) {
                    continue;
                }
                // 允许跨订单依赖（装配场景），统一建边 pred → op
                let pred_id = index.operations[pred].1;
                let pred_op = &p.orders[index.operations[pred].0].operations[pred_id];
                succs
                    .entry(pred_op.id.as_str())
                    .or_default()
                    .push(op.id.as_str());
                *indeg.entry(op.id.as_str()).or_insert(0) += 1;
            }
        }
    }
    let mut ready: Vec<&str> = indeg
        .iter()
        .filter(|(_, d)| **d == 0)
        .map(|(k, _)| *k)
        .collect();
    ready.sort_unstable();
    let mut visited = 0usize;
    let mut queue = ready;
    while let Some(node) = queue.pop() {
        visited += 1;
        if let Some(list) = succs.get(node) {
            for s in list {
                let d = indeg.get_mut(s).expect("successor exists");
                *d -= 1;
                if *d == 0 {
                    queue.push(s);
                }
            }
        }
    }
    if visited == indeg.len() {
        return None;
    }
    // 收集环上节点（仍存在入度的节点集，按 ID 排序，稳定输出）
    let mut remaining: Vec<String> = indeg
        .iter()
        .filter(|(_, d)| **d > 0)
        .map(|(k, _)| k.to_string())
        .collect();
    remaining.sort();
    remaining.truncate(8);
    Some(remaining)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;

    fn load(rel: &str) -> crate::model::RawProblem {
        let text = std::fs::read_to_string(format!("{}/../{}", env!("CARGO_MANIFEST_DIR"), rel)).unwrap();
        let j = json::parse(&text).unwrap();
        let (p, issues) = crate::model::parse_problem(&j);
        assert!(p.is_some(), "解析失败: {:?}", issues);
        p.unwrap()
    }

    #[test]
    fn baseline_is_valid() {
        let p = load("mock/baseline.json");
        let issues = validate(&p);
        let errors: Vec<_> = issues
            .iter()
            .filter(|i| i.severity == crate::errors::Severity::Error)
            .collect();
        assert!(errors.is_empty(), "基线样本不应有语义错误: {:?}", errors);
    }

    #[test]
    fn all_fixtures_are_valid_models() {
        for f in [
            "mock/baseline.json",
            "mock/machine-breakdown.json",
            "mock/material-delay.json",
            "mock/infeasible-no-welder.json",
        ] {
            let p = load(f);
            let errors: Vec<_> = validate(&p)
                .into_iter()
                .filter(|i| i.severity == crate::errors::Severity::Error)
                .collect();
            assert!(errors.is_empty(), "{} 应为合法模型: {:?}", f, errors);
        }
    }

    #[test]
    fn detects_cycle_and_unknown_refs() {
        let text = r#"{
          "meta": {"schema_version":"plan-problem/1.0","tenant_id":"t","site_id":"s","snapshot_id":"snap",
                   "timezone":"UTC","horizon_start":"2026-10-05T08:00:00Z","horizon_end":"2026-10-09T17:00:00Z","resolution_min":15},
          "machines": [{"id":"M1","capabilities":["cut"],"available":[{"start":"2026-10-05T08:00:00Z","end":"2026-10-05T12:00:00Z"}],"blocked":[]}],
          "workers": [{"id":"W1","skills":["cut"],"qualifications":[],"available":[{"start":"2026-10-05T08:00:00Z","end":"2026-10-05T12:00:00Z"}],"blocked":[]}],
          "tools": [],
          "materials": [],
          "orders": [{"id":"O1","quantity":1,"priority":1,"release_at":"2026-10-05T08:00:00Z","due_at":"2026-10-05T10:00:00Z",
            "operations":[
              {"id":"A","predecessors":["B"],"skill":"cut","qualifications":[],"worker_count":1,"alternatives":[{"machine_id":"M1","duration_min":30}],"tools":["NO-SUCH-TOOL"],"materials":{}},
              {"id":"B","predecessors":["A"],"skill":"cut","qualifications":[],"worker_count":1,"alternatives":[{"machine_id":"M9","duration_min":30}],"tools":[],"materials":{}}
            ]}],
          "objective": {"strategy":"lexicographic","phases":["weighted_tardiness"],"time_limit_ms":1000,"seed":0}
        }"#;
        let j = json::parse(text).unwrap();
        let (p, _) = crate::model::parse_problem(&j);
        let p = p.expect("模型结构本身合法");
        let issues = validate(&p);
        let codes: Vec<&str> = issues.iter().map(|i| i.code.as_str()).collect();
        assert!(codes.contains(&"PRECEDENCE_CYCLE"), "{:?}", issues);
        assert!(codes.contains(&"UNKNOWN_REFERENCE"), "{:?}", issues);
        let cycle = find_cycle(&p).unwrap();
        assert_eq!(cycle.len(), 2);
    }
}
