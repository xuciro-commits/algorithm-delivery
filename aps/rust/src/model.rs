//! `PlanProblem v1` 的**原始领域模型**与严格反序列化。
//!
//! 本模块只负责“结构 + 类型 + 取值域”的契约校验（对应 JSON Schema 2020-12 的约束，
//! 含 `additionalProperties: false`、`const`、`minItems`、`uniqueItems`、`enum`），
//! 并把所有时间字段同时解析为**绝对分钟**（见 `datetime`）。
//! 引用完整性、语义冲突、周期检测等在 `validate` 中完成。

use crate::datetime::parse_iso8601;
use crate::errors::{Issue, SCHEMA_VERSION_PROBLEM};
use crate::json::Json;

pub const PROBLEM_ROOT_FIELDS: &[&str] = &[
    "meta",
    "machines",
    "workers",
    "tools",
    "materials",
    "orders",
    "objective",
];

#[derive(Debug, Clone, PartialEq)]
pub struct RawMeta {
    pub schema_version: String,
    pub tenant_id: String,
    pub site_id: String,
    pub snapshot_id: String,
    pub timezone: String,
    pub horizon_start: String,
    pub horizon_end: String,
    pub horizon_start_min: i64,
    pub horizon_end_min: i64,
    /// 书写偏移（用于输出格式化；全流程按绝对分钟运算）
    pub offset_min: i32,
    pub resolution_min: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawInterval {
    pub start: String,
    pub end: String,
    pub start_min: i64,
    pub end_min: i64,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawMachine {
    pub id: String,
    pub capabilities: Vec<String>,
    pub available: Vec<RawInterval>,
    pub blocked: Vec<RawInterval>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawWorker {
    pub id: String,
    pub skills: Vec<String>,
    pub qualifications: Vec<String>,
    pub available: Vec<RawInterval>,
    pub blocked: Vec<RawInterval>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawTool {
    pub id: String,
    pub capacity: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawReceipt {
    pub at: String,
    pub at_min: i64,
    pub quantity: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawMaterial {
    pub id: String,
    pub initial_quantity: i64,
    pub receipts: Vec<RawReceipt>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawAlternative {
    pub machine_id: String,
    pub duration_min: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawOperation {
    pub id: String,
    pub predecessors: Vec<String>,
    pub skill: String,
    pub qualifications: Vec<String>,
    pub worker_count: i64,
    pub alternatives: Vec<RawAlternative>,
    pub tools: Vec<String>,
    /// 保持文件中的插入顺序，便于追溯与稳定输出。
    pub materials: Vec<(String, i64)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawOrder {
    pub id: String,
    pub quantity: i64,
    pub priority: i64,
    pub release_at: String,
    pub release_min: i64,
    pub due_at: String,
    pub due_min: i64,
    pub operations: Vec<RawOperation>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawObjective {
    pub strategy: String,
    pub phases: Vec<String>,
    pub time_limit_ms: i64,
    pub seed: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawProblem {
    pub meta: RawMeta,
    pub machines: Vec<RawMachine>,
    pub workers: Vec<RawWorker>,
    pub tools: Vec<RawTool>,
    pub materials: Vec<RawMaterial>,
    pub orders: Vec<RawOrder>,
    pub objective: RawObjective,
    /// 原始 JSON（用于 `problem_hash` 的规范化摘要）
    pub source: Json,
}

impl RawMeta {
    /// 把原始 ISO 时间换算为自规划起点起的分钟（绝对时间差）。
    pub fn to_relative_min(&self, epoch_min: i64) -> i64 {
        epoch_min - self.horizon_start_min
    }
    pub fn to_iso(&self, epoch_min: i64) -> String {
        crate::datetime::format_iso8601(epoch_min, self.offset_min)
    }
    pub fn horizon_len_min(&self) -> i64 {
        self.horizon_end_min - self.horizon_start_min
    }
}

/// 收集式解析上下文：一次报告尽可能多的字段问题。
pub struct Ctx {
    pub issues: Vec<Issue>,
}

impl Default for Ctx {
    fn default() -> Self {
        Ctx::new()
    }
}

impl Ctx {
    pub fn new() -> Self {
        Ctx { issues: Vec::new() }
    }

    pub fn error(&mut self, code: &str, path: impl Into<String>, msg: impl Into<String>) {
        self.issues.push(Issue::error(code, path, msg));
    }

    pub fn warn(&mut self, code: &str, path: impl Into<String>, msg: impl Into<String>) {
        self.issues.push(Issue::warning(code, path, msg));
    }

    pub fn has_errors(&self) -> bool {
        self.issues
            .iter()
            .any(|i| i.severity == crate::errors::Severity::Error)
    }

    fn type_err(&mut self, path: &str, expected: &str, actual: &Json) {
        self.error(
            "TYPE_MISMATCH",
            path,
            format!("期望 {}，实际为 {}", expected, actual.type_name()),
        );
    }

    /// 严格字段白名单（`additionalProperties: false`）。
    pub fn check_keys(&mut self, obj: &Json, path: &str, allowed: &[&str]) {
        if let Some(fields) = obj.as_obj() {
            for (k, _) in fields {
                if !allowed.contains(&k.as_str()) {
                    self.error(
                        "UNKNOWN_FIELD",
                        format!("{}.{}", path, k),
                        format!("契约不允许字段 '{}'（additionalProperties: false）", k),
                    );
                }
            }
        }
    }

    pub fn expect_obj<'a>(&mut self, value: &'a Json, path: &str) -> Option<&'a Json> {
        if value.as_obj().is_none() {
            self.type_err(path, "object", value);
            return None;
        }
        Some(value)
    }

    /// 取对象字段（缺失即报 MISSING_FIELD）。
    pub fn field<'a>(&mut self, obj: &'a Json, key: &str, base: &str) -> Option<&'a Json> {
        match obj.get(key) {
            Some(v) => Some(v),
            None => {
                self.error(
                    "MISSING_FIELD",
                    format!("{}.{}", base, key),
                    format!("缺少必需字段 '{}'", key),
                );
                None
            }
        }
    }

    pub fn req_obj<'a>(&mut self, obj: &'a Json, key: &str, base: &str) -> Option<&'a Json> {
        let v = self.field(obj, key, base)?;
        if v.as_obj().is_none() {
            self.type_err(&format!("{}.{}", base, key), "object", v);
            return None;
        }
        Some(v)
    }

    pub fn req_str(&mut self, obj: &Json, key: &str, base: &str) -> Option<String> {
        let v = self.field(obj, key, base)?;
        match v.as_str() {
            Some(s) if !s.is_empty() => Some(s.to_string()),
            Some(_) => {
                self.error(
                    "RANGE_VIOLATION",
                    format!("{}.{}", base, key),
                    "字符串不得为空（minLength: 1）",
                );
                None
            }
            None => {
                self.type_err(&format!("{}.{}", base, key), "string", v);
                None
            }
        }
    }

    pub fn opt_str(&mut self, obj: &Json, key: &str, base: &str) -> Option<String> {
        match obj.get(key) {
            None | Some(Json::Null) => None,
            Some(v) => match v.as_str() {
                Some(s) => Some(s.to_string()),
                None => {
                    self.type_err(&format!("{}.{}", base, key), "string", v);
                    None
                }
            },
        }
    }

    pub fn req_i64(
        &mut self,
        obj: &Json,
        key: &str,
        base: &str,
        min: i64,
        max: i64,
    ) -> Option<i64> {
        let v = self.field(obj, key, base)?;
        match v.as_i64() {
            Some(i) => {
                if i < min || i > max {
                    self.error(
                        "RANGE_VIOLATION",
                        format!("{}.{}", base, key),
                        format!("取值 {} 超出允许范围 [{}, {}]", i, min, max),
                    );
                    return None;
                }
                Some(i)
            }
            None => {
                self.type_err(&format!("{}.{}", base, key), "integer", v);
                None
            }
        }
    }

    pub fn opt_i64(&mut self, obj: &Json, key: &str, base: &str, min: i64, max: i64) -> Option<i64> {
        match obj.get(key) {
            None | Some(Json::Null) => None,
            Some(v) => match v.as_i64() {
                Some(i) if i >= min && i <= max => Some(i),
                Some(i) => {
                    self.error(
                        "RANGE_VIOLATION",
                        format!("{}.{}", base, key),
                        format!("取值 {} 超出允许范围 [{}, {}]", i, min, max),
                    );
                    None
                }
                None => {
                    self.type_err(&format!("{}.{}", base, key), "integer", v);
                    None
                }
            },
        }
    }

    pub fn req_arr<'a>(
        &mut self,
        obj: &'a Json,
        key: &str,
        base: &str,
        min_items: usize,
    ) -> Option<&'a [Json]> {
        let v = self.field(obj, key, base)?;
        match v.as_arr() {
            Some(items) => {
                if items.len() < min_items {
                    self.error(
                        "EMPTY_ARRAY",
                        format!("{}.{}", base, key),
                        format!("数组元素个数 {} 少于 minItems {}", items.len(), min_items),
                    );
                    return None;
                }
                Some(items)
            }
            None => {
                self.type_err(&format!("{}.{}", base, key), "array", v);
                None
            }
        }
    }

    /// 字符串数组；`unique_items` 时检查重复。
    pub fn str_list(
        &mut self,
        obj: &Json,
        key: &str,
        base: &str,
        min_items: usize,
        unique_items: bool,
    ) -> Option<Vec<String>> {
        let items = self.req_arr(obj, key, base, min_items)?;
        let path = format!("{}.{}", base, key);
        let mut out: Vec<String> = Vec::with_capacity(items.len());
        for (i, item) in items.iter().enumerate() {
            match item.as_str() {
                Some(s) if !s.is_empty() => {
                    if unique_items && out.iter().any(|x| x == s) {
                        self.error(
                            "DUPLICATE_ITEM",
                            format!("{}[{}]", path, i),
                            format!("数组元素 '{}' 重复（uniqueItems: true）", s),
                        );
                    } else {
                        out.push(s.to_string());
                    }
                }
                Some(_) => self.error(
                    "RANGE_VIOLATION",
                    format!("{}[{}]", path, i),
                    "数组元素不得为空字符串",
                ),
                None => {
                    self.error(
                        "TYPE_MISMATCH",
                        format!("{}[{}]", path, i),
                        format!("期望 string，实际为 {}", item.type_name()),
                    );
                }
            }
        }
        Some(out)
    }

    /// 解析 `date-time` 字段，返回 (原文, 绝对分钟, 偏移分钟)。
    pub fn req_time(
        &mut self,
        obj: &Json,
        key: &str,
        base: &str,
    ) -> Option<(String, i64, i32)> {
        let text = self.req_str(obj, key, base)?;
        let path = format!("{}.{}", base, key);
        match parse_iso8601(&text) {
            Ok(dt) => Some((text, dt.epoch_min, dt.offset_min)),
            Err(e) => {
                self.error("TIME_FORMAT", path, e.message);
                None
            }
        }
    }

    /// 解析 `{start, end, reason?}` 区间数组（available / blocked）。
    pub fn interval_list(&mut self, obj: &Json, key: &str, base: &str) -> Option<Vec<RawInterval>> {
        let items = self.req_arr(obj, key, base, 0)?;
        let path = format!("{}.{}", base, key);
        let mut out = Vec::with_capacity(items.len());
        for (i, item) in items.iter().enumerate() {
            let ipath = format!("{}[{}]", path, i);
            if self.expect_obj(item, &ipath).is_none() {
                continue;
            }
            self.check_keys(item, &ipath, &["start", "end", "reason"]);
            let (start, start_min, _) = match self.req_time(item, "start", &ipath) {
                Some(v) => v,
                None => continue,
            };
            let (end, end_min, _) = match self.req_time(item, "end", &ipath) {
                Some(v) => v,
                None => continue,
            };
            if end_min <= start_min {
                self.error(
                    "RANGE_VIOLATION",
                    ipath.clone(),
                    format!(
                        "区间终点必须晚于起点（{} 至 {}）",
                        start, end
                    ),
                );
                continue;
            }
            let reason = self.opt_str(item, "reason", &ipath);
            out.push(RawInterval {
                start,
                end,
                start_min,
                end_min,
                reason,
            });
        }
        Some(out)
    }
}

/// 解析 PlanProblem v1。返回 `(Some(problem), issues)`：issues 中可能同时包含 warning。
pub fn parse_problem(json: &Json) -> (Option<RawProblem>, Vec<Issue>) {
    let mut c = Ctx::new();
    let problem = parse_problem_inner(&mut c, json);
    (problem, c.issues)
}

fn parse_problem_inner(c: &mut Ctx, json: &Json) -> Option<RawProblem> {
    if c.expect_obj(json, "$").is_none() {
        return None;
    }
    c.check_keys(json, "$", PROBLEM_ROOT_FIELDS);

    // 每个顶层集合独立解析并累计错误：一次运行报告尽可能多的字段问题。
    let meta = parse_meta(c, json);
    let machines = parse_machines(c, json);
    let workers = parse_workers(c, json);
    let tools = parse_tools(c, json);
    let materials = parse_materials(c, json);
    let orders = parse_orders(c, json);
    let objective = parse_objective(c, json);

    if c.has_errors() {
        return None;
    }
    Some(RawProblem {
        meta: meta?,
        machines: machines?,
        workers: workers?,
        tools: tools?,
        materials: materials?,
        orders: orders?,
        objective: objective?,
        source: json.clone(),
    })
}

fn parse_meta(c: &mut Ctx, root: &Json) -> Option<RawMeta> {
    let meta = c.req_obj(root, "meta", "$")?;
    c.check_keys(
        meta,
        "$.meta",
        &[
            "schema_version",
            "tenant_id",
            "site_id",
            "snapshot_id",
            "timezone",
            "horizon_start",
            "horizon_end",
            "resolution_min",
        ],
    );
    let schema_version = c.req_str(meta, "schema_version", "$.meta")?;
    if schema_version != SCHEMA_VERSION_PROBLEM {
        c.error(
            "CONST_MISMATCH",
            "$.meta.schema_version",
            format!(
                "schema_version 必须为 '{}'，实际为 '{}'",
                SCHEMA_VERSION_PROBLEM, schema_version
            ),
        );
    }
    let tenant_id = c.req_str(meta, "tenant_id", "$.meta")?;
    let site_id = c.req_str(meta, "site_id", "$.meta")?;
    let snapshot_id = c.req_str(meta, "snapshot_id", "$.meta")?;
    let timezone = c.req_str(meta, "timezone", "$.meta")?;
    // 先解析时间并立即做跨字段检查，再解析其余字段：
    // 保证“时域颠倒”与“分辨率非法”能在同一次运行中一起报出。
    let hs = c.req_time(meta, "horizon_start", "$.meta");
    let he = c.req_time(meta, "horizon_end", "$.meta");
    if let (Some(a), Some(b)) = (&hs, &he) {
        if b.1 <= a.1 {
            c.error(
                "RANGE_VIOLATION",
                "$.meta.horizon_end",
                "horizon_end 必须晚于 horizon_start",
            );
        }
    }
    let resolution_min = c.req_i64(meta, "resolution_min", "$.meta", 1, i64::MAX);
    let (horizon_start, horizon_start_min, offset_min) = hs?;
    let (horizon_end, horizon_end_min, _) = he?;
    let resolution_min = resolution_min?;
    Some(RawMeta {
        schema_version,
        tenant_id,
        site_id,
        snapshot_id,
        timezone,
        horizon_start,
        horizon_end,
        horizon_start_min,
        horizon_end_min,
        offset_min,
        resolution_min,
    })
}

fn parse_machines(c: &mut Ctx, root: &Json) -> Option<Vec<RawMachine>> {
    let items = c.req_arr(root, "machines", "$", 1)?;
    let mut out = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let path = format!("$.machines[{}]", i);
        if let Some(v) = parse_machine(c, item, &path) {
            out.push(v);
        }
    }
    Some(out)
}

fn parse_machine(c: &mut Ctx, item: &Json, path: &str) -> Option<RawMachine> {
    c.expect_obj(item, path)?;
    c.check_keys(item, path, &["id", "capabilities", "available", "blocked"]);
    let id = c.req_str(item, "id", path)?;
    let capabilities = c.str_list(item, "capabilities", path, 1, false)?;
    let available = c.interval_list(item, "available", path)?;
    let blocked = c.interval_list(item, "blocked", path)?;
    Some(RawMachine {
        id,
        capabilities,
        available,
        blocked,
    })
}

fn parse_workers(c: &mut Ctx, root: &Json) -> Option<Vec<RawWorker>> {
    let items = c.req_arr(root, "workers", "$", 1)?;
    let mut out = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let path = format!("$.workers[{}]", i);
        if let Some(v) = parse_worker(c, item, &path) {
            out.push(v);
        }
    }
    Some(out)
}

fn parse_worker(c: &mut Ctx, item: &Json, path: &str) -> Option<RawWorker> {
    c.expect_obj(item, path)?;
    c.check_keys(
        item,
        path,
        &["id", "skills", "qualifications", "available", "blocked"],
    );
    let id = c.req_str(item, "id", path)?;
    let skills = c.str_list(item, "skills", path, 0, false)?;
    let qualifications = c.str_list(item, "qualifications", path, 0, false)?;
    let available = c.interval_list(item, "available", path)?;
    let blocked = c.interval_list(item, "blocked", path)?;
    Some(RawWorker {
        id,
        skills,
        qualifications,
        available,
        blocked,
    })
}

fn parse_tools(c: &mut Ctx, root: &Json) -> Option<Vec<RawTool>> {
    let items = c.req_arr(root, "tools", "$", 0)?;
    let mut out = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let path = format!("$.tools[{}]", i);
        if let Some(v) = parse_tool(c, item, &path) {
            out.push(v);
        }
    }
    Some(out)
}

