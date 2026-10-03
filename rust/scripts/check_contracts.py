#!/usr/bin/env python3
"""契约符合性检查（零依赖）：把 Rust 引擎的输入/输出逐条对照 `aps/contracts/*.schema.json`。

为什么需要它：JSON Schema 2020-12 的官方校验器（`jsonschema` / `ajv`）不是本仓库的依赖。
本脚本实现这三种 schema **实际用到的关键字子集**（type / required / properties / additionalProperties /
items / minItems / uniqueItems / enum / const / minimum / minLength / format:date-time），
因此可以在任意装有 Python 3.8+ 的环境里离线跑，作为 CI 的一环。

用法：
    python3 scripts/check_contracts.py [--aps-dir ../..] [--bin ../../target/release/aps]

检查内容：
  1. 三个 schema 文件本身可加载、`$schema` 正确、结构自洽；
  2. `aps/mock/*.json` 全部符合 PlanProblem v1；
  3. `contracts/plan-result.example.json` 符合 PlanSolution v1（交付包自带的样例）；
  4. 引擎真实跑出的方案（baseline / machine-breakdown / material-delay）符合 PlanSolution v1，
     且 `aps verify` 独立复核零违约；
  5. `aps capabilities --profile native|wasm-light --json` 符合 SolverCapabilities v1；
  6. 对抗用例：故意把手写方案改坏（去掉必填字段 / 改状态枚举 / 容量非 1），校验器必须报错。

退出码：0 全部通过；1 有失败。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# 极简 JSON Schema 子集校验器（只覆盖本仓库 schema 用到的关键字）
# ---------------------------------------------------------------------------

DATE_TIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$"
)

JSON_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "boolean": bool,
    "integer": int,
    "number": (int, float),
    "null": type(None),
}


def type_ok(value, expected: str) -> bool:
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    py = JSON_TYPES.get(expected)
    if py is None:
        return True
    if expected == "string":
        return isinstance(value, str)
    return isinstance(value, py)


def validate(instance, schema: dict, path: str = "$", errors: list | None = None) -> list:
    """返回错误字符串列表（空表示通过）。"""
    if errors is None:
        errors = []
    if not isinstance(schema, dict):
        return errors

    if "type" in schema and not type_ok(instance, schema["type"]):
        errors.append(f"{path}: 期望类型 {schema['type']}，实际 {type(instance).__name__}")
        return errors

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: 期望常量 {schema['const']!r}，实际 {instance!r}")

    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: 值 {instance!r} 不在枚举 {schema['enum']} 内")

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{path}: {instance} 小于 minimum={schema['minimum']}")

    if isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            errors.append(f"{path}: 长度 {len(instance)} 小于 minLength={schema['minLength']}")
        if schema.get("format") == "date-time" and not DATE_TIME_RE.match(instance):
            errors.append(f"{path}: '{instance}' 不符合 ISO 8601 date-time（需带时区偏移）")

    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: 元素数 {len(instance)} 小于 minItems={schema['minItems']}")
        if schema.get("uniqueItems"):
            seen = [json.dumps(x, sort_keys=True, ensure_ascii=False) for x in instance]
            if len(seen) != len(set(seen)):
                errors.append(f"{path}: 存在重复元素（uniqueItems）")
        if "items" in schema:
            for i, item in enumerate(instance):
                validate(item, schema["items"], f"{path}[{i}]", errors)

    if isinstance(instance, dict):
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in instance:
                errors.append(f"{path}: 缺少必填字段 '{key}'")
        if schema.get("additionalProperties") is False:
            for key in instance:
                if key not in props:
                    errors.append(f"{path}: 出现未声明的字段 '{key}'")
        for key, sub in props.items():
            if key in instance:
                validate(instance[key], sub, f"{path}.{key}", errors)

    return errors


# ---------------------------------------------------------------------------
# 运行引擎
# ---------------------------------------------------------------------------


def run_engine(binary: str, args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([binary, *args], capture_output=True, text=True)


def find_binary(explicit: str | None, aps_dir: Path) -> str:
    if explicit:
        return explicit
    env = os.environ.get("APS_BIN")
    if env:
        return env
    candidates: list[Path] = []
    cargo_target = os.environ.get("CARGO_TARGET_DIR")
    if cargo_target:
        candidates.append(Path(cargo_target) / "release" / "aps")
    candidates.append(aps_dir / "rust" / "target" / "release" / "aps")
    candidates.append(aps_dir / ".." / "target" / "release" / "aps")
    for cand in candidates:
        if cand.exists():
            return str(cand)
    print("找不到 aps 可执行文件：请先 `cargo build --release`，或用 --bin 指定 / 设置 APS_BIN",
          file=sys.stderr)
    sys.exit(2)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


class Report:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.failures: list[str] = []

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        if ok:
            self.passed += 1
            print(f"  ✓ {name}")
        else:
            self.failed += 1
            self.failures.append(name)
            print(f"  ✗ {name}")
            if detail:
                for line in detail.splitlines():
                    print(f"      {line}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aps-dir", default=None, help="aps 交付目录（默认自动定位）")
    ap.add_argument("--bin", default=None, help="aps 可执行文件路径")
    args = ap.parse_args()

    here = Path(__file__).resolve().parent           # aps/rust/scripts
    aps_dir = Path(args.aps_dir).resolve() if args.aps_dir else here.parent.parent
    if not (aps_dir / "contracts" / "plan-problem.schema.json").exists():
        print(f"{aps_dir} 不是 aps 交付目录（缺少 contracts/）", file=sys.stderr)
        return 2

    repo = Report()
    print(f"契约检查目录: {aps_dir}")

    # ---- 1. schema 文件自身 ----
    print("\n[1] 加载 schema 文件")
    schemas: dict[str, dict] = {}
    for name in ("plan-problem", "plan-solution", "solver-capabilities"):
        path = aps_dir / "contracts" / f"{name}.schema.json"
        try:
            s = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            repo.check(f"{path.name} 可加载", False, str(e))
            continue
        schemas[name] = s
        ok = s.get("$schema", "").startswith("https://json-schema.org/draft/2020-12")
        repo.check(f"{path.name} 声明 JSON Schema 2020-12", ok, f"$schema={s.get('$schema')}")

    # ---- 2. Mock 输入符合 PlanProblem v1 ----
    print("\n[2] Mock 输入是否符合 PlanProblem v1")
    if "plan-problem" in schemas:
        for fixture in sorted((aps_dir / "mock").glob("*.json")):
            doc = json.loads(fixture.read_text(encoding="utf-8"))
            errs = validate(doc, schemas["plan-problem"])
            repo.check(f"{fixture.name} 符合 plan-problem/1.0", not errs, "\n".join(errs[:6]))

    # ---- 3. 交付示例符合 PlanSolution v1 ----
    print("\n[3] contracts/plan-result.example.json 是否符合 PlanSolution v1")
    if "plan-solution" in schemas:
        example = json.loads((aps_dir / "contracts" / "plan-result.example.json").read_text("utf-8"))
        errs = validate(example, schemas["plan-solution"])
        repo.check("plan-result.example.json 符合 plan-solution/1.0", not errs, "\n".join(errs[:8]))

    # ---- 4. 引擎输出符合契约 + 独立复核 ----
    binary = find_binary(args.bin, aps_dir)
    print(f"\n[4] 引擎输出（{binary}）")
    tmp = aps_dir / "rust" / "target" / "contract-check"
    tmp.mkdir(parents=True, exist_ok=True)
    for fixture in ("baseline", "machine-breakdown", "material-delay"):
        problem = aps_dir / "mock" / f"{fixture}.json"
        out = tmp / f"{fixture}.solution.json"
        proc = run_engine(binary, [
            "solve", "--problem", str(problem), "--out", str(out),
            "--time-limit-ms", "300", "--seed", "42",
        ])
        if proc.returncode not in (0, 4, 5, 6):
            repo.check(f"{fixture}: solve 执行成功", False, proc.stdout[-400:] + proc.stderr[-400:])
            continue
        solution = json.loads(out.read_text("utf-8"))
        errs = validate(solution, schemas["plan-solution"])
        repo.check(f"{fixture}: 引擎方案符合 plan-solution/1.0", not errs, "\n".join(errs[:8]))
        repo.check(
            f"{fixture}: 状态 ∈ 契约枚举",
            solution["status"] in schemas["plan-solution"]["properties"]["status"]["enum"],
            solution["status"],
        )
        if solution["operations"]:
            for op in solution["operations"]:
                oerrs = validate(
                    op,
                    schemas["plan-solution"]["properties"]["operations"]["items"],
                    f"$.operations[{op['operation_id']}]",
                )
                if oerrs:
                    repo.check(f"{fixture}: 工序字段严格符合契约", False, "\n".join(oerrs[:4]))
                    break
            else:
                repo.check(f"{fixture}: 每道工序字段严格符合契约（additionalProperties=false）", True)

        vproc = run_engine(binary, [
            "verify", "--problem", str(problem), "--solution", str(out), "--json",
        ])
        try:
            vjson = json.loads(vproc.stdout)
        except Exception as e:  # noqa: BLE001
            repo.check(f"{fixture}: verify 输出可解析", False, str(e))
            continue
        repo.check(
            f"{fixture}: 独立校验零违约",
            vjson.get("valid") is True and vjson.get("count") == 0,
            json.dumps(vjson, ensure_ascii=False)[:300],
        )

    # ---- 5. 能力声明符合契约 ----
    print("\n[5] SolverCapabilities v1")
    if "solver-capabilities" in schemas:
        for profile in ("native", "wasm-light"):
            proc = run_engine(binary, ["capabilities", "--profile", profile, "--json"])
            caps = json.loads(proc.stdout)
            errs = validate(caps, schemas["solver-capabilities"])
            repo.check(f"capabilities[{profile}] 符合契约", not errs, "\n".join(errs[:6]))
            repo.check(
                f"capabilities[{profile}] 约束集合法",
                caps.get("constraints") == [f"H0{i}" for i in range(1, 9)],
                str(caps.get("constraints")),
            )

    # ---- 6. 负例：校验器必须能报错（证明检查本身有效） ----
    print("\n[6] 负例（校验器自身有效性）")
    if "plan-solution" in schemas:
        good = json.loads((aps_dir / "contracts" / "plan-result.example.json").read_text("utf-8"))
        broken_cases = {
            "缺少必填字段 operations": lambda d: d.pop("operations"),
            "状态不在枚举内": lambda d: d.update(status="MAYBE_OK"),
            "工序缺 worker_id": lambda d: d["operations"][0].pop("worker_id"),
            "工序出现未声明字段": lambda d: d["operations"][0].update(extra="x"),
            "时间不是带时区 ISO": lambda d: d["operations"][0].update(start_at="2026-10-05 08:00"),
        }
        for name, mutate in broken_cases.items():
            doc = json.loads(json.dumps(good))
            mutate(doc)
            errs = validate(doc, schemas["plan-solution"])
            repo.check(f"负例可检出：{name}", bool(errs), "未报错（校验器过松）")
    if "plan-problem" in schemas:
        base = json.loads((aps_dir / "mock" / "baseline.json").read_text("utf-8"))
        doc = json.loads(json.dumps(base))
        doc["tools"][0]["capacity"] = 2
        errs = validate(doc, schemas["plan-problem"])
        repo.check("负例可检出：工具容量 ≠ 1（P0 恒为独占）", bool(errs), "未报错")

    print(f"\n汇总: {repo.passed} 通过 / {repo.failed} 失败")
    if repo.failed:
        print("失败项: " + "; ".join(repo.failures))
    return 1 if repo.failed else 0


if __name__ == "__main__":
    sys.exit(main())
