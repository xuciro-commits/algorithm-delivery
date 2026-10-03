//! 模型编译：`compile(problem, capabilities) -> internal_model`（APS-SRS §4）。
//!
//! 编译层职责：
//! * 把所有时间换算为“自 `meta.horizon_start` 起的整数分钟”，日历转换为连续可用窗口；
//! * 建立 `业务 ID ↔ 数学变量下标` 的**追溯映射**（`ProblemIndex`）；
//! * 生成工艺依赖的全局拓扑序（支持跨订单前置，装配场景）；
//! * 产出**可构造的无解证明**（certificate）：资格死角 / 单工序无可用窗口 /
//!   物料总供给不足 / 关键链长度超出时域。
//!
//! 注意：证书只覆盖上述"可证明"类型；其他无解情形必须由求解层诚实返回
//! `NO_SOLUTION_FOUND` 或 `UNKNOWN`（见 `capabilities`）。

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::calendar::{self, Interval};
use crate::errors::{Issue, Severity};
use crate::json::Json;
use crate::model::RawProblem;
use crate::validate::{build_index, ProblemIndex};

pub type Min = i64;

#[derive(Debug, Clone, PartialEq)]
pub struct CompiledMeta {
    pub tenant_id: String,
    pub site_id: String,
    pub snapshot_id: String,
    pub timezone: String,
    pub offset_min: i32,
    pub horizon_start_iso: String,
    pub horizon_len_min: Min,
    pub resolution_min: Min,
    pub problem_hash: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CMachine {
    pub id: String,
    pub capabilities: Vec<String>,
    pub windows: Vec<Interval>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CWorker {
    pub id: String,
    pub skills: Vec<String>,
    pub quals: Vec<String>,
    pub windows: Vec<Interval>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CTool {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CMaterial {
    pub id: String,
    pub initial: i64,
    /// 到货事件（相对分钟，数量），按时间升序。
    pub receipts: Vec<(Min, i64)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Alt {
    pub machine: usize,
    pub duration: Min,
}

#[derive(Debug, Clone, PartialEq)]
pub struct COp {
    pub id: String,
    pub order: usize,
    pub skill: String,
    pub quals: Vec<String>,
    pub alts: Vec<Alt>,
    pub tools: Vec<usize>,
    pub materials: Vec<(usize, i64)>,
    pub preds: Vec<usize>,
    pub succs: Vec<usize>,
    /// 订单投放时间（相对分钟）
    pub release: Min,
    /// 订单交期（相对分钟）
    pub due: Min,
    pub min_dur: Min,
}

#[derive(Debug, Clone, PartialEq)]
pub struct COrder {
    pub id: String,
    pub priority: i64,
    pub quantity: i64,
    pub release: Min,
    pub due: Min,
    pub ops: Vec<usize>,
}

/// 无解证明条目（仅在求解层声明 `can_prove_infeasible` 时用于 `INFEASIBLE`）。
#[derive(Debug, Clone, PartialEq)]
pub struct Certificate {
    pub code: &'static str,
    pub message: String,
    pub order_id: Option<String>,
    pub operation_id: Option<String>,
    pub details: Vec<(String, Json)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompileStats {
    pub operations: usize,
    pub orders: usize,
    pub machines: usize,
    pub workers: usize,
    pub tools: usize,
    pub materials: usize,
    pub horizon_min: Min,
    pub total_duration_min: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Compiled {
    pub meta: CompiledMeta,
    pub machines: Vec<CMachine>,
    pub workers: Vec<CWorker>,
    pub tools: Vec<CTool>,
    pub materials: Vec<CMaterial>,
    pub orders: Vec<COrder>,
    pub ops: Vec<COp>,
    /// 全局拓扑序（工序下标）
    pub topo: Vec<usize>,
    /// 业务 ID ↔ 下标 追溯映射
    pub index: ProblemIndex,
    pub certificates: Vec<Certificate>,
    pub warnings: Vec<Issue>,
    pub stats: CompileStats,
    /// 规划起点的绝对分钟（用于 ISO 输出；不参与业务语义）
    pub horizon_start_epoch: Min,
}

impl Compiled {
    /// 追溯：工序下标 → (订单 ID, 工序 ID)
    pub fn trace_op(&self, op: usize) -> (&str, &str) {
        let o = &self.orders[self.ops[op].order];
        (o.id.as_str(), self.ops[op].id.as_str())
    }

    /// 相对分钟 → 契约 ISO 时间（使用问题元数据的书写偏移）。
    pub fn iso(&self, rel_min: Min) -> String {
        crate::datetime::format_iso8601(rel_min + self.horizon_start_epoch, self.meta.offset_min)
    }

    /// 订单终端工序（无后继者）。
    pub fn terminal_ops(&self, order: usize) -> Vec<usize> {
        self.orders[order]
            .ops
            .iter()
            .copied()
            .filter(|op| self.ops[*op].succs.is_empty())
            .collect()
    }
}

/// 编译入口。调用前必须已通过 `validate`（本函数仍做防御性处理，不会 panic）。
pub fn compile(p: &RawProblem, problem_hash: String) -> Compiled {
    let problem_source = p.clone();
    let t0 = p.meta.horizon_start_min;
    let h = p.meta.horizon_len_min();
    let res = p.meta.resolution_min;
    let mut warnings: Vec<Issue> = Vec::new();

    let machines: Vec<CMachine> = p
        .machines
        .iter()
        .map(|m| {
            let windows = calendar::build_windows(&m.available, &m.blocked, t0, h, res);
            if windows.is_empty() {
                warnings.push(Issue::warning(
                    "MACHINE_NO_WINDOW",
                    format!(
                        "$.machines[{}]",
                        p.machines.iter().position(|x| x.id == m.id).unwrap_or(0)
                    ),
                    format!("机器 '{}' 在时域内没有任何可用窗口", m.id),
                ));
            }
            CMachine {
                id: m.id.clone(),
                capabilities: m.capabilities.clone(),
                windows,
            }
        })
        .collect();

    let workers: Vec<CWorker> = p
        .workers
        .iter()
        .map(|w| CWorker {
            id: w.id.clone(),
            skills: w.skills.clone(),
            quals: w.qualifications.clone(),
            windows: calendar::build_windows(&w.available, &w.blocked, t0, h, res),
        })
        .collect();

    let tools: Vec<CTool> = p.tools.iter().map(|t| CTool { id: t.id.clone() }).collect();

    let materials: Vec<CMaterial> = p
        .materials
        .iter()
        .map(|m| {
            let mut receipts: Vec<(Min, i64)> = m
                .receipts
                .iter()
                .map(|r| (r.at_min - t0, r.quantity))
                .collect();
            receipts.sort_by_key(|(t, _)| *t);
            CMaterial {
                id: m.id.clone(),
                initial: m.initial_quantity,
                receipts,
            }
        })
        .collect();

    let index = build_index(p);

    // ---- 工序表 ----
    let mut ops: Vec<COp> = Vec::new();
    let mut orders: Vec<COrder> = Vec::with_capacity(p.orders.len());
    for (oi, order) in p.orders.iter().enumerate() {
        let mut op_ids: Vec<usize> = Vec::with_capacity(order.operations.len());
        for op in order.operations.iter() {
            let alts: Vec<Alt> = op
                .alternatives
                .iter()
                .filter_map(|a| {
                    index.machines.get(&a.machine_id).map(|mi| Alt {
                        machine: *mi,
                        duration: a.duration_min,
                    })
                })
                .collect();
            let min_dur = alts.iter().map(|a| a.duration).min().unwrap_or(0);
            let tools_idx: Vec<usize> = op
                .tools
                .iter()
                .filter_map(|t| index.tools.get(t).copied())
                .collect();
            let materials_idx: Vec<(usize, i64)> = op
                .materials
                .iter()
                .filter_map(|(id, qty)| index.materials.get(id).map(|mi| (*mi, *qty)))
                .collect();
            let preds: Vec<usize> = op
                .predecessors
                .iter()
                .filter_map(|pid| {
                    index.operations.get(pid).map(|(oi2, pi2)| {
                        // 全局工序下标
                        let mut base = 0usize;
                        for k in 0..*oi2 {
                            base += p.orders[k].operations.len();
                        }
                        base + pi2
                    })
                })
                .collect();
            let idx = ops.len();
            ops.push(COp {
                id: op.id.clone(),
                order: oi,
                skill: op.skill.clone(),
                quals: op.qualifications.clone(),
                alts,
                tools: tools_idx,
                materials: materials_idx,
                preds,
                succs: Vec::new(),
                release: order.release_min - t0,
                due: order.due_min - t0,
                min_dur,
            });
            op_ids.push(idx);
        }
        orders.push(COrder {
            id: order.id.clone(),
            priority: order.priority,
            quantity: order.quantity,
            release: order.release_min - t0,
            due: order.due_min - t0,
            ops: op_ids,
        });
    }
    for i in 0..ops.len() {
        let preds = ops[i].preds.clone();
        for pred in preds {
            if pred < ops.len() && pred != i {
                ops[pred].succs.push(i);
            }
        }
    }
    for op in ops.iter_mut() {
        op.succs.sort_unstable();
        op.succs.dedup();
        op.preds.sort_unstable();
        op.preds.dedup();
    }

    // ---- 拓扑序（确定性：小顶堆按下标）----
    let mut indeg: Vec<usize> = vec![0; ops.len()];
    for op in ops.iter() {
        for s in op.succs.iter() {
            indeg[*s] += 1;
        }
    }
    let mut heap: BinaryHeap<Reverse<usize>> = BinaryHeap::new();
    for (i, d) in indeg.iter().enumerate() {
        if *d == 0 {
            heap.push(Reverse(i));
        }
    }
    let mut topo: Vec<usize> = Vec::with_capacity(ops.len());
    while let Some(Reverse(i)) = heap.pop() {
        topo.push(i);
        for s in ops[i].succs.clone() {
            indeg[s] -= 1;
            if indeg[s] == 0 {
                heap.push(Reverse(s));
            }
        }
    }
    if topo.len() != ops.len() {
        // 理论上 validate 已拦截；此处防御性降级为下标序，避免 panic。
        topo = (0..ops.len()).collect();
        warnings.push(Issue::error(
            "PRECEDENCE_CYCLE",
            "$.orders[*].operations[*].predecessors",
            "拓扑排序未覆盖全部工序（存在环），已降级为数组顺序",
        ));
    }

    let stats = CompileStats {
        operations: ops.len(),
        orders: orders.len(),
        machines: machines.len(),
        workers: workers.len(),
        tools: tools.len(),
        materials: materials.len(),
        horizon_min: h,
        total_duration_min: ops.iter().map(|o| o.min_dur).sum(),
    };

    let mut compiled = Compiled {
        meta: CompiledMeta {
            tenant_id: p.meta.tenant_id.clone(),
            site_id: p.meta.site_id.clone(),
            snapshot_id: p.meta.snapshot_id.clone(),
            timezone: p.meta.timezone.clone(),
            offset_min: p.meta.offset_min,
            horizon_start_iso: p.meta.horizon_start.clone(),
            horizon_len_min: h,
            resolution_min: res,
            problem_hash,
        },
        machines,
        workers,
        tools,
        materials,
        orders,
        ops,
        topo,
        index,
        certificates: Vec::new(),
        warnings,
        stats,
        horizon_start_epoch: t0,
    };
    compiled.certificates = build_certificates(&problem_source, &compiled);
    compiled
}

impl Compiled {
    /// 该工序在该机器上的所有备选时长。
    pub fn durations_for(&self, op: usize, machine: usize) -> Vec<Min> {
        self.ops[op]
            .alts
            .iter()
            .filter(|a| a.machine == machine)
            .map(|a| a.duration)
            .collect()
    }

    /// 人员是否满足工序的技能与资格要求（H05 静态部分）。
    pub fn worker_eligible(&self, op: usize, worker: usize) -> bool {
        let o = &self.ops[op];
        let w = &self.workers[worker];
        w.skills.iter().any(|s| s == &o.skill)
            && o.quals.iter().all(|q| w.quals.iter().any(|wq| wq == q))
    }

    /// 工序可用的（机器, 时长）组合：机器具备能力且窗口可容纳。
    pub fn machine_candidates(&self, op: usize) -> Vec<Alt> {
        let o = &self.ops[op];
        o.alts
            .iter()
            .filter(|a| {
                let m = &self.machines[a.machine];
                m.capabilities.iter().any(|c| c == &o.skill)
                    && m.windows.iter().any(|w| w.len() >= a.duration)
            })
            .copied()
            .collect()
    }
}

/// 构造无解证明（见模块文档）。
fn build_certificates(_p: &RawProblem, c: &Compiled) -> Vec<Certificate> {
    let mut certs: Vec<Certificate> = Vec::new();

    // C1：资格死角 / 无可用机器 / 日历容不下
    let mut no_machine_count = 0usize;
    let mut no_worker_count = 0usize;
    for (oi, op) in c.ops.iter().enumerate() {
        let cands = c.machine_candidates(oi);
        if cands.is_empty() {
            no_machine_count += 1;
            if certs.len() < 16 {
                let alts_detail: Vec<Json> = op
                    .alts
                    .iter()
                    .map(|a| {
                        let m = &c.machines[a.machine];
                        Json::obj(vec![
                            ("machine_id", Json::str(m.id.clone())),
                            ("duration_min", Json::int(a.duration)),
                            (
                                "longest_window_min",
                                Json::int(m.windows.iter().map(|w| w.len()).max().unwrap_or(0)),
                            ),
                            (
                                "capability_ok",
                                Json::Bool(m.capabilities.iter().any(|cap| cap == &op.skill)),
                            ),
                        ])
                    })
                    .collect();
                certs.push(Certificate {
                    code: "NO_ELIGIBLE_MACHINE",
                    message: format!(
                        "工序 '{}' 在全部备选机器上都无法安排：能力不匹配或没有任何可用窗口能容纳其时长",
                        op.id
                    ),
                    order_id: Some(c.orders[op.order].id.clone()),
                    operation_id: Some(op.id.clone()),
                    details: vec![("alternatives".to_string(), Json::Arr(alts_detail))],
                });
            }
        }

        let min_dur = op.min_dur.max(1);
        let has_worker = (0..c.workers.len()).any(|w| {
            c.worker_eligible(oi, w) && c.workers[w].windows.iter().any(|win| win.len() >= min_dur)
        });
        if !has_worker {
            no_worker_count += 1;
            if certs.len() < 16 {
                let qualified: Vec<Json> = c
                    .workers
                    .iter()
                    .filter(|w| {
                        w.skills.iter().any(|s| s == &op.skill)
                            && op.quals.iter().all(|q| w.quals.iter().any(|wq| wq == q))
                    })
                    .map(|w| {
                        Json::obj(vec![
                            ("worker_id", Json::str(w.id.clone())),
                            (
                                "longest_window_min",
                                Json::int(w.windows.iter().map(|x| x.len()).max().unwrap_or(0)),
                            ),
                        ])
                    })
                    .collect();
                certs.push(Certificate {
                    code: "NO_ELIGIBLE_WORKER",
                    message: format!(
                        "工序 '{}' 找不到满足技能 '{}' 与资格 {:?} 且日历可容纳的人员",
                        op.id, op.skill, op.quals
                    ),
                    order_id: Some(c.orders[op.order].id.clone()),
                    operation_id: Some(op.id.clone()),
                    details: vec![
                        ("required_skill".to_string(), Json::str(op.skill.clone())),
                        (
                            "required_qualifications".to_string(),
                            Json::strings(op.quals.iter().cloned()),
                        ),
                        ("skill_matched_workers".to_string(), Json::Arr(qualified)),
                    ],
                });
            }
        }
    }
    if no_machine_count > 16 || no_worker_count > 16 {
        certs.push(Certificate {
            code: "CERTIFICATE_TRUNCATED",
            message: format!(
                "同类证书数量较多已截断显示：无可用机器的工序 {no_machine_count} 个、无合格人员的工序 {no_worker_count} 个"
            ),
            order_id: None,
            operation_id: None,
            details: vec![],
        });
    }

    // C2：物料总供给不足（必要条件的违反 ⇒ 必然无解）
    for (mi, m) in c.materials.iter().enumerate() {
        let demand: i64 = c
            .ops
            .iter()
            .flat_map(|o| o.materials.iter())
            .filter(|(mat, _)| *mat == mi)
            .map(|(_, q)| *q)
            .sum();
        if demand == 0 {
            continue;
        }
        let supply: i64 = m.initial
            + m.receipts
                .iter()
                .filter(|(t, _)| *t <= c.meta.horizon_len_min)
                .map(|(_, q)| *q)
                .sum::<i64>();
        if demand > supply {
            certs.push(Certificate {
                code: "MATERIAL_SHORTAGE",
                message: format!(
                    "物料 '{}' 在时域内总供给 {} 小于总需求 {}，缺口 {}",
                    m.id,
                    supply,
                    demand,
                    demand - supply
                ),
                order_id: None,
                operation_id: None,
                details: vec![
                    ("material_id".to_string(), Json::str(m.id.clone())),
                    ("demand".to_string(), Json::int(demand)),
                    ("supply".to_string(), Json::int(supply)),
                ],
            });
        }
    }

    // C3：关键链长度（忽略产能竞争的下界）超出时域
    for (oi, order) in c.orders.iter().enumerate() {
        if order.ops.is_empty() {
            continue;
        }
        // 最长路（按最小时长）
        let mut longest: Vec<i64> = c.ops.iter().map(|_| 0).collect();
        let mut chain = 0i64;
        for &op in c.topo.iter() {
            if c.ops[op].order != oi {
                continue;
            }
            let base = c.ops[op].release.max(0);
            let start_bound = c.ops[op]
                .preds
                .iter()
                .map(|pr| longest[*pr])
                .max()
                .unwrap_or(0)
                .max(base);
            longest[op] = start_bound + c.ops[op].min_dur;
            chain = chain.max(longest[op]);
        }
        let terminals = c.terminal_ops(oi);
        let completion_lb = terminals.iter().map(|t| longest[*t]).max().unwrap_or(chain);
        if completion_lb > c.meta.horizon_len_min {
            certs.push(Certificate {
                code: "CHAIN_TOO_LONG",
                message: format!(
                    "订单 '{}' 的最短关键链在忽略产能竞争时也需要在相对第 {} 分钟完工，超出时域长度 {} 分钟",
                    order.id, completion_lb, c.meta.horizon_len_min
                ),
                order_id: Some(order.id.clone()),
                operation_id: None,
                details: vec![
                    ("lower_bound_min".to_string(), Json::int(completion_lb)),
                    (
                        "horizon_min".to_string(),
                        Json::int(c.meta.horizon_len_min),
                    ),
                ],
            });
        }
    }

    certs
}

/// 供 CLI/测试使用：证书 → JSON。
pub fn certificates_to_json(certs: &[Certificate]) -> Vec<Json> {
    certs
        .iter()
        .map(|c| {
            Json::obj(vec![
                ("code", Json::str(c.code.to_string())),
                ("severity", Json::str(Severity::Error.as_str())),
                ("constraint", Json::Null),
                ("message", Json::str(c.message.clone())),
                ("order_id", Json::opt_str(c.order_id.clone())),
                ("operation_id", Json::opt_str(c.operation_id.clone())),
                ("details", Json::Obj(c.details.clone())),
            ])
        })
        .collect()
}