fn parse_tool(c: &mut Ctx, item: &Json, path: &str) -> Option<RawTool> {
    c.expect_obj(item, path)?;
    c.check_keys(item, path, &["id", "capacity"]);
    let id = c.req_str(item, "id", path)?;
    let capacity = c.req_i64(item, "capacity", path, 1, i64::MAX)?;
    if capacity != 1 {
        c.error(
            "CONST_MISMATCH",
            format!("{}.capacity", path),
            "capacity 必须为 1（独占共享工装）",
        );
    }
    Some(RawTool { id, capacity })
}

fn parse_materials(c: &mut Ctx, root: &Json) -> Option<Vec<RawMaterial>> {
    let items = c.req_arr(root, "materials", "$", 0)?;
    let mut out = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let path = format!("$.materials[{}]", i);
        if let Some(v) = parse_material(c, item, &path) {
            out.push(v);
        }
    }
    Some(out)
}

fn parse_material(c: &mut Ctx, item: &Json, path: &str) -> Option<RawMaterial> {
    c.expect_obj(item, path)?;
    c.check_keys(item, path, &["id", "initial_quantity", "receipts"]);
    let id = c.req_str(item, "id", path)?;
    let initial_quantity = c.req_i64(item, "initial_quantity", path, 0, i64::MAX)?;
    let receipt_items = c.req_arr(item, "receipts", path, 0)?;
    let mut receipts = Vec::with_capacity(receipt_items.len());
    for (j, r) in receipt_items.iter().enumerate() {
        let rpath = format!("{}.receipts[{}]", path, j);
        if let Some(rec) = parse_receipt(c, r, &rpath) {
            receipts.push(rec);
        }
    }
    Some(RawMaterial {
        id,
        initial_quantity,
        receipts,
    })
}

