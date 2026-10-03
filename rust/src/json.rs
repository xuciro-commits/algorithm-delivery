//! 零依赖 JSON 实现（解析 / 序列化 / 规范化）。
//!
//! 设计要点：
//! * 对象保留插入顺序（`Vec<(String, Json)>`），无哈希表遍历顺序带来的不确定性；
//! * 整数与浮点分类型保存，避免 `i64` 精度丢失（契约要求“非负整数”）；
//! * 解析器严格：拒绝尾随内容、重复键、非法数字、超过深度上限的嵌套；
//! * 提供 `canonical()`：键按字节序排序 + 紧凑输出，用于 `problem_hash`（跨语言可复现）。

use std::fmt;

/// JSON 值。契约文档中所有字段均由本类型承载。
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    // ---------- 构造 ----------
    pub fn str<S: Into<String>>(s: S) -> Json {
        Json::Str(s.into())
    }
    pub fn obj(fields: Vec<(&str, Json)>) -> Json {
        Json::Obj(
            fields
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        )
    }
    pub fn int(v: i64) -> Json {
        Json::Int(v)
    }
    pub fn opt_str<S: Into<String>>(v: Option<S>) -> Json {
        match v {
            Some(s) => Json::Str(s.into()),
            None => Json::Null,
        }
    }
    pub fn opt_int(v: Option<i64>) -> Json {
        match v {
            Some(i) => Json::Int(i),
            None => Json::Null,
        }
    }
    pub fn strings<I, S>(items: I) -> Json
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Json::Arr(items.into_iter().map(|s| Json::Str(s.into())).collect())
    }

    // ---------- 访问 ----------
    /// 对象取值；非对象或键不存在返回 `None`。
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// 是否存在该键（用于 `additionalProperties: false` 的严格校验）。
    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// 对象可变取值（用于对抗测试中的“故意破坏”改造）。
    pub fn get_mut(&mut self, key: &str) -> Option<&mut Json> {
        match self {
            Json::Obj(fields) => fields.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_arr_mut(&mut self) -> Option<&mut Vec<Json>> {
        match self {
            Json::Arr(items) => Some(items),
            _ => None,
        }
    }

    pub fn set(&mut self, key: &str, value: Json) {
        if let Json::Obj(fields) = self {
            match fields.iter_mut().find(|(k, _)| k == key) {
                Some((_, v)) => *v = value,
                None => fields.push((key.to_string(), value)),
            }
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// 仅接受整数；浮点即便数值为整也不接受（契约要求整数类型）。
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Json::Int(i) => Some(*i),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Int(i) => Some(*i as f64),
            Json::Float(f) => Some(*f),
            _ => None,
        }
    }

    pub fn as_arr(&self) -> Option<&[Json]> {
        match self {
            Json::Arr(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_obj(&self) -> Option<&[(String, Json)]> {
        match self {
            Json::Obj(o) => Some(o),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Json::Null)
    }

    /// 用于错误信息中的类型名。
    pub fn type_name(&self) -> &'static str {
        match self {
            Json::Null => "null",
            Json::Bool(_) => "boolean",
            Json::Int(_) | Json::Float(_) => "number",
            Json::Str(_) => "string",
            Json::Arr(_) => "array",
            Json::Obj(_) => "object",
        }
    }

    // ---------- 序列化 ----------
    /// 紧凑序列化（保留插入顺序与数字类型）。
    pub fn to_compact(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, None, false, 0);
        out
    }

    /// 2 空格缩进的漂亮输出（与仓库内 JSON 样本风格一致）。
    pub fn to_pretty(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, Some(2), false, 0);
        out.push('\n');
        out
    }

    /// 规范化文本：键按字节序排序、数字取规范形式（整数值浮点写成整数）。用于跨语言一致的哈希输入。
    pub fn canonical(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, None, true, 0);
        out
    }

    fn write(&self, out: &mut String, indent: Option<usize>, canonical: bool, depth: usize) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(true) => out.push_str("true"),
            Json::Bool(false) => out.push_str("false"),
            Json::Int(i) => out.push_str(&i.to_string()),
            Json::Float(f) => {
                if !f.is_finite() {
                    out.push_str("null"); // 非有限值不进入 JSON
                } else if canonical && *f == f.trunc() && f.abs() < 9.007_199_254_740_992e15 {
                    // 规范化模式：整数值浮点写成整数，保证跨语言摘要一致
                    out.push_str(&format!("{}", *f as i64));
                } else {
                    let text = format!("{f}");
                    out.push_str(&text);
                    // 保留浮点类型（1.0 不得写成 1），保证解析回读类型一致
                    if !text.contains('.') && !text.contains('e') && !text.contains('E') {
                        out.push_str(".0");
                    }
                }
            }
            Json::Str(s) => write_escaped(out, s),
            Json::Arr(items) => {
                if items.is_empty() {
                    out.push_str("[]");
                    return;
                }
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    if let Some(n) = indent {
                        out.push('\n');
                        push_indent(out, n * (depth + 1));
                    }
                    item.write(out, indent, canonical, depth + 1);
                }
                if let Some(n) = indent {
                    out.push('\n');
                    push_indent(out, n * depth);
                }
                out.push(']');
            }
            Json::Obj(fields) => {
                let ordered: Vec<&(String, Json)> = if canonical {
                    // canonical 模式：键按字节序排序，跨语言/跨运行时稳定
                    let mut v: Vec<&(String, Json)> = fields.iter().collect();
                    v.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
                    v
                } else {
                    fields.iter().collect()
                };
                if ordered.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push('{');
                for (i, (k, v)) in ordered.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    if let Some(n) = indent {
                        out.push('\n');
                        push_indent(out, n * (depth + 1));
                    }
                    write_escaped(out, k);
                    out.push(':');
                    if indent.is_some() {
                        out.push(' ');
                    }
                    v.write(out, indent, canonical, depth + 1);
                }
                if let Some(n) = indent {
                    out.push('\n');
                    push_indent(out, n * depth);
                }
                out.push('}');
            }
        }
    }
}

