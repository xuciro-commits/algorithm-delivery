//! 指标计算：从（问题, 时间线, 任务段, 任务结局）导出解报告中的 `metrics`。
//!
//! verify.rs 按同一语义从 JSON 重算并比对 —— int 字段必须完全一致。

use aps_engine::json::Json;

use crate::integrate::{Mission, Realized};
use crate::problem::Problem;

pub struct Metrics {
    pub completed_tasks: usize,
    pub total_tasks: usize,
    /// 工作完工时刻（最后 dropoff_done；无完成任务为 0）。
    pub makespan: u32,
    /// Σ (dropoff_done − release)（未加权）。
    pub total_flow_time: u64,
    pub total_lateness: u64,
    pub deadline_violations: usize,
    pub total_travel_steps: u64,
    pub loaded_travel_steps: u64,
    pub empty_travel_steps: u64,
    pub total_wait_steps: u64,
    pub avg_utilization: f64,
    pub mapf_solves: usize,
}

/// 任务相关任务段相位（忙碌）。
fn is_busy_phase(phase: &str) -> bool {
    matches!(
        phase,
        "to_pickup" | "servicing_pickup" | "to_dropoff" | "servicing_dropoff"
    )
}

fn phase_at(missions: &[Mission], t: u32) -> Option<&'static str> {
    // 找覆盖 [t, t+1) 的任务段：from ≤ t < to；零长段（done）不覆盖。
    for m in missions {
        if m.from <= t && t < m.to {
            return Some(m.phase);
        }
    }
    None
}

pub fn compute(p: &Problem, r: &Realized) -> Metrics {
    let mut m = Metrics {
        completed_tasks: 0,
        total_tasks: p.tasks.len(),
        makespan: 0,
        total_flow_time: 0,
        total_lateness: 0,
        deadline_violations: 0,
        total_travel_steps: 0,
        loaded_travel_steps: 0,
        empty_travel_steps: 0,
        total_wait_steps: 0,
        avg_utilization: 0.0,
        mapf_solves: r.mapf_solves,
    };
    for (ti, o) in r.tasks.iter().enumerate() {
        if o.status != "completed" {
            continue;
        }
        m.completed_tasks += 1;
        let task = &p.tasks[ti];
        let done = o.dropoff_done.unwrap_or(0);
        m.makespan = m.makespan.max(done);
        m.total_flow_time += (done.saturating_sub(task.release_step)) as u64;
        if let Some(due) = task.due_step {
            if done > due {
                m.deadline_violations += 1;
                m.total_lateness += (done - due) as u64;
            }
        }
    }
    // 逐车逐时间步：行程 / 等待 / 利用率
    let mut busy_total: u64 = 0;
    for (v, tl) in r.timelines.iter().enumerate() {
        let missions = &r.missions[v];
        let mut busy: u64 = 0;
        for t in 0..r.horizon {
            let a = tl.get(t as usize).copied();
            let b = tl.get(t as usize + 1).copied();
            let (Some(a), Some(b)) = (a, b) else { break };
            let phase = phase_at(missions, t);
            if let Some(ph) = phase {
                if is_busy_phase(ph) {
                    busy += 1;
                }
            }
            if a != b {
                m.total_travel_steps += 1;
                if phase == Some("to_dropoff") {
                    m.loaded_travel_steps += 1;
                } else {
                    m.empty_travel_steps += 1;
                }
            } else if phase.is_some_and(is_busy_phase) {
                m.total_wait_steps += 1;
            }
        }
        busy_total += busy;
    }
    let denom = m.makespan.max(1) as f64 * p.vehicles.len().max(1) as f64;
    m.avg_utilization = (busy_total as f64 / denom * 10_000.0).round() / 10_000.0;
    m
}

pub fn to_json(m: &Metrics, dispatch_ms: f64, mapf_ms: f64, verify_ms: f64, total_ms: f64) -> Json {
    Json::obj(vec![
        ("completed_tasks", Json::int(m.completed_tasks as i64)),
        ("total_tasks", Json::int(m.total_tasks as i64)),
        ("makespan", Json::int(m.makespan as i64)),
        ("total_flow_time", Json::int(m.total_flow_time as i64)),
        ("total_lateness", Json::int(m.total_lateness as i64)),
        (
            "deadline_violations",
            Json::int(m.deadline_violations as i64),
        ),
        ("total_travel_steps", Json::int(m.total_travel_steps as i64)),
        (
            "loaded_travel_steps",
            Json::int(m.loaded_travel_steps as i64),
        ),
        ("empty_travel_steps", Json::int(m.empty_travel_steps as i64)),
        ("total_wait_steps", Json::int(m.total_wait_steps as i64)),
        ("avg_utilization", Json::Float(m.avg_utilization)),
        ("mapf_solves", Json::int(m.mapf_solves as i64)),
        (
            "dispatch_ms",
            Json::Float((dispatch_ms * 1000.0).round() / 1000.0),
        ),
        ("mapf_ms", Json::Float((mapf_ms * 1000.0).round() / 1000.0)),
        (
            "verify_ms",
            Json::Float((verify_ms * 1000.0).round() / 1000.0),
        ),
        (
            "total_ms",
            Json::Float((total_ms * 1000.0).round() / 1000.0),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_lookup_respects_half_open_interval() {
        // to_dropoff [0,3) 覆盖 t=0,1,2；servicing [3,4) 覆盖 t=3
        let missions = vec![
            Mission {
                task: Some(0),
                phase: "to_dropoff",
                from: 0,
                to: 3,
                dock: None,
            },
            Mission {
                task: Some(0),
                phase: "servicing_dropoff",
                from: 3,
                to: 4,
                dock: None,
            },
        ];
        assert_eq!(phase_at(&missions, 0), Some("to_dropoff"));
        assert_eq!(phase_at(&missions, 2), Some("to_dropoff"));
        assert_eq!(phase_at(&missions, 3), Some("servicing_dropoff"));
        assert_eq!(phase_at(&missions, 4), None);
    }
}
