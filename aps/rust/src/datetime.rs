//! ISO 8601 带偏移时间的解析与格式化，以及“自规划起点起的整数分钟”换算。
//!
//! 契约要求（APS-SRS §2）：
//! * 输入/输出为 ISO 8601 含偏移的时间；
//! * 内部以 `meta.horizon_start` 起算的非负整数分钟建模；
//! * 跨夏令时不得用“当地时钟直接相减”。
//!
//! 本模块因此始终在**绝对时间（UTC 分钟）**上做算术：解析时减去偏移得到绝对分钟，
//! 输出时再加回偏移。这样即使输入混用不同偏移（或夏季/冬季偏移）也不会算错。

use std::fmt;

/// 解析后的时间点：绝对时刻（自 Unix 纪元起的分钟）与书写偏移。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DateTime {
    /// 自 1970-01-01T00:00:00Z 起的分钟数（已含偏移）。
    pub epoch_min: i64,
    /// 原文中的偏移分钟（如 -07:00 为 -420）。
    pub offset_min: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TimeError {
    pub message: String,
}

impl fmt::Display for TimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for TimeError {}

fn err<T>(msg: impl Into<String>) -> Result<T, TimeError> {
    Err(TimeError {
        message: msg.into(),
    })
}

/// 解析 `YYYY-MM-DDThh:mm[:ss][.fff](Z|±hh:mm)`；P0 要求秒与毫秒为 0。
pub fn parse_iso8601(text: &str) -> Result<DateTime, TimeError> {
    let s = text.trim();
    let b = s.as_bytes();
    // 最少 "YYYY-MM-DDThh:mmZ" = 17 字符
    if b.len() < 17 {
        return err(format!("时间 '{}' 过短，期望 ISO 8601 含时区偏移", text));
    }
    if b[4] != b'-' || b[7] != b'-' {
        return err(format!("时间 '{}' 的日期部分应为 YYYY-MM-DD", text));
    }
    let year: i64 = parse_digits(text, 0, 4)?;
    let month: u32 = parse_digits(text, 5, 2)? as u32;
    let day: u32 = parse_digits(text, 8, 2)? as u32;
    let sep = b[10];
    if sep != b'T' && sep != b't' && sep != b' ' {
        return err(format!("时间 '{}' 缺少 'T' 分隔符", text));
    }
    if b[13] != b':' {
        return err(format!("时间 '{}' 的时:分部分应为 hh:mm", text));
    }
    let hour: u32 = parse_digits(text, 11, 2)? as u32;
    let minute: u32 = parse_digits(text, 14, 2)? as u32;

    let mut idx = 16usize;
    let mut second: u32 = 0;
    let mut nanos: u32 = 0;
    if b.len() > idx && b[idx] == b':' {
        second = parse_digits(text, idx + 1, 2)? as u32;
        idx += 3;
    }
    if b.len() > idx && b[idx] == b'.' {
        let start = idx + 1;
        let mut end = start;
        while end < b.len() && b[end].is_ascii_digit() {
            end += 1;
        }
        if end == start {
            return err(format!("时间 '{}' 的小数秒缺少数字", text));
        }
        let frac = &text[start..end];
        let mut ns: u32 = 0;
        for (i, ch) in frac.chars().enumerate() {
            if i < 9 {
                ns = ns * 10 + ch.to_digit(10).unwrap_or(0);
            }
        }
        for _ in frac.len()..9 {
            ns *= 10;
        }
        nanos = ns;
        idx = end;
    }

    if idx >= b.len() {
        return err(format!("时间 '{}' 缺少时区偏移（如 -07:00 或 Z）", text));
    }
    let offset_min = parse_offset(&s[idx..])?;

    if !(1..=12).contains(&month) {
        return err(format!("时间 '{}' 的月份非法", text));
    }
    let dim = days_in_month(year, month);
    if day < 1 || day > dim {
        return err(format!(
            "时间 '{}' 的日期非法（{:04}-{:02} 共 {} 天）",
            text, year, month, dim
        ));
    }
    if hour > 23 || minute > 59 {
        return err(format!("时间 '{}' 的时分非法", text));
    }
    if second > 59 {
        return err(format!("时间 '{}' 不支持闰秒（秒值须为 00-59）", text));
    }
    if second != 0 || nanos != 0 {
        // P0：分辨率为分钟，秒与亚秒必须为 0，避免静默截断导致时间漂移。
        return err(format!(
            "时间 '{}' 含非零秒/亚秒部分；P0 时间分辨率为分钟，秒必须为 00",
            text
        ));
    }

    let days = days_from_civil(year, month, day);
    let epoch_min = days * 1440 + (hour as i64) * 60 + minute as i64 - offset_min as i64;
    Ok(DateTime {
        epoch_min,
        offset_min,
    })
}

fn parse_digits(text: &str, start: usize, len: usize) -> Result<i64, TimeError> {
    let b = text.as_bytes();
    if start + len > b.len() {
        return err(format!("时间 '{}' 在位置 {} 处长度不足", text, start));
    }
    let mut v: i64 = 0;
    for i in start..start + len {
        let c = b[i];
        if !c.is_ascii_digit() {
            return err(format!(
                "时间 '{}' 在位置 {} 处期望数字，实际为 '{}'",
                text, i, c as char
            ));
        }
        v = v * 10 + (c - b'0') as i64;
    }
    Ok(v)
}

