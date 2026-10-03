#!/usr/bin/env python3
"""生成 mapf/contracts/*.schema.json（契约的可机读形态）。

约定：
* schema 与 Rust 解析层（mapf/rust/src/problem.rs）的字段白名单**一一对应**——
  `additionalProperties:false` 保证“契约外字段必须被显式建模或显式拒绝”，
  与引擎的 E-MAPF-UNKNOWN-FIELD（警告）/E-CAP-*（能力外拒绝）形成双保险；
* 枚举值与 `src/errors.rs`、`src/capabilities.rs` 保持一致；
* 修改本目录任一 schema 后必须同步 `docs/ERROR-CODES.md`/`MODEL-MATH.md`。

用法：python3 mapf/contracts/make_schemas.py
"""
import json
from pathlib import Path

P = Path(__file__).resolve().parent

refid = {"type": "string", "minLength": 1}
nonneg = {"type": "integer", "minimum": 0}
pos = {"type": "integer", "minimum": 1}
cell = {
    "type": "array", "minItems": 2, "maxItems": 2,
    "items": nonneg, "description": "[x, y]，x 向右、y 向下，原点左上",
}
cells_arr = {"type": "array", "minItems": 1, "items": {"type": "string", "minLength": 1}}
ts = {"type": "string", "format": "date-time"}

# ------------------------------------------------------------------ problem
problem = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://example.invalid/mapf/mapf-problem.schema.json",
    "title": "MapfProblem v1",
    "type": "object",
    "additionalProperties": False,
    "required": ["map", "robots", "objective", "time_model"],
    "properties": {
        "schema_version": {"const": "mapf-problem/1.0"},
        "id": refid,
        "created_at": ts,
        "map": {
            "type": "object", "additionalProperties": False,
            "anyOf": [{"required": ["cells"]}, {"required": ["width", "height"]}],
            "properties": {
                "cells": cells_arr,
                "width": pos, "height": pos,
                "blocked": {"type": "array", "items": cell},
                "coordinates": {"enum": ["grid-corner", "center-origin"]},
            },
        },
        "time_model": {
            "type": "object", "additionalProperties": False,
            "required": ["horizon"],
            "properties": {
                "timestep": {"const": "discrete"},
                "horizon": {"anyOf": [pos, {"const": "auto"}]},
            },
        },
        "movement": {
            "type": "object", "additionalProperties": False,
            "properties": {
                "neighbors": {"enum": ["4+wait", "4+wait+sync"]},
                "sync": {"const": "synchronous"},
                "wait_action": {"type": "boolean"},
                "diagonal": {"type": "boolean"},
            },
        },
        "robots": {
            "type": "array", "minItems": 1,
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["id", "start", "goal"],
                "properties": {"id": refid, "start": cell, "goal": cell, "label": {"type": "string"}},
            },
        },
        "objective": {
            "type": "object", "additionalProperties": False,
            "required": ["kind"],
            "properties": {
                "kind": {"enum": ["soc", "makespan"]},
                "direction": {"const": "min"},
            },
        },
        "solver": {
            "type": "object", "additionalProperties": False,
            "properties": {
                "planner": {"enum": ["auto", "ecbs", "cbs", "pp", "prioritized"]},
                "time_limit_ms": {"type": "integer", "minimum": 1, "maximum": 900000},
                "seed": nonneg,
                "suboptimality_factor": {"type": "number", "minimum": 1.0, "maximum": 3.0},
                "max_expansions": nonneg,
                "warm_start": {"type": "boolean"},
                "restarts": nonneg,
            },
        },
        "benchmark": {
            "type": "object", "additionalProperties": False,
            "properties": {
                "source": {"type": "string"},
                "map_file": {"type": "string"}, "scen_file": {"type": "string"},
                "map_sha256": {"type": "string", "pattern": r"^sha256:[0-9a-f]{64}$"},
                "scen_sha256": {"type": "string", "pattern": r"^sha256:[0-9a-f]{64}$"},
                "instance_id": nonneg, "agents": pos,
                "converter_version": {"type": "string"},
                "cite": {"type": "string"},
                "conversion": {"type": "string", "description": "standard:line#N | additive:first-k-lines"},
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
                        "time": nonneg,
                        "frozen_steps": nonneg,
                        "frozen": {"type": "object", "additionalProperties": nonneg},
                        "paths": {"type": "object", "additionalProperties": {"type": "array", "items": cell}},
                        "prior_solution_hash": {"type": "string"},
                        "actual_positions": {"type": "object", "additionalProperties": cell},
                    },
                },
                "events": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["type", "at"],
                        "properties": {
                            "type": {"enum": ["obstacle_add", "obstacle_remove", "path_invalid", "goal_change"]},
                            "at": nonneg,
                            "until": {"anyOf": [nonneg, {"type": "null"}]},
                            "cell": cell,
                            "robot": refid,
                            "robots": {"type": "array", "items": refid},
                            "goal": cell,
                        },
                    },
                },
            },
        },
        "tags": {"type": "object"},
        "notes": {"type": "array", "items": {"type": "string"}},
    },
}

