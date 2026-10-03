//! WASM（`wasm32-unknown-unknown`）导出 ABI：浏览器 Web Worker 调用入口。
//!
//! 与 `aps/rust` 同构：零 wasm-bindgen、手写 C ABI + JS 胶水（`web/mapf-worker.js`），
//! 同一份代码在 native 下也可编译并被 `cargo test` 直接单测（wasm32 上的差异只有
//! 时钟导入与内存布局）。
//!
//! ABI：
//!
//! | 导出 | 说明 |
//! |------|------|
//! | `mapf_alloc(len) -> ptr` | 申请 `len` 字节，JS 侧写入 JSON 文本 |
//! | `mapf_free(ptr, len)` | 释放（与 `mapf_alloc` 配对） |
//! | `mapf_solve(ptr, len) -> i32` | 就地求解 `MapfProblem`（含动态块 ⇒ 重规划） |
//! | `mapf_solve_with_options(p...,o...) -> i32` | 同上，宿主级参数覆盖（seed/预算/w/目标/规划器/verify） |
//! | `mapf_result_ptr() / mapf_result_len()` | 读取结果 JSON 的 UTF-8 字节 |
//! | `mapf_cancel()` | 置取消标志（下一次进入求解循环时协作退出） |
//! | `mapf_version() -> ptr` | 版本字符串（NUL 结尾） |
//! | `mapf_verify(p_ptr,p_len,s_ptr,s_len,strict) -> i32` | 独立核验（与求解器解耦） |
//! | `mapf_fingerprint(s_ptr,s_len) -> i32` | 方案指纹 |
//! | `mapf_capabilities() -> i32` | 当前档位（wasm-light）能力声明 |
//! | `mapf_peak_memory_bytes() -> i32` | 峰值内存统计 |
//!
//! 状态码与 `MapfSolution.status` 一一对应：
//! `1=OPTIMAL 2=FEASIBLE 3=INFEASIBLE 4=UNKNOWN 5=INVALID_INPUT 6=UNSUPPORTED
//!  7=CANCELLED`；`0=参数错误`。
//!
//! 宿主必须提供导入 `env.aps_now_ms() -> f64`（复用 aps 公共时钟层；胶水同时提供
//! `mapf_now_ms` 别名以便独立宿主）。
//!
//! 档位固定为 `wasm-light`：规模上限、预算上限小于 native，超限返回 `UNSUPPORTED`
//! （能力声明里如实给出两侧数字）。

use std::sync::Mutex;

use aps_engine::engine::CancelToken;
use aps_engine::json::Json;

use crate::capabilities::Profile;
use crate::engine::{self, SolveOptions};
use crate::errors::Status;

struct State {
    result: Vec<u8>,
    cancel: Option<CancelToken>,
}

static STATE: Mutex<State> = Mutex::new(State {
    result: Vec::new(),
    cancel: None,
});

/// 每次求解开头重建取消令牌 ⇒ “取消后重新求解”无需其它恢复动作（M12 语义）。
fn begin_solve() -> CancelToken {
    let mut st = STATE.lock().expect("mapf state lock");
    let token = CancelToken::new();
    st.cancel = Some(token.clone());
    st.result.clear();
    token
}

fn current_cancel() -> CancelToken {
    let mut st = STATE.lock().expect("mapf state lock");
    if st.cancel.is_none() {
        st.cancel = Some(CancelToken::new());
    }
    st.cancel.clone().unwrap()
}

fn write_result(bytes: Vec<u8>) {
    let mut st = STATE.lock().expect("mapf state lock");
    st.result = bytes;
}

