# Algorithm Delivery · 常用命令入口
#
# 目标：不用翻文档就知道"我现在该跑什么"。
# 所有目标都是对已有脚本的薄封装——真正的逻辑仍在 lab/package.json 与 */rust 里，
# 这里只负责把最常用的几条路径写成一句话。
#
#   make help            # 看这份清单
#   make static          # 静态检查（不需要 Rust、不需要浏览器），迭代时最常用
#   make dev             # 本地开发预览
#   make test            # 全量：构建引擎 → 构建前端 → 全部检查
#   make engine-aps      # 只验一个引擎（native + WASM + 验收）
#   make audit-models    # 生成模型结构审查报告
#   make ci              # 与 CI 质量门等价（能跑多快跑多快，不部署）

SHELL := /bin/bash
LAB := lab
CARGO_TARGETS := wasm32-unknown-unknown

.DEFAULT_GOAL := help
.PHONY: help static static-docs static-art static-perf dev build test test-engines \
        engine-aps engine-mapf engine-agv engine-warehouse sync sync-assets audit-models audit-perf \
        check-docs check-workflows ci clean

help: ## 显示全部命令
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ------------------------------------------------------------------ 迭代（最常用）
static: ## 静态检查：文档 / 美术契约 / 性能红线 / CI 工作流（秒级，无依赖）
	cd $(LAB) && npm run test:static

static-docs: ## 只查文档与脚本一致性
	cd $(LAB) && npm run check:docs

static-art: ## 只查三维美术契约（含 JSX 配平）
	cd $(LAB) && npm run test:art

static-perf: ## 只查性能红线
	cd $(LAB) && npm run audit:perf

check-docs: static-docs ## 别名
check-workflows: ## 只自查 CI 工作流（Node 24 / 超时 / 触发范围）
	node $(LAB)/scripts/check-workflows.mjs

dev: ## 本地开发服务器（LAB_BASE=/ 根路径，避免子路径）
	cd $(LAB) && LAB_BASE=/ npm run dev

# ------------------------------------------------------------------ 构建与全量检查
build: ## 同步引擎产物 + 类型检查 + 打包
	cd $(LAB) && npm run build

test: ## 全量：构建 + 静态检查 + 集成测试（需要 Rust WASM 产物）
	cd $(LAB) && npm run test:all

test-engines: ## 四个 Rust 引擎的质量门（native + WASM + 验收 + 契约）
	cd aps/rust && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test --release --locked && ./target/release/aps acceptance
	cd mapf/rust && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test --release --locked && ./target/release/mapf acceptance
	cd agv/rust && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test --release --locked && ./target/release/agv acceptance
	cd warehouse/rust && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test --release --locked && ./target/release/warehouse acceptance --out /tmp/warehouse-acceptance.json

engine-aps: ## 只验 APS 引擎
	cd aps/rust && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test --release --locked && python3 scripts/check_contracts.py && bash scripts/build_wasm.sh

engine-mapf: ## 只验 MAPF 引擎
	cd mapf/rust && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test --release --locked && ./target/release/mapf acceptance && python3 scripts/check_contracts.py && bash scripts/build_wasm.sh

engine-agv: ## 只验 AGV 引擎
	cd agv/rust && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test --release --locked && ./target/release/agv acceptance && python3 scripts/check_contracts.py && bash scripts/build_wasm.sh

engine-warehouse: ## 只验仓储引擎（库位优化 / 密集立库调度 / 联合优化）
	cd warehouse/rust && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test --release --locked && ./target/release/warehouse acceptance --out /tmp/warehouse-acceptance.json && python3 scripts/check_contracts.py && bash scripts/build_wasm.sh

# ------------------------------------------------------------------ 数据与资产
sync: ## 同步四引擎产物 + 上传模型到 lab/public
	cd $(LAB) && npm run sync

sync-assets: ## 只同步三维实验室用到的上传模型
	cd $(LAB) && npm run sync:assets

audit-models: ## 重新生成模型结构审查报告（472 件上传资产）
	cd $(LAB) && npm run audit:models

audit-perf: ## 重新跑性能红线审计
	cd $(LAB) && npm run audit:perf

# ------------------------------------------------------------------ CI 等价
ci: ## 与 CI 质量门等价的一串检查（不部署）
	cd $(LAB) && npm run test:post-build

clean: ## 清理构建产物
	rm -rf $(LAB)/dist $(LAB)/artifacts
