//! 单调时钟抽象：native 用 `std::time::Instant`；wasm32 通过导入的 `aps_now_ms()`。
//!
//! 为什么需要抽象：`std::time::Instant::now()` 在 `wasm32-unknown-unknown` 上会在运行时 panic，
//! 而契约要求求解指标（建模耗时、首解时间、总耗时）。WASM 侧由 JS 胶水层提供
//! `env.aps_now_ms()`（`performance.now()`），从而得到真实毫秒；
//! 若宿主无法提供该导入，浏览器侧应把指标标记为 `unavailable`（见 `docs/USAGE.md`）。

/// 单调毫秒（进程内相对基准即可，仅用于测量耗时）。
#[cfg(not(target_arch = "wasm32"))]
pub fn now_ms() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static T0: OnceLock<Instant> = OnceLock::new();
    let t0 = T0.get_or_init(Instant::now);
    t0.elapsed().as_secs_f64() * 1000.0
}

/// 单调毫秒（WASM：由宿主提供）。
#[cfg(target_arch = "wasm32")]
pub fn now_ms() -> f64 {
    extern "C" {
        /// 宿主注入：`performance.now()`（毫秒，单调）
        fn aps_now_ms() -> f64;
    }
    unsafe { aps_now_ms() }
}

/// 该平台上时间指标是否可用（用于诚实地写 `unavailable`）。
pub const TIME_METRICS_AVAILABLE: bool = true;

#[cfg(test)]
mod tests {
    #[test]
    fn monotonic_nondecreasing() {
        let a = super::now_ms();
        let mut acc = 0u64;
        for i in 0..1000 {
            acc += i as u64;
        }
        let b = super::now_ms();
        assert!(b >= a, "时钟必须单调不回退");
        std::hint::black_box(acc);
    }
}
