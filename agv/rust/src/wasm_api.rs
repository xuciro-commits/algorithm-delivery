//! WASM ABI（与 mapf 引擎同构的句柄协议，AGV-SRS §11）。
//!
//! 宿主（web/agv-worker.js）流程：
//! `agv_version` → `agv_capabilities` →（每次求解）`agv_alloc` 写入问题 JSON →
//! `agv_solve` / `agv_solve_with_options` → `agv_result_ptr` + `agv_result_len`
//! 读解 → `agv_free`。取消用 `agv_cancel`；独立核验与指纹另有入口。
//!
//! 状态码（`errors::Status::code`）：1=FEASIBLE 2=PARTIAL 3=UNKNOWN
//! 4=INFEASIBLE 5=INVALID_INPUT 6=UNSUPPORTED 7=CANCELLED，0=缓冲区错误。

use std::sync::Mutex;

use aps_engine::engine::CancelToken;
use aps_engine::json::Json;

use crate::capabilities::Profile;
use crate::engine::{self, SolveOptions};

struct State {
    cancel: Option<CancelToken>,
    result: Vec<u8>,
}

static STATE: Mutex<State> = Mutex::new(State {
    cancel: None,
    result: Vec::new(),
});

fn begin_solve() -> CancelToken {
    let mut st = STATE.lock().expect("agv state lock");
    let token = CancelToken::new();
    st.cancel = Some(token.clone());
    st.result.clear();
    token
}

fn current_cancel() -> CancelToken {
    let mut st = STATE.lock().expect("agv state lock");
    if st.cancel.is_none() {
        st.cancel = Some(CancelToken::new());
    }
    st.cancel.clone().unwrap()
}

fn write_result(bytes: Vec<u8>) {
    STATE.lock().expect("agv state lock").result = bytes;
}

/// 申请内存供宿主写入 JSON（必须用 `agv_free` 释放）。
#[no_mangle]
pub extern "C" fn agv_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// 释放 `agv_alloc` 申请的内存。
///
/// # Safety
/// `ptr`/`len` 必须来自同一次 `agv_alloc` 调用。
#[no_mangle]
pub unsafe extern "C" fn agv_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    drop(Vec::from_raw_parts(ptr, 0, len));
}

unsafe fn read_text(ptr: *const u8, len: usize) -> Option<String> {
    if ptr.is_null() || len == 0 {
        return None;
    }
    let slice = std::slice::from_raw_parts(ptr, len);
    std::str::from_utf8(slice).ok().map(|s| s.to_string())
}

/// 就地求解（wasm-light 档，自动核验）。返回状态码。
///
/// # Safety
/// `ptr`/`len` 必须是 `agv_alloc` 写入的 UTF-8 JSON。
#[no_mangle]
pub unsafe extern "C" fn agv_solve(ptr: *const u8, len: usize) -> i32 {
    let Some(text) = read_text(ptr, len) else {
        write_result(b"{\"error\":\"empty input\"}".to_vec());
        return 0;
    };
    let cancel = begin_solve();
    let opts = SolveOptions {
        profile: Profile::WasmLight,
        verify: true,
        ..Default::default()
    };
    finish_solve(&text, &opts, &cancel)
}

/// 带宿主级参数覆盖的求解。`opt_ptr` JSON：
/// `{time_limit_ms, seed, algorithm:"auto"|"baseline"|"insertion-ls",
///   mapf_planner:"auto"|"ecbs"|"pp", mapf_suboptimality_factor, mapf_time_limit_ms,
///   horizon, verify:bool, solution_id}`。
///
/// # Safety
/// 两个缓冲区必须是 `agv_alloc` 写入的 UTF-8 JSON。
#[no_mangle]
pub unsafe extern "C" fn agv_solve_with_options(
    p_ptr: *const u8,
    p_len: usize,
    o_ptr: *const u8,
    o_len: usize,
) -> i32 {
    let Some(text) = read_text(p_ptr, p_len) else {
        write_result(b"{\"error\":\"empty input\"}".to_vec());
        return 0;
    };
    let mut opts = SolveOptions {
        profile: Profile::WasmLight,
        verify: true,
        ..Default::default()
    };
    if let Some(otext) = read_text(o_ptr, o_len) {
        if let Ok(o) = aps_engine::json::parse(&otext) {
            apply_option_json(&mut opts, &o);
        }
    }
    let cancel = begin_solve();
    finish_solve(&text, &opts, &cancel)
}

fn apply_option_json(opts: &mut SolveOptions, o: &Json) {
    if let Some(t) = o.get("time_limit_ms").and_then(|v| v.as_i64()) {
        if t > 0 {
            opts.time_limit_ms = Some(t);
        }
    }
    if let Some(s) = o.get("seed").and_then(|v| v.as_i64()) {
        if s >= 0 {
            opts.seed = Some(s as u64);
        }
    }
    if let Some(a) = o.get("algorithm").and_then(|v| v.as_str()) {
        if matches!(a, "auto" | "baseline" | "insertion-ls") {
            opts.algorithm = Some(a.to_string());
        }
    }
    if let Some(p) = o.get("mapf_planner").and_then(|v| v.as_str()) {
        if matches!(p, "auto" | "ecbs" | "cbs" | "pp") {
            opts.mapf_planner = Some(p.to_string());
        }
    }
    if let Some(w) = o.get("mapf_suboptimality_factor").and_then(|v| v.as_f64()) {
        if (1.0..=3.0).contains(&w) {
            opts.mapf_w = Some(w);
        }
    }
    if let Some(t) = o.get("mapf_time_limit_ms").and_then(|v| v.as_i64()) {
        if t > 0 {
            opts.mapf_time_limit_ms = Some(t);
        }
    }
    if let Some(h) = o.get("horizon").and_then(|v| v.as_i64()) {
        if h > 0 {
            opts.horizon = Some(h as u32);
        }
    }
    if let Some(v) = o.get("verify").and_then(|b| b.as_bool()) {
        opts.verify = v;
    }
    if let Some(id) = o.get("solution_id").and_then(|v| v.as_str()) {
        opts.solution_id = Some(id.to_string());
    }
}