fn push_indent(out: &mut String, n: usize) {
    for _ in 0..n {
        out.push(' ');
    }
}

/// 按 RFC 8259 写出字符串字面量（非 ASCII 原样输出，仓库样本为 UTF-8）。
pub fn write_escaped(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// 解析错误（带行列定位，便于契约校验时给出字段级提示）。
#[derive(Debug, Clone, PartialEq)]
pub struct JsonError {
    pub message: String,
    pub line: usize,
    pub column: usize,
    pub offset: usize,
}

impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "JSON 解析失败（第 {} 行 第 {} 列）：{}",
            self.line, self.column, self.message
        )
    }
}

impl std::error::Error for JsonError {}

const MAX_DEPTH: usize = 128;

/// 由 UTF-8 首字节推出该字符的编码长度（0 表示非法首字节）。
#[inline]
fn utf8_len(b: u8) -> usize {
    match b {
        0x00..=0x7F => 1,
        0xC2..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF4 => 4,
        _ => 0,
    }
}

/// 解析 JSON 文本。空白区之外的任何尾随内容都会报错。
pub fn parse(text: &str) -> Result<Json, JsonError> {
    let mut p = Parser {
        bytes: text.as_bytes(),
        pos: 0,
    };
    p.skip_ws();
    let v = p.parse_value(0)?;
    p.skip_ws();
    if p.pos != p.bytes.len() {
        return Err(p.err("存在尾随内容（JSON 文档必须是单个值）"));
    }
    Ok(v)
}

