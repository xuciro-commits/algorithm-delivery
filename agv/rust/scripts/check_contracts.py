#!/usr/bin/env python3
"""契约符合性检查（零依赖）：引擎输入/输出逐条对照 `agv/contracts/*.schema.json`。

与 aps/mapf 侧同名脚本同一方法论：不引入 jsonschema/ajv，用脚本内实现的 schema
关键字子集（type/required/properties/additionalProperties/items/minItems/maxItems/
uniqueItems/enum/const/minimum/maximum/minLength/pattern/anyOf）离线校验，可进 CI。

用法：
    python3 agv/rust/scripts/check_contracts.py [--bin path/to/agv]

检查内容：
  1. 四份 schema 可加载且 `$schema` 正确，且与 `make_schemas.py` 再生成结果一致（防漂移）；
  2. `agv/mock/*.json`（问题文件）符合 agv-dispatch-problem/1.0；
  3. 引擎对 a01/a07/a10 的真实输出符合 agv-dispatch-solution/1.0，且内嵌核验通过；
  4. 非法输入（坏 JSON）输出仍符合 solution 契约（错误路径也是契约的一部分）；
  5. `agv capabilities` 符合 agv-dispatch-capabilities/1.0；
  6. `agv verify` 报告符合 agv-verification/1.0：干净解 ok=true；篡改解
     ok=false 且 violations 非空（2026-10 修复的契约脱节项，本条即回归防线）；
  7. 对抗样例：删必填 / 加未知字段，schema 必须拒绝。

退出码：0 全部通过；1 有失败；2 环境错误。
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

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
    return True if py is None else isinstance(value, py)


def validate(instance, schema: dict, path: str = "$", errors: list | None = None) -> list:
    if errors is None:
        errors = []
    if not isinstance(schema, dict):
        return errors

    if "anyOf" in schema:
        sub_results = []
        for sub in schema["anyOf"]:
            e: list = []
            validate(instance, sub, path, e)
            sub_results.append(e)
        if all(len(x) > 0 for x in sub_results):
            errors.append(f"{path}: 不满足 anyOf 中任何分支（首个原因：{sub_results[0][0]}）")
        return errors

    if "type" in schema:
        t = schema["type"]
        if isinstance(t, list):
            if not any(type_ok(instance, x) for x in t):
                errors.append(f"{path}: 期望类型之一 {t}，实际 {type(instance).__name__}")
                return errors
        elif not type_ok(instance, t):
            errors.append(f"{path}: 期望类型 {t}，实际 {type(instance).__name__}")
            return errors

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: 期望常量 {schema['const']!r}，实际 {instance!r}")
    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: 值 {instance!r} 不在枚举 {schema['enum']} 内")

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{path}: {instance} 小于 minimum={schema['minimum']}")
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append(f"{path}: {instance} 大于 maximum={schema['maximum']}")
    if isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            errors.append(f"{path}: 长度 {len(instance)} 小于 minLength={schema['minLength']}")
        if "pattern" in schema and not re.match(schema["pattern"], instance):
            errors.append(f"{path}: '{instance}' 不匹配 pattern {schema['pattern']}")

    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: 元素数 {len(instance)} 小于 minItems={schema['minItems']}")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errors.append(f"{path}: 元素数 {len(instance)} 大于 maxItems={schema['maxItems']}")
        if schema.get("uniqueItems"):
            seen = [json.dumps(x, sort_keys=True) for x in instance]
            if len(set(seen)) != len(seen):
                errors.append(f"{path}: 存在重复元素（uniqueItems）")
        if "items" in schema:
            for i, item in enumerate(instance):
                validate(item, schema["items"], f"{path}[{i}]", errors)

    if isinstance(instance, dict):
        for key in schema.get("required", []):
            if key not in instance:
                errors.append(f"{path}: 缺少必填字段 {key}")
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for key in instance:
                if key not in props:
                    errors.append(f"{path}: 白名单外字段 {key}")
        for key, value in instance.items():
            if key in props:
                validate(value, props[key], f"{path}.{key}", errors)

    return errors


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=str(Path(__file__).resolve().parents[1] / "target" / "release" / "agv"))
    ap.add_argument("--wasm", default=str(Path(__file__).resolve().parents[1] / "dist" / "agv_engine.wasm"))
    args = ap.parse_args()

    here = Path(__file__).resolve().parent          # agv/rust/scripts
    agv = here.parents[1]                            # agv/
    contracts = agv / "contracts"
    mocks = agv / "mock"
    root = agv.parent
    agv_rust = here.parents[1]

    failures: list[str] = []
    total = 0

    def check(name: str, ok: bool, detail: str = "") -> None:
        nonlocal total
        total += 1
        mark = "✓" if ok else "✗"
        print(f"{mark} {name}" + (f" — {detail}" if detail else ""))
        if not ok:
            failures.append(name)

    schemas = {}
    for name in [
        "agv-dispatch-problem.schema.json",
        "agv-dispatch-solution.schema.json",
        "agv-dispatch-capabilities.schema.json",
        "agv-dispatch-verification.schema.json",
    ]:
        p = contracts / name
        try:
            schemas[name] = json.loads(p.read_text(encoding="utf-8"))
            check(f"schema 可加载：{name}", schemas[name].get("$schema", "").startswith("https://json-schema.org/"))
        except Exception as exc:  # noqa: BLE001
            check(f"schema 可加载：{name}", False, str(exc))
            return 2

    # 1b) schema 与生成器一致（防漂移）
    with tempfile.TemporaryDirectory() as td:
        env_out = ["--out", td]
        script = contracts / "make_schemas.py"
        try:
            subprocess.run(
                [sys.executable, str(script), *env_out], capture_output=True, text=True, check=True, cwd=str(contracts),
            )
            generated = sorted(Path(td).glob("*.json"))
            check("make_schemas.py 可在任意输出目录运行", len(generated) == 4)
            same = True
            for g in generated:
                src = contracts / g.name
                if not src.exists() or src.read_text(encoding="utf-8") != g.read_text(encoding="utf-8"):
                    same = False
                    failures_detail = g.name
            check("四份 schema 与 make_schemas.py 再生成结果逐字节一致（防漂移）", same, "" if same else failures_detail)
        except Exception as exc:  # noqa: BLE001
            check("make_schemas.py 重生成一致", False, str(exc))

    prob_schema = schemas["agv-dispatch-problem.schema.json"]
    sol_schema = schemas["agv-dispatch-solution.schema.json"]
    cap_schema = schemas["agv-dispatch-capabilities.schema.json"]
    ver_schema = schemas["agv-dispatch-verification.schema.json"]

    # 2) mock 问题文件
    mock_files = sorted(mocks.glob("*.json"))
    check("mock 问题文件数量 ≥ 13", len(mock_files) >= 13, f"{len(mock_files)} 个")
    for f in mock_files:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            errs = validate(data, prob_schema)
            check(f"{f.name} 符合 problem 契约", not errs, errs[0] if errs else "")
        except Exception as exc:  # noqa: BLE001
            check(f"{f.name} 符合 problem 契约", False, str(exc))

    # 3) 引擎真实输出
    def run_cli(*cli_args: str, stdin_text: str | None = None, expect_fail: bool = False) -> str:
        proc = subprocess.run(
            [args.bin, *cli_args], capture_output=True, text=True, input=stdin_text, cwd=str(root)
        )
        if expect_fail:
            if proc.returncode not in (0, 1):
                raise RuntimeError(f"CLI {cli_args} 退出码异常：{proc.returncode}\n{proc.stderr}")
        elif proc.returncode != 0:
            raise RuntimeError(f"CLI {cli_args} 失败：{proc.returncode}\n{proc.stderr}")
        return proc.stdout

    def solve(mock: str) -> tuple[dict, str]:
        text = run_cli("solve", str(mocks / mock))
        return json.loads(text), text

    try:
        for mock, expect_status in [
            ("a01-single-task.json", "FEASIBLE"),
            ("a07-station-capacity.json", "FEASIBLE"),
            ("a10-dynamic-task-add.json", "FEASIBLE"),
            ("a02-multi-task-single-vehicle.json", "FEASIBLE"),
        ]:
            sol, _ = solve(mock)
            errs = validate(sol, sol_schema)
            check(f"{mock} 输出符合 solution 契约", not errs, errs[0] if errs else "")
            check(f"{mock} 状态 = {expect_status}", sol.get("status") == expect_status, str(sol.get("status")))
            check(f"{mock} 内嵌核验通过", sol.get("verified") is True and sol.get("verify", {}).get("ok") is True)

        # 4) 错误路径：非法输入输出仍符合契约
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
            tf.write("{ not json")
            bad_path = tf.name
        out = subprocess.run(
            [args.bin, "solve", bad_path], capture_output=True, text=True, cwd=str(root)
        )
        bad_sol = json.loads(out.stdout)
        errs = validate(bad_sol, sol_schema)
        check("非法输入输出符合 solution 契约（错误路径也是契约）", not errs, errs[0] if errs else "")
        check("非法输入状态 = INVALID_INPUT", bad_sol.get("status") == "INVALID_INPUT", str(bad_sol.get("status")))

        # 5) capabilities
        caps = json.loads(run_cli("capabilities", "--profile", "wasm-light"))
        errs = validate(caps, cap_schema)
        check("capabilities（wasm-light）符合契约", not errs, errs[0] if errs else "")

        # 6) verify 报告契约（2026-10 修复项的回归防线）
        sol, sol_text = solve("a01-single-task.json")
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
            tf.write(sol_text)
            sol_path = tf.name
        report_text = run_cli("verify", str(mocks / "a01-single-task.json"), sol_path)
        report = json.loads(report_text)
        errs = validate(report, ver_schema)
        check("干净解 verify 报告符合 agv-verification/1.0", not errs, errs[0] if errs else "")
        check("干净解 verify: ok=true / mode=full", report.get("ok") is True and report.get("mode") == "full")
        check("干净解无 violations", report.get("violations") == [])
        check("verify 报告携带指标复算（recomputed.completed_tasks=1）",
              (report.get("recomputed") or {}).get("completed_tasks") == 1)

        tampered = json.loads(sol_text)
        tampered["plan"]["tasks"][0]["dropoff_done"] = 3
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
            json.dump(tampered, tf)
            tam_path = tf.name
        report2 = json.loads(run_cli("verify", str(mocks / "a01-single-task.json"), tam_path, expect_fail=True))
        errs = validate(report2, ver_schema)
        check("篡改解 verify 报告符合契约", not errs, errs[0] if errs else "")
        check("篡改解 ok=false 且 violations 非空", report2.get("ok") is False and len(report2.get("violations") or []) > 0,
              (report2.get("violations") or [{}])[0].get("code", ""))

        # 7) 对抗样例：schema 必须拒绝
        adv = json.loads((mocks / "a01-single-task.json").read_text(encoding="utf-8"))
        del adv["vehicles"]
        errs = validate(adv, prob_schema)
        check("对抗：删必填 vehicles 被拒绝", bool(errs))
        adv = json.loads((mocks / "a01-single-task.json").read_text(encoding="utf-8"))
        adv["rogue_field"] = 1
        errs = validate(adv, prob_schema)
        check("对抗：白名单外字段被拒绝", bool(errs))
        adv = json.loads((mocks / "a01-single-task.json").read_text(encoding="utf-8"))
        adv["vehicles"][0]["start"] = [-1, 0]
        errs = validate(adv, prob_schema)
        check("对抗：负坐标被拒绝", bool(errs))
        sol_bad = json.loads(sol_text)
        sol_bad["status"] = "SOMEHOW"
        errs = validate(sol_bad, sol_schema)
        check("对抗：solution 未知状态被拒绝", bool(errs))

    except subprocess.CalledProcessError as exc:
        print(f"环境错误：CLI 调用失败 {exc}", file=sys.stderr)
        return 2

    print(f"\n汇总: {total - len(failures)}/{total} 通过")
    if failures:
        print("  - " + "\n  - ".join(failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
