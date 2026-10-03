//! Moving AI MAPF 基准格式适配（SRS §6）：`.map` 地图 + `.scen` 场景 → `MapfProblem`。
//!
//! 格式（https://movingai.com/benchmarks/mapf.html，数据许可 ODC-BY 1.0）：
//! * `.map`：头部 `key value` 行（`name/width/height`），随后每行 `width` 个字符，`.` 可行、`*` 障碍
//!   （`@` 起点标记按可行处理）。行序 = y 从 0 起（与引擎坐标约定一致）。
//! * `.scen`：可选首行 `version 1`；随后每行：
//!   `<agents> <map_file> <width> <height> (sx sy gx gy)×agents <avg_time>`。
//!   Moving AI 官方发布另有“逐行累加一辆车”的切分格式（其页面明确说明用法是
//!   “add one agent at a time”）：当行内只有 1 对起终点时，本转换器取前 k 行组成 k 车实例。
//!   两种读法都会记录在 `benchmark.conversion` 里，保证可审计。

use aps_engine::json::Json;

/// 单个场景行。
#[derive(Debug, Clone)]
pub struct ScenLine {
    pub declared_agents: usize,
    pub pairs: Vec<((u32, u32), (u32, u32))>,
}

#[derive(Debug, Clone)]
pub struct MapFile {
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// '#' = 障碍，'.' = 可行（规范化后仅两字符）。
    pub rows: Vec<Vec<char>>,
}

/// 栅格数据行判据：Moving AI 官方字符集（. 空 @ G 可行；* # T O S 障碍）——
/// 全行均为集合内字符且非空。SGV2 数字行/`name` 行必然含字母数字外字符，不会误判。
fn is_grid_row(t: &str) -> bool {
    !t.is_empty()
        && t.chars()
            .all(|c| matches!(c, '.' | '@' | '+' | 'G' | ' ' | '#' | '*' | 'T' | 'O' | 'S'))
}

pub fn parse_map(text: &str) -> Result<MapFile, String> {
    let mut name = String::new();
    let mut width: Option<u32> = None;
    let mut height: Option<u32> = None;
    let mut rows: Vec<Vec<char>> = Vec::new();
    let mut in_grid = false;
    let mut seen_map = false;
    for (ln, raw) in text.lines().enumerate() {
        let line = raw.trim_end_matches('\r');
        let t = line.trim_end();
        if t.trim().is_empty() {
            continue;
        }
        if in_grid {
            if is_grid_row(t) {
                rows.push(
                    t.chars()
                        .map(|c| {
                            if matches!(c, '.' | '@' | '+' | 'G' | ' ') {
                                '.'
                            } else {
                                '#'
                            }
                        })
                        .collect(),
                );
                continue;
            }
            return Err(format!("第 {} 行不是合法地图数据行：{t}", ln + 1));
        }
        let mut it = t.split_whitespace();
        match it.next().unwrap_or("") {
            "type" => {
                let ty = it.next().unwrap_or("octile");
                if ty != "octile" && ty != "4-neighbor" && ty != "4-adj" {
                    return Err(format!(
                        "地图 type `{ty}` 不受支持（仅支持 4-邻接 octile/4-neighbor 栅格）"
                    ));
                }
            }
            "height" => {
                height = Some(
                    it.next()
                        .and_then(|x| x.parse::<u32>().ok())
                        .ok_or("height 字段非法")?,
                );
            }
            "width" => {
                width = Some(
                    it.next()
                        .and_then(|x| x.parse::<u32>().ok())
                        .ok_or("width 字段非法")?,
                );
            }
            "name" => {
                name = it.next().unwrap_or("").to_string();
            }
            "map" => {
                // 标记行本身不含数据；真正的数据行在下方 other 分支里探测（SGV2 在
                // `map` 与 `name/height/width` 之间还夹着三个数字行）。
                seen_map = true;
            }
            other => {
                // 真正的栅格数据行：全部字符 ∈ {.,*,@,#,+,空格}。
                // 判据：字符全在栅格集内；未见 `map` 标记时还须行宽吻合（防把
                // 巧合的短行当数据），见标记后任意合法字符行即数据行。
                if is_grid_row(t)
                    && (seen_map || width.is_none() || t.chars().count() == width.unwrap() as usize)
                {
                    in_grid = true;
                    rows.push(
                        t.chars()
                            .map(|c| {
                                if c == '.' || c == '@' || c == '+' || c == ' ' {
                                    '.'
                                } else {
                                    '#'
                                }
                            })
                            .collect(),
                    );
                    continue;
                }
                // SGV2 前导数字行（“0”“8”“0”）与 `-w h 0` 尺寸行：兼容跳过
                let nums: Vec<&str> = other.split('-').filter(|x| !x.is_empty()).collect();
                let all_digits = t
                    .split_whitespace()
                    .all(|w| w.parse::<i64>().is_ok() || nums.contains(&w));
                if !all_digits {
                    return Err(format!("无法识别的地图头行：{t}"));
                }
            }
        }
    }
    if rows.is_empty() {
        return Err("地图无数据行（缺少 `map` 段？）".into());
    }
    let w = width.unwrap_or_else(|| rows.iter().map(|r| r.len() as u32).max().unwrap_or(0));
    let h = height.unwrap_or(rows.len() as u32);
    if h as usize != rows.len() {
        return Err(format!("height={h} 与数据行数 {} 不一致", rows.len()));
    }
    for r in &mut rows {
        if r.len() < w as usize {
            r.resize(w as usize, '#');
        } else if r.len() > w as usize {
            return Err(format!("行宽 {} 超过声明宽度 {w}", r.len()));
        }
    }
    if name.is_empty() {
        name = format!("{}-{}x{}", "grid", w, h);
    }
    Ok(MapFile {
        name,
        width: w,
        height: h,
        rows,
    })
}