# ------------------------------------------------------------------ solution
issue = {
    "type": "object", "additionalProperties": False,
    "required": ["code", "path", "message"],
    "properties": {
        "code": {"type": "string", "pattern": r"^E-[A-Z0-9-]+$"},
        "severity": {"enum": ["error", "warning"]},
        "path": {"type": "string"},
        "message": {"type": "string"},
    },
}
solution = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://example.invalid/mapf/mapf-solution.schema.json",
    "title": "MapfSolution v1",
    "type": "object",
    "additionalProperties": False,
    "required": ["schema_version", "status", "optimality_proven", "verified", "robots", "errors"],
    "properties": {
        "schema_version": {"const": "mapf-solution/1.0"},
        "id": refid,
        "problem_id": {"type": "string"},
        "problem_hash": {"anyOf": [{"type": "string", "pattern": r"^sha256:[0-9a-f]{64}$"}, {"type": "null"}]},
        "engine": refid, "engine_version": refid,
        "compiler_version": {"type": "string"}, "ruleset_version": {"type": "string"},
        "capability_profile": {"enum": ["native", "wasm-light"]},
        "status": {"enum": ["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN", "INVALID_INPUT", "UNSUPPORTED", "CANCELLED"]},
        "optimality_proven": {"type": "boolean"},
        "verified": {"type": "boolean"},
        "objective": {
            "type": "object",
            "required": ["kind"],
            "properties": {
                "kind": {"enum": ["soc", "makespan"]},
                "direction": {"const": "min"},
                "value": {"anyOf": [nonneg, {"type": "null"}]},
                "lower_bound": nonneg,
                "gap": {"anyOf": [{"type": "number", "minimum": 1.0}, {"type": "null"}]},
                "suboptimality_factor": {"type": "number", "minimum": 1.0, "maximum": 3.0},
                "bound_note": {"type": "string"},
            },
        },
        "soc": {"anyOf": [nonneg, {"type": "null"}]},
        "makespan": {"anyOf": [nonneg, {"type": "null"}]},
        "horizon": nonneg,
        "time_model": {"type": "object"},
        "coordinate_convention": {"type": "string"},
        "robots": {
            "type": "array",
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["id", "path", "arrival"],
                "properties": {
                    "id": refid, "start": cell, "goal": cell,
                    "path": {"type": "array", "minItems": 2, "items": cell},
                    "arrival": nonneg, "steps": nonneg, "locked": {"type": "boolean"},
                },
            },
        },
        "search": {"type": "object"},
        "metrics": {"type": "object"},
        "benchmark": {"type": ["object", "null"]},
        "dynamic": {"type": ["object", "null"]},
        "verify": {"type": ["object", "null"]},
        "errors": {"type": "array", "items": issue},
        "notes": {"type": "array", "items": {"type": "string"}},
        "semantic_digest": {"type": "string"},
    },
}

