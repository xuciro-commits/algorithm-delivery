//! wasm32 ABI：与 aps / mapf / agv 同一套约定，`wh_` 前缀。
//!
//! 约定：
//! * 所有导出函数都不 panic 穿越边界（catch_unwind 不适用于 wasm，改为内部 Result 化）；
//! * 结果放在全局缓冲里，宿主先取 `wh_result_ptr` / `wh_result_len`，用完调 `wh_free_result`；
//! * 时间来自宿主导入的 `env.aps_now_ms()`（aps-engine 的时钟抽象；wasm32-unknown-unknown 无 std::time）；
//! * `wh_solve` 按文档 `kind` 字段分派到库位 / 调度 / 联合三个引擎。
//!
//! 线程安全：浏览器里 Worker 是单线程 + 每次求解独占，全局 `Mutex` 仅为与宿主契约一致。

#![allow(static_mut_refs)]

use std::sync::Mutex;

use aps_engine::json::Json;

use crate::errors::{codes, Issues, Status};

static RESULT: Mutex<Option<Vec<u8>>> = Mutex::new(None);
static INPUT: Mutex<Option<Vec<u8>>> = Mutex::new(None);

fn store_result(text: String) -> usize {
    let bytes = text.into_bytes();
    let len = bytes.len();
    if let Ok(mut slot) = RESULT.lock() {
        *slot = Some(bytes);
    }
    len
}