pub fn parse_scen(text: &str) -> Result<Vec<ScenLine>, String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        let t = line.trim();
        if t.is_empty() || t.starts_with("version") {
            continue;
        }
        let toks: Vec<&str> = t.split_whitespace().collect();
        if toks.len() < 5 {
            return Err(format!("场景行字段不足：{line}"));
        }
        let declared: usize = toks[0]
            .parse()
            .map_err(|_| format!("agents 字段非法：{line}"))?;
        let w: u32 = toks[2]
            .parse()
            .map_err(|_| format!("width 字段非法：{line}"))?;
        let h: u32 = toks[3]
            .parse()
            .map_err(|_| format!("height 字段非法：{line}"))?;
        // 数值对（跳过 map 名与 w/h；忽略行尾 avg 时间）
        let mut nums: Vec<u32> = Vec::new();
        for tok in &toks[4..] {
            match tok.parse::<f64>() {
                Ok(x) if x >= 0.0 => nums.push(x as u32),
                _ => break,
            }
        }
        let pairs = nums.len() / 4;
        if pairs == 0 {
            return Err(format!("场景行没有可用的起终点配对：{line}"));
        }
        let mut parsed = Vec::with_capacity(pairs);
        for p in 0..pairs {
            let (sx, sy, gx, gy) = (
                nums[4 * p],
                nums[4 * p + 1],
                nums[4 * p + 2],
                nums[4 * p + 3],
            );
            if sx >= w || gx >= w || sy >= h || gy >= h {
                return Err(format!(
                    "场景坐标越界（{sx},{sy}→{gx},{gy} vs {w}×{h}）：{line}"
                ));
            }
            parsed.push(((sx, sy), (gx, gy)));
        }
        let _ = declared;
        out.push(ScenLine {
            declared_agents: pairs.max(1),
            pairs: parsed,
        });
    }
    if out.is_empty() {
        return Err("场景文件没有可用行".into());
    }
    Ok(out)
}

pub struct ConvertOptions {
    pub agents: usize,
    pub horizon: Option<u32>,
    pub budget_ms: i64,
    pub objective: &'static str,
    pub w: f64,
    pub seed: u64,
    pub map_sha256: String,
    pub scen_sha256: String,
    pub map_file: String,
    pub scen_file: String,
}

