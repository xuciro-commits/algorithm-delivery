#!/usr/bin/env python3
"""生成 agv/contracts/*.schema.json（AGV Dispatch 契约的可机读形态）。

约定（与 mapf/contracts/make_schemas.py 一致）：
* schema 与 Rust 解析层（agv/rust/src/problem.rs）的字段白名单**一一对应**；
* 枚举值与 `agv/rust/src/errors.rs`、`agv/rust/src/capabilities.rs` 保持一致；
* 修改任一 schema 后必须同步 `agv/rust/docs/ERROR-CODES.md` 与 AGV-SRS.md。

用法：python3 agv/contracts/make_schemas.py
"""
import json
from pathlib import Path

P = Path(__file__).resolve().parent

refid = {"type": "string", "minLength": 1}
nonneg = {"type": "integer", "minimum": 0}
pos = {"type": "integer", "minimum": 1}
step = {"type": "integer", "minimum": 0}
cell = {
    "type": "array", "minItems": 2, "maxItems": 2, "items": nonneg,
    "description": "[x, y]，x 向右、y 向下，原点左上",
}
cells_arr = {"type": "array", "minItems": 1, "items": {"type": "string", "minLength": 1}}

loc = {
    "description": "位置：显式格 [x,y]，或工作站引用",
    "oneOf": [
        cell,
        {
            "type": "object", "additionalProperties": False, "required": ["station"],
            "properties": {"station": refid},
        },
    ],
}

# ------------------------------------------------------------------ problem
problem = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://example.invalid/agv/agv-dispatch-problem.schema.json",
    "title": "AgvDispatchProblem v1",
    "type": "object",
    "additionalProperties": False,
    "required": ["map", "vehicles", "tasks", "objective", "time_model"],
    "properties": {
        "schema_version": {"const": "agv-dispatch-problem/1.0"},
        "id": refid,
        "map": {
            "type": "object", "additionalProperties": False,
            "anyOf": [{"required": ["cells"]}],
            "properties": {"cells": cells_arr},
        },
        "time_model": {
            "type": "object", "additionalProperties": False, "required": ["horizon"],
            "properties": {
                "timestep": {"const": "discrete"},
                "horizon": {"anyOf": [pos, {"const": "auto"}]},
            },
        },
        "vehicles": {
            "type": "array", "minItems": 1,
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["id", "start"],
                "properties": {
                    "id": refid,
                    "start": cell,
                    "capabilities": {"type": "array", "minItems": 1, "items": refid, "uniqueItems": True},
                    "status": {"enum": ["available", "paused"]},
                },
            },
        },
        "tasks": {
            "type": "array",
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["id", "pickup", "dropoff"],
                "properties": {
                    "id": refid,
                    "pickup": loc,
                    "dropoff": loc,
                    "release_step": step,
                    "priority": pos,
                    "pickup_service": step,
                    "dropoff_service": step,
                    "due_step": {"anyOf": [step, {"type": "null"}]},
                    "required_capability": {"anyOf": [refid, {"type": "null"}]},
                },
            },
        },
        "stations": {
            "type": "array",
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["id", "cells"],
                "properties": {
                    "id": refid,
                    "cells": {"type": "array", "minItems": 1, "uniqueItems": True, "items": cell},
                    "capacity": pos,
                },
            },
        },
        "parking": {"type": "array", "uniqueItems": True, "items": cell},
        "objective": {
            "type": "object", "additionalProperties": False, "required": ["kind"],
            "properties": {
                "kind": {"const": "lexicographic-weighted"},
                "weights": {
                    "type": "object", "additionalProperties": False,
                    "properties": {
                        "makespan": {"type": "number", "minimum": 0},
                        "flow_time": {"type": "number", "minimum": 0},
                        "empty_travel": {"type": "number", "minimum": 0},
                        "lateness": {"type": "number", "minimum": 0},
                    },
                },
            },
        },
        "solver": {
            "type": "object", "additionalProperties": False,
            "properties": {
                "algorithm": {"enum": ["auto", "baseline", "insertion-ls"]},
                "time_limit_ms": pos,
                "seed": nonneg,
                "frozen_steps": step,
                "mapf": {
                    "type": "object", "additionalProperties": False,
                    "properties": {
                        "planner": {"enum": ["auto", "ecbs", "cbs", "pp"]},
                        "suboptimality_factor": {"type": "number", "minimum": 1.0, "maximum": 3.0},
                        "time_limit_ms": pos,
                    },
                },
            },
        },
        "dynamic": {
            "type": "object", "additionalProperties": False,
            "required": ["snapshot", "events"],
            "properties": {
                "snapshot": {
                    "type": "object", "additionalProperties": False,
                    "required": ["time"],
                    "properties": {
                        "time": step,
                        "vehicles": {
                            "type": "object",
                            "additionalProperties": {
                                "type": "object", "additionalProperties": False,
                                "required": ["pos"],
                                "properties": {
                                    "pos": cell,
                                    "phase": {
                                        "enum": ["idle", "to_pickup", "servicing_pickup",
                                                 "to_dropoff", "servicing_dropoff", "parking", "paused"],
                                    },
                                    "task": {"anyOf": [refid, {"type": "null"}]},
                                    "path": {"type": "array", "minItems": 1, "items": cell},
                                },
                            },
                        },
                        "tasks": {
                            "type": "object",
                            "additionalProperties": {
                                "type": "object", "additionalProperties": False,
                                "required": ["status"],
                                "properties": {
                                    "status": {
                                        "enum": ["pending", "assigned", "picked", "done",
                                                 "unassigned", "leg_infeasible", "budget", "cancelled"],
                                    },
                                    "assignee": {"anyOf": [refid, {"type": "null"}]},
                                    "pickup_dock": {"anyOf": [cell, {"type": "null"}]},
                                    "dropoff_dock": {"anyOf": [cell, {"type": "null"}]},
                                    "pickup_arrival": {"anyOf": [step, {"type": "null"}]},
                                    "pickup_done": {"anyOf": [step, {"type": "null"}]},
                                    "dropoff_arrival": {"anyOf": [step, {"type": "null"}]},
                                    "dropoff_done": {"anyOf": [step, {"type": "null"}]},
                                },
                            },
                        },
                    },
                },
                "events": {
                    "type": "array",
                    "items": {
                        "type": "object", "required": ["type"],
                        "properties": {
                            "type": {
                                "enum": ["task_add", "task_cancel", "task_priority",
                                         "vehicle_pause", "vehicle_resume",
                                         "obstacle_add", "obstacle_remove"],
                            },
                            "task": refid,
                            "task_def": {
                                "type": "object",
                                "properties": {
                                    "id": refid, "pickup": loc, "dropoff": loc,
                                    "release_step": step, "priority": pos,
                                    "pickup_service": step, "dropoff_service": step,
                                    "due_step": {"anyOf": [step, {"type": "null"}]},
                                    "required_capability": {"anyOf": [refid, {"type": "null"}]},
                                },
                            },
                            "priority": pos,
                            "vehicle": refid,
                            "cell": cell,
                        },
                    },
                },
            },
        },
        "tags": {"type": "object"},
    },
}

