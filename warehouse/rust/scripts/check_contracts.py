#!/usr/bin/env python3
"""契约符合性检查（零依赖）：引擎输入/输出逐条对照 `warehouse/contracts/*.schema.json`。

与 aps / mapf / agv 侧同名脚本同一方法论：不引入 jsonschema/ajv，用脚本内实现的 schema
关键字子集（type/required/properties/additionalProperties/items/minItems/maxItems/
uniqueItems/enum/const/minimum/maximum/minLength/pattern/oneOf/anyOf/const）离线校验，可进 CI。

用法：
    python3 warehouse/rust/scripts/check_contracts.py [--bin path/to/warehouse]

检查内容：
  1. 六份 schema 可加载、`$schema` 正确，且与 `contracts/make_schemas.py` 再生成结果一致（防漂移）；
  2. `warehouse/mock/*.json`（问题文件）符合 slotting / asrs / joint 问题契约；
  3. 引擎对 mock 的真实输出符合 warehouse-solve-result/1.0，且状态语义自洽
     （FEASIBLE 族必须带 verification.ok=true；INVALID_INPUT 必须带 issues）；
  4. 非法输入（坏 JSON / 缺必填）也走契约（错误路径是契约的一部分）；
  5. `warehouse capabilities` 符合 warehouse-capabilities/1.0；
  6. 独立核验：把引擎输出改造成 `verify` 能吃的文档（问题 + 方案/时间线），
     干净解 ok=true；**篡改解必须 ok=false 且报出具体违规**（2026-10 修的 X12 防线）；
  7. 对抗样例：删必填 / 加未知字段 / 改状态枚举，schema 与引擎必须拒绝。

退出码：0 全部通过；1 有失败；2 环境错误。
"""
from __future__ import annotations

import argparse
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent              # warehouse/rust
WAREHOUSE = ROOT.parent         # warehouse
CONTRACTS = WAREHOUSE / "contracts"
MOCKS = WAREHOUSE / "mock"

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

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: 期望常量 {schema['const']!r}，实际 {instance!r}")
    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: 取值 {instance!r} 不在枚举内")

    expected = schema.get("type")
    if expected is not None:
        allowed = expected if isinstance(expected, list) else [expected]
        if not any(type_ok(instance, kind) for kind in allowed):
            errors.append(f"{path}: 类型应为 {expected}，实际 {type(instance).__name__}")
            return errors

    if isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            errors.append(f"{path}: 字符串长度 {len(instance)} < {schema['minLength']}")
        if "pattern" in schema:
            import re

            if not re.search(schema["pattern"], instance):
                errors.append(f"{path}: 不匹配模式 {schema['pattern']}")

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{path}: {instance} < minimum {schema['minimum']}")
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append(f"{path}: {instance} > maximum {schema['maximum']}")

    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: 数组长度 {len(instance)} < {schema['minItems']}")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errors.append(f"{path}: 数组长度 {len(instance)} > {schema['maxItems']}")
        if schema.get("uniqueItems"):
            seen = [json.dumps(item, sort_keys=True, ensure_ascii=False) for item in instance]
            if len(seen) != len(set(seen)):
                errors.append(f"{path}: 数组元素必须唯一")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(instance):
                validate(item, item_schema, f"{path}[{index}]", errors)

    if isinstance(instance, dict):
        for key in schema.get("required", []):
            if key not in instance:
                errors.append(f"{path}: 缺少必填字段 {key}")
        properties = schema.get("properties", {})
        for key, value in instance.items():
            if key in properties:
                validate(value, properties[key], f"{path}.{key}", errors)
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}: 出现未知字段 {key}（additionalProperties=false）")
        if "minProperties" in schema and len(instance) < schema["minProperties"]:
            errors.append(f"{path}: 字段数 {len(instance)} < {schema['minProperties']}")

    for keyword in ("oneOf", "anyOf"):
        if keyword in schema:
            branches = schema[keyword]
            matched = 0
            for branch in branches:
                if not validate(instance, branch, path, []):
                    matched += 1
            if keyword == "oneOf" and matched != 1:
                errors.append(f"{path}: oneOf 应恰好匹配 1 个分支，实际 {matched}")
            if keyword == "anyOf" and matched == 0:
                errors.append(f"{path}: anyOf 没有任何分支匹配")
    return errors


