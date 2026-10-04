#!/usr/bin/env python3
"""生成 `warehouse/contracts/*.schema.json`（JSON Schema draft-07，零依赖）。

与 aps / mapf / agv 侧同一方法论：schema 由脚本生成、脚本再校验一致性，
避免"手改 schema 忘了同步检查脚本"的漂移。任何契约变更都必须改本文件并重新生成：

    python3 warehouse/contracts/make_schemas.py          # 写入
    python3 warehouse/contracts/make_schemas.py --check  # CI：只校验是否一致

六个契约：
  * warehouse-slotting-problem  库位优化问题
  * warehouse-asrs-problem      密集立库调度问题
  * warehouse-joint-problem     联合优化问题（slotting + asrs）
  * warehouse-solve-result      求解结果信封（三个域共用同一外壳）
  * warehouse-verification      独立核验报告
  * warehouse-capabilities      档位能力声明
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

SCHEMA_URI = "http://json-schema.org/draft-07/schema#"

STATUS_ENUM = [
    "OPTIMAL_PROVEN",
    "FEASIBLE_WITH_BOUND",
    "FEASIBLE",
    "BUDGET_EXCEEDED",
    "NO_SOLUTION_FOUND",
    "INFEASIBLE_PROVEN",
    "CANCELLED",
    "INVALID_INPUT",
    "UNSUPPORTED",
    "INTERNAL_ERROR",
]

VECTOR3 = {
    "type": "array",
    "minItems": 3,
    "maxItems": 3,
    "items": {"type": "number"},
}

TOPOLOGY = {
    "type": "object",
    "required": ["areas", "aisles", "racks", "nodes", "links", "devices", "stations", "buffers"],
    "properties": {
        "id": {"type": "string"},
        "name": {"type": "string"},
        "template": {"type": "string"},
        "units": {"type": "object"},
        "areas": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": ["id", "kind"],
                "properties": {
                    "id": {"type": "string"},
                    "kind": {"type": "string"},
                    "name": {"type": "string"},
                    # 区域中心是 2 维（x, z）：立库平面图就是二维布局
                    "center": {"type": "array", "minItems": 2, "maxItems": 2, "items": {"type": "number"}},
                    "size": {"type": "array", "items": {"type": "number"}},
                    "height_m": {"type": "number"},
                },
            },
        },
        "aisles": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": ["id", "endNodeIds"],
                "properties": {
                    "id": {"type": "string"},
                    "areaId": {"type": "string"},
                    "level": {"type": "integer"},
                    "length_m": {"type": "number"},
                    "axis": {"type": "array", "items": {"type": "number"}},
                    "bidirectional": {"type": "boolean"},
                    "rackIds": {"type": "array", "items": {"type": "string"}},
                    "endNodeIds": {"type": "array", "minItems": 2, "items": {"type": "string"}},
                },
            },
        },
        "racks": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": ["id", "aisleId", "bays", "levels", "origin"],
                "properties": {
                    "id": {"type": "string"},
                    "aisleId": {"type": "string"},
                    "areaId": {"type": "string"},
                    "kind": {"type": "string"},
                    "bays": {"type": "integer", "minimum": 1},
                    "depths": {"type": "integer", "minimum": 1},
                    "origin": VECTOR3,
                    "bayAxis": {"type": "array", "minItems": 2, "items": {"type": "number"}},
                    "depthAxis": {"type": "array", "minItems": 2, "items": {"type": "number"}},
                    "levels": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "required": ["level", "y_m"],
                            "properties": {
                                "level": {"type": "integer"},
                                "y_m": {"type": "number"},
                                "height_m": {"type": "number"},
                            },
                        },
                    },
                    "locationSize": {"type": "object"},
                    "maxWeight_kg": {"type": "number"},
                    "maxVolume_m3": {"type": "number"},
                },
            },
        },
        "nodes": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": ["id", "position"],
                "properties": {
                    "id": {"type": "string"},
                    "kind": {"type": "string"},
                    "level": {"type": "integer"},
                    "aisleId": {"type": ["string", "null"]},
                    "areaId": {"type": ["string", "null"]},
                    "position": VECTOR3,
                },
            },
        },
        "links": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["id", "from", "to"],
                "properties": {
                    "id": {"type": "string"},
                    "from": {"type": "string"},
                    "to": {"type": "string"},
                    "mode": {"type": "string"},
                    "length_m": {"type": "number"},
                    "capacity": {"type": "integer"},
                    "bidirectional": {"type": "boolean"},
                    "allowMeeting": {"type": "boolean"},
                },
            },
        },
        "devices": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": ["id", "kind"],
                "properties": {
                    "id": {"type": "string"},
                    "kind": {"type": "string"},
                    "name": {"type": "string"},
                    # 设备状态是结构化对象（state / speedFactor / health…），不是单一字符串
                    "status": {"type": ["string", "object"]},
                    "homeNodeId": {"type": "string"},
                    "motion": {"type": "object"},
                    "energy": {"type": "object"},
                    "capability": {"type": "object"},
                    "coupling": {"type": "object"},
                },
            },
        },
        "stations": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["id", "nodeId"],
                "properties": {
                    "id": {"type": "string"},
                    "nodeId": {"type": "string"},
                    "name": {"type": "string"},
                    "areaId": {"type": "string"},
                    "direction": {"type": "string"},
                    "bufferCapacity": {"type": "integer"},
                    "handover_s": {"type": "number"},
                    "servedBy": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "buffers": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["id", "nodeId"],
                "properties": {
                    "id": {"type": "string"},
                    "nodeId": {"type": "string"},
                    "areaId": {"type": "string"},
                    "capacity": {"type": "integer"},
                    "dwellLimit_s": {"type": "number"},
                },
            },
        },
        "frozenLocations": {"type": "array", "items": {"type": "string"}},
        "reservedLocations": {"type": "array", "items": {"type": "string"}},
    },
}

SKU = {
    "type": "object",
    "required": ["id"],
    "properties": {
        "id": {"type": "string", "minLength": 1},
        "name": {"type": "string"},
        "abc": {"type": "string"},
        "xyz": {"type": "string"},
        "category": {"type": "string"},
        "temperature": {"type": "string"},
        "unitWeightKg": {"type": "number"},
        "unitVolumeM3": {"type": "number"},
        "meanDailyDemand": {"type": "number"},
        "demandCv": {"type": "number"},
        "affinityCluster": {"type": ["string", "null"]},
        "allowedZones": {"type": "array", "items": {"type": "string"}},
        "batchPolicy": {"type": "string"},
    },
}

INVENTORY_UNIT = {
    "type": "object",
    "required": ["id", "skuId"],
    "properties": {
        "id": {"type": "string", "minLength": 1},
        "skuId": {"type": "string"},
        "quantity": {"type": "number"},
        "locationId": {"type": ["string", "null"]},
        "status": {"type": "string"},
        "batch": {"type": "string"},
        "inbound_at_s": {"type": ["number", "null"]},
        "expires_at_s": {"type": ["number", "null"]},
    },
}

ORDER = {
    "type": "object",
    "required": ["id", "lines"],
    "properties": {
        "id": {"type": "string", "minLength": 1},
        "release_s": {"type": "number"},
        "due_s": {"type": ["number", "null"]},
        "priority": {"type": "integer"},
        "channel": {"type": "string"},
        "lines": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["skuId"],
                "properties": {"skuId": {"type": "string"}, "quantity": {"type": "number"}},
            },
        },
    },
}

TASK = {
    "type": "object",
    "required": ["id", "kind"],
    "properties": {
        "id": {"type": "string", "minLength": 1},
        # 引擎按字符串分派（inbound / outbound / relocate / count / 派生任务…），
        # 不做枚举硬约束：新增任务类型不应该让旧 schema 误报。
        "kind": {"type": "string", "minLength": 1},
        "priority": {"type": "integer"},
        "release_s": {"type": "number"},
        "deadline_s": {"type": ["number", "null"]},
        "orderId": {"type": ["string", "null"]},
        "skuId": {"type": ["string", "null"]},
        "loadUnitId": {"type": ["string", "null"]},
        "fromLocationId": {"type": ["string", "null"]},
        "toLocationId": {"type": ["string", "null"]},
        "fromNodeId": {"type": ["string", "null"]},
        "toNodeId": {"type": ["string", "null"]},
        "dependsOn": {"type": "array", "items": {"type": "string"}},
        "cancellable": {"type": "boolean"},
        "dualCommandEligible": {"type": "boolean"},
    },
}

# 动态事件（intent）：引擎按 `kind` 分派（`type` 仅是历史字段，不再读取）。
# 已知 kind：device-breakdown / fault、speed-degradation / degraded-speed、
#            aisle-closure、location-freeze、task-cancel / order-cancel / cancel、
#            priority-boost / expedite、insertion / task-insert / new-task / urgent-insert。
# 未知 kind 会被引擎忽略（不报错），因此这里不做枚举硬约束 —— 但 `kind` 必须存在，
# 否则事件会被静默丢弃，这正是契约要拦住的错误。
INTENT = {
    "type": "object",
    "required": ["kind"],
    "properties": {
        "kind": {"type": "string", "minLength": 1},
        "type": {"type": "string"},
        "at_s": {"type": "number"},
        "until_s": {"type": ["number", "null"]},
        "targetId": {"type": ["string", "null"]},
        "note": {"type": "string"},
        "deviceIds": {"type": "array", "items": {"type": "string"}},
        "taskIds": {"type": "array", "items": {"type": "string"}},
        "locationIds": {"type": "array", "items": {"type": "string"}},
        "linkIds": {"type": "array", "items": {"type": "string"}},
        "tasks": {"type": "array", "items": {"type": "object"}},
        "priority": {"type": "number"},
        "deadline_s": {"type": ["number", "null"]},
        "speedFactor": {"type": "number"},
        "capacity": {"type": "integer"},
    },
}

# 生成器与手写文档都会在顶层带这些元数据（场景编号、目标、期望、规模统计）；
# `additionalProperties: false` 让"拼错字段名"这种低级错误在契约层就被拦住。
DOC_META = {
    "scenarioId": {"type": ["string", "null"]},
    "scale": {"type": ["string", "null"]},
    "seed": {"type": "integer"},
    "name": {"type": "string"},
    "goal": {"type": "string"},
    "expect": {"type": "string"},
    "stats": {"type": "object"},
    "topology": TOPOLOGY,
}

SLOTTING_PROBLEM = {
    "$schema": SCHEMA_URI,
    "$id": "warehouse-slotting-problem/1.0",
    "title": "库位优化问题（Warehouse Slotting Problem）",
    "type": "object",
    "required": ["kind", "problem"],
    "additionalProperties": False,
    "properties": {
        "kind": {"type": "string", "const": "slotting"},
        **DOC_META,
        "problem": {
            "type": "object",
            "required": ["topology", "skus", "inventory", "orders"],
            "properties": {
                "id": {"type": "string"},
                "datasetVersion": {"type": "string"},
                "topology": TOPOLOGY,
                "skus": {"type": "array", "minItems": 1, "items": SKU},
                "inventory": {"type": "array", "items": INVENTORY_UNIT},
                "orders": {"type": "array", "items": ORDER},
                # 引擎的实际结构是"货物单元 → 库位"的**列表**（不是对象映射）
                "currentAssignment": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["loadUnitId", "locationId"],
                        "properties": {
                            "loadUnitId": {"type": "string"},
                            "locationId": {"type": "string"},
                        },
                    },
                },
                "objectives": {"type": "array"},
                "constraints": {"type": "object"},
                "algorithm": {"type": "object"},
                "costModel": {"type": "object"},
                "events": {"type": "array", "items": INTENT},
                "hardConstraints": {"type": "array", "items": {"type": "string"}},
            },
        },
    },
}

ASRS_PROBLEM = {
    "$schema": SCHEMA_URI,
    "$id": "warehouse-asrs-problem/1.0",
    "title": "密集立库调度问题（AS/RS Dispatch Problem）",
    "type": "object",
    "required": ["kind", "problem"],
    "additionalProperties": False,
    "properties": {
        "kind": {"type": "string", "const": "asrs"},
        **DOC_META,
        "problem": {
            "type": "object",
            "required": ["topology", "tasks"],
            "properties": {
                "id": {"type": "string"},
                "datasetVersion": {"type": "string"},
                "topology": TOPOLOGY,
                "tasks": {"type": "array", "minItems": 0, "items": TASK},
                "loadUnits": {"type": "array", "items": INVENTORY_UNIT},
                "skus": {"type": "array", "items": SKU},
                "dispatch": {"type": "object"},
                "events": {"type": "array", "items": INTENT},
                "hardConstraints": {"type": "array", "items": {"type": "string"}},
                "slottingPlan": {"type": ["object", "null"]},
            },
        },
    },
}

JOINT_PROBLEM = {
    "$schema": SCHEMA_URI,
    "$id": "warehouse-joint-problem/1.0",
    "title": "联合优化问题（库位 × 密集立库调度）",
    "type": "object",
    "required": ["kind", "slotting", "asrs"],
    "additionalProperties": False,
    "properties": {
        "kind": {"type": "string", "const": "joint"},
        **DOC_META,
        "slotting": SLOTTING_PROBLEM["properties"]["problem"],
        "asrs": ASRS_PROBLEM["properties"]["problem"],
    },
}

ISSUE = {
    "type": "object",
    "required": ["code", "path", "message"],
    "properties": {
        "code": {"type": "string", "minLength": 1},
        "path": {"type": "string"},
        "message": {"type": "string"},
        "severity": {"type": "string", "enum": ["info", "warning", "error"]},
    },
}

VIOLATION = {
    "type": "object",
    "required": ["code", "class", "severity", "message"],
    "properties": {
        "code": {"type": "string", "minLength": 1},
        "class": {"type": "string", "enum": ["hard", "soft"]},
        "severity": {"type": "string", "enum": ["info", "warning", "error"]},
        "message": {"type": "string"},
        "at_s": {"type": ["number", "null"]},
        "deviceId": {"type": ["string", "null"]},
        "taskId": {"type": ["string", "null"]},
        "locationId": {"type": ["string", "null"]},
        "position": {"type": ["array", "null"], "items": {"type": "number"}},
        "expected": {},
        "actual": {},
        "subjects": {"type": "array", "items": {"type": "string"}},
    },
}

VERIFICATION = {
    "$schema": SCHEMA_URI,
    "$id": "warehouse-verification/1.0",
    "title": "独立核验报告",
    "type": "object",
    "required": ["ok", "violations"],
    "properties": {
        "ok": {"type": "boolean"},
        "checked": {"type": "object"},
        "violations": {"type": "array", "items": VIOLATION},
    },
}

SOLVE_RESULT = {
    "$schema": SCHEMA_URI,
    "$id": "warehouse-solve-result/1.0",
    "title": "求解结果信封（slotting / asrs / joint 共用）",
    "type": "object",
    "required": [
        "engine",
        "engineVersion",
        "rulesetVersion",
        "fingerprint",
        "status",
        "runtimeMs",
        "issues",
        "metrics",
        "result",
        "verification",
    ],
    "properties": {
        "engine": {"type": "string", "const": "rust-warehouse"},
        "engineVersion": {"type": "string"},
        "rulesetVersion": {"type": "string"},
        "fingerprint": {"type": "string", "minLength": 8},
        "status": {"type": "string", "enum": STATUS_ENUM},
        "runtimeMs": {"type": "number", "minimum": 0},
        "objective": {"type": ["number", "null"]},
        "issues": {"type": "array", "items": ISSUE},
        "metrics": {"type": "object"},
        # 无解/非法输入时 result 为 null（"有没有解"由状态语义表达，不靠空对象假装）
        "result": {
            "oneOf": [
                {"type": "null"},
                {"type": "object", "required": ["kind"]},
            ]
        },
        "comparison": {"type": ["object", "null"]},
        "timeline": {"type": ["object", "null"]},
        "verification": {"oneOf": [{"type": "null"}, VERIFICATION]},
    },
}

CAPABILITIES = {
    "$schema": SCHEMA_URI,
    "$id": "warehouse-capabilities/1.0",
    "title": "引擎档位能力声明",
    "type": "object",
    "required": [
        "engine",
        "engineVersion",
        "rulesetVersion",
        "profile",
        "domains",
        "statuses",
        "tiers",
        "scenarios",
    ],
    "properties": {
        "engine": {"type": "string", "const": "rust-warehouse"},
        "engineVersion": {"type": "string"},
        "compilerVersion": {"type": "string"},
        "rulesetVersion": {"type": "string"},
        "profile": {"type": "string", "enum": ["native", "wasm-light"]},
        "domains": {
            "type": "array",
            "minItems": 3,
            "items": {
                "type": "object",
                # 联合域回答的是"闭环问题"，本身不新增算法清单（它复用两侧算法），
                # 因此 algorithms 只在有算法清单的域里出现。
                "required": ["id", "label"],
                "properties": {
                    "id": {"type": "string", "enum": ["slotting", "asrs", "joint"]},
                    "label": {"type": "string"},
                    "problem": {"type": "string"},
                    "algorithms": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "required": ["id"],
                            "properties": {
                                "id": {"type": "string"},
                                "kind": {"type": "string"},
                                "label": {"type": "string"},
                                "canProveOptimal": {"type": "boolean"},
                                "canProveInfeasible": {"type": "boolean"},
                                "boundKind": {"type": "string"},
                            },
                        },
                    },
                    "objectives": {"type": "array", "items": {"type": "string"}},
                    "supports": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "limits": {"type": "object"},
        "statuses": {
            "type": "array",
            "minItems": 10,
            "items": {
                "type": "object",
                "required": ["code", "status", "hasSolution"],
                "properties": {
                    "code": {"type": "integer"},
                    "status": {"type": "string", "enum": STATUS_ENUM},
                    "hasSolution": {"type": "boolean"},
                },
            },
        },
        "tiers": {
            "type": "array",
            "minItems": 2,
            "items": {
                "type": "object",
                "required": ["name", "maxSkus", "maxLocations", "maxLoadUnits", "maxTasks", "maxBudgetMs"],
                "properties": {
                    "name": {"type": "string", "enum": ["native", "wasm-light"]},
                    "label": {"type": "string"},
                    "maxSkus": {"type": "integer"},
                    "maxLocations": {"type": "integer"},
                    "maxLoadUnits": {"type": "integer"},
                    "maxTasks": {"type": "integer"},
                    "maxBudgetMs": {"type": "number"},
                },
            },
        },
        "scenarios": {
            "type": "object",
            "required": ["count", "families"],
            "properties": {
                "count": {"type": "integer", "minimum": 1},
                "families": {"type": "array", "minItems": 5, "items": {"type": "string"}},
            },
        },
        "reproducibility": {"type": "object"},
        "verification": {"type": "object"},
    },
}

FILES = {
    "warehouse-slotting-problem.schema.json": SLOTTING_PROBLEM,
    "warehouse-asrs-problem.schema.json": ASRS_PROBLEM,
    "warehouse-joint-problem.schema.json": JOINT_PROBLEM,
    "warehouse-solve-result.schema.json": SOLVE_RESULT,
    "warehouse-verification.schema.json": VERIFICATION,
    "warehouse-capabilities.schema.json": CAPABILITIES,
}


def rendered() -> dict[str, str]:
    return {name: json.dumps(schema, ensure_ascii=False, indent=2, sort_keys=True) + "\n" for name, schema in FILES.items()}


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 / 校验 warehouse 契约 schema")
    parser.add_argument("--check", action="store_true", help="只校验文件是否与生成结果一致（CI 用）")
    args = parser.parse_args()

    payload = rendered()
    if args.check:
        drifted = []
        for name, text in payload.items():
            path = HERE / name
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                drifted.append(name)
        if drifted:
            print("✗ schema 与 make_schemas.py 不一致：" + ", ".join(drifted), file=sys.stderr)
            print("  运行 python3 warehouse/contracts/make_schemas.py 重新生成", file=sys.stderr)
            return 1
        print(f"✓ {len(payload)} 份 schema 与生成脚本一致")
        return 0

    for name, text in payload.items():
        (HERE / name).write_text(text, encoding="utf-8")
        print(f"写入 {name}（{len(text)} 字节）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
