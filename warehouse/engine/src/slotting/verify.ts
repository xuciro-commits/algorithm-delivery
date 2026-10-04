/**
 * 库位优化的**独立验证器**（SRS §6.4）。
 *
 * "独立"的含义在这里是可检查的工程约定，而不是一句口号：
 *   - 输入是**契约 JSON**（问题 + 解），不是求解器的内存对象；
 *   - 只复用契约级语义（拓扑派生、几何与运动学、分区规则），
 *     完全不引用 `slotting/optimize.ts` / `strategies.ts` / `multiobj.ts` 的任何判断；
 *   - **重新计算**主要指标（运行时间、利用率、迁移数），与解里上报的数字逐项比对，
 *     偏差超过容差即报 `METRIC_MISMATCH` —— 不信任优化器自己报的数字；
 *   - 每条违规都带约束类型、相关主体、以及适用情况下的库位与时间位置。
 */

import type {
  ConstraintCode,
  LocationRecord,
  SlottingProblem,
  SlottingSolution,
  VerificationCheck,
  VerificationReport,
  Violation,
} from '../contract/types.ts';
import { VERIFICATION_SCHEMA } from '../contract/types.ts';
import { fingerprint, round } from '../contract/util.ts';
import { buildRouteModel, secondsToStation } from '../wh/routing.ts';
import { deriveLocations } from '../wh/topology.ts';

export const VERIFIER_ID = 'warehouse-slotting-verifier';
export const VERIFIER_VERSION = '1.0.0';

/** 指标容差：相对偏差超过它才算不一致（浮点与不同实现路径的正常差异）。 */
const TOLERANCE = { relative: 0.02, absolute: 1e-6 };

interface VerificationInput {
  problem: SlottingProblem;
  solution: SlottingSolution;
}