# ------------------------------------------------------------------ solution
solution = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://example.invalid/agv/agv-dispatch-solution.schema.json",
    "title": "AgvDispatchSolution v1",
    "type": "object",
    "additionalProperties": False,
    "required": ["schema_version", "status", "verified", "plan", "errors"],
    "properties": {
        "schema_version": {"const": "agv-dispatch-solution/1.0"},
        "id": refid,
        "problem_id": {"type": "string"},
        "problem_hash": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "engine": refid,
        "engine_version": refid,
        "mapf_engine_version": {"type": "string"},
        "compiler_version": {"type": "string"},
        "ruleset_version": {"type": "string"},
        "capability_profile": {"enum": ["native", "wasm-light"]},
        "status": {
            "enum": ["FEASIBLE", "PARTIAL", "UNKNOWN", "INFEASIBLE",
                     "INVALID_INPUT", "UNSUPPORTED", "CANCELLED"],
        },
        "verified": {"type": "boolean"},
        "plan": {
            "type": "object", "additionalProperties": False,
            "required": ["horizon", "vehicles", "tasks"],
            "properties": {
                "horizon": step,
                "start_step": {"type": "integer", "minimum": 0, "default": 0,
                               "description": "本解开始规划的绝对时刻（动态重调度 = 快照时刻；0 = 全程规划）。任务段自此时刻起，之前的 timeline 为已执行历史"},
                "vehicles": {
                    "type": "array",
                    "items": {
                        "type": "object", "additionalProperties": False,
                        "required": ["id", "timeline", "missions"],
                        "properties": {
                            "id": refid,
                            "timeline": {"type": "array", "minItems": 1, "items": cell,
                                         "description": "timeline[t] = t 步末所在格，覆盖 0..horizon"},
                            "missions": {
                                "type": "array",
                                "items": {
                                    "type": "object", "additionalProperties": False,
                                    "required": ["task", "phase", "from", "to"],
                                    "properties": {
                                        "task": {"anyOf": [refid, {"type": "null"}]},
                                        "phase": {
                                            "enum": ["to_pickup", "servicing_pickup",
                                                     "to_dropoff", "servicing_dropoff",
                                                     "done", "relocating", "parked"],
                                        },
                                        "from": step, "to": step,
                                        "dock": {"anyOf": [cell, {"type": "null"}]},
                                    },
                                },
                            },
                        },
                    },
                },
                "tasks": {
                    "type": "array",
                    "items": {
                        "type": "object", "additionalProperties": False,
                        "required": ["id", "status"],
                        "properties": {
                            "id": refid,
                            "status": {
                                "enum": ["completed", "assigned", "picked",
                                         "unassigned", "leg_infeasible", "budget", "cancelled"],
                            },
                            "vehicle": {"anyOf": [refid, {"type": "null"}]},
                            "pickup_dock": {"anyOf": [cell, {"type": "null"}]},
                            "dropoff_dock": {"anyOf": [cell, {"type": "null"}]},
                            "pickup_arrival": {"anyOf": [step, {"type": "null"}]},
                            "pickup_done": {"anyOf": [step, {"type": "null"}]},
                            "dropoff_arrival": {"anyOf": [step, {"type": "null"}]},
                            "dropoff_done": {"anyOf": [step, {"type": "null"}]},
                            "flow_time": {"anyOf": [step, {"type": "null"}]},
                            "lateness": {"anyOf": [step, {"type": "null"}]},
                            "reason": {"anyOf": [refid, {"type": "null"}]},
                        },
                    },
                },
            },
        },
        "metrics": {"type": "object"},
        "search": {"type": "object"},
        "dynamic": {"type": ["object", "null"]},
        "verify": {"type": ["object", "null"]},
        "errors": {
            "type": "array",
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["code", "path", "message"],
                "properties": {
                    "code": {"type": "string", "pattern": "^E-[A-Z0-9-]+$"},
                    "severity": {"enum": ["error", "warning"]},
                    "path": {"type": "string"},
                    "message": {"type": "string"},
                },
            },
        },
        "notes": {"type": "array", "items": {"type": "string"}},
        "fingerprint": {"type": "string"},
    },
}

