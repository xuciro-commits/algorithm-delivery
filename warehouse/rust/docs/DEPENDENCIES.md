# 依赖与许可（最小 SBOM）

## 直接依赖

| 依赖 | 类型 | 说明 |
| --- | --- | --- |
| `aps-engine` | 仓库内路径依赖（`../../aps/rust`） | 只复用**契约无关基础件**：自研 JSON（`json.rs`）、SHA-256（`hash.rs`）、单调时钟（`clock.rs`）、峰值内存统计（`alloc.rs`） |
| 第三方 crate | **无** | `Cargo.lock` 里只有 `warehouse-engine`（package 名）与 `aps-engine` 两个包 |

```bash
cargo tree                              # 期望只有 2 个包，无 registry 依赖
test "$(grep -c '^\[\[package\]\]' Cargo.lock)" = "2"
```

## std 之外的运行时依赖

| 项 | 说明 |
| --- | --- |
| `env.aps_now_ms()` | wasm32 唯一宿主导入（时钟）；native 不需要 |
| 浏览器 API | Web Worker + WebAssembly（`web/warehouse-worker.js`），无 npm 依赖 |

## 为什么零依赖

1. **可审计**：SBOM 只有内部包，供应链面为零；
2. **wasm 体积**：产物只有一份自研 JSON + 求解器，避免 serde/chrono 等把体积抬到 MB 级；
3. **确定性**：JSON 序列化用自研实现（插入序稳定、`canonical()` 键排序），指纹可复现。

## 许可

本目录代码遵循仓库根 `LICENSE`（Apache-2.0）。`aps-engine` 同仓库同许可。