fn parse_receipt(c: &mut Ctx, item: &Json, path: &str) -> Option<RawReceipt> {
    c.expect_obj(item, path)?;
    c.check_keys(item, path, &["at", "quantity"]);
    let (at, at_min, _) = c.req_time(item, "at", path)?;
    let quantity = c.req_i64(item, "quantity", path, 1, i64::MAX)?;
    Some(RawReceipt {
        at,
        at_min,
        quantity,
    })
}

fn parse_orders(c: &mut Ctx, root: &Json) -> Option<Vec<RawOrder>> {
    let items = c.req_arr(root, "orders", "$", 1)?;
    let mut out = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let path = format!("$.orders[{}]", i);
        if let Some(v) = parse_order(c, item, &path) {
            out.push(v);
        }
    }
    Some(out)
}

fn parse_order(c: &mut Ctx, item: &Json, path: &str) -> Option<RawOrder> {
    if c.expect_obj(item, path).is_none() {
        return None;
    }
    c.check_keys(
        item,
        path,
        &["id", "quantity", "priority", "release_at", "due_at", "operations"],
    );
    // 逐个字段解析并累计错误（不提前返回），一次报告订单内尽可能多的问题。
    let id = c.req_str(item, "id", path);
    let quantity = c.req_i64(item, "quantity", path, 1, i64::MAX);
    let priority = c.req_i64(item, "priority", path, 1, i64::MAX);
    let release = c.req_time(item, "release_at", path);
    let due = c.req_time(item, "due_at", path);
    if let (Some(r), Some(d)) = (&release, &due) {
        if d.1 < r.1 {
            c.error(
                "RANGE_VIOLATION",
                format!("{}.due_at", path),
                "due_at 不得早于 release_at",
            );
        }
    }
    let mut operations = Vec::new();
    let mut ops_ok = true;
    match c.req_arr(item, "operations", path, 1) {
        Some(op_items) => {
            for (j, op) in op_items.iter().enumerate() {
                let opath = format!("{}.operations[{}]", path, j);
                match parse_operation(c, op, &opath) {
                    Some(v) => operations.push(v),
                    None => ops_ok = false,
                }
            }
        }
        None => ops_ok = false,
    }
    match (id, quantity, priority, release, due) {
        (Some(id), Some(quantity), Some(priority), Some((release_at, release_min, _)), Some((due_at, due_min, _)))
            if ops_ok =>
        {
            Some(RawOrder {
                id,
                quantity,
                priority,
                release_at,
                due_at,
                release_min,
                due_min,
                operations,
            })
        }
        _ => None,
    }
}