/// 从字节解析（wasm ABI 入口使用，输入必须是 UTF-8）。
pub fn parse_bytes(bytes: &[u8]) -> Result<Json, JsonError> {
    let s = std::str::from_utf8(bytes).map_err(|e| JsonError {
        message: format!("输入不是合法 UTF-8：{e}"),
        line: 1,
        column: 1,
        offset: 0,
    })?;
    parse(s)
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn err(&self, msg: &str) -> JsonError {
        let (line, column) = self.line_col(self.pos);
        JsonError {
            message: msg.to_string(),
            line,
            column,
            offset: self.pos,
        }
    }

    fn line_col(&self, offset: usize) -> (usize, usize) {
        let mut line = 1usize;
        let mut col = 1usize;
        for i in 0..offset.min(self.bytes.len()) {
            if self.bytes[i] == b'\n' {
                line += 1;
                col = 1;
            } else {
                col += 1;
            }
        }
        (line, col)
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            match b {
                b' ' | b'\t' | b'\n' | b'\r' => self.pos += 1,
                _ => break,
            }
        }
    }

    fn expect(&mut self, b: u8) -> Result<(), JsonError> {
        if self.peek() == Some(b) {
            self.pos += 1;
            Ok(())
        } else {
            Err(self.err(&format!("期望字符 '{}'", b as char)))
        }
    }

    fn parse_value(&mut self, depth: usize) -> Result<Json, JsonError> {
        if depth > MAX_DEPTH {
            return Err(self.err("嵌套层级超过上限（128）"));
        }
        match self.peek() {
            None => Err(self.err("期望一个 JSON 值，但输入已结束")),
            Some(b'{') => self.parse_object(depth),
            Some(b'[') => self.parse_array(depth),
            Some(b'"') => Ok(Json::Str(self.parse_string()?)),
            Some(b't') => {
                self.literal("true")?;
                Ok(Json::Bool(true))
            }
            Some(b'f') => {
                self.literal("false")?;
                Ok(Json::Bool(false))
            }
            Some(b'n') => {
                self.literal("null")?;
                Ok(Json::Null)
            }
            Some(_) => self.parse_number(),
        }
    }

    fn literal(&mut self, lit: &str) -> Result<(), JsonError> {
        if self.bytes.len() >= self.pos + lit.len()
            && &self.bytes[self.pos..self.pos + lit.len()] == lit.as_bytes()
        {
            self.pos += lit.len();
            Ok(())
        } else {
            Err(self.err(&format!("非法字面量，期望 '{lit}'")))
        }
    }

    fn parse_object(&mut self, depth: usize) -> Result<Json, JsonError> {
        self.expect(b'{')?;
        let mut fields: Vec<(String, Json)> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Json::Obj(fields));
        }
        loop {
            self.skip_ws();
            let key = match self.peek() {
                Some(b'"') => self.parse_string()?,
                _ => return Err(self.err("对象的键必须是字符串")),
            };
            if fields.iter().any(|(k, _)| k == &key) {
                return Err(self.err(&format!("对象存在重复键 '{key}'")));
            }
            self.skip_ws();
            self.expect(b':')?;
            self.skip_ws();
            let value = self.parse_value(depth + 1)?;
            fields.push((key, value));
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                _ => return Err(self.err("对象成员之间缺少 ',' 或结尾缺少 '}'")),
            }
        }
        Ok(Json::Obj(fields))
    }

    fn parse_array(&mut self, depth: usize) -> Result<Json, JsonError> {
        self.expect(b'[')?;
        let mut items: Vec<Json> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            self.skip_ws();
            items.push(self.parse_value(depth + 1)?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b']') => {
                    self.pos += 1;
                    break;
                }
                _ => return Err(self.err("数组元素之间缺少 ',' 或结尾缺少 ']'")),
            }
        }
        Ok(Json::Arr(items))
    }

    fn parse_string(&mut self) -> Result<String, JsonError> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let b = match self.peek() {
                Some(b) => b,
                None => return Err(self.err("字符串未闭合")),
            };
            match b {
                b'"' => {
                    self.pos += 1;
                    return Ok(out);
                }
                b'\\' => {
                    self.pos += 1;
                    let esc = match self.peek() {
                        Some(e) => e,
                        None => return Err(self.err("转义序列未结束")),
                    };
                    self.pos += 1;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{08}'),
                        b'f' => out.push('\u{0c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.parse_hex4()?;
                            if (0xD800..0xDC00).contains(&hi) {
                                // 代理对
                                if self.peek() == Some(b'\\') {
                                    self.pos += 1;
                                    if self.peek() == Some(b'u') {
                                        self.pos += 1;
                                        let lo = self.parse_hex4()?;
                                        if !(0xDC00..0xE000).contains(&lo) {
                                            return Err(self.err("非法 UTF-16 代理对低位"));
                                        }
                                        let cp = 0x10000
                                            + (((hi - 0xD800) as u32) << 10)
                                            + (lo - 0xDC00) as u32;
                                        match char::from_u32(cp) {
                                            Some(c) => out.push(c),
                                            None => return Err(self.err("非法 Unicode 码点")),
                                        }
                                    } else {
                                        return Err(self.err("代理对缺少 \\u 低位转义"));
                                    }
                                } else {
                                    return Err(self.err("代理对缺少低位转义"));
                                }
                            } else if (0xDC00..0xE000).contains(&hi) {
                                return Err(self.err("孤立的 UTF-16 低位代理"));
                            } else {
                                match char::from_u32(hi as u32) {
                                    Some(c) => out.push(c),
                                    None => return Err(self.err("非法 Unicode 码点")),
                                }
                            }
                        }
                        other => {
                            return Err(self.err(&format!("非法转义字符 '\\{}'", other as char)))
                        }
                    }
                }
                b if b < 0x20 => {
                    return Err(self.err("字符串中出现未转义的控制字符"));
                }
                _ => {
                    // 按 UTF-8 字符推进：只解码当前字符的字节（1–4 字节），
                    // 不要对剩余全文做 from_utf8 校验——那会退化为 O(n²)。
                    let n = utf8_len(b);
                    if n == 0 || self.pos + n > self.bytes.len() {
                        return Err(self.err("字符串中存在非法 UTF-8 字节"));
                    }
                    let chunk = &self.bytes[self.pos..self.pos + n];
                    let ch = match std::str::from_utf8(chunk) {
                        Ok(s) => s.chars().next().unwrap(),
                        Err(_) => return Err(self.err("字符串中存在非法 UTF-8 字节")),
                    };
                    if out.is_empty() {
                        out.reserve(16);
                    }
                    out.push(ch);
                    self.pos += n;
                }
            }
        }
    }

    fn parse_hex4(&mut self) -> Result<u16, JsonError> {
        if self.pos + 4 > self.bytes.len() {
            return Err(self.err("\\u 转义需要 4 位十六进制"));
        }
        let mut v: u16 = 0;
        for _ in 0..4 {
            let b = self.bytes[self.pos];
            let d = match b {
                b'0'..=b'9' => b - b'0',
                b'a'..=b'f' => b - b'a' + 10,
                b'A'..=b'F' => b - b'A' + 10,
                _ => return Err(self.err("\\u 转义需要 4 位十六进制")),
            };
            v = v * 16 + d as u16;
            self.pos += 1;
        }
        Ok(v)
    }

    fn parse_number(&mut self) -> Result<Json, JsonError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        let mut is_float = false;
        let int_start = self.pos;
        while let Some(b'0'..=b'9') = self.peek() {
            self.pos += 1;
        }
        if self.pos == int_start {
            return Err(self.err("数字缺少整数部分"));
        }
        // 前导零检查（RFC 8259）
        if self.bytes[int_start] == b'0' && self.pos - int_start > 1 {
            return Err(self.err("数字存在非法前导零"));
        }
        if self.peek() == Some(b'.') {
            is_float = true;
            self.pos += 1;
            let frac_start = self.pos;
            while let Some(b'0'..=b'9') = self.peek() {
                self.pos += 1;
            }
            if self.pos == frac_start {
                return Err(self.err("小数点后缺少数字"));
            }
        }
        if let Some(b'e') | Some(b'E') = self.peek() {
            is_float = true;
            self.pos += 1;
            if let Some(b'+') | Some(b'-') = self.peek() {
                self.pos += 1;
            }
            let exp_start = self.pos;
            while let Some(b'0'..=b'9') = self.peek() {
                self.pos += 1;
            }
            if self.pos == exp_start {
                return Err(self.err("指数部分缺少数字"));
            }
        }
        let text = std::str::from_utf8(&self.bytes[start..self.pos]).unwrap_or("");
        if !is_float {
            if let Ok(i) = text.parse::<i64>() {
                return Ok(Json::Int(i));
            }
        }
        match text.parse::<f64>() {
            Ok(f) if f.is_finite() => Ok(Json::Float(f)),
            _ => Err(self.err("非法数字（超出可表示范围）")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_roundtrip() {
        let text = r#"{"a":1,"b":[true,null,"x\u00e9\ud83d\ude00"],"c":{"d":-2.5e3}}"#;
        let v = parse(text).unwrap();
        assert_eq!(v.get("a").unwrap().as_i64(), Some(1));
        let b = v.get("b").unwrap().as_arr().unwrap();
        assert_eq!(b[0].as_bool(), Some(true));
        assert_eq!(b[1], Json::Null);
        assert_eq!(b[2].as_str().unwrap(), "xé😀");
        assert_eq!(
            v.get("c").unwrap().get("d").unwrap().as_f64(),
            Some(-2500.0)
        );
        // 紧凑-再解析幂等
        let again = parse(&v.to_compact()).unwrap();
        assert_eq!(again, v);
    }

    #[test]
    fn parsing_large_document_stays_linear() {
        // 回归：曾因逐字符 `from_utf8(剩余全文)` 退化为 O(n²)（3MB 文档约 90 秒）。
        let mut doc = String::from("{\"items\":[");
        for i in 0..20_000 {
            if i > 0 {
                doc.push(',');
            }
            doc.push_str("{\"id\":\"");
            doc.push_str(&"x".repeat(20));
            doc.push_str("\",\"n\":");
            doc.push_str(&i.to_string());
            doc.push('}');
        }
        doc.push_str("]}");
        let t = std::time::Instant::now();
        let v = parse(&doc).expect("大文档应可解析");
        let elapsed = t.elapsed();
        assert_eq!(v.get("items").unwrap().as_arr().unwrap().len(), 20_000);
        assert!(
            elapsed.as_secs() < 5,
            "解析 {} 字节耗时 {:?}，疑似退化为非线性",
            doc.len(),
            elapsed
        );
    }

    #[test]
    fn unicode_strings_roundtrip() {
        let doc = "{\"名称\":\"车间-α 🚀\",\"emoji\":\"\\ud83d\\ude80\"}";
        let v = parse(doc).unwrap();
        assert_eq!(v.get("名称").unwrap().as_str(), Some("车间-α 🚀"));
        assert_eq!(v.get("emoji").unwrap().as_str(), Some("🚀"));
    }

    #[test]
    fn rejects_invalid_documents() {
        assert!(parse("{\"a\":1,}").is_err());
        assert!(parse("{\"a\":1,\"a\":2}").is_err()); // 重复键
        assert!(parse("[01]").is_err()); // 前导零
        assert!(parse("1 2").is_err()); // 尾随内容
        assert!(parse("\"abc").is_err()); // 未闭合
        assert!(parse("").is_err());
    }

    #[test]
    fn canonical_sorts_keys_and_normalizes_numbers() {
        let v = parse(r#"{"b":1.0,"a":{"z":"中","y":[1]}}"#).unwrap();
        assert_eq!(v.canonical(), r#"{"a":{"y":[1],"z":"中"},"b":1}"#);
        // 紧凑/漂亮输出保留插入顺序与浮点类型
        assert_eq!(v.to_compact(), r#"{"b":1.0,"a":{"z":"中","y":[1]}}"#);
        assert_eq!(parse(&v.to_compact()).unwrap(), v, "紧凑输出必须可原样回读");
        assert!(v.to_pretty().contains("\n  \"b\": 1.0,"));
    }

    #[test]
    fn escapes_are_symmetric() {
        let s = "行\n\t\"引号\"\\";
        let mut out = String::new();
        write_escaped(&mut out, s);
        let parsed = parse(&out).unwrap();
        assert_eq!(parsed.as_str().unwrap(), s);
    }
}