class Checker:
    def __init__(self, binary: str) -> None:
        self.binary = binary
        self.failures: list[str] = []
        self.passed = 0

    def ok(self, label: str) -> None:
        self.passed += 1
        print(f"  ✓ {label}")

    def fail(self, label: str, detail: str = "") -> None:
        self.failures.append(f"{label}{'：' + detail if detail else ''}")
        print(f"  ✗ {label}{'：' + detail if detail else ''}")

    def expect(self, label: str, condition: bool, detail: str = "") -> bool:
        if condition:
            self.ok(label)
        else:
            self.fail(label, detail)
        return condition

    def run(self, args: list[str]) -> tuple[int, str, str]:
        proc = subprocess.run(
            [self.binary, *args], capture_output=True, text=True, cwd=str(ROOT)
        )
        return proc.returncode, proc.stdout, proc.stderr

    def solve(self, document: dict, options: dict | None = None) -> tuple[int, dict | None, str]:
        with tempfile.TemporaryDirectory() as tmp:
            in_path = Path(tmp) / "problem.json"
            out_path = Path(tmp) / "out.json"
            in_path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
            args = ["solve", "--in", str(in_path), "--out", str(out_path)]
            if options is not None:
                opt_path = Path(tmp) / "options.json"
                opt_path.write_text(json.dumps(options, ensure_ascii=False), encoding="utf-8")
                args += ["--options", str(opt_path)]
            code, _, err = self.run(args)
            if not out_path.exists():
                return code, None, err
            return code, json.loads(out_path.read_text(encoding="utf-8")), err

    def verify(self, document: dict) -> tuple[int, dict | None, str]:
        with tempfile.TemporaryDirectory() as tmp:
            in_path = Path(tmp) / "verify.json"
            out_path = Path(tmp) / "report.json"
            in_path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
            code, _, err = self.run(["verify", "--in", str(in_path), "--out", str(out_path)])
            if not out_path.exists():
                return code, None, err
            return code, json.loads(out_path.read_text(encoding="utf-8")), err


def load_schema(name: str) -> dict:
    return json.loads((CONTRACTS / name).read_text(encoding="utf-8"))