fn parse_operation(c: &mut Ctx, op: &Json, opath: &str) -> Option<RawOperation> {
    if c.expect_obj(op, opath).is_none() {
        return None;
    }
    c.check_keys(
        op,
        opath,
        &[
            "id",
            "predecessors",
            "skill",
            "qualifications",
            "worker_count",
            "alternatives",
            "tools",
            "materials",
        ],
    );
    let op_id = c.req_str(op, "id", opath);
    let predecessors = c.str_list(op, "predecessors", opath, 0, true);
    if let (Some(id), Some(preds)) = (&op_id, &predecessors) {
        if preds.iter().any(|p| p == id) {
            c.error(
                "RANGE_VIOLATION",
                format!("{}.predecessors", opath),
                "工序不能把自己作为前置工序",
            );
        }
    }
    let skill = c.req_str(op, "skill", opath);
    let qualifications = c.str_list(op, "qualifications", opath, 0, true);
    let worker_count = c.req_i64(op, "worker_count", opath, 1, i64::MAX);
    if let Some(wc) = worker_count {
        if wc != 1 {
            c.error(
                "CONST_MISMATCH",
                format!("{}.worker_count", opath),
                "P0 的 worker_count 必须为 1（多工序协同资源属于 P1）",
            );
        }
    }
    let mut alternatives: Vec<RawAlternative> = Vec::new();
    let mut alts_ok = true;
    match c.req_arr(op, "alternatives", opath, 1) {
        Some(alt_items) => {
            for (k, alt) in alt_items.iter().enumerate() {
                let apath = format!("{}.alternatives[{}]", opath, k);
                match parse_alternative(c, alt, &apath) {
                    Some(v) => {
                        if alternatives.iter().any(|a| a.machine_id == v.machine_id) {
                            c.error(
                                "DUPLICATE_ITEM",
                                apath,
                                format!("同一工序出现重复的备选机器 '{}'", v.machine_id),
                            );
                        } else {
                            alternatives.push(v);
                        }
                    }
                    None => alts_ok = false,
                }
            }
            if alternatives.is_empty() {
                c.error(
                    "EMPTY_ARRAY",
                    format!("{}.alternatives", opath),
                    "工序至少需要一个备选机器（minItems: 1）",
                );
                alts_ok = false;
            }
        }
        None => alts_ok = false,
    }
    let tools = c.str_list(op, "tools", opath, 0, true);
    let mut materials: Vec<(String, i64)> = Vec::new();
    let mut mats_ok = true;
    match c.req_obj(op, "materials", opath) {
        Some(mat_obj) => {
            for (mat_id, qty) in mat_obj.as_obj().unwrap_or(&[]) {
                let mpath = format!("{}.materials.{}", opath, mat_id);
                match qty.as_i64() {
                    Some(q) if q >= 1 => materials.push((mat_id.clone(), q)),
                    Some(q) => {
                        c.error("RANGE_VIOLATION", mpath, format!("用量必须 ≥ 1，实际为 {}", q));
                        mats_ok = false;
                    }
                    None => {
                        c.error(
                            "TYPE_MISMATCH",
                            mpath,
                            format!("期望 integer（≥1），实际为 {}", qty.type_name()),
                        );
                        mats_ok = false;
                    }
                }
            }
        }
        None => mats_ok = false,
    }
    match (op_id, predecessors, skill, qualifications, worker_count, tools) {
        (
            Some(op_id),
            Some(predecessors),
            Some(skill),
            Some(qualifications),
            Some(worker_count),
            Some(tools),
        ) if alts_ok && mats_ok => Some(RawOperation {
            id: op_id,
            predecessors,
            skill,
            qualifications,
            worker_count,
            alternatives,
            tools,
            materials,
        }),
        _ => None,
    }
}