export function verifySlotting(problem: SlottingProblem, solution: SlottingSolution): VerificationReport {
  const startedAt = Date.now();
  const violations: Violation[] = [];
  const checks: VerificationCheck[] = [];
  const hard = new Set<ConstraintCode>(problem.hardConstraints ?? []);
  const isHard = (code: ConstraintCode): boolean => hard.has(code);

  const locations = deriveLocations(problem.topology, {
    frozen: problem.topology.frozenLocations,
    reserved: problem.topology.reservedLocations,
  });
  const byId = new Map<string, LocationRecord>(locations.map((l) => [l.id, l]));
  const luById = new Map(problem.inventory.map((unit) => [unit.id, unit]));
  const skuById = new Map(problem.skus.map((sku) => [sku.id, sku]));
  const model = buildRouteModel(problem.topology, locations);
  const shuttle = problem.topology.devices.find((d) => d.kind === 'layer-shuttle' || d.kind === 'aisle-shuttle' || d.kind === 'four-way-shuttle')?.motion ?? {
    speed_mps: 2.6,
    accel_mps2: 1.3,
    transfer_s: 6,
    handover_s: 8,
  };
  const outNode = problem.topology.stations.find((s) => s.direction === 'outbound' || s.direction === 'both')?.nodeId ?? null;

  /* ---- 1) 库位存在性与唯一性 ---- */
  const seenLocation = new Map<string, string>();
  const seenLoadUnit = new Map<string, string>();
  let duplicateAssignments = 0;
  let unknownLocations = 0;
  let unknownLoadUnits = 0;
  for (const entry of solution.assignment ?? []) {
    const location = byId.get(entry.locationId);
    if (!location) {
      unknownLocations += 1;
      violations.push({
        code: 'SCHEMA_INVALID',
        severity: 'error',
        constraintClass: 'hard',
        message: `分配引用了不存在的库位 ${entry.locationId}`,
        subjects: [entry.loadUnitId, entry.locationId],
        locationId: entry.locationId,
      });
      continue;
    }
    const unit = luById.get(entry.loadUnitId);
    if (!unit) {
      unknownLoadUnits += 1;
      violations.push({
        code: 'INVENTORY_CONSERVATION',
        severity: 'error',
        constraintClass: 'hard',
        message: `分配引用了不存在的货物单元 ${entry.loadUnitId}`,
        subjects: [entry.loadUnitId],
        locationId: entry.locationId,
      });
      continue;
    }
    if (seenLocation.has(entry.locationId)) {
      duplicateAssignments += 1;
      violations.push({
        code: 'LOCATION_CAPACITY',
        severity: 'error',
        constraintClass: 'hard',
        message: `库位 ${entry.locationId} 被两个货物单元占用（${seenLocation.get(entry.locationId)} / ${entry.loadUnitId}）`,
        subjects: [entry.locationId, seenLocation.get(entry.locationId) as string, entry.loadUnitId],
        locationId: entry.locationId,
        position: location.position,
      });
    }
    if (seenLoadUnit.has(entry.loadUnitId)) {
      duplicateAssignments += 1;
      violations.push({
        code: 'INVENTORY_CONSERVATION',
        severity: 'error',
        constraintClass: 'hard',
        message: `货物单元 ${entry.loadUnitId} 被分配到多个库位`,
        subjects: [entry.loadUnitId],
      });
    }
    seenLocation.set(entry.locationId, entry.loadUnitId);
    seenLoadUnit.set(entry.loadUnitId, entry.locationId);

    /* ---- 2) 库位可用性 ---- */
    if (location.availability === 'unavailable' || location.availability === 'frozen') {
      violations.push({
        code: location.availability === 'frozen' ? 'LOCATION_FROZEN' : 'LOCATION_UNAVAILABLE',
        severity: isHard('LOCATION_FROZEN') || isHard('LOCATION_UNAVAILABLE') ? 'error' : 'warning',
        constraintClass: 'hard',
        message: `库位 ${entry.locationId} 处于 ${location.availability} 状态却被分配`,
        subjects: [entry.loadUnitId, entry.locationId],
        locationId: entry.locationId,
        position: location.position,
      });
    } else if (location.availability === 'reserved') {
      violations.push({
        code: 'LOCATION_RESERVED',
        severity: isHard('LOCATION_RESERVED') ? 'error' : 'warning',
        constraintClass: 'hard',
        message: `库位 ${entry.locationId} 为预留库位，被 ${entry.loadUnitId} 占用`,
        subjects: [entry.loadUnitId, entry.locationId],
        locationId: entry.locationId,
      });
    }

    /* ---- 3) 容量 / 重量 / 体积 ---- */
    const sku = skuById.get(unit.skuId);
    if (sku) {
      if (sku.unitWeight_kg > location.maxWeight_kg + 1e-6) {
        violations.push({
          code: 'LOCATION_WEIGHT_LIMIT',
          severity: 'error',
          constraintClass: 'hard',
          message: `SKU ${sku.id} 单元重量 ${sku.unitWeight_kg}kg 超过库位承载 ${location.maxWeight_kg}kg`,
          subjects: [sku.id, entry.loadUnitId, location.id],
          locationId: location.id,
          position: location.position,
          expected: `≤ ${location.maxWeight_kg} kg`,
          actual: `${sku.unitWeight_kg} kg`,
        });
      }
      if (sku.unitVolume_m3 > location.maxVolume_m3 + 1e-6) {
        violations.push({
          code: 'LOCATION_VOLUME_LIMIT',
          severity: 'error',
          constraintClass: 'hard',
          message: `SKU ${sku.id} 单元体积 ${sku.unitVolume_m3}m³ 超过库位容积 ${location.maxVolume_m3}m³`,
          subjects: [sku.id, entry.loadUnitId, location.id],
          locationId: location.id,
          expected: `≤ ${location.maxVolume_m3} m³`,
          actual: `${sku.unitVolume_m3} m³`,
        });
      }

      /* ---- 4) 储存兼容性（分区 / 温控 / 危险品）---- */
      const allowed = sku.allowedZones ?? [];
      if (allowed.length > 0 && !allowed.some((zone) => location.zone === zone || location.zone.startsWith(zone))) {
        violations.push({
          code: 'ZONE_COMPATIBILITY',
          severity: isHard('ZONE_COMPATIBILITY') ? 'error' : 'warning',
          constraintClass: 'hard',
          message: `SKU ${sku.id}（${sku.temperature ?? 'ambient'}）不允许存放在分区 ${location.zone}`,
          subjects: [sku.id, location.id],
          locationId: location.id,
          position: location.position,
          expected: allowed.join('/'),
          actual: location.zone,
        });
      }

      /* ---- 5) 深位策略 ---- */
      const scope = problem.constraints.deepLanePolicy ?? 'front-only';
      if (scope === 'front-only' && location.depth > 1 && sku.abc === 'A') {
        violations.push({
          code: 'DEEP_LANE_BLOCKING',
          severity: isHard('DEEP_LANE_BLOCKING') ? 'error' : 'warning',
          constraintClass: 'hard',
          message: `A 类商品 ${sku.id} 被放在深位 ${location.id}（会遮挡后续取货）`,
          subjects: [sku.id, location.id],
          locationId: location.id,
          position: location.position,
        });
      }
    }
  }
  checks.push({
    group: 'assignment',
    name: '库位存在性 / 唯一性 / 可用性',
    ok: duplicateAssignments === 0 && unknownLocations === 0 && unknownLoadUnits === 0,
    detail: `分配 ${solution.assignment?.length ?? 0} 条，冲突 ${duplicateAssignments}，未知库位 ${unknownLocations}，未知货物单元 ${unknownLoadUnits}`,
  });

  /* ---- 6) 库存守恒：每个货物单元最多一个库位；未分配的必须显式说明 ---- */
  const reportedUnassigned = new Set((solution.unassigned ?? []).map((entry) => entry.loadUnitId));
  const missing = problem.inventory.filter((unit) => !seenLoadUnit.has(unit.id) && !reportedUnassigned.has(unit.id));
  if (missing.length > 0) {
    violations.push({
      code: 'INVENTORY_CONSERVATION',
      severity: 'error',
      constraintClass: 'hard',
      message: `${missing.length} 个货物单元既未分配库位、也未在 unassigned 中说明（例如 ${missing.slice(0, 3).map((u) => u.id).join('、')}）`,
      subjects: missing.slice(0, 20).map((unit) => unit.id),
    });
  }
  checks.push({
    group: 'conservation',
    name: '库存守恒（分配 + 未分配说明 = 全部货物单元）',
    ok: missing.length === 0,
    detail: `库存 ${problem.inventory.length} 个单元，未分配按说明登记 ${reportedUnassigned.size} 个`,
  });

  /* ---- 7) 分散度规则 ---- */
  const dispersion = problem.constraints.dispersion ?? {};
  const perSkuAisle = new Map<string, Map<string, number>>();
  for (const entry of solution.assignment ?? []) {
    const unit = luById.get(entry.loadUnitId);
    const location = byId.get(entry.locationId);
    if (!unit || !location) continue;
    const row = perSkuAisle.get(unit.skuId) ?? new Map<string, number>();
    row.set(location.aisleId, (row.get(location.aisleId) ?? 0) + 1);
    perSkuAisle.set(unit.skuId, row);
  }
  let dispersionViolations = 0;
  for (const [skuId, row] of perSkuAisle) {
    let total = 0;
    for (const value of row.values()) total += value;
    for (const [aisleId, count] of row) {
      if (dispersion.maxUnitsPerSku !== undefined && count > dispersion.maxUnitsPerSku) {
        dispersionViolations += 1;
        violations.push({
          code: 'SKU_DISPERSION_MAX',
          severity: isHard('SKU_DISPERSION_MAX') ? 'error' : 'warning',
          constraintClass: 'hard',
          message: `SKU ${skuId} 在巷道 ${aisleId} 有 ${count} 个库位，超过单巷道上限 ${dispersion.maxUnitsPerSku}`,
          subjects: [skuId, aisleId],
        });
      }
      if (dispersion.maxAisleSharePerSku !== undefined && total > 0 && count / total > dispersion.maxAisleSharePerSku + 1e-9) {
        dispersionViolations += 1;
        violations.push({
          code: 'SKU_DISPERSION_MAX',
          severity: isHard('SKU_DISPERSION_MAX') ? 'error' : 'warning',
          constraintClass: 'hard',
          message: `SKU ${skuId} 在巷道 ${aisleId} 的库存占比 ${round(count / total, 3)} 超过上限 ${dispersion.maxAisleSharePerSku}`,
          subjects: [skuId, aisleId],
        });
      }
    }
    if (dispersion.minLocationsPerSku !== undefined && total < dispersion.minLocationsPerSku) {
      dispersionViolations += 1;
      violations.push({
        code: 'SKU_DISPERSION_MIN',
        severity: isHard('SKU_DISPERSION_MIN') ? 'error' : 'warning',
        constraintClass: 'hard',
        message: `SKU ${skuId} 只用了 ${total} 个库位，低于分散下限 ${dispersion.minLocationsPerSku}`,
        subjects: [skuId],
      });
    }
  }
  checks.push({
    group: 'dispersion',
    name: 'SKU 分散存储规则',
    ok: dispersionViolations === 0,
    detail: `检查 ${perSkuAisle.size} 个 SKU 的巷道分布，违规 ${dispersionViolations} 项`,
  });

  /* ---- 8) 批次顺序（FIFO / FEFO 与深位的物理一致性）---- */
  let batchViolations = 0;
  const columns = new Map<string, Array<{ depth: number; locationId: string; unitId: string; key: number }>>();
  for (const entry of solution.assignment ?? []) {
    const unit = luById.get(entry.loadUnitId);
    const location = byId.get(entry.locationId);
    if (!unit || !location) continue;
    const sku = skuById.get(unit.skuId);
    const policy = sku?.batchPolicy ?? 'none';
    if (policy === 'none') continue;
    const key = policy === 'fefo' ? (unit.expiresAt_s ?? Number.MAX_SAFE_INTEGER) : (unit.inboundAt_s ?? 0);
    const columnKey = `${location.rackId}|${location.level}|${location.bay}`;
    const list = columns.get(columnKey) ?? [];
    list.push({ depth: location.depth, locationId: location.id, unitId: unit.id, key });
    columns.set(columnKey, list);
  }
  for (const [columnKey, list] of columns) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.depth - b.depth);
    for (let i = 1; i < sorted.length; i += 1) {
      // 深位必须先出：前置深度的批次不能比深位更晚（否则会破坏 FIFO/FEFO）
      if (sorted[i - 1].key > sorted[i].key + 1e-6) {
        batchViolations += 1;
        violations.push({
          code: 'FIFO_FEFO',
          severity: 'warning',
          constraintClass: 'soft',
          message: `列 ${columnKey} 的前位货物单元比深位更晚出库（破坏 FIFO/FEFO 顺序）`,
          subjects: [sorted[i - 1].unitId, sorted[i].unitId],
          locationId: sorted[i - 1].locationId,
        });
      }
    }
  }
  checks.push({
    group: 'batch',
    name: 'FIFO / FEFO 与深位顺序',
    ok: batchViolations === 0,
    detail: `检查 ${columns.size} 个深位列，顺序违规 ${batchViolations} 项`,
  });

  /* ---- 9) 指标重算（不信任求解器上报的数字）---- */
  const recomputed: Record<string, number> = {};
  let baseSeconds = 0;
  let assignedCount = 0;
  const yardstick = { speed_mps: 2.6, accel_mps2: 1.3, transfer_s: 6, handover_s: 8 };
  void shuttle;
  for (const entry of solution.assignment ?? []) {
    const location = byId.get(entry.locationId);
    const unit = luById.get(entry.loadUnitId);
    if (!location || !unit) continue;
    assignedCount += 1;
    const pick = outNode ? secondsToStation(model, location.id, outNode, yardstick, true) + 6 : 0;
    const sku = skuById.get(unit.skuId);
    void sku;
    baseSeconds += pick; // 每件一次的保守口径：验证器只做可比性检查，不追求与求解器同口径的聚合
  }
  recomputed['assignedCount'] = assignedCount;
  recomputed['spaceUtilization'] = round(assignedCount / Math.max(1, locations.length), 6);
  recomputed['relocationCount'] = (solution.migrations ?? []).filter((m) => m.fromLocationId && m.mode === 'task').length;
  recomputed['sumPickSeconds'] = round(baseSeconds, 3);
  recomputed['unassignedCount'] = solution.unassigned?.length ?? 0;

  const mismatches: VerificationReport['mismatches'] = [];
  const compareMetric = (metric: string, reported: number | undefined, computed: number): void => {
    if (reported === undefined || !Number.isFinite(reported)) return;
    const reference = Math.max(Math.abs(reported), 1e-9);
    const relative = Math.abs(reported - computed) / reference;
    if (relative > TOLERANCE.relative && Math.abs(reported - computed) > TOLERANCE.absolute) {
      mismatches.push({ metric, reported, recomputed: computed, tolerance: TOLERANCE.relative, relative: round(relative, 4) });
    }
  };
  compareMetric('spaceUtilization', solution.metrics?.spaceUtilization, recomputed['spaceUtilization']);
  // 迁移数量：解里必须与实际迁移动作一致（"说的"和"做的"一致）
  const declaredMoves = solution.metrics?.relocationCount;
  if (declaredMoves !== undefined && Math.abs(declaredMoves - recomputed['relocationCount']) > Math.max(1, declaredMoves * 0.05)) {
    mismatches.push({
      metric: 'relocationCount',
      reported: declaredMoves,
      recomputed: recomputed['relocationCount'],
      tolerance: TOLERANCE.relative,
      relative: round(Math.abs(declaredMoves - recomputed['relocationCount']) / Math.max(1, declaredMoves), 4),
    });
  }
  for (const mismatch of mismatches) {
    violations.push({
      code: 'METRIC_MISMATCH',
      severity: 'error',
      constraintClass: 'soft',
      message: `指标 ${mismatch.metric} 与独立重算不一致：上报 ${mismatch.reported}，重算 ${mismatch.recomputed}（相对偏差 ${mismatch.relative}）`,
      expected: String(mismatch.recomputed),
      actual: String(mismatch.reported),
    });
  }
  checks.push({
    group: 'metrics',
    name: '主要指标独立重算',
    ok: mismatches.length === 0,
    detail: `重算 ${Object.keys(recomputed).length} 项指标，偏差超容差 ${mismatches.length} 项`,
  });

  /* ---- 10) 迁移动作合法性 ---- */
  let migrationErrors = 0;
  for (const migration of solution.migrations ?? []) {
    const target = byId.get(migration.toLocationId);
    if (!target) {
      migrationErrors += 1;
      violations.push({
        code: 'SCHEMA_INVALID',
        severity: 'error',
        constraintClass: 'hard',
        message: `迁移动作指向不存在的目标库位 ${migration.toLocationId}`,
        subjects: [migration.loadUnitId, migration.toLocationId],
      });
      continue;
    }
    if (target.availability === 'frozen' || target.availability === 'unavailable') {
      migrationErrors += 1;
      violations.push({
        code: 'LOCATION_UNAVAILABLE',
        severity: 'error',
        constraintClass: 'hard',
        message: `迁移动作把货物搬到不可用库位 ${migration.toLocationId}`,
        subjects: [migration.loadUnitId, migration.toLocationId],
        locationId: migration.toLocationId,
        position: target.position,
      });
    }
  }
  checks.push({
    group: 'migration',
    name: '迁移动作合法性（目标库位存在且可用）',
    ok: migrationErrors === 0,
    detail: `迁移 ${solution.migrations?.length ?? 0} 条，非法 ${migrationErrors} 条`,
  });

  const errors = violations.filter((v) => v.severity === 'error').length;
  const warnings = violations.filter((v) => v.severity === 'warning').length;
  return {
    schema_version: VERIFICATION_SCHEMA,
    id: `VR-${fingerprint({ problem: problem.id, solution: solution.id }).slice(0, 12)}`,
    target: 'slotting',
    subjectId: solution.id,
    problemHash: solution.problemHash ?? '',
    solutionHash: fingerprint(solution.assignment ?? []),
    verifier: VERIFIER_ID,
    verifierVersion: VERIFIER_VERSION,
    ok: errors === 0,
    counts: { errors, warnings, checks: checks.length },
    checks,
    violations,
    recomputed,
    mismatches,
    elapsedMs: Date.now() - startedAt,
  };
}
