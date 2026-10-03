# 依赖、许可证与 SBOM（DEPENDENCIES）

> 对应 SRS §9「构建指令、Docker/本地启动方法、许可证清单、SBOM、升级和故障回退方法」中
> **由本 Rust 交付件负责**的部分（React / Go / OR-Tools 的子件由各自团队提供）。

## 1. 结论（一句话）

`aps-engine` crate **没有任何第三方依赖**：`Cargo.toml` 的 `[dependencies]` 为空，
构建产物不含外部 crate；唯一的外部组件是 **Rust 标准库**（随工具链发布，MIT OR Apache-2.0 双许可）。

## 2. 依赖清单（许可证清单）

| 组件 | 版本 | 用途 | 引入方式 | 许可证 | 义务 |
|------|------|------|----------|--------|------|
| Rust 标准库 (`std`, `core`, `alloc`) | 1.88.0（本交付验证版本） | 语言运行时 | 工具链自带 | MIT OR Apache-2.0 | 无（不修改分发） |
| `rustc` / `cargo` | 1.88.0 | 构建工具（**不进入产物**） | 工具链 | MIT OR Apache-2.0 | 无 |
| `rustfmt` / `clippy` | 1.8.0 / 0.1.88 | 开发期格式与静态检查（**不进入产物**） | 工具链组件 | MIT OR Apache-2.0 | 无 |
| `@rustbin/*` 预编译包 | 1.88.0 | **仅受限网络环境**下的工具链获取渠道 | `toolchain/setup_rust.sh` | 同 rust 官方构建 | 仅作为安装渠道，不进入产物 |
| 第三方 crate | — | — | **无** | — | — |
| `wasm-bindgen` / `js-sys` | — | — | **无**（手写 C ABI） | — | — |
| `serde` / `chrono` / `sha2` / `regex` | — | 自带实现替代（`json.rs`/`datetime.rs`/`hash.rs`） | **无** | — | — |

显式说明：本 crate 自行实现了 JSON 解析/序列化、ISO 8601 时间、SHA-256、确定性随机数，
因此不存在“间接依赖传递闭包”（可复核：`cargo tree` 只输出本 crate 一行）。

## 3. 可复核的验证命令

```bash
cd aps/rust

# 1) 依赖为空（应输出 aps-engine 一行，无子节点）
cargo tree

# 2) 锁定文件仅含本 crate 与其自身元数据
grep -c '^\[\[package\]\]' Cargo.lock        # → 1

# 3) 许可证字段
cargo metadata --format-version 1 --no-deps | python3 -c \
  'import json,sys; p=json.load(sys.stdin)["packages"][0]; print(p["name"], p["license"], len(p["dependencies"]))'

# 4) 质量门（CI 同样执行）：格式与静态检查
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
```

CI（`.github/workflows/aps-rust.yml`）会执行 1)–4) 并在日志中打印结果，作为 SBOM 与质量门的最小可审计证据。

> 受限网络环境用 `toolchain/setup_rust.sh` 安装的工具链同样包含 rustfmt/clippy；
> 由于该预编译 rustfmt 未启用 cargo-fmt 协议，脚本会放置一个**极简 `cargo-fmt` 替身**，
> 使 `cargo fmt --all -- --check` 与 CI 行为一致（详见脚本内注释）。

## 4. 最小 SBOM（CycloneDX 风格，本 crate）

```json
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.5",
  "metadata": {
    "component": {
      "type": "application",
      "name": "aps-engine",
      "version": "1.0.0",
      "licenses": [{ "license": { "id": "Apache-2.0" } }],
      "purl": "pkg:cargo/aps-engine@1.0.0"
    }
  },
  "components": [
    {
      "type": "library",
      "name": "rust-std",
      "version": "1.88.0",
      "licenses": [{ "license": { "id": "MIT" } }, { "license": { "id": "Apache-2.0" } }],
      "scope": "required",
      "properties": [{ "name": "delivery", "value": "toolchain (not vendored)" }]
    }
  ]
}
```

> 如需机器可读的全量 SBOM，可在联网环境执行 `cargo install cargo-cyclonedx && cargo cyclonedx`
> （本交付沙箱无法访问 crates.io，故未生成；上面给出等价的最小清单）。

## 5. 构建与运行（本地 / 容器）

```bash
# 本地
cd aps/rust && cargo build --release && cargo test --release
cd .. && rust/target/release/aps accept

# 容器（只需一个 rust 基础镜像；无网络依赖，因为零 crate 依赖）
cat > Dockerfile <<'DOCKER'
FROM rust:1.88-slim AS build
WORKDIR /src
COPY aps/ /src/aps/
RUN cd aps/rust && cargo build --release --locked

FROM debian:12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/aps/rust/target/release/aps /usr/local/bin/aps
COPY aps/ /srv/aps/
WORKDIR /srv/aps
ENTRYPOINT ["/usr/local/bin/aps"]
CMD ["accept"]
DOCKER

# 受限网络镜像（不能访问 static.rust-lang.org 时）：
#   基础镜像内先执行 toolchain/setup_rust.sh，或把 /opt/rust 作为构建层缓入
```

## 6. 升级与故障回退

| 场景 | 操作 | 回退 |
|------|------|------|
| 升级引擎版本 | 用新版本重跑 `aps accept` + `scripts/check_contracts.py`；对比 `docs/BENCHMARKS.md` 指标；灰度切换 | 保留上一版本二进制与 `engine_version`，平台按作业记录回切 |
| 升级 Rust 工具链 | 改动 `toolchain/setup_rust.sh` 的版本号 → 重建 → 全量测试 | 恢复版本号即可（工具链不影响已发布方案） |
| 依赖变化（未来若引入 crate） | 必须走许可证评审（SRS §9：按实际构建依赖逐项核查）并更新本文与 SBOM | —— |
| 引擎异常/自检失败 | 引擎自身会把结果标记 `verified=false` + `UNKNOWN`；平台应拒绝发布 | 保留既有已发布计划；用上一版本引擎重算 |
| 契约升级 | 先升级 `aps/contracts/*.schema.json` 与 `scripts/check_contracts.py`，再改引擎 | schema 与引擎版本一一对应入库，按快照回看 |
