#!/usr/bin/env python3
"""契约符合性检查（零依赖）：引擎输入/输出逐条对照 `mapf/contracts/*.schema.json`。

与 aps 侧同名脚本同一方法论：不引入 jsonschema/ajv，用脚本内实现的 schema 关键字
子集（type/required/properties/additionalProperties/items/minItems/maxItems/uniqueItems/
enum/const/minimum/maximum/minimum/minLength/pattern/format:anyOf）离线校验，可进 CI。

用法：
    python3 mapf/rust/scripts/check_contracts.py [--bin path/to/mapf]

检查内容：
  1. 五份 schema 可加载且 `$schema` 正确；
  2. `mapf/mock/*.json`（问题文件）符合 mapf-problem/1.0（m11-tampered-solution 除外，
     那是故意非法的核验样例）；
  3. 引擎对 m01/m02/m05/m10 的真实输出符合 mapf-solution/1.0，且内嵌核验通过；
  4. 非法输入（m07）/能力外（m07b）输出仍符合 solution 契约（错误路径也是契约的一部分）；
  5. `mapf capabilities --profile native|wasm-light` 符合 mapf-capabilities/1.0；
  6. `mapf/bench/manifest.json` 符合 mapf-bench-manifest/1.0；
  7. 对抗样例：删必填 / 改枚举 / 越界数字 / 加未知字段，schema 必须拒绝。

退出码：0 全部通过；1 有失败；2 环境错误。
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
            if not any(isinstance(instance, JSON_TYPES.get(x, object)) or (x == "integer" and type_ok(instance, "integer")) for x in t):
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
        if schema.get("format") == "date-time" and not re.match(
            r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$", instance
        ):
            errors.append(f"{path}: '{instance}' 不符合 ISO 8601 date-time")

    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: 元素数 {len(instance)} 小于 minItems={schema['minItems']}")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errors.append(f"{path}: 元素数 {len(instance)} 大于 maxItems={schema['maxItems']}")
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
        elif isinstance(schema.get("additionalProperties"), dict):
            for key, val in instance.items():
                if key not in props:
                    validate(val, schema["additionalProperties"], f"{path}.{key}", errors)
        for key, sub in props.items():
            if key in instance:
                validate(instance[key], sub, f"{path}.{key}", errors)
    return errors


class Report:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        if ok:
            self.passed += 1
            print(f"  ✓ {name}")
        else:
            self.failed += 1
            print(f"  ✗ {name}")
            for line in detail.splitlines()[:8]:
                print(f"      {line}")


def run_mapf(binary: str, args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([binary, *args], capture_output=True, text=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=None, help="mapf 可执行文件（默认 target/release/mapf）")
    args = ap.parse_args()

    here = Path(__file__).resolve().parent            # mapf/rust/scripts
    root = here.parent.parent.parent                   # 仓库根（…/algorithm-delivery）
    mapf_dir = root / "mapf"
    contracts = mapf_dir / "contracts"

    binary = args.bin or os.environ.get("MAPF_BIN")
    if not binary:
        for cand in (mapf_dir / "rust" / "target" / "release" / "mapf", Path("target/release/mapf")):
            if cand.exists():
                binary = str(cand)
                break
    if not binary:
        print("找不到 mapf 可执行文件（先 cargo build --release 或 --bin 指定）", file=sys.stderr)
        return 2

    r = Report()
    print(f"契约检查目录: {mapf_dir}\n引擎: {binary}")

    # [1] schema 文件
    print("\n[1] schema 文件自洽")
    schemas: dict[str, dict] = {}
    for name in ("mapf-problem", "mapf-solution", "mapf-verify", "mapf-capabilities", "mapf-bench-manifest"):
        p = contracts / f"{name}.schema.json"
        try:
            s = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            r.check(f"{p.name} 可加载", False, str(e))
            continue
        schemas[name] = s
        r.check(f"{name}.schema.json 声明 JSON Schema 2020-12",
                s.get("$schema", "").startswith("https://json-schema.org/draft/2020-12"))

    # [2] mock 问题文件符合契约
    print("\n[2] mapf/mock/*.json 符合 MapfProblem v1")
    for fixture in sorted((mapf_dir / "mock").glob("*.json")):
        if "tampered-solution" in fixture.name:
            continue
        doc = json.loads(fixture.read_text(encoding="utf-8"))
        errs = validate(doc, schemas["mapf-problem"])
        r.check(f"{fixture.name} 符合 mapf-problem/1.0", not errs, "\n".join(errs[:6]))

    # [3] 引擎输出符合 solution 契约（正常路径）+ 独立核验
    print("\n[3] 引擎输出符合 MapfSolution v1（m01/m02/m05/m10）")
    for fid in ("m01-single-basic", "m02-crossing", "m05-cycle", "m10-dynamic-events"):
        prob = mapf_dir / "mock" / f"{fid}.json"
        out = Path("/tmp") / f"cc-{fid}.json"
        proc = run_mapf(binary, ["solve", str(prob), "--out", str(out)])
        if proc.returncode not in (0,):
            r.check(f"{fid}: solve exit=0", False, (proc.stdout + proc.stderr)[-300:])
            continue
        sol = json.loads(out.read_text())
        errs = validate(sol, schemas["mapf-solution"])
        r.check(f"{fid}: 方案符合 mapf-solution/1.0", not errs, "\n".join(errs[:8]))
        r.check(f"{fid}: 状态合法且已内嵌核验（verified=true）",
                sol["status"] in ("OPTIMAL", "FEASIBLE") and sol.get("verified") is True,
                f"status={sol['status']} verified={sol.get('verified')}")

    # [4] 错误路径同样符合契约
    print("\n[4] 错误输出符合 MapfSolution v1（m07 INVALID_INPUT / m07b UNSUPPORTED）")
    for fid, want in (("m07-invalid-input", "INVALID_INPUT"), ("m07b-unsupported", "UNSUPPORTED")):
        proc = run_mapf(binary, ["solve", str(mapf_dir / "mock" / f"{fid}.json"), "--out", f"/tmp/cc-{fid}.json"])
        sol = json.loads(Path(f"/tmp/cc-{fid}.json").read_text())
        errs = validate(sol, schemas["mapf-solution"])
        r.check(f"{fid}: 输出符合契约且 status={want}",
                not errs and sol["status"] == want and len(sol["errors"]) > 0,
                "\n".join(errs[:4]) + f"\nstatus={sol['status']}")

    # [5] capabilities
    print("\n[5] capabilities 报告符合 MapfSolverCapabilities v1")
    for prof in ("native", "wasm-light"):
        proc = run_mapf(binary, ["capabilities", "--profile", prof, "--out", f"/tmp/cc-caps-{prof}.json"])
        caps = json.loads(Path(f"/tmp/cc-caps-{prof}.json").read_text())
        errs = validate(caps, schemas["mapf-capabilities"])
        r.check(f"capabilities({prof}) 符合契约", not errs, "\n".join(errs[:6]))

    # [6] bench manifest
    print("\n[6] bench/manifest.json 符合 MapfBenchManifest v1")
    mpath = mapf_dir / "bench" / "manifest.json"
    if mpath.exists():
        doc = json.loads(mpath.read_text())
        errs = validate(doc, schemas["mapf-bench-manifest"])
        r.check("manifest.json 符合契约", not errs, "\n".join(errs[:6]))
    else:
        r.check("manifest.json 存在", False, "（基准数据未下载时可为缺失——CI 完整流水线中存在）")

    # [7] 对抗样例
    print("\n[7] 对抗样例必须被 schema 拒绝")
    good = json.loads((mapf_dir / "mock" / "m01-single-basic.json").read_text())
    mut1 = {k: v for k, v in good.items() if k != "robots"}
    r.check("删 robots（必填）被拒绝", len(validate(mut1, schemas["mapf-problem"])) > 0)
    mut2 = json.loads(json.dumps(good))
    mut2["objective"]["kind"] = "wcs"
    r.check("未知目标枚举被拒绝", len(validate(mut2, schemas["mapf-problem"])) > 0)
    mut3 = json.loads(json.dumps(good))
    mut3["solver"] = {"suboptimality_factor": 4.5}
    r.check("w=4.5 超出 [1,3] 被拒绝", len(validate(mut3, schemas["mapf-problem"])) > 0)
    mut4 = json.loads(json.dumps(good))
    mut4["extra_field"] = 1
    r.check("未知顶层字段被拒绝（additionalProperties:false）", len(validate(mut4, schemas["mapf-problem"])) > 0)
    tampered_path = mapf_dir / "mock" / "m11-tampered-solution.json"
    vproc = subprocess.run([binary, "verify", str(mapf_dir / "mock" / "m11-tampered.json"),
                            str(mapf_dir / "mock" / "m11-tampered-solution.json"), "--out", "/tmp/cc-m11.json"],
                           capture_output=True, text=True)
    rep = json.loads(Path("/tmp/cc-m11.json").read_text())
    codes = {v["code"] for v in rep["violations"]}
    r.check("M11 篡改方案：核验拒绝且错误码齐备",
            rep["ok"] is False and {"E-WALL-ENTRY", "E-CONFLICT-VERTEX", "E-OBJ-SOC"} <= codes,
            f"codes={sorted(codes)} tampered_file_exists={tampered_path.exists()}")

    print(f"\n结论：{r.passed} 通过 / {r.failed} 失败")
    return 0 if r.failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