fn parse_alternative(c: &mut Ctx, alt: &Json, apath: &str) -> Option<RawAlternative> {
    if c.expect_obj(alt, apath).is_none() {
        return None;
    }
    c.check_keys(alt, apath, &["machine_id", "duration_min"]);
    let machine_id = c.req_str(alt, "machine_id", apath);
    let duration_min = c.req_i64(alt, "duration_min", apath, 1, i64::MAX);
    match (machine_id, duration_min) {
        (Some(machine_id), Some(duration_min)) => Some(RawAlternative {
            machine_id,
            duration_min,
        }),
        _ => None,
    }
}

fn parse_objective(c: &mut Ctx, root: &Json) -> Option<RawObjective> {
    let obj = c.req_obj(root, "objective", "$")?;
    c.check_keys(
        obj,
        "$.objective",
        &["strategy", "phases", "time_limit_ms", "seed"],
    );
    let strategy = c.req_str(obj, "strategy", "$.objective")?;
    if strategy != "lexicographic" && strategy != "makespan" {
        c.error(
            "INVALID_ENUM",
            "$.objective.strategy",
            format!(
                "strategy 只能为 'lexicographic' 或 'makespan'，实际为 '{}'",
                strategy
            ),
        );
    }
    let phase_items = c.req_arr(obj, "phases", "$.objective", 0)?;
    let mut phases = Vec::with_capacity(phase_items.len());
    for (i, p) in phase_items.iter().enumerate() {
        match p.as_str() {
            Some(s @ "weighted_tardiness") | Some(s @ "makespan") => phases.push(s.to_string()),
            Some(other) => c.error(
                "INVALID_ENUM",
                format!("$.objective.phases[{}]", i),
                format!("未知阶段 '{}'（仅支持 weighted_tardiness / makespan）", other),
            ),
            None => c.error(
                "TYPE_MISMATCH",
                format!("$.objective.phases[{}]", i),
                format!("期望 string，实际为 {}", p.type_name()),
            ),
        }
    }
    let time_limit_ms = c.req_i64(obj, "time_limit_ms", "$.objective", 1, i64::MAX)?;
    let seed = c.req_i64(obj, "seed", "$.objective", 0, i64::MAX)?;
    Some(RawObjective {
        strategy,
        phases,
        time_limit_ms,
        seed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(rel: &str) -> Json {
        let path = format!("{}/../{}", env!("CARGO_MANIFEST_DIR"), rel);
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读取 {} 失败: {}", path, e));
        crate::json::parse(&text).expect("JSON 解析失败")
    }

    #[test]
    fn parses_baseline_fixture() {
        let json = load("mock/baseline.json");
        let (problem, issues) = parse_problem(&json);
        assert!(
            issues.iter().all(|i| i.severity != crate::errors::Severity::Error),
            "基线样本应无结构错误: {:?}",
            issues
        );
        let p = problem.expect("应解析成功");
        assert_eq!(p.meta.tenant_id, "mock-tenant-alpha");
        assert_eq!(p.meta.resolution_min, 15);
        assert_eq!(p.machines.len(), 5);
        assert_eq!(p.workers.len(), 8);
        assert_eq!(p.tools.len(), 1);
        assert_eq!(p.materials.len(), 3);
        assert_eq!(p.orders.len(), 8);
        assert_eq!(
            p.orders.iter().map(|o| o.operations.len()).sum::<usize>(),
            24
        );
        // 时间换算：规划起点 = 0 分钟
        assert_eq!(p.meta.to_relative_min(p.meta.horizon_start_min), 0);
        assert_eq!(p.meta.horizon_len_min(), 4 * 1440 + 9 * 60); // 10-05 08:00 → 10-09 17:00
        // 物料到货与消耗
        let paint = p.materials.iter().find(|m| m.id == "M-PAINT").unwrap();
        assert_eq!(paint.initial_quantity, 8);
        assert_eq!(paint.receipts[0].quantity, 10);
        assert_eq!(
            p.meta.to_relative_min(paint.receipts[0].at_min),
            1440 // 10-06T08:00 相对 10-05T08:00
        );
    }

    #[test]
    fn reports_multiple_field_errors() {
        let text = r#"{
          "meta": {"schema_version":"plan-problem/2.0","tenant_id":"t","site_id":"s","snapshot_id":"snap",
                   "timezone":"UTC","horizon_start":"2026-10-05T08:00:00Z","horizon_end":"2026-10-06T08:00:00Z","resolution_min":15},
          "machines": [{"id":"M1","capabilities":["cut"],"available":[{"start":"2026-10-05T08:00:00Z","end":"2026-10-05T12:00:00Z"}],"blocked":[]}],
          "workers": [{"id":"W1","skills":["cut"],"qualifications":[],"available":[{"start":"2026-10-05T08:00:00Z","end":"2026-10-05T12:00:00Z"}],"blocked":[]}],
          "tools": [],
          "materials": [],
          "orders": [{"id":"O1","quantity":1,"priority":1,"release_at":"2026-10-05T08:00:00Z","due_at":"2026-10-05T10:00:00Z",
            "operations":[{"id":"O1-A","predecessors":[],"skill":"cut","qualifications":[],"worker_count":1,
              "alternatives":[{"machine_id":"M1","duration_min":30}],"tools":[],"materials":{},"bogus":1}]}],
          "objective": {"strategy":"lexicographic","phases":["weighted_tardiness"],"time_limit_ms":1000,"seed":1}
        }"#;
        let json = crate::json::parse(text).unwrap();
        let (problem, issues) = parse_problem(&json);
        assert!(problem.is_none());
        let codes: Vec<&str> = issues.iter().map(|i| i.code.as_str()).collect();
        assert!(codes.contains(&"CONST_MISMATCH"), "{:?}", issues);
        assert!(codes.contains(&"UNKNOWN_FIELD"), "{:?}", issues);
        assert!(issues
            .iter()
            .any(|i| i.path == "$.orders[0].operations[0].bogus"));
    }

    #[test]
    fn rejects_bad_time_and_range() {
        let text = r#"{
          "meta": {"schema_version":"plan-problem/1.0","tenant_id":"t","site_id":"s","snapshot_id":"snap",
                   "timezone":"UTC","horizon_start":"2026-10-05T08:00:00Z","horizon_end":"2026-10-05T07:00:00Z","resolution_min":0},
          "machines": [{"id":"M1","capabilities":["cut"],"available":[],"blocked":[]}],
          "workers": [{"id":"W1","skills":["cut"],"qualifications":[],"available":[],"blocked":[]}],
          "tools": [],
          "materials": [],
          "orders": [{"id":"O1","quantity":0,"priority":1,"release_at":"2026-10-05T08:00:00Z","due_at":"2026-10-05T09:00:00Z",
            "operations":[{"id":"O1-A","predecessors":[],"skill":"cut","qualifications":[],"worker_count":2,
              "alternatives":[{"machine_id":"M1","duration_min":0}],"tools":[],"materials":{}}]}],
          "objective": {"strategy":"lexicographic","phases":["weighted_tardiness"],"time_limit_ms":1000,"seed":0}
        }"#;
        let json = crate::json::parse(text).unwrap();
        let (_problem, issues) = parse_problem(&json);
        let paths: Vec<&str> = issues.iter().map(|i| i.path.as_str()).collect();
        assert!(paths.contains(&"$.meta.horizon_end"));
        assert!(paths.contains(&"$.meta.resolution_min"));
        assert!(paths.contains(&"$.orders[0].quantity"));
        assert!(paths.contains(&"$.orders[0].operations[0].worker_count"));
        assert!(paths.contains(&"$.orders[0].operations[0].alternatives[0].duration_min"));
    }
}
