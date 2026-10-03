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
//! | `aps_solve_with_options(p_ptr,p_len,o_ptr,o_len) -> i32` | 同上，但用宿主级参数覆盖 seed/时限/策略/规则/修复/迭代上限 |
//! | `aps_result_ptr() -> ptr` / `aps_result_len() -> len` | 读取结果 JSON 的 UTF-8 字节 |
//! | `aps_cancel() -> ()` | 置取消标志（若档位声明 supports_cancel） |
//! | `aps_version() -> ptr` | 版本字符串指针（以 NUL 结尾） |
//! | `aps_verify(p_ptr,p_len,s_ptr,s_len,strict) -> i32` | **独立校验**既有方案，报告写入结果缓冲区 |
//! | `aps_fingerprint(s_ptr,s_len) -> i32` | 方案指纹（规范化 JSON 去掉运行期 `metrics` 后的 sha256） |
//! | `aps_capabilities() -> i32` | 当前档位（wasm-light）的能力声明，写入结果缓冲区 |
//!
//! 状态码与 `PlanSolution.status` 一一对应：
//! `1=OPTIMAL 2=FEASIBLE 3=INFEASIBLE 4=UNKNOWN 5=MODEL_INVALID 6=NO_SOLUTION_FOUND
//!  7=UNSUPPORTED_CONSTRAINT 8=CANCELLED`，`0=参数错误`。
//!
//! 后三个“分析类”导出共用结果缓冲区，并统一返回
//! `0=成功（报告已写入）`、`1=参数错误`、`2=输入 JSON 非法（报告里带 issues）`。
//! 它们**不改变**求解语义，只是把 native CLI 已有的 `verify` / `fingerprint` /
//! `capabilities` 暴露给浏览器端实验室使用（见 `docs/INTEGRATION.md` §2.3）。
//!
//! 宿主必须提供导入 `env.aps_now_ms() -> f64`（`performance.now()`）；若无法提供，
//! 请把 `clock::now_ms` 替换为固定 0 并在前端把耗时指标显示为 `unavailable`。

use std::sync::Mutex;

use crate::engine::{self, CancelToken, SolveOptions};
use crate::errors::Status;
use crate::json::Json;

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
    let Some(text) = read_utf8(ptr, len) else {
        return 0;
    };
    solve_inner(text, None)
}

