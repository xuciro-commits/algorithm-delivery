//! 峰值内存统计：包装全局分配器，记录当前/峰值字节数。
//!
//! 契约要求“统计…峰值内存”（APS-SRS §4/§7）；WASM 侧同样可用本实现，
//! 因此浏览器端也能给出真实的 `peak_memory_bytes`，无需写 `unavailable`。

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

/// 记录当前与峰值的内存分配器包装。
pub struct TrackingAllocator<A> {
    inner: A,
}

impl<A> TrackingAllocator<A> {
    pub const fn new(inner: A) -> Self {
        TrackingAllocator { inner }
    }
}

unsafe impl<A: GlobalAlloc> GlobalAlloc for TrackingAllocator<A> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = self.inner.alloc(layout);
        if !ptr.is_null() {
            record_alloc(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        self.inner.dealloc(ptr, layout);
        CURRENT.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_ptr = self.inner.realloc(ptr, layout, new_size);
        if !new_ptr.is_null() {
            if new_size >= layout.size() {
                record_alloc(new_size - layout.size());
            } else {
                CURRENT.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
            }
        }
        new_ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = self.inner.alloc_zeroed(layout);
        if !ptr.is_null() {
            record_alloc(layout.size());
        }
        ptr
    }
}

fn record_alloc(size: usize) {
    let cur = CURRENT.fetch_add(size, Ordering::Relaxed) + size;
    let mut peak = PEAK.load(Ordering::Relaxed);
    while cur > peak {
        match PEAK.compare_exchange_weak(peak, cur, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(observed) => peak = observed,
        }
    }
}

/// 当前进程/模块占用的堆字节数。
pub fn current_bytes() -> usize {
    CURRENT.load(Ordering::Relaxed)
}

/// 历史峰值字节数。
pub fn peak_bytes() -> usize {
    PEAK.load(Ordering::Relaxed)
}

/// 把峰值重置为当前占用（每次求解前调用，使指标对应本次求解）。
pub fn reset_peak() {
    PEAK.store(CURRENT.load(Ordering::Relaxed), Ordering::Relaxed);
}

/// 安装全局分配器：`#[global_allocator] static ALLOC: TrackingAllocator<System> = ...;`
pub type DefaultTrackingAllocator = TrackingAllocator<System>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peak_tracks_allocations() {
        reset_peak();
        let before = peak_bytes();
        let v: Vec<u64> = (0..100_000).collect();
        assert!(peak_bytes() >= before + 100_000 * 8);
        assert!(current_bytes() > 0);
        drop(v);
        std::hint::black_box(before);
    }
}