/// 申请内存供宿主写入 JSON（返回的指针必须用 `mapf_free` 释放）。
#[no_mangle]
pub extern "C" fn mapf_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// 释放 `mapf_alloc` 申请的内存。
///
/// # Safety
/// `ptr`/`len` 必须来自同一次 `mapf_alloc` 调用。
#[no_mangle]
pub unsafe extern "C" fn mapf_free(ptr: *mut u8, len: usize) {
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

/// 就地求解。返回状态码；方案 JSON 写入结果缓冲区。
///
/// # Safety
/// `ptr`/`len` 必须是 `mapf_alloc` 写入的 UTF-8 JSON。
#[no_mangle]
pub unsafe extern "C" fn mapf_solve(ptr: *const u8, len: usize) -> i32 {
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
/// `{time_limit_ms, seed, suboptimality_factor, objective:"soc"|"makespan",
///   planner:"auto"|"ecbs"|"pp", verify:bool}`。
///
/// # Safety
/// 两个缓冲区必须是 `mapf_alloc` 写入的 UTF-8 JSON。
#[no_mangle]
pub unsafe extern "C" fn mapf_solve_with_options(
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
    if let Some(w) = o.get("suboptimality_factor").and_then(|v| v.as_f64()) {
        if (1.0..=3.0).contains(&w) {
            opts.w = Some(w);
        }
    }
    if let Some(p) = o.get("planner").and_then(|v| v.as_str()) {
        opts.planner = match p {
            "auto" => Some(crate::problem::PlannerKind::Auto),
            "ecbs" | "cbs" => Some(crate::problem::PlannerKind::Ecbs),
            "pp" | "prioritized" => Some(crate::problem::PlannerKind::Pp),
            _ => None,
        };
    }
    if let Some(ob) = o.get("objective").and_then(|v| v.as_str()) {
        opts.objective = match ob {
            "soc" => Some(crate::problem::Objective::Soc),
            "makespan" => Some(crate::problem::Objective::Makespan),
            _ => None,
        };
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
    let code = outcome.status.abi_code();
    write_result(outcome.solution_json.into_bytes());
    code
}

fn read_result_json() -> Vec<u8> {
    let st = STATE.lock().expect("mapf state lock");
    st.result.clone()
}

/// 结果缓冲区指针（`mapf_result_len` 给出长度；JS 侧读取时按 (ptr, len) 切片）。
#[no_mangle]
pub extern "C" fn mapf_result_ptr() -> *const u8 {
    STATE.lock().expect("mapf state lock").result.as_ptr()
}

/// 结果缓冲区长度。
#[no_mangle]
pub extern "C" fn mapf_result_len() -> usize {
    STATE.lock().expect("mapf state lock").result.len()
}

/// 置取消标志（协作式；求解循环内检查）。
#[no_mangle]
pub extern "C" fn mapf_cancel() {
    current_cancel().cancel();
}

/// 版本字符串（NUL 结尾；勿释放）。
#[no_mangle]
pub extern "C" fn mapf_version() -> *const u8 {
    concat!(env!("CARGO_PKG_VERSION"), "\0").as_ptr()
}

/// 峰值内存字节数。
#[no_mangle]
pub extern "C" fn mapf_peak_memory_bytes() -> u64 {
    aps_engine::alloc::peak_bytes() as u64
}

/// 独立核验：`report` 写入结果缓冲区；返回 0=完成（ok 与否看报告）1=参数错误。
///
/// # Safety
/// 指针来自 `mapf_alloc`。
#[no_mangle]
pub unsafe extern "C" fn mapf_verify(
    p_ptr: *const u8,
    p_len: usize,
    s_ptr: *const u8,
    s_len: usize,
    strict: i32,
) -> i32 {
    let (Some(ptext), Some(stext)) = (read_text(p_ptr, p_len), read_text(s_ptr, s_len)) else {
        write_result(b"{\"ok\":false,\"violations\":[{\"code\":\"E-MAPF-BAD-JSON\",\"message\":\"buffer empty\"}]}".to_vec());
        return 1;
    };
    let report = engine::verify_solution_json(&ptext, &stext, strict != 0);
    write_result(report.to_compact().into_bytes());
    0
}

/// 方案指纹：`{fingerprint, status}` 写入结果缓冲区。
///
/// # Safety
/// 指针来自 `mapf_alloc`。
#[no_mangle]
pub unsafe extern "C" fn mapf_fingerprint(s_ptr: *const u8, s_len: usize) -> i32 {
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
            Json::str(crate::errors::SCHEMA_VERSION_SOLUTION),
        ),
        ("fingerprint", Json::str(fp)),
        ("status", sol.get("status").cloned().unwrap_or(Json::Null)),
    ]);
    write_result(report.to_compact().into_bytes());
    0
}

/// 当前档位能力声明（wasm-light）。
#[no_mangle]
pub extern "C" fn mapf_capabilities() -> i32 {
    let report = crate::capabilities::report(Profile::WasmLight);
    write_result(report.to_compact().into_bytes());
    0
}

/// 测试辅助：读取当前结果缓冲区文本（native 单测用；wasm 侧由 JS 直接读内存）。
pub fn result_text_for_test() -> String {
    String::from_utf8(read_result_json()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cstr(text: &str) -> (*mut u8, usize) {
        let b = text.as_bytes();
        let ptr = mapf_alloc(b.len());
        unsafe {
            std::ptr::copy_nonoverlapping(b.as_ptr(), ptr, b.len());
        }
        (ptr, b.len())
    }

    #[test]
    fn solve_via_abi_and_capabilities() {
        let problem = r#"{
          "id":"abi",
          "map":{"cells":["....","...."]},
          "robots":[{"id":"A","start":[0,0],"goal":[3,0]}],
          "time_model":{"horizon":6},
          "objective":{"kind":"soc"}
        }"#;
        let (p, plen) = cstr(problem);
        let code = unsafe { mapf_solve(p, plen) };
        unsafe { mapf_free(p, plen) };
        assert_eq!(
            code,
            1,
            "OPTIMAL expected, got code {code}: {}",
            result_text_for_test()
        );
        let caps = mapf_capabilities();
        assert_eq!(caps, 0);
        let text = result_text_for_test();
        assert!(text.contains("wasm-light"), "{text}");
    }

    #[test]
    fn cancel_then_resolve_recovers() {
        let problem = r#"{
          "id":"cancel-recover",
          "map":{"cells":["....","...."]},
          "robots":[
            {"id":"A","start":[0,0],"goal":[3,0]},
            {"id":"B","start":[3,0],"goal":[0,0]}
          ],
          "time_model":{"horizon":10},
          "objective":{"kind":"soc"},
          "solver":{"time_limit_ms":15000}
        }"#;
        let (p, plen) = cstr(problem);
        mapf_cancel(); // 预置取消：begin_solve 会重置为“新请求未取消”
        let code = unsafe { mapf_solve(p, plen) };
        assert_eq!(
            code,
            1,
            "begin_solve 必须重置取消标志：{code} {}",
            result_text_for_test()
        );
        unsafe { mapf_free(p, plen) };
    }
}