/// 两个求解入口的**唯一实现**：`overrides` 为宿主级参数覆盖（`None` 表示只用问题的 `objective` 块）。
///
/// 档位固定为 `wasm-light`、`verify = true`（契约要求返回前交叉验证），两条路径共用，
/// 避免“普通 solve 与带参 solve 行为漂移”。
unsafe fn solve_inner(text: &str, overrides: Option<&Json>) -> i32 {
    // 非 UTF-8 输入：直接给出契约合法的 MODEL_INVALID 方案（与历史行为一致）
    let (token, mut opts) = {
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

    if let Some(o) = overrides {
        if !apply_overrides(&mut opts, o) {
            return 0; // apply_overrides 已把错误写进结果缓冲区
        }
    }

    let outcome = engine::solve_json(text, &opts, &token);
    let status_code = status_to_code(outcome.status);
    store_result(outcome.solution_json);
    status_code
}

/// 应用宿主级覆盖；返回 `false` 表示参数非法（错误已写入结果缓冲区）。
fn apply_overrides(opts: &mut SolveOptions, overrides: &Json) -> bool {
    if let Some(seed) = overrides.get("seed").and_then(|v| v.as_i64()) {
        if seed < 0 {
            fail_result("seed 必须 ≥ 0");
            return false;
        }
        opts.seed = seed as u64;
    }
    if let Some(t) = overrides.get("time_limit_ms").and_then(|v| v.as_i64()) {
        if t <= 0 {
            fail_result("time_limit_ms 必须 > 0");
            return false;
        }
        opts.time_limit_ms = t;
    }
    if let Some(s) = overrides.get("strategy").and_then(|v| v.as_str()) {
        match crate::objective::Strategy::parse(s) {
            Some(st) => opts.strategy = st,
            None => {
                fail_result(&format!("未知 strategy: {s}"));
                return false;
            }
        }
    }
    if let Some(r) = overrides.get("rule").and_then(|v| v.as_str()) {
        match crate::solver::Rule::parse(r) {
            Some(rule) => opts.rule = rule,
            None => {
                fail_result(&format!("未知 rule: {r}"));
                return false;
            }
        }
    }
    if let Some(rep) = overrides.get("repair").and_then(|v| v.as_bool()) {
        opts.repair = rep;
    }
    if let Some(n) = overrides.get("max_iterations").and_then(|v| v.as_i64()) {
        if n < 0 {
            fail_result("max_iterations 必须 ≥ 0");
            return false;
        }
        opts.max_iterations = n as usize;
    }
    true
}

/// 求解（带**宿主级参数覆盖**）：`problem` 为 PlanProblem JSON，`options` 为覆盖项 JSON。
///
/// 覆盖项（全部可选，未给出的沿用 `objective` 块/默认值）：
///
/// ```json
/// { "seed": 42, "time_limit_ms": 2000, "strategy": "lexicographic",
///   "rule": "auto", "repair": true, "max_iterations": 100000 }
/// ```
///
/// 为什么单独开一个入口：`PlanProblem` 契约里只有 `objective.{strategy,time_limit_ms,seed}`，
/// “搜索规则 / 是否修复 / 迭代上限”属于**求解器旋钮**而不是问题定义，
/// 写进问题文件会污染契约（并让同一问题在不同参数下产生不同哈希）。
/// 实验室（`lab/`）与 CLI 的 `--rule/--no-repair/--max-iterations` 语义保持一致。
///
/// 返回状态码同 `aps_solve`；参数非法时返回 `0` 且结果缓冲区写入 `{"error": ...}`。
///
/// # Safety
/// 两段指针必须分别来自 `aps_alloc`。
#[no_mangle]
pub unsafe extern "C" fn aps_solve_with_options(
    problem_ptr: *const u8,
    problem_len: usize,
    options_ptr: *const u8,
    options_len: usize,
) -> i32 {
    let Some(problem) = read_utf8(problem_ptr, problem_len) else {
        return 0;
    };
    let Some(options_text) = read_utf8(options_ptr, options_len) else {
        return 0;
    };
    let Ok(overrides) = crate::json::parse(options_text) else {
        fail_result("options 不是合法 JSON");
        return 0;
    };
    solve_inner(problem, Some(&overrides))
}

/// 参数错误：把错误写进结果缓冲区并返回 `0`（0 在 `aps_solve` 里表示 ABI 错误，宿主据此显示提示）。
fn fail_result(message: &str) -> i32 {
    store_result(
        Json::obj(vec![
            ("error", Json::str(message)),
            ("status", Json::str("MODEL_INVALID")),
        ])
        .to_pretty(),
    );
    0
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

/// 独立校验：`problem` 与 `solution` 两段 JSON 文本，`strict != 0` 时要求租户与问题哈希绑定。
///
/// 报告写入结果缓冲区（`plan-verify-report/1.0`），含 `ok` / `counts` / `violations` / `issues`。
/// 返回 `0` 成功、`1` 参数错误、`2` 输入 JSON 非法。
///
/// # Safety
/// 两段指针必须分别来自 `aps_alloc`，且长度与各自缓冲区一致。
#[no_mangle]
pub unsafe extern "C" fn aps_verify(
    problem_ptr: *const u8,
    problem_len: usize,
    solution_ptr: *const u8,
    solution_len: usize,
    strict: i32,
) -> i32 {
    let problem = match read_utf8(problem_ptr, problem_len) {
        Some(t) => t,
        None => return 1,
    };
    let solution = match read_utf8(solution_ptr, solution_len) {
        Some(t) => t,
        None => return 1,
    };
    let opts = if strict != 0 {
        crate::verify::VerifyOptions::strict()
    } else {
        crate::verify::VerifyOptions::permissive()
    };
    let (report, parsed) = match engine::verify_solution_json_with(problem, solution, opts) {
        Ok((_p, _s, violations)) => {
            let issues: Vec<Json> = Vec::new();
            (verify_report(strict != 0, violations, issues, true), true)
        }
        Err(issues) => {
            let js: Vec<Json> = issues.iter().map(|i| i.to_json()).collect();
            (verify_report(strict != 0, Vec::new(), js, false), false)
        }
    };
    store_result(report.to_pretty());
    // 返回码语义：0 = 已产出报告（可能含违约）；2 = 输入本身不合法（解析/契约阶段失败）。
    // “方案有违约”不是错误——报告里会带 violations，UI 需要它来展示。
    if parsed {
        0
    } else {
        2
    }
}

/// 方案指纹：规范化 JSON 移除运行期 `metrics` 后的 sha256（与 CLI `aps fingerprint` 同源）。
///
/// 返回 `0` 成功、`1` 参数错误、`2` 方案 JSON 非法。
///
/// # Safety
/// `ptr`/`len` 必须来自 `aps_alloc`。
#[no_mangle]
pub unsafe extern "C" fn aps_fingerprint(ptr: *const u8, len: usize) -> i32 {
    let text = match read_utf8(ptr, len) {
        Some(t) => t,
        None => return 1,
    };
    let Ok(json) = crate::json::parse(text) else {
        store_result(
            Json::obj(vec![
                ("error", Json::str("方案 JSON 解析失败")),
                ("fingerprint", Json::Null),
            ])
            .to_pretty(),
        );
        return 2;
    };
    let status = json
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("UNKNOWN")
        .to_string();
    let report = Json::obj(vec![
        ("schema_version", Json::str("plan-fingerprint/1.0")),
        (
            "fingerprint",
            Json::str(engine::solution_fingerprint(&json)),
        ),
        ("status", Json::str(status)),
        ("excludes", Json::Arr(vec![Json::str("metrics")])),
    ]);
    store_result(report.to_pretty());
    0
}

/// 当前档位（固定 `wasm-light`）的能力声明 JSON。
#[no_mangle]
pub extern "C" fn aps_capabilities() -> i32 {
    let caps = crate::capabilities::capabilities_for(crate::capabilities::Profile::WasmLight);
    store_result(caps.to_json().to_pretty());
    0
}

fn verify_report(
    strict: bool,
    violations: Vec<crate::errors::Violation>,
    issues: Vec<Json>,
    parsed: bool,
) -> Json {
    let errors = violations
        .iter()
        .filter(|v| v.severity == crate::errors::Severity::Error)
        .count();
    let warnings = violations
        .iter()
        .filter(|v| v.severity == crate::errors::Severity::Warning)
        .count();
    let violation_json: Vec<Json> = violations.iter().map(|v| v.to_json()).collect();
    let issue_errors = issues.len();
    Json::obj(vec![
        ("schema_version", Json::str("plan-verify-report/1.0")),
        (
            "mode",
            Json::str(if strict { "strict" } else { "permissive" }),
        ),
        ("parsed", Json::Bool(parsed)),
        ("ok", Json::Bool(parsed && errors == 0 && issue_errors == 0)),
        (
            "counts",
            Json::obj(vec![
                ("violations", Json::int(violation_json.len() as i64)),
                ("errors", Json::int(errors as i64)),
                ("warnings", Json::int(warnings as i64)),
                ("issues", Json::int(issue_errors as i64)),
            ]),
        ),
        ("violations", Json::Arr(violation_json)),
        ("issues", Json::Arr(issues)),
    ])
}

/// 读取宿主写入的 UTF-8 文本；`None` 表示指针/长度非法。
///
/// # Safety
/// 调用方保证 `ptr` 可读 `len` 字节。
unsafe fn read_utf8<'a>(ptr: *const u8, len: usize) -> Option<&'a str> {
    if ptr.is_null() || len == 0 {
        return None;
    }
    std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).ok()
}

/// 覆盖写入结果缓冲区（与 `aps_solve` 共用读取入口）。
fn store_result(text: String) {
    let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
    st.result = text.into_bytes();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn read_result() -> Json {
        let ptr = aps_result_ptr();
        let len = aps_result_len();
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
        crate::json::parse(std::str::from_utf8(bytes).unwrap()).unwrap()
    }

    /// 把文本写进 wasm 堆（复用 `aps_alloc`/`aps_free` 的真实路径）。
    fn with_buffer<T>(text: &str, f: impl FnOnce(*const u8, usize) -> T) -> T {
        let bytes = text.as_bytes();
        let ptr = aps_alloc(bytes.len());
        assert!(!ptr.is_null());
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
            let out = f(ptr as *const u8, bytes.len());
            aps_free(ptr, bytes.len());
            out
        }
    }

    fn baseline_text() -> String {
        std::fs::read_to_string(format!("{}/mock/baseline.json", env!("CARGO_MANIFEST_DIR")))
            .unwrap_or_else(|_| {
                std::fs::read_to_string(format!(
                    "{}/../mock/baseline.json",
                    env!("CARGO_MANIFEST_DIR")
                ))
                .unwrap()
            })
    }

    #[test]
    fn capabilities_export_is_schema_conformant_wasm_light() {
        assert_eq!(aps_capabilities(), 0);
        let report = read_result();
        // 契约 `solver-capabilities.schema.json` 要求这 7 个字段且 additionalProperties=false，
        // 因此这里断言字段集合完全一致（档位本身通过 can_prove_optimal / max_operations 体现）。
        let mut keys: Vec<String> = match &report {
            Json::Obj(fields) => fields.iter().map(|(k, _)| k.clone()).collect(),
            _ => Vec::new(),
        };
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "can_prove_infeasible",
                "can_prove_optimal",
                "constraints",
                "engine",
                "max_operations",
                "supports_cancel",
                "version",
            ]
        );
        // wasm-light 口径（与 `aps capabilities --profile wasm-light` 一致）：
        // 不证明最优/无解、600 工序上限、不支持**协作式**取消（浏览器端靠 terminate Worker）。
        assert_eq!(
            report.get("can_prove_optimal").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            report.get("can_prove_infeasible").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            report.get("max_operations").and_then(|v| v.as_i64()),
            Some(600)
        );
        assert_eq!(
            report.get("supports_cancel").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            report
                .get("constraints")
                .and_then(|v| v.as_arr())
                .map(|a| a.len()),
            Some(8)
        );
        // 与 native 声明同源（同一份 capabilities.rs），版本与应用版本一致
        assert_eq!(
            report.get("version").and_then(|v| v.as_str()),
            Some(env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn fingerprint_export_matches_engine_helper() {
        let solution = r#"{"schema_version":"plan-solution/1.0","status":"FEASIBLE","metrics":{"total_ms":1.5},"operations":[]}"#;
        let code = with_buffer(solution, |p, l| unsafe { aps_fingerprint(p, l) });
        assert_eq!(code, 0);
        let report = read_result();
        let expected = crate::engine::solution_fingerprint(&crate::json::parse(solution).unwrap());
        assert_eq!(
            report.get("fingerprint").and_then(|v| v.as_str()),
            Some(expected.as_str())
        );
        // 契约要求：指纹必须忽略运行期 metrics
        let other = r#"{"schema_version":"plan-solution/1.0","status":"FEASIBLE","metrics":{"total_ms":999.0},"operations":[]}"#;
        let code = with_buffer(other, |p, l| unsafe { aps_fingerprint(p, l) });
        assert_eq!(code, 0);
        assert_eq!(
            read_result().get("fingerprint").and_then(|v| v.as_str()),
            Some(expected.as_str())
        );
    }

    #[test]
    fn fingerprint_export_rejects_bad_json() {
        assert_eq!(
            with_buffer("{not json", |p, l| unsafe { aps_fingerprint(p, l) }),
            2
        );
        assert_eq!(unsafe { aps_fingerprint(std::ptr::null(), 0) }, 1);
    }

    #[test]
    fn verify_export_reports_violations_without_error_code() {
        let problem = baseline_text();
        // 先用引擎求解，再把某道工序挪到周六（周末无窗口）制造确定性违约
        let out = engine::solve_json(&problem, &SolveOptions::default(), &CancelToken::new());
        let mut solution = out.solution.unwrap();
        if let Some(ops) = solution.get_mut("operations").and_then(|v| v.as_arr_mut()) {
            if let Some(op) = ops.first_mut() {
                op.set("start_at", Json::str("2026-10-10T08:00:00-07:00"));
                op.set("end_at", Json::str("2026-10-10T08:15:00-07:00"));
            }
        }
        let solution_text = solution.to_pretty();
        let code = with_buffer(&problem, |pp, pl| {
            with_buffer(&solution_text, |sp, sl| unsafe {
                aps_verify(pp, pl, sp, sl, 0)
            })
        });
        assert_eq!(code, 0, "方案有违约时仍应产出报告（返回 0）");
        let report = read_result();
        assert_eq!(report.get("ok").and_then(|v| v.as_bool()), Some(false));
        assert!(
            report
                .get("counts")
                .and_then(|c| c.get("violations"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
                > 0
        );
        assert_eq!(
            report.get("mode").and_then(|v| v.as_str()),
            Some("permissive")
        );
    }

    #[test]
    fn verify_export_strict_requires_binding_fields() {
        let problem = baseline_text();
        let out = engine::solve_json(&problem, &SolveOptions::default(), &CancelToken::new());
        let mut solution = out.solution.unwrap();
        // 去掉绑定字段：严格模式必须报缺失
        if let Json::Obj(fields) = &mut solution {
            fields.retain(|(k, _)| k != "tenant_id" && k != "problem_hash");
        }
        let solution_text = solution.to_pretty();
        let code = with_buffer(&problem, |pp, pl| {
            with_buffer(&solution_text, |sp, sl| unsafe {
                aps_verify(pp, pl, sp, sl, 1)
            })
        });
        assert_eq!(code, 0);
        let report = read_result();
        assert_eq!(report.get("mode").and_then(|v| v.as_str()), Some("strict"));
        let codes: Vec<String> = report
            .get("violations")
            .and_then(|v| v.as_arr())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.get("code").and_then(|c| c.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            codes
                .iter()
                .any(|c| c == "TENANT_MISMATCH" || c == "PROBLEM_HASH_MISMATCH"),
            "严格模式应报绑定缺失，实际 {codes:?}"
        );
    }

    #[test]
    fn verify_export_flags_invalid_input_json() {
        let code = with_buffer("{}", |pp, pl| {
            with_buffer("{}", |sp, sl| unsafe { aps_verify(pp, pl, sp, sl, 0) })
        });
        assert_eq!(code, 2, "输入不合法时应返回 2 并在报告中给出 issues");
        let report = read_result();
        assert_eq!(report.get("parsed").and_then(|v| v.as_bool()), Some(false));
        assert!(!report
            .get("issues")
            .and_then(|v| v.as_arr())
            .map(|a| a.is_empty())
            .unwrap_or(true));
    }

    #[test]
    fn solve_with_options_applies_search_knobs() {
        let problem = baseline_text();
        // rule=random + 固定 seed 应仍给出可行解，且 options 覆盖生效（可用 rule 字段区分结果差异）
        let code = with_buffer(&problem, |pp, pl| {
            with_buffer(
                r#"{"seed":7,"time_limit_ms":300,"rule":"random","repair":false,"max_iterations":50}"#,
                |op, ol| unsafe { aps_solve_with_options(pp, pl, op, ol) },
            )
        });
        assert!(code == 1 || code == 2, "带参求解应给出解，实际 code={code}");
        let solution = read_result();
        assert_eq!(
            solution
                .get("options")
                .and_then(|o| o.get("rule"))
                .and_then(|v| v.as_str()),
            Some("random")
        );
        assert_eq!(
            solution
                .get("options")
                .and_then(|o| o.get("repair"))
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            solution
                .get("options")
                .and_then(|o| o.get("seed"))
                .and_then(|v| v.as_i64()),
            Some(7)
        );
        // 档位必须仍是 wasm-light（浏览器不得伪装成 native）
        assert_eq!(
            solution
                .get("options")
                .and_then(|o| o.get("profile"))
                .and_then(|v| v.as_str()),
            Some("wasm-light")
        );
    }

    #[test]
    fn solve_with_options_rejects_unknown_rule() {
        let problem = baseline_text();
        let code = with_buffer(&problem, |pp, pl| {
            with_buffer(r#"{"rule":"nope"}"#, |op, ol| unsafe {
                aps_solve_with_options(pp, pl, op, ol)
            })
        });
        assert_eq!(code, 0, "非法参数应返回 0（ABI 参数错误）");
        let report = read_result();
        let message = report.get("error").and_then(|v| v.as_str()).unwrap_or("");
        assert!(
            message.contains("rule"),
            "错误信息应指出 rule，实际：{message}"
        );
    }

    #[test]
    fn solve_with_options_matches_plain_solve_when_empty() {
        let problem = baseline_text();
        let plain = with_buffer(&problem, |p, l| unsafe { aps_solve(p, l) });
        let plain_solution = read_result();
        let with_opts = with_buffer(&problem, |pp, pl| {
            with_buffer("{}", |op, ol| unsafe {
                aps_solve_with_options(pp, pl, op, ol)
            })
        });
        assert_eq!(plain, with_opts, "空覆盖应与普通 solve 状态一致");
        let opt_solution = read_result();
        // 除运行期 metrics 外应完全一致（同一 seed/策略/规则）
        let strip = |mut j: Json| {
            if let Json::Obj(f) = &mut j {
                f.retain(|(k, _)| k != "metrics");
            }
            j.canonical()
        };
        assert_eq!(strip(plain_solution), strip(opt_solution));
    }

    #[test]
    fn solve_export_still_returns_status_codes() {
        let problem = baseline_text();
        let code = with_buffer(&problem, |p, l| unsafe { aps_solve(p, l) });
        assert!(
            code == 1 || code == 2,
            "基线应解出 OPTIMAL/FEASIBLE，实际 {code}"
        );
        let solution = read_result();
        assert!(solution.get("operations").is_some());
    }
}