/// 申请输入缓冲（宿主把 JSON 写进来）。
#[no_mangle]
pub extern "C" fn wh_alloc(len: usize) -> *mut u8 {
    let mut buffer = vec![0u8; len];
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// 释放输入缓冲（`wh_alloc` 的配对调用）。
///
/// # Safety
/// `pointer` / `len` 必须来自同一次 `wh_alloc` 调用，且没有被重复释放。
#[no_mangle]
pub unsafe extern "C" fn wh_free(pointer: *mut u8, len: usize) {
    if pointer.is_null() || len == 0 {
        return;
    }
    let _ = Vec::from_raw_parts(pointer, len, len);
}

/// 释放结果缓冲（宿主读完即调用）。
#[no_mangle]
pub extern "C" fn wh_free_result() {
    if let Ok(mut slot) = RESULT.lock() {
        *slot = None;
    }
}

#[no_mangle]
pub extern "C" fn wh_result_ptr() -> *const u8 {
    match RESULT.lock() {
        Ok(slot) => match &*slot {
            Some(bytes) => bytes.as_ptr(),
            None => std::ptr::null(),
        },
        Err(_) => std::ptr::null(),
    }
}

#[no_mangle]
pub extern "C" fn wh_result_len() -> usize {
    match RESULT.lock() {
        Ok(slot) => slot.as_ref().map(|bytes| bytes.len()).unwrap_or(0),
        Err(_) => 0,
    }
}

/// 取消当前求解（协作式：搜索循环检查标志并尽快返回当前最好解）。
#[no_mangle]
pub extern "C" fn wh_cancel() {
    crate::engine::cancel();
}

#[no_mangle]
pub extern "C" fn wh_version_major() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn wh_version_minor() -> u32 {
    0
}

/// 版本字符串（结果为 `rust-warehouse/<version>`）。
#[no_mangle]
pub extern "C" fn wh_version() -> usize {
    store_result(format!("{}/{}", crate::ENGINE_NAME, crate::ENGINE_VERSION))
}

/// 峰值内存（字节）：宿主用它做内存预算控制。
#[no_mangle]
pub extern "C" fn wh_peak_memory_bytes() -> u32 {
    aps_engine::alloc::peak_bytes().min(u32::MAX as usize) as u32
}

/// 能力清单（宿主启动时读一次）。
#[no_mangle]
pub extern "C" fn wh_capabilities() -> usize {
    store_result(crate::capabilities::capabilities_json().canonical())
}

/// 场景清单（实验室场景选择器直接读它）。
#[no_mangle]
pub extern "C" fn wh_scenarios() -> usize {
    store_result(crate::scenario::catalog_json().canonical())
}

/// 生成场景问题文档（凭空生成数据，不需要宿主提供数据集）。
///
/// `selector` 形如 `{"scenarioId":"D04","scale":"small","seed":7}`。
#[no_mangle]
pub extern "C" fn wh_generate(input_ptr: *const u8, input_len: usize) -> i32 {
    let text = match read_input(input_ptr, input_len) {
        Some(text) => text,
        None => return Status::InvalidInput.code(),
    };
    let mut issues = Issues::new();
    let value = match aps_engine::json::parse(&text) {
        Ok(value) => value,
        Err(error) => {
            issues.error(codes::SCHEMA_INVALID, "$", format!("{error:?}"));
            store_result(issues.to_json().canonical());
            return Status::InvalidInput.code();
        }
    };
    let scenario_id =
        crate::contract::opt_str(&value, "scenarioId").unwrap_or_else(|| "S01".to_string());
    let scale = crate::contract::opt_str(&value, "scale");
    let seed = crate::contract::opt_i64(&value, "seed").map(|value| value.max(0) as u64);
    let document = crate::scenario::build(&scenario_id, scale.as_deref(), seed, &mut issues);
    if issues.has_errors() {
        store_result(issues.to_json().canonical());
        return Status::InvalidInput.code();
    }
    store_result(document.canonical());
    0
}

/// 求解：按文档 `kind` 分派（slotting / asrs / joint）。
///
/// 返回**状态码**（`Status::code()`，1–10；与 `agv_solve` / `wh_verify` 同一约定）：
/// 有解时是 1–3，无解/输入错误时是 4–10。`0` 只表示参数或 ABI 层面的错误
/// （宿主按"0 = 不该发生的错误"处理，绝不要把 0 当成成功）。
/// 结果 JSON 从 `wh_result_*` 取。
#[no_mangle]
pub extern "C" fn wh_solve(input_ptr: *const u8, input_len: usize) -> i32 {
    let text = match read_input(input_ptr, input_len) {
        Some(text) => text,
        None => return Status::InvalidInput.code(),
    };
    crate::engine::reset_cancel();
    let kind = aps_engine::json::parse(&text)
        .ok()
        .and_then(|value| crate::contract::opt_str(&value, "kind"))
        .unwrap_or_else(|| "slotting".to_string());
    let (result, status) = match kind.as_str() {
        "asrs" | "dense-asrs" => crate::engine::solve_asrs(&text, None),
        "joint" => crate::engine::solve_joint(&text, None),
        _ => crate::engine::solve_slotting(&text, None),
    };
    aps_engine::alloc::reset_peak();
    store_result(result);
    status.code()
}

/// 带选项求解（选项 JSON 形如 `{"algorithm":"alns","seed":7,"budgetMs":3000}`）。
#[no_mangle]
pub extern "C" fn wh_solve_with_options(
    input_ptr: *const u8,
    input_len: usize,
    options_ptr: *const u8,
    options_len: usize,
) -> i32 {
    let text = match read_input(input_ptr, input_len) {
        Some(text) => text,
        None => return Status::InvalidInput.code(),
    };
    // 空指针 / 长度为 0 由 `read_input` 判成 None（与 native CLI"没给参数"同义）
    let options = read_input(options_ptr, options_len);
    crate::engine::reset_cancel();
    let kind = aps_engine::json::parse(&text)
        .ok()
        .and_then(|value| crate::contract::opt_str(&value, "kind"))
        .unwrap_or_else(|| "slotting".to_string());
    let (result, status) = match kind.as_str() {
        "asrs" | "dense-asrs" => crate::engine::solve_asrs(&text, options.as_deref()),
        "joint" => crate::engine::solve_joint(&text, options.as_deref()),
        _ => crate::engine::solve_slotting(&text, options.as_deref()),
    };
    store_result(result);
    status.code()
}

/// 独立验证：输入是"问题 + 方案"，输出验证报告。
#[no_mangle]
pub extern "C" fn wh_verify(input_ptr: *const u8, input_len: usize) -> i32 {
    let text = match read_input(input_ptr, input_len) {
        Some(text) => text,
        None => return Status::InvalidInput.code(),
    };
    let (result, status) = crate::engine::verify(&text, None);
    store_result(result);
    status.code()
}

/// 求解并同时返回指标（供面板一次取全，避免多次往返）。
#[no_mangle]
pub extern "C" fn wh_solve_summary(input_ptr: *const u8, input_len: usize) -> i32 {
    let text = match read_input(input_ptr, input_len) {
        Some(text) => text,
        None => return Status::InvalidInput.code(),
    };
    crate::engine::reset_cancel();
    let kind = aps_engine::json::parse(&text)
        .ok()
        .and_then(|value| crate::contract::opt_str(&value, "kind"))
        .unwrap_or_else(|| "slotting".to_string());
    let (result, status) = match kind.as_str() {
        "asrs" | "dense-asrs" => crate::engine::solve_asrs(&text, None),
        "joint" => crate::engine::solve_joint(&text, None),
        _ => crate::engine::solve_slotting(&text, None),
    };
    // 顶层再补一个 summary 字段（面板标题栏直接用，不必解析整个结果）
    let mut root = aps_engine::json::parse(&result).unwrap_or(Json::Null);
    if let Json::Obj(fields) = &mut root {
        fields.push((
            "summary".to_string(),
            Json::obj(vec![
                ("status", Json::str(status.as_str())),
                ("engine", Json::str(crate::ENGINE_NAME)),
                ("version", Json::str(crate::ENGINE_VERSION)),
            ]),
        ));
    }
    store_result(root.canonical());
    status.code()
}

/// 读取输入缓冲（不复制整个缓冲区两遍：wasm 内直接 UTF-8 校验）。
fn read_input(pointer: *const u8, len: usize) -> Option<String> {
    if pointer.is_null() || len == 0 {
        return None;
    }
    let slice = unsafe { std::slice::from_raw_parts(pointer, len) };
    match std::str::from_utf8(slice) {
        Ok(text) => Some(text.to_string()),
        Err(_) => None,
    }
}

/// 供宿主探测 ABI（与 agv 的 `*-worker.js` 约定一致）。
#[no_mangle]
pub extern "C" fn wh_abi_version() -> u32 {
    1
}

/// 保留：把最后一次输入留在引擎里（便于崩溃诊断），返回长度。
#[no_mangle]
pub extern "C" fn wh_retain_input(input_ptr: *const u8, input_len: usize) -> usize {
    let Some(text) = read_input(input_ptr, input_len) else {
        return 0;
    };
    let bytes = text.into_bytes();
    let len = bytes.len();
    if let Ok(mut slot) = INPUT.lock() {
        *slot = Some(bytes);
    }
    len
}

/// 诊断：最近一次保留输入的长度（0 表示没有）。
#[no_mangle]
pub extern "C" fn wh_retained_input_len() -> usize {
    match INPUT.lock() {
        Ok(slot) => slot.as_ref().map(|bytes| bytes.len()).unwrap_or(0),
        Err(_) => 0,
    }
}