# ------------------------------------------------------------------ verification
verification = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://example.invalid/agv/agv-dispatch-verification.schema.json",
    "title": "AgvDispatchVerification v1",
    "type": "object",
    "additionalProperties": False,
    "required": ["schema_version", "ok", "checks", "violations"],
    "properties": {
        "schema_version": {"const": "agv-dispatch-verification/1.0"},
        "mode": {"enum": ["full", "full+strict"]},
        "ruleset_version": {"type": "string"},
        "ok": {"type": "boolean"},
        "counts": {"type": "object"},
        "checks": {
            "type": "array",
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["name", "ok"],
                "properties": {"name": refid, "ok": {"type": "boolean"}},
            },
        },
        "violations": {
            "type": "array",
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["code", "constraint", "severity", "message"],
                "properties": {
                    "code": {"type": "string", "pattern": "^E-[A-Z0-9-]+$"},
                    "constraint": refid,
                    "severity": {"enum": ["error", "warning"]},
                    "message": {"type": "string"},
                    "vehicles": {"type": "array", "items": refid},
                    "tasks": {"type": "array", "items": refid},
                    "at_step": {"anyOf": [step, {"type": "null"}]},
                    "cell": {"anyOf": [cell, {"type": "null"}]},
                },
            },
        },
        "recomputed": {"type": ["object", "null"]},
    },
}

# ------------------------------------------------------------------ capabilities
capabilities = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://example.invalid/agv/agv-dispatch-capabilities.schema.json",
    "title": "AgvDispatchCapabilities v1",
    "type": "object",
    "additionalProperties": False,
    "required": ["schema_version", "engine", "version", "profile", "limits", "algorithms"],
    "properties": {
        "schema_version": {"const": "agv-dispatch-capabilities/1.0"},
        "engine": refid,
        "version": refid,
        "profile": {"enum": ["native", "wasm-light"]},
        "limits": {
            "type": "object", "additionalProperties": False,
            "properties": {
                "max_vehicles": pos,
                "max_tasks": pos,
                "max_map_cells": pos,
                "max_horizon": pos,
                "max_budget_ms": pos,
                "max_events": pos,
                "max_input_bytes": pos,
            },
        },
        "algorithms": {"type": "array", "minItems": 1, "items": refid, "uniqueItems": True},
        "mapf": {"type": "object"},
        "unsupported_features": {"type": "array", "items": refid},
    },
}

# --out <dir>：输出到指定目录（用于防漂移比对）；默认原地覆盖 agv/contracts/。
import os
import sys

OUT = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else P
OUT.mkdir(parents=True, exist_ok=True)
for name, obj in [
    ("agv-dispatch-problem.schema.json", problem),
    ("agv-dispatch-solution.schema.json", solution),
    ("agv-dispatch-verification.schema.json", verification),
    ("agv-dispatch-capabilities.schema.json", capabilities),
]:
    with (OUT / name).open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")
print(f"已生成 4 份 schema → {OUT}")