/// 解析时区偏移：`Z` / `±hh:mm` / `±hhmm` / `±hh`。
fn parse_offset(s: &str) -> Result<i32, TimeError> {
    let b = s.as_bytes();
    if b.is_empty() {
        return err("缺少时区偏移");
    }
    if b[0] == b'Z' || b[0] == b'z' {
        if b.len() != 1 {
            return err(format!("时区偏移 '{}' 非法（Z 之后不应有内容）", s));
        }
        return Ok(0);
    }
    let sign = match b[0] {
        b'+' => 1,
        b'-' => -1,
        _ => return err(format!("时区偏移 '{}' 应以 +、- 或 Z 开头", s)),
    };
    let (hh, mm) = match b.len() {
        3 => (parse_digits(s, 1, 2)?, 0),
        5 => {
            if b[3] == b':' {
                (parse_digits(s, 1, 2)?, parse_digits(s, 4, 2)?)
            } else {
                (parse_digits(s, 1, 2)?, parse_digits(s, 3, 2)?)
            }
        }
        6 => {
            if b[3] != b':' {
                return err(format!("时区偏移 '{}' 非法", s));
            }
            (parse_digits(s, 1, 2)?, parse_digits(s, 4, 2)?)
        }
        _ => return err(format!("时区偏移 '{}' 非法", s)),
    };
    if hh > 23 || mm > 59 {
        return err(format!("时区偏移 '{}' 数值越界", s));
    }
    Ok((sign * (hh * 60 + mm)) as i32)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// Howard Hinnant 的 days_from_civil 算法（对儒略纪元安全）。
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = ((m + 9) % 12) as i64; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe - 719468
}

/// 逆算法：由天数得到 (年, 月, 日)。
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 按给定偏移格式化为 ISO 8601（秒固定为 00，与 P0 分钟分辨率一致）。
pub fn format_iso8601(epoch_min: i64, offset_min: i32) -> String {
    let local = epoch_min + offset_min as i64;
    let days = local.div_euclid(1440);
    let rem = local.rem_euclid(1440);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm) = (rem / 60, rem % 60);
    let sign = if offset_min < 0 { '-' } else { '+' };
    let (oh, om) = (offset_min.abs() / 60, offset_min.abs() % 60);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:00{}{:02}:{:02}",
        y, m, d, hh, mm, sign, oh, om
    )
}

/// 解析并直接得到绝对分钟。
pub fn parse_to_epoch_min(text: &str) -> Result<i64, TimeError> {
    Ok(parse_iso8601(text)?.epoch_min)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_with_offsets() {
        let a = parse_iso8601("2026-10-05T08:00:00-07:00").unwrap();
        let b = parse_iso8601("2026-10-05T15:00:00Z").unwrap();
        let c = parse_iso8601("2026-10-05T22:00:00+07:00").unwrap();
        assert_eq!(a.epoch_min, b.epoch_min);
        assert_eq!(b.epoch_min, c.epoch_min);
        assert_eq!(a.offset_min, -420);
        let d = parse_iso8601("2026-10-05T08:00-0700").unwrap();
        assert_eq!(d.epoch_min, a.epoch_min);
    }

    #[test]
    fn roundtrip_format() {
        for text in [
            "2026-10-05T08:00:00-07:00",
            "2026-03-08T01:30:00-08:00", // 跨夏令时边界前
            "2026-11-01T01:30:00-07:00", // 跨夏令时边界后
            "2026-10-09T17:00:00-07:00",
            "2024-02-29T00:00:00+00:00",
        ] {
            let dt = parse_iso8601(text).unwrap();
            let formatted = format_iso8601(dt.epoch_min, dt.offset_min);
            assert_eq!(formatted, text, "roundtrip {}", text);
        }
    }

    #[test]
    fn rejects_malformed() {
        for bad in [
            "2026-10-05",
            "2026-10-05T08:00:00",
            "2026-13-05T08:00:00Z",
            "2026-02-30T08:00:00Z",
            "2026-10-05T25:00:00Z",
            "2026-10-05T08:00:30Z",
            "2026-10-05T08:00:00.500Z",
            "2026-10-5T08:00:00Z",
        ] {
            assert!(parse_iso8601(bad).is_err(), "应被拒绝: {}", bad);
        }
    }

    #[test]
    fn civil_roundtrip_wide_range() {
        for days in [-25000i64, -1, 0, 1, 19000, 21000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
    }

    #[test]
    fn no_local_clock_subtraction() {
        // 美国 2026-11-01 夏令时回拨：本地时钟 01:30-07:00 与 01:30-08:00 是不同绝对时刻
        let a = parse_iso8601("2026-11-01T01:30:00-07:00").unwrap();
        let b = parse_iso8601("2026-11-01T01:30:00-08:00").unwrap();
        assert_eq!(b.epoch_min - a.epoch_min, 60);
    }
}
