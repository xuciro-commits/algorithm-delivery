//! 日历与区间代数（H04 的基础设施）。
//!
//! 编译规则（严格遵循 SRS §2 “所有持续时间及可用窗口对齐”且“不得放大可用时间”）：
//!
//! * `available` 先裁剪到 horizon 内；
//! * `blocked` 按**扩大**方向取整（起点向下取整、终点向上取整），保证不会把停工时间误当可用；
//! * 合并重叠/相接的可用窗口，再减去 blocked，得到“连续可用窗口”；
//! * 最终窗口按**缩小**方向取整到分辨率网格（起点向上、终点向下）。
//!
//! 工序占用必须**完整落在某一个连续可用窗口内**（不可抢占、不得跨越班次空档/停工）。

use crate::model::RawInterval;

/// 半开区间 `[s, e)`，单位为自规划起点起的整数分钟。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Interval {
    pub s: i64,
    pub e: i64,
}

impl Interval {
    pub fn new(s: i64, e: i64) -> Interval {
        Interval { s, e }
    }
    pub fn len(&self) -> i64 {
        self.e - self.s
    }
    pub fn is_empty(&self) -> bool {
        self.e <= self.s
    }
}

/// 区间是否重叠（半开区间，端点相接不算重叠）。
pub fn overlaps(a: (i64, i64), b: (i64, i64)) -> bool {
    a.0 < b.1 && b.0 < a.1
}

/// 按起点排序并合并重叠或相接的区间。
pub fn merge_intervals(mut v: Vec<Interval>) -> Vec<Interval> {
    v.retain(|i| i.e > i.s);
    v.sort_by_key(|i| (i.s, i.e));
    let mut out: Vec<Interval> = Vec::with_capacity(v.len());
    for iv in v {
        match out.last_mut() {
            Some(last) if iv.s <= last.e => {
                if iv.e > last.e {
                    last.e = iv.e;
                }
            }
            _ => out.push(iv),
        }
    }
    out
}

/// `base` 减去 `holes`。
pub fn subtract(base: &[Interval], holes: &[Interval]) -> Vec<Interval> {
    let holes = merge_intervals(holes.to_vec());
    let mut out: Vec<Interval> = Vec::new();
    for b in base {
        let mut cursor = b.s;
        for h in holes.iter() {
            if h.e <= cursor {
                continue;
            }
            if h.s >= b.e {
                break;
            }
            if h.s > cursor {
                out.push(Interval::new(cursor, h.s.min(b.e)));
            }
            cursor = cursor.max(h.e);
            if cursor >= b.e {
                break;
            }
        }
        if cursor < b.e {
            out.push(Interval::new(cursor, b.e));
        }
    }
    out.retain(|i| i.e > i.s);
    out
}

/// 裁剪到 `[lo, hi]`。
pub fn clip(ivs: &[Interval], lo: i64, hi: i64) -> Vec<Interval> {
    ivs.iter()
        .map(|i| Interval::new(i.s.max(lo), i.e.min(hi)))
        .filter(|i| i.e > i.s)
        .collect()
}

/// 把区间起点向上取整、终点向下取整到分辨率网格（只会缩小可用时间）。
pub fn shrink_to_grid(ivs: &[Interval], res: i64) -> Vec<Interval> {
    if res <= 1 {
        return ivs.to_vec();
    }
    ivs.iter()
        .map(|i| Interval::new(ceil_to(i.s, res), floor_to(i.e, res)))
        .filter(|i| i.e > i.s)
        .collect()
}

/// 把区间起点向下取整、终点向上取整到网格（只会扩大区间，用于 blocked/保守处理）。
pub fn grow_to_grid(ivs: &[Interval], res: i64) -> Vec<Interval> {
    if res <= 1 {
        return ivs.to_vec();
    }
    ivs.iter()
        .map(|i| Interval::new(floor_to(i.s, res), ceil_to(i.e, res)))
        .collect()
}

pub fn floor_to(v: i64, res: i64) -> i64 {
    v.div_euclid(res) * res
}

pub fn ceil_to(v: i64, res: i64) -> i64 {
    -((-v).div_euclid(res)) * res
}

/// 由原始 available / blocked 构造连续可用窗口。
///
/// `t0`：规划起点的绝对分钟；`horizon_len`：时域长度（分钟）；`res`：分辨率。
pub fn build_windows(
    available: &[RawInterval],
    blocked: &[RawInterval],
    t0: i64,
    horizon_len: i64,
    res: i64,
) -> Vec<Interval> {
    let av: Vec<Interval> = available
        .iter()
        .map(|iv| Interval::new(iv.start_min - t0, iv.end_min - t0))
        .collect();
    let mut av = clip(&merge_intervals(av), 0, horizon_len);
    av = shrink_to_grid(&av, res);
    let mut bk: Vec<Interval> = blocked
        .iter()
        .map(|iv| Interval::new(iv.start_min - t0, iv.end_min - t0))
        .collect();
    bk = grow_to_grid(&bk, res);
    let free = subtract(&av, &bk);
    merge_intervals(shrink_to_grid(&free, res))
}

