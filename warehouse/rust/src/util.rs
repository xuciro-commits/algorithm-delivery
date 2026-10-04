//! 确定性工具：随机数、统计、定点化与格式化。
//!
//! 为什么自己实现而不是引依赖：引擎要在**浏览器 WASM** 与 **native CLI** 两处跑，
//! 结果必须逐位可复现（SRS §6.3）。随机数使用 sfc32（整数运算 + IEEE-754 明确规定
//! 的浮点运算），任何平台上的序列完全一致；统计函数避免引入排序以外的假设。

/// sfc32 随机数发生器（确定性、可 fork）。
#[derive(Debug, Clone)]
pub struct Rng {
    a: u32,
    b: u32,
    c: u32,
    d: u32,
    seed: u64,
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        let mut s = (seed as u32) ^ 0x9e37_79b9;
        let mut next_seed = || {
            s = s.wrapping_add(0x9e37_79b9);
            let mut z = s ^ (s >> 16);
            z = z.wrapping_mul(0x21f0_aaad);
            z ^= z >> 15;
            z = z.wrapping_mul(0x735a_2d97);
            z ^ (z >> 15)
        };
        Rng {
            a: next_seed(),
            b: next_seed(),
            c: next_seed(),
            d: next_seed(),
            seed,
        }
    }

    /// [0,1) 均匀分布。
    pub fn next_f64(&mut self) -> f64 {
        let mut t = self.a.wrapping_add(self.b);
        self.a = self.b ^ (self.b >> 9);
        self.b = self.c.wrapping_add(self.c << 3);
        self.c = self.c.rotate_left(21);
        self.d = self.d.wrapping_add(1);
        t = t.wrapping_add(self.d);
        self.c = self.c.wrapping_add(t);
        (t as f64) / 4_294_967_296.0
    }

    /// [min,max) 均匀整数。
    pub fn int(&mut self, min: i64, max: i64) -> i64 {
        if max <= min {
            return min;
        }
        min + (self.next_f64() * (max - min) as f64) as i64
    }

    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            return 0;
        }
        (self.next_f64() * n as f64) as usize
    }

    /// 标准正态（Box–Muller；不使用缓存，保证序列长度一致）。
    pub fn normal(&mut self) -> f64 {
        let u1 = self.next_f64().max(1e-12);
        let u2 = self.next_f64();
        (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
    }

    pub fn log_normal(&mut self, mu: f64, sigma: f64) -> f64 {
        (mu + sigma * self.normal()).exp()
    }

    /// 派生独立子序列（分区并行时不破坏主序列）。
    pub fn fork(&mut self, salt: u64) -> Rng {
        Rng::new(self.seed ^ salt.wrapping_mul(0x9e37_79b9) ^ (self.a as u64))
    }
}

/// 字符串 → 稳定种子（场景 → 问题生成）。
pub fn seed_from(parts: &[&str]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for byte in part.as_bytes() {
            h ^= *byte as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        h ^= 0x7c;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

pub fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

pub fn round(v: f64, digits: i32) -> f64 {
    let f = 10f64.powi(digits);
    (v * f).round() / f
}

pub fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().sum::<f64>() / values.len() as f64
}

pub fn stddev(values: &[f64]) -> f64 {
    if values.len() <= 1 {
        return 0.0;
    }
    let m = mean(values);
    let acc: f64 = values.iter().map(|v| (v - m).powi(2)).sum();
    (acc / (values.len() - 1) as f64).sqrt()
}

pub fn percentile(values: &[f64], p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let index = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

/// 基尼系数（0 = 完全均衡）；用于巷道 / 设备负载均衡度。
pub fn gini(values: &[f64]) -> f64 {
    let n = values.len();
    if n == 0 {
        return 0.0;
    }
    let total: f64 = values.iter().sum();
    if total <= 0.0 {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let weighted: f64 = sorted
        .iter()
        .enumerate()
        .map(|(i, v)| (i as f64 + 1.0) * v)
        .sum();
    (2.0 * weighted) / (n as f64 * total) - (n as f64 + 1.0) / n as f64
}

/// 条件风险价值（最差 α 比例的平均值）；鲁棒优化的风险度量。
pub fn cvar(values: &[f64], alpha: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let k = ((alpha.clamp(0.01, 1.0) * sorted.len() as f64).ceil() as usize).max(1);
    mean(&sorted[..k.min(sorted.len())])
}

/// 秒 → `HH:MM:SS`（跨天显示 `d+N`）。
pub fn format_seconds(total_seconds: f64) -> String {
    let s = total_seconds.max(0.0).floor() as i64;
    let day = s / 86_400;
    let hh = (s % 86_400) / 3_600;
    let mm = (s % 3_600) / 60;
    let ss = s % 60;
    if day > 0 {
        format!("d{day} {hh:02}:{mm:02}:{ss:02}")
    } else {
        format!("{hh:02}:{mm:02}:{ss:02}")
    }
}

/// 秒 → 人类可读时长。
pub fn human_duration(seconds: f64) -> String {
    if !seconds.is_finite() {
        return "—".to_string();
    }
    if seconds < 60.0 {
        format!("{:.1} s", seconds)
    } else if seconds < 3600.0 {
        format!("{:.1} min", seconds / 60.0)
    } else {
        format!("{:.2} h", seconds / 3600.0)
    }
}

/// 无条件写入调试输出（WASM 下由宿主忽略）。
pub fn debug_line(message: &str) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        eprintln!("{message}");
    }
    #[cfg(target_arch = "wasm32")]
    {
        let _ = message;
    }
}