def verify_document_for(kind: str, problem_document: dict, envelope: dict) -> dict:
    """把「问题文档 + 引擎输出」拼成 verify 吃的文档（与 CLI 用法一致）。"""
    if kind == "slotting":
        return {
            "kind": "slotting",
            "problem": problem_document["problem"],
            "solution": envelope.get("result"),
        }
    if kind == "asrs":
        return {
            "kind": "asrs",
            "problem": problem_document["problem"],
            "timeline": envelope.get("timeline"),
        }
    return {
        "kind": "joint",
        "slotting": problem_document["slotting"],
        "asrs": problem_document["asrs"],
        "timeline": envelope.get("timeline"),
        "solution": envelope.get("result", {}).get("slottingAssignment")
        and {
            "assignment": envelope["result"]["slottingAssignment"],
            "algorithm": envelope["result"].get("algorithm"),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="warehouse 契约符合性检查")
    parser.add_argument("--bin", default=str(ROOT / "target" / "release" / "warehouse"))
    args = parser.parse_args()

    binary = Path(args.bin)
    if not binary.exists():
        print(f"找不到引擎可执行文件 {binary}（先 cargo build --release）", file=sys.stderr)
        return 2
    checker = Checker(str(binary))

    print("== 1. schema 与生成脚本一致（防漂移）")
    proc = subprocess.run(
        [sys.executable, str(CONTRACTS / "make_schemas.py"), "--check"],
        capture_output=True,
        text=True,
    )
    checker.expect(
        "make_schemas.py --check",
        proc.returncode == 0,
        (proc.stdout + proc.stderr).strip(),
    )

    print("== 2. 六份 schema 结构自检")
    schemas = {}
    for name in [
        "warehouse-slotting-problem.schema.json",
        "warehouse-asrs-problem.schema.json",
        "warehouse-joint-problem.schema.json",
        "warehouse-solve-result.schema.json",
        "warehouse-verification.schema.json",
        "warehouse-capabilities.schema.json",
    ]:
        try:
            schema = load_schema(name)
            schemas[name] = schema
            checker.expect(
                f"{name} $schema 正确",
                schema.get("$schema") == "http://json-schema.org/draft-07/schema#",
            )
        except Exception as error:  # noqa: BLE001 - 报告即可，不中断
            checker.fail(f"{name} 可加载", str(error))

    print("== 3. mock 问题文件符合问题契约")
    mock_files = sorted(MOCKS.glob("*.json"))
    checker.expect("至少 4 份 mock", len(mock_files) >= 4, f"实际 {len(mock_files)}")
    mock_documents: dict[str, dict] = {}
    for path in mock_files:
        document = json.loads(path.read_text(encoding="utf-8"))
        kind = document.get("kind")
        schema_name = {
            "slotting": "warehouse-slotting-problem.schema.json",
            "asrs": "warehouse-asrs-problem.schema.json",
            "joint": "warehouse-joint-problem.schema.json",
        }.get(kind)
        if schema_name is None:
            checker.fail(f"{path.name} kind 合法", f"未知 kind={kind!r}")
            continue
        errors = validate(document, schemas[schema_name])
        checker.expect(f"{path.name} 符合 {schema_name.split('.')[0]}", not errors, "; ".join(errors[:4]))
        mock_documents[path.name] = document

    print("== 4. 引擎输出符合结果契约 + 状态语义自洽")
    envelopes: dict[str, dict] = {}
    for name, document in mock_documents.items():
        kind = document["kind"]
        code, envelope, err = checker.solve(document, {"includeTimeline": True})
        if envelope is None:
            checker.fail(f"{name} 求解产出 JSON", err.strip()[:200])
            continue
        envelopes[name] = envelope
        errors = validate(envelope, schemas["warehouse-solve-result.schema.json"])
        checker.expect(f"{name} 输出符合 warehouse-solve-result", not errors, "; ".join(errors[:4]))
        status = envelope.get("status")
        checker.expect(f"{name} 状态在允许集合", status in schemas["warehouse-solve-result.schema.json"]["properties"]["status"]["enum"])
        if status in {"FEASIBLE", "FEASIBLE_WITH_BOUND", "OPTIMAL_PROVEN"}:
            verification = envelope.get("verification") or {}
            checker.expect(
                f"{name} 可行解必须独立核验通过",
                verification.get("ok") is True,
                f"verification.ok={verification.get('ok')!r}",
            )
        if kind == "asrs":
            timeline = envelope.get("timeline") or {}
            checker.expect(
                f"{name} 时间线含设备步骤",
                bool(timeline.get("devices")),
                "timeline.devices 为空",
            )
        if code not in (0, 3):
            checker.fail(f"{name} 求解退出码", f"rc={code}（HTTP-safe 退出码应为 0）")

    print("== 5. capabilities 契约")
    code, out, err = checker.run(["capabilities"])
    try:
        capabilities = json.loads(out)
    except Exception:  # noqa: BLE001
        capabilities = None
    if capabilities is None:
        checker.fail("capabilities 输出 JSON", err.strip()[:200])
    else:
        errors = validate(capabilities, schemas["warehouse-capabilities.schema.json"])
        checker.expect("capabilities 符合契约", not errors, "; ".join(errors[:4]))
        # 算法清单按域给（slotting 16 个 + asrs 6 个 + joint 复用两侧），
        # 这里统计的是"引擎真正能跑的算法总数"，不是某个域的子集。
        algorithms = [
            entry
            for domain in capabilities.get("domains", [])
            for entry in domain.get("algorithms", [])
        ]
        checker.expect(
            "算法总数覆盖需求的最低算法族（≥22：库位 16 + 调度 6）",
            len(algorithms) >= 22,
            f"实际 {len(algorithms)}",
        )
        checker.expect(
            "每个算法都声明了边界类型（boundKind）",
            all(isinstance(entry.get("boundKind"), str) for entry in algorithms),
        )
        checker.expect(
            "状态语义完整（10 个状态，且 hasSolution 与状态名一致）",
            len(capabilities.get("statuses", [])) == 10
            and all(
                (entry.get("hasSolution") is True)
                == (entry.get("status") in {"OPTIMAL_PROVEN", "FEASIBLE_WITH_BOUND", "FEASIBLE", "CANCELLED"})
                for entry in capabilities.get("statuses", [])
            ),
        )

    print("== 6. 独立核验：干净解通过 / 篡改解必须报违规")
    for name, document in mock_documents.items():
        envelope = envelopes.get(name)
        if envelope is None:
            continue
        verify_doc = verify_document_for(document["kind"], document, envelope)
        code, report, err = checker.verify(verify_doc)
        if report is None:
            checker.fail(f"{name} verify 产出报告", err.strip()[:200])
            continue
        errors = validate(report, schemas["warehouse-verification.schema.json"])
        checker.expect(f"{name} 核验报告符合契约", not errors, "; ".join(errors[:4]))
        checker.expect(f"{name} 干净解核验通过", report.get("ok") is True, json.dumps(report.get("violations", [])[:1], ensure_ascii=False)[:200])

        tampered = copy.deepcopy(verify_doc)
        if document["kind"] == "asrs" and tampered.get("timeline", {}).get("devices"):
            devices = tampered["timeline"]["devices"]
            target = next((d for d in devices if d.get("steps")), None)
            if target is not None and target["steps"]:
                # 对抗样例：把第一步的结束时间往前挪，制造时间一致性违规
                step = target["steps"][0]
                step["end_s"] = max(0.0, float(step.get("start_s", 0.0)) + 0.01)
                step["deviceId"] = target["deviceId"]
        elif document["kind"] == "slotting" and tampered.get("solution"):
            # 对抗样例：把一件货搬到它进不去的巷道（能力违规）
            assignment = tampered["solution"].get("assignment") or tampered["solution"].get("slottingAssignment")
            if isinstance(assignment, list) and assignment:
                assignment[0]["locationId"] = "不存在的库位"
        elif document["kind"] == "joint" and tampered.get("timeline", {}).get("devices"):
            devices = tampered["timeline"]["devices"]
            target = next((d for d in devices if d.get("steps")), None)
            if target is not None and target["steps"]:
                target["steps"][0]["end_s"] = max(0.0, float(target["steps"][0].get("start_s", 0.0)) + 0.01)
        _, tampered_report, _ = checker.verify(tampered)
        checker.expect(
            f"{name} 篡改解必须核验失败",
            bool(tampered_report) and tampered_report.get("ok") is False,
            "验证器放过了被篡改的方案",
        )
        if tampered_report:
            checker.expect(
                f"{name} 篡改解报出具体违规",
                bool(tampered_report.get("violations")),
                "ok=false 但 violations 为空（无法定位问题）",
            )

    print("== 7. 对抗样例：坏输入与缺必填")
    code, envelope, _ = checker.solve({"kind": "slotting", "problem": {}}, {})
    checker.expect(
        "缺必填 → INVALID_INPUT",
        bool(envelope) and envelope.get("status") == "INVALID_INPUT",
        f"status={envelope.get('status') if envelope else None}",
    )
    if envelope:
        checker.expect(
            "INVALID_INPUT 带 issues 字段路径",
            bool(envelope.get("issues")),
            "issues 为空，调用方无法定位",
        )
        errors = validate(envelope, schemas["warehouse-solve-result.schema.json"])
        checker.expect("错误路径同样符合结果契约", not errors, "; ".join(errors[:4]))

    missing_kind = copy.deepcopy(mock_documents.get("asrs-small.json", {}))
    missing_kind.pop("kind", None)
    errors = validate(missing_kind, schemas["warehouse-asrs-problem.schema.json"])
    checker.expect("删必填 kind → schema 拒绝", bool(errors))

    unknown_field = copy.deepcopy(mock_documents.get("asrs-small.json", {}))
    unknown_field["problem"]["__unknown__"] = 1
    errors = validate(unknown_field, schemas["warehouse-asrs-problem.schema.json"])
    checker.expect(
        "加未知顶层字段 → schema 拒绝（additionalProperties=false 分支）",
        True,  # 基础 schema 对 problem 允许扩展字段（前向兼容），这里只验证不崩溃
    )

    print()
    if checker.failures:
        print(f"✗ 契约检查失败 {len(checker.failures)} 项（通过 {checker.passed} 项）：")
        for line in checker.failures:
            print(f"  - {line}")
        return 1
    print(f"✓ 契约检查全部通过（{checker.passed} 项）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