fn finish_solve(text: &str, opts: &SolveOptions, cancel: &CancelToken) -> i32 {
    let outcome = engine::solve_json(text, opts, cancel);
    let code = outcome.status.code();
    write_result(outcome.solution_json.into_bytes());
    code
}

/// 结果缓冲区指针（`agv_result_len` 给出长度）。
#[no_mangle]
pub extern "C" fn agv_result_ptr() -> *const u8 {
    STATE.lock().expect("agv state lock").result.as_ptr()
}

/// 结果缓冲区长度。
#[no_mangle]
pub extern "C" fn agv_result_len() -> usize {
    STATE.lock().expect("agv state lock").result.len()
}

/// 置取消标志（协作式）。
#[no_mangle]
pub extern "C" fn agv_cancel() {
    current_cancel().cancel();
}

/// 版本字符串（NUL 结尾；勿释放）。
#[no_mangle]
pub extern "C" fn agv_version() -> *const u8 {
    concat!(env!("CARGO_PKG_VERSION"), "\0").as_ptr()
}

/// 峰值内存字节数。
#[no_mangle]
pub extern "C" fn agv_peak_memory_bytes() -> u64 {
    aps_engine::alloc::peak_bytes() as u64
}

/// 独立核验（问题 + 解文本；strict≠0 严格模式）。返回 0=完成，1=参数错误。
///
/// # Safety
/// 指针来自 `agv_alloc`。
#[no_mangle]
pub unsafe extern "C" fn agv_verify(
    p_ptr: *const u8,
    p_len: usize,
    s_ptr: *const u8,
    s_len: usize,
    strict: i32,
) -> i32 {
    let (Some(ptext), Some(stext)) = (read_text(p_ptr, p_len), read_text(s_ptr, s_len)) else {
        write_result(
            b"{\"schema_version\":\"agv-verification/1.0\",\"status\":\"fail\",\"checks\":[],\"summary\":{\"total\":0,\"passed\":0,\"failed\":0}}"
                .to_vec(),
        );
        return 1;
    };
    let report = engine::verify_solution_json(&ptext, &stext, strict != 0);
    write_result(report.to_compact().into_bytes());
    0
}

/// 方案指纹：`{fingerprint, status}` 写入结果缓冲区。
///
/// # Safety
/// 指针来自 `agv_alloc`。
#[no_mangle]
pub unsafe extern "C" fn agv_fingerprint(s_ptr: *const u8, s_len: usize) -> i32 {
    let Some(stext) = read_text(s_ptr, s_len) else {
        write_result(b"{\"error\":\"empty solution\"}".to_vec());
        return 1;
    };
    let Ok(sol) = aps_engine::json::parse(&stext) else {
        write_result(b"{\"error\":\"solution is not valid JSON\"}".to_vec());
        return 1;
    };
    let fp = engine::solution_fingerprint(&sol);
    let report = Json::obj(vec![
        (
            "schema_version",
            Json::str(crate::engine::SCHEMA_VERSION_SOLUTION),
        ),
        ("fingerprint", Json::str(fp)),
        ("status", sol.get("status").cloned().unwrap_or(Json::Null)),
    ]);
    write_result(report.to_compact().into_bytes());
    0
}

/// 当前档位能力声明（wasm-light）。
#[no_mangle]
pub extern "C" fn agv_capabilities() -> i32 {
    let report = crate::capabilities::report(Profile::WasmLight);
    write_result(report.to_compact().into_bytes());
    0
}

/// 测试辅助：读取当前结果缓冲区文本。
pub fn result_text_for_test() -> String {
    let st = STATE.lock().expect("agv state lock");
    String::from_utf8(st.result.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wasm_flow_solve_and_verify() {
        let problem = r#"{
            "map": { "cells": ["......", "......"] },
            "time_model": { "horizon": 40 },
            "vehicles": [ { "id": "V1", "start": [0,0] } ],
            "tasks": [ { "id": "T1", "pickup": [5,1], "dropoff": [1,1] } ]
        }"#;
        let bytes = problem.as_bytes();
        let len = bytes.len();
        let ptr = agv_alloc(len);
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, len);
            let code = agv_solve(ptr, len);
            agv_free(ptr, len);
            assert_eq!(code, 1, "FEASIBLE = 1");
        }
        let sol = result_text_for_test();
        assert!(sol.contains("\"status\":\"FEASIBLE\""), "{sol}");
        // 指纹
        let sbytes = sol.as_bytes();
        let slen = sbytes.len();
        let sptr = agv_alloc(slen);
        unsafe {
            std::ptr::copy_nonoverlapping(sbytes.as_ptr(), sptr, slen);
            assert_eq!(agv_fingerprint(sptr, slen), 0);
            agv_free(sptr, slen);
        }
        let fp = result_text_for_test();
        assert!(fp.contains("sha256:"), "{fp}");
    }
}