# ------------------------------------------------------------------ verify
violation = {
    "type": "object", "additionalProperties": False,
    "required": ["code", "constraint", "severity", "message"],
    "properties": {
        "code": {"type": "string", "pattern": r"^E-[A-Z0-9-]+$"},
        "constraint": {"type": "string"},
        "severity": {"enum": ["error", "warning"]},
        "message": {"type": "string"},
        "robots": {"type": "array", "items": {"type": "string"}},
        "at_time": {"anyOf": [nonneg, {"type": "null"}]},
        "cell": {"anyOf": [cell, {"type": "null"}]},
        "expected": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "actual": {"anyOf": [{"type": "string"}, {"type": "null"}]},
    },
}
verify = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://example.invalid/mapf/mapf-verify.schema.json",
    "title": "MapfVerifyReport v1",
    "type": "object",
    "additionalProperties": False,
    "required": ["schema_version", "ok", "violations", "checks"],
    "properties": {
        "schema_version": {"const": "mapf-verify/1.0"},
        "mode": {"enum": ["full", "full+strict"]},
        "ruleset_version": {"type": "string"},
        "ok": {"type": "boolean"},
        "counts": {"type": "object"},
        "checks": {
            "type": "array",
            "items": {
                "type": "object", "additionalProperties": False, "required": ["name", "ok"],
                "properties": {"name": {"type": "string"}, "ok": {"type": "boolean"}},
            },
        },
        "violations": {"type": "array", "items": violation},
        "recomputed": {"type": ["object", "null"]},
    },
}

# ------------------------------------------------------------------ capabilities
capabilities = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://example.invalid/mapf/mapf-capabilities.schema.json",
    "title": "MapfSolverCapabilities v1",
    "type": "object",
    "additionalProperties": False,
    "required": ["schema_version", "engine", "version", "profile", "semantics", "objectives", "proofs", "limits", "unsupported_features"],
    "properties": {
        "schema_version": {"const": "mapf-capabilities/1.0"},
        "engine": refid, "version": refid,
        "profile": {"enum": ["native", "wasm-light"]},
        "semantics": {"type": "object", "required": ["time", "movement", "conflicts", "stay_at_target", "ruleset_version"]},
        "objectives": {"type": "array", "items": {"enum": ["soc", "makespan"]}},
        "proofs": {"type": "object"},
        "dynamic": {"type": "object"},
        "limits": {
            "type": "object",
            "required": ["max_agents", "max_cells", "max_horizon", "max_budget_ms"],
            "properties": {"max_agents": pos, "max_cells": pos, "max_side": pos, "max_horizon": pos, "max_budget_ms": pos},
        },
        "unsupported_features": {"type": "array", "items": {"type": "string"}},
        "verification": {"type": "string"},
        "determinism": {"type": "string"},
        "benchmark": {"type": "string"},
    },
}

# ------------------------------------------------------------------ bench manifest
bench_manifest = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://example.invalid/mapf/mapf-bench-manifest.schema.json",
    "title": "MapfBenchManifest v1",
    "type": "object",
    "additionalProperties": False,
    "required": ["schema_version", "entries", "budgets_ms", "objectives"],
    "properties": {
        "schema_version": {"const": "mapf-bench-manifest/1.0"},
        "entries": {
            "type": "array", "minItems": 1,
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["name", "family", "map_file", "map_sha256", "scen_file", "scen_sha256", "agent_counts"],
                "properties": {
                    "name": refid, "family": refid,
                    "map_file": refid, "scen_file": refid,
                    "map_sha256": {"type": "string", "pattern": r"^sha256:[0-9a-f]{64}$"},
                    "scen_sha256": {"type": "string", "pattern": r"^sha256:[0-9a-f]{64}$"},
                    "agent_counts": {"type": "array", "minItems": 1, "items": pos, "uniqueItems": True},
                    "note": {"type": "string"},
                },
            },
        },
        "budgets_ms": {"type": "array", "minItems": 1, "items": pos},
        "objectives": {"type": "array", "minItems": 1, "items": {"enum": ["soc", "makespan"]}, "uniqueItems": True},
        "suboptimality_factor": {"type": "number", "minimum": 1.0, "maximum": 3.0},
        "seed": nonneg,
        "horizon": {"anyOf": [pos, {"const": "auto"}]},
        "upstream": {"type": "object"},
    },
}

for name, obj in [
    ("mapf-problem.schema.json", problem),
    ("mapf-solution.schema.json", solution),
    ("mapf-verify.schema.json", verify),
    ("mapf-capabilities.schema.json", capabilities),
    ("mapf-bench-manifest.schema.json", bench_manifest),
]:
    with (P / name).open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")
print(f"已生成 {len(list(P.glob('*.schema.json')))} 份 schema → mapf/contracts/")