/// 组装 `MapfProblem` JSON（含 benchmark 溯源块）。
pub fn build_problem(
    map: &MapFile,
    scen: &[ScenLine],
    opt: &ConvertOptions,
) -> Result<Json, String> {
    let k = opt.agents;
    let mut lines_used: Vec<usize> = Vec::new();
    let conversion;
    // 标准读法：行内 pairs ≥ k 的行（Moving AI 原始 -even/-random.scen）
    if let Some(pos) = scen.iter().position(|l| l.pairs.len() >= k) {
        lines_used.extend(std::iter::repeat(pos).take(k));
        conversion = format!("standard:line#{pos}");
    } else if k <= scen.len() {
        // 累加读法：前 k 行，每行取第一对（“add one agent at a time”）
        conversion = "additive:first-k-lines".to_string();
    } else {
        return Err(format!(
            "场景只有 {} 个可用起终对，不足 {k} 台机器人",
            scen.iter().map(|l| l.pairs.len()).sum::<usize>()
        ));
    }
    let mut robots: Vec<Json> = Vec::new();
    let mut seen_start: Vec<(u32, u32)> = Vec::new();
    let mut seen_goal: Vec<(u32, u32)> = Vec::new();
    let mut taken_pairs: Vec<((u32, u32), (u32, u32))> = Vec::new();
    if k > scen.len() && scen.iter().all(|l| l.pairs.len() == 1) {
        return Err(format!("场景行数 {} 不足 {k} 台机器人", scen.len()));
    }
    if conversion.starts_with("standard") {
        let pos = lines_used[0];
        taken_pairs.extend(scen[pos].pairs.iter().take(k).cloned());
    } else {
        for l in scen.iter().take(k) {
            taken_pairs.push(l.pairs[0]);
        }
    }
    // 上游 Moving AI 数据里偶见“起点=终点”的退化行（官方 solvers 惯例是直接跳过：
    // 该车无需规划）。跳过并在 benchmark.conversion 记录，不静默、不失败。
    let total_pairs = taken_pairs.len();
    taken_pairs.retain(|((sx, sy), (gx, gy))| !(sx == gx && sy == gy));
    let skipped_degen = total_pairs - taken_pairs.len();
    if taken_pairs.is_empty() {
        return Err("全部起终对均为退化（起点=终点），无可规划机器人".to_string());
    }
    for (i, ((sx, sy), (gx, gy))) in taken_pairs.iter().enumerate() {
        if map.rows[*sy as usize][*sx as usize] == '#'
            || map.rows[*gy as usize][*gx as usize] == '#'
        {
            return Err(format!(
                "场景 {i} 的起/终点落在障碍上（数据损坏或约定不匹配）"
            ));
        }
        if seen_start.contains(&(*sx, *sy)) {
            return Err(format!("场景 {i} 起点与更早场景重复"));
        }
        if seen_goal.contains(&(*gx, *gy)) {
            return Err(format!("场景 {i} 终点与更早场景重复"));
        }
        seen_start.push((*sx, *sy));
        seen_goal.push((*gx, *gy));
        robots.push(Json::obj(vec![
            ("id", Json::str(format!("R{}", i + 1))),
            (
                "start",
                Json::Arr(vec![Json::int(*sx as i64), Json::int(*sy as i64)]),
            ),
            (
                "goal",
                Json::Arr(vec![Json::int(*gx as i64), Json::int(*gy as i64)]),
            ),
        ]));
    }
    let cells: Vec<Json> = map
        .rows
        .iter()
        .map(|r| Json::str(r.iter().collect::<String>()))
        .collect();
    let mut time_model = Json::obj(vec![]);
    match opt.horizon {
        Some(h) => time_model.set("horizon", Json::int(h as i64)),
        None => time_model.set("horizon", Json::str("auto")),
    }
    time_model.set("timestep", Json::str("discrete"));
    let mut bench = Json::obj(vec![
        ("source", Json::str("movingai")),
        ("map_file", Json::str(opt.map_file.clone())),
        ("scen_file", Json::str(opt.scen_file.clone())),
        ("instance_id", Json::int(0)),
        ("agents", Json::int(robots.len() as i64)),
        ("converter_version", Json::str(crate::COMPILER_VERSION)),
        (
            "conversion",
            Json::str(if skipped_degen > 0 {
                format!("{conversion}+skipped-degen{skipped_degen}")
            } else {
                conversion.clone()
            }),
        ),
        (
            "cite",
            Json::str("stern2019mapf (SoCS)；Moving AI Lab；数据许可 ODC-BY 1.0"),
        ),
    ]);
    if !opt.map_sha256.is_empty() {
        bench.set("map_sha256", Json::str(opt.map_sha256.clone()));
    }
    if !opt.scen_sha256.is_empty() {
        bench.set("scen_sha256", Json::str(opt.scen_sha256.clone()));
    }
    Ok(Json::obj(vec![
        (
            "schema_version",
            Json::str(crate::errors::SCHEMA_VERSION_PROBLEM),
        ),
        (
            "id",
            Json::str(format!(
                "movingai:{}:{}:{}",
                map.name,
                opt.scen_file.rsplit('/').next().unwrap_or(&opt.scen_file),
                k
            )),
        ),
        (
            "map",
            Json::obj(vec![
                ("width", Json::int(map.width as i64)),
                ("height", Json::int(map.height as i64)),
                ("cells", Json::Arr(cells)),
                ("coordinates", Json::str("x-right-y-down-origin-topleft")),
            ]),
        ),
        ("time_model", time_model),
        ("robots", Json::Arr(robots)),
        (
            "objective",
            Json::obj(vec![
                ("kind", Json::str(opt.objective)),
                ("direction", Json::str("min")),
            ]),
        ),
        (
            "solver",
            Json::obj(vec![
                ("planner", Json::str("auto")),
                ("time_limit_ms", Json::int(opt.budget_ms)),
                ("seed", Json::int(opt.seed as i64)),
                ("suboptimality_factor", Json::Float(opt.w)),
            ]),
        ),
        ("benchmark", bench),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAP: &str =
        "map\n0\n8\n0\nname empty-4-4.map\nheight 4\nwidth 4\n....\n.##.\n.##.\n....\n";
    const SCEN: &str =
        "version 1\n2\tempty-4-4.map\t4\t4\t0\t0\t3\t3\t2\t3\t3\t0\t5.65685425\t0.0\n";

    #[test]
    fn map_and_scen_roundtrip() {
        let m = parse_map(MAP).unwrap();
        assert_eq!((m.width, m.height), (4, 4));
        assert_eq!(m.rows[1][1], '#');
        let s = parse_scen(SCEN).unwrap();
        assert_eq!(s[0].pairs.len(), 2);
        let j = build_problem(
            &m,
            &s,
            &ConvertOptions {
                agents: 2,
                horizon: Some(20),
                budget_ms: 1000,
                objective: "soc",
                w: 1.0,
                seed: 42,
                map_sha256: format!("sha256:{}", "a".repeat(64)),
                scen_sha256: String::new(),
                map_file: "empty-4-4.map".into(),
                scen_file: "x.scen".into(),
            },
        )
        .unwrap();
        let text = j.to_compact();
        assert!(text.contains("\"robots\""));
        // 引擎能直接消化转换产物
        let p = crate::problem::parse_problem(&text, crate::capabilities::Profile::Native).unwrap();
        assert_eq!(p.robots.len(), 2);
    }

    #[test]
    fn additive_scen_mode() {
        let m = parse_map(MAP).unwrap();
        let s = parse_scen("version 1\n0\tempty-4-4.map\t4\t4\t0\t0\t3\t0\t3\n1\tempty-4-4.map\t4\t4\t3\t3\t0\t3\t3\n").unwrap();
        let j = build_problem(
            &m,
            &s,
            &ConvertOptions {
                agents: 2,
                horizon: Some(20),
                budget_ms: 500,
                objective: "makespan",
                w: 1.0,
                seed: 1,
                map_sha256: String::new(),
                scen_sha256: String::new(),
                map_file: "a.map".into(),
                scen_file: "b.scen".into(),
            },
        )
        .unwrap();
        let robots = j.get("robots").unwrap().as_arr().unwrap();
        assert_eq!(robots.len(), 2);
    }
}
