//! SRS §7 的 S01–S08 全套验收（引擎侧判据）。
//!
//! 该套件会真实跑多档规模与多轮求解，耗时约 1 分钟，因此默认标记 `#[ignore]`：
//!
//! ```text
//! cargo test --release --test acceptance_suite -- --ignored --nocapture
//! # 或直接使用 CLI：cd aps && aps accept
//! ```

use std::path::Path;

#[test]
#[ignore = "完整 S01–S08 验收约 1 分钟；用 cargo test -- --ignored 触发"]
fn s01_to_s08_all_pass() {
    let start = Path::new(env!("CARGO_MANIFEST_DIR"));
    let dir = aps_engine::acceptance::locate_aps_dir(start).expect("定位 aps 交付目录");
    let report = aps_engine::acceptance::run(&dir);
    for case in report.cases.iter() {
        println!(
            "[{}] {} — {}",
            case.id,
            case.name,
            if case.passed { "通过" } else { "失败" }
        );
        for d in case.details.iter() {
            println!("    {}", d);
        }
    }
    assert_eq!(
        report.failed(),
        0,
        "S01–S08 存在失败用例：{:?}",
        report
            .cases
            .iter()
            .filter(|c| !c.passed)
            .map(|c| c.id)
            .collect::<Vec<_>>()
    );
    assert!(report.all_passed());
}
