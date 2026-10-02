//! WASM（`wasm32-unknown-unknown`）导出 ABI：浏览器 Web Worker 调用入口。
//!
//! 为什么不用 `wasm-bindgen`：本期交付要求“Rust native/wasm 共用基础算法”，而
//! 引入 wasm-bindgen 需要额外的 crate 依赖与工具链；这里采用**零依赖 C ABI + 手写 JS 胶水**，
//! 体积更小、构建更可控（离线可复现），也便于原生宿主（Go/C++）以同样方式加载。
//!
//! ABI：
//!
//! | 导出 | 说明 |
//! |------|------|
//! | `aps_alloc(len) -> ptr` | 申请 `len` 字节，JS 侧写入 JSON 文本 |
//! | `aps_free(ptr, len)` | 释放（与 `aps_alloc` 配对使用） |
//! | `aps_solve(ptr, len) -> i32` | 就地求解，返回状态码（见下），结果写入缓冲区 |
//! | `aps_result_ptr() -> ptr` / `aps_result_len() -> len` | 读取结果 JSON 的 UTF-8 字节 |
//! | `aps_cancel() -> ()` | 置取消标志（若档位声明 supports_cancel） |
//! | `aps_version() -> ptr` | 版本字符串指针（以 NUL 结尾） |
//!
//! 状态码与 `PlanSolution.status` 一一对应：
//! `1=OPTIMAL 2=FEASIBLE 3=INFEASIBLE 4=UNKNOWN 5=MODEL_INVALID 6=NO_SOLUTION_FOUND
//!  7=UNSUPPORTED_CONSTRAINT 8=CANCELLED`，`0=参数错误`。
//!
//! 宿主必须提供导入 `env.aps_now_ms() -> f64`（`performance.now()`）；若无法提供，
//! 请把 `clock::now_ms` 替换为固定 0 并在前端把耗时指标显示为 `unavailable`。

use std::sync::Mutex;

use crate::engine::{self, CancelToken, SolveOptions};
use crate::errors::Status;

/// 全局求解上下文（同一 Worker 内串行使用；`Mutex` 防止意外重入）。
static STATE: Mutex<State> = Mutex::new(State {
    result: Vec::new(),
    cancel: CancelTokenHandle::empty(),
    booted: false,
});

struct CancelTokenHandle {
    // 使用 OnceLock 之外的简化实现：延迟初始化由 `ensure` 完成
    token: Option<CancelToken>,
}

impl CancelTokenHandle {
    const fn empty() -> CancelTokenHandle {
        CancelTokenHandle { token: None }
    }
    fn get(&mut self) -> &CancelToken {
        if self.token.is_none() {
            self.token = Some(CancelToken::new());
        }
        self.token.as_ref().unwrap()
    }
    fn ensure(&mut self) -> CancelToken {
        self.get().clone()
    }
}

struct State {
    result: Vec<u8>,
    cancel: CancelTokenHandle,
    booted: bool,
}

impl State {
    fn ensure(&mut self) -> CancelToken {
        self.booted = true;
        self.cancel.ensure()
    }
}

/// 申请内存供宿主写入 JSON（返回的指针必须用 `aps_free` 释放）。
#[no_mangle]
pub extern "C" fn aps_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// 释放 `aps_alloc` 申请的内存。
///
/// # Safety
/// `ptr`/`len` 必须来自同一次 `aps_alloc` 调用。
#[no_mangle]
pub unsafe extern "C" fn aps_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// 求解：`ptr/len` 指向 PlanProblem JSON（UTF-8）。返回状态码。
///
/// # Safety
/// `ptr`/`len` 必须指向 `aps_alloc` 分配的、长度为 `len` 的有效缓冲区。
#[no_mangle]
pub unsafe extern "C" fn aps_solve(ptr: *const u8, len: usize) -> i32 {
    if ptr.is_null() || len == 0 {
        return 0;
    }
    let bytes = std::slice::from_raw_parts(ptr, len);
    let text = match std::str::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => {
            let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
            st.result = b"{\"schema_version\":\"plan-solution/1.0\",\"snapshot_id\":\"\",\"status\":\"MODEL_INVALID\",\"optimality_proven\":false,\"operations\":[]}".to_vec();
            return 5;
        }
    };

    let (token, opts) = {
        let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
        let token = st.ensure();
        // 预算/策略/种子以问题自带的 objective 块为准（与 CLI 一致），档位固定为 wasm-light。
        // 宿主若不希望跑满预算，应在 objective.time_limit_ms 里给更小的值。
        let objective = crate::json::parse(text)
            .ok()
            .and_then(|j| j.get("objective").cloned());
        let mut opts = SolveOptions::from_objective(objective.as_ref());
        opts.profile = crate::capabilities::Profile::WasmLight;
        opts.verify = true;
        (token, opts)
    };

    let outcome = engine::solve_json(text, &opts, &token);
    let status_code = status_to_code(outcome.status);
    let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
    st.result = outcome.solution_json.into_bytes();
    status_code
}

/// 请求取消（协作式；浏览器侧推荐直接 terminate Worker）。
#[no_mangle]
pub extern "C" fn aps_cancel() {
    let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
    st.ensure().cancel();
}

/// 结果缓冲区指针（UTF-8 JSON，长度由 `aps_result_len` 给出）。
#[no_mangle]
pub extern "C" fn aps_result_ptr() -> *const u8 {
    let st = STATE.lock().unwrap_or_else(|e| e.into_inner());
    st.result.as_ptr()
}

/// 结果字节数。
#[no_mangle]
pub extern "C" fn aps_result_len() -> usize {
    let st = STATE.lock().unwrap_or_else(|e| e.into_inner());
    st.result.len()
}

/// 引擎版本字符串（NUL 结尾，静态生命周期）。
#[no_mangle]
pub extern "C" fn aps_version() -> *const u8 {
    static VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "\0");
    VERSION.as_ptr()
}

/// 峰值内存（字节）——浏览器端也能给出真实值。
#[no_mangle]
pub extern "C" fn aps_peak_memory_bytes() -> u64 {
    crate::alloc::peak_bytes() as u64
}

fn status_to_code(s: Status) -> i32 {
    match s {
        Status::Optimal => 1,
        Status::Feasible => 2,
        Status::Infeasible => 3,
        Status::Unknown => 4,
        Status::ModelInvalid => 5,
        Status::NoSolutionFound => 6,
        Status::UnsupportedConstraint => 7,
        Status::Cancelled => 8,
    }
}