/// 在 `windows` 内、避开 `busy`（按起点升序、两两不重叠）、不早于 `est` 找到最早的可容纳
/// `dur` 分钟的连续空档。返回起点（整数分钟）。
pub fn earliest_slot(
    windows: &[Interval],
    busy: &[(i64, i64)],
    dur: i64,
    est: i64,
) -> Option<i64> {
    debug_assert!(dur > 0);
    for w in windows {
        if w.e - w.s < dur {
            continue;
        }
        let mut cursor = w.s.max(est);
        if cursor + dur > w.e {
            continue;
        }
        let mut ok = true;
        for (bs, be) in busy.iter() {
            if *be <= cursor {
                continue;
            }
            if *bs >= w.e {
                break;
            }
            if *bs - cursor >= dur {
                // 当前 cursor 到该占用之间的空档足够
                break;
            }
            cursor = cursor.max(*be);
            if cursor + dur > w.e {
                ok = false;
                break;
            }
        }
        if ok && cursor + dur <= w.e {
            return Some(cursor);
        }
    }
    None
}

/// 把区间插入按起点排序的向量（用于维护资源占用时间线）。
pub fn insert_sorted(v: &mut Vec<(i64, i64)>, item: (i64, i64)) {
    let pos = v.partition_point(|x| (x.0, x.1) < (item.0, item.1));
    v.insert(pos, item);
}

/// 移除一个区间（按值匹配）。
pub fn remove_sorted(v: &mut Vec<(i64, i64)>, item: (i64, i64)) -> bool {
    if let Ok(pos) = v.binary_search(&item) {
        v.remove(pos);
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iv(start: &str, end: &str) -> RawInterval {
        RawInterval {
            start: start.to_string(),
            end: end.to_string(),
            start_min: crate::datetime::parse_to_epoch_min(start).unwrap(),
            end_min: crate::datetime::parse_to_epoch_min(end).unwrap(),
            reason: None,
        }
    }

    #[test]
    fn windows_subtract_blocked_and_shrink() {
        let t0 = crate::datetime::parse_to_epoch_min("2026-10-05T08:00:00-07:00").unwrap();
        let avail = vec![
            iv("2026-10-05T08:00:00-07:00", "2026-10-05T12:00:00-07:00"),
            iv("2026-10-05T13:00:00-07:00", "2026-10-05T17:00:00-07:00"),
        ];
        let blocked = vec![iv("2026-10-05T09:00:00-07:00", "2026-10-05T10:00:00-07:00")];
        let w = build_windows(&avail, &blocked, t0, 4 * 1440, 15);
        assert_eq!(w, vec![Interval::new(0, 60), Interval::new(120, 240), Interval::new(300, 540)]);

        // 未对齐窗口：可用时间只会缩小（08:07 → 09:53 变成 08:15 → 09:45）
        let odd = vec![iv("2026-10-05T08:07:00-07:00", "2026-10-05T09:53:00-07:00")];
        let w2 = build_windows(&odd, &[], t0, 4 * 1440, 15);
        assert_eq!(w2, vec![Interval::new(15, 105)]);

        // blocked 未对齐：只会扩大（09:07-09:53 变成 09:00-10:00）
        let w3 = build_windows(
            &avail,
            &[iv("2026-10-05T09:07:00-07:00", "2026-10-05T09:53:00-07:00")],
            t0,
            4 * 1440,
            15,
        );
        assert_eq!(w3, vec![Interval::new(0, 60), Interval::new(120, 240), Interval::new(300, 540)]);
    }

    #[test]
    fn earliest_slot_respects_busy_and_est() {
        let windows = vec![Interval::new(0, 600)];
        let busy = vec![(30, 90), (100, 130)];
        assert_eq!(earliest_slot(&windows, &busy, 30, 0), Some(0));
        // est=45：90~100 只有 10 分钟空档，放不下 40 分钟 → 下一个空档 130
        assert_eq!(earliest_slot(&windows, &busy, 40, 45), Some(130));
        // 最长空档为 130~600（470 分钟），480 分钟放不下
        assert_eq!(earliest_slot(&windows, &busy, 480, 0), None);
        assert_eq!(earliest_slot(&windows, &busy, 30, 560), Some(560));
        assert_eq!(earliest_slot(&windows, &busy, 50, 560), None);
    }

    #[test]
    fn merge_and_subtract_edges() {
        let merged = merge_intervals(vec![
            Interval::new(0, 10),
            Interval::new(10, 20),
            Interval::new(25, 30),
            Interval::new(5, 8),
        ]);
        assert_eq!(merged, vec![Interval::new(0, 20), Interval::new(25, 30)]);
        let left = subtract(&merged, &[Interval::new(15, 27)]);
        assert_eq!(left, vec![Interval::new(0, 15), Interval::new(27, 30)]);
    }

    #[test]
    fn insert_and_remove_sorted() {
        let mut v: Vec<(i64, i64)> = vec![];
        insert_sorted(&mut v, (10, 20));
        insert_sorted(&mut v, (0, 5));
        insert_sorted(&mut v, (30, 40));
        assert_eq!(v, vec![(0, 5), (10, 20), (30, 40)]);
        assert!(remove_sorted(&mut v, (10, 20)));
        assert!(!remove_sorted(&mut v, (10, 20)));
        assert_eq!(v, vec![(0, 5), (30, 40)]);
    }

    #[test]
    fn earliest_slot_scans_multiple_windows() {
        let windows = vec![Interval::new(0, 60), Interval::new(120, 240)];
        let busy = vec![(0, 30)];
        assert_eq!(earliest_slot(&windows, &busy, 30, 0), Some(30));
        assert_eq!(earliest_slot(&windows, &busy, 90, 0), Some(120));
        assert_eq!(earliest_slot(&windows, &busy, 130, 0), None);
    }
}
