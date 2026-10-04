#!/usr/bin/env node
/**
 * AGV Lab 测试（M4）：
 *  1) 场景内核：parse/serialize 白名单、编辑命令、预检、13 mock roundtrip；
 *  2) 真实 WASM 集成：vendored agv-worker.js 加载 agv_engine.wasm，解 a01/a07/a10，
 *     断言调度解结构（timeline/missions/相位/动态汇总块/核验），与 CLI 同源。
 */

import { build } from 'esbuild';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHarness } from './lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const repoRoot = resolve(labDir, '..');
const { check, finish, failures } = createHarness('AGV Lab 测试');

// ---- 1) 场景内核 ----
const tmp = join(labDir, 'node_modules', '.lab-agv-scene');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
await build({
  entryPoints: [join(labDir, 'src/modules/agv/scene.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: join(tmp, 'scene.mjs'),
  logLevel: 'warning',
});
const scene = await import(pathToFileURL(join(tmp, 'scene.mjs')).href);
const {
  blankAgvScene, parseAgvScene, serializeAgvScene, agvSceneEquivalent, agvDims,
  AgvSceneHistory, precheckAgvScene, locCells,
} = scene;

{
  const h = new AgvSceneHistory(blankAgvScene(6, 4));
  h.exec({ type: 'toggleWall', cell: [3, 1], blocked: true });
  h.exec({ type: 'addVehicle', at: [0, 0], id: 'V1' });
  h.exec({ type: 'addTask', pickup: [5, 0], dropoff: [1, 3], id: 'T1' });
  check('命令序列：障碍 + 车 + 任务', h.doc.vehicles.length === 1 && h.doc.tasks.length === 1 && h.doc.map.cells[1][3] === '#');
  h.undo();
  check('撤销移除任务', h.doc.tasks.length === 0);
  h.redo();
  check('重做恢复任务', h.doc.tasks.length === 1);

  let issues = precheckAgvScene(h.doc, { maxVehicles: 64, maxTasks: 128, maxCells: 16384, maxBudgetMs: 120000 });
  check('正常场景无 error', !issues.some((i) => i.level === 'error'));
  const bad = JSON.parse(JSON.stringify(h.doc));
  bad.vehicles[0].start = [3, 1];
  issues = precheckAgvScene(bad, { maxVehicles: 64, maxTasks: 128, maxCells: 16384, maxBudgetMs: 120000 });
  check('车辆起点在障碍 → error', issues.some((i) => i.code === 'E-VEHICLE-START-BLOCKED'));

  const s = blankAgvScene(5, 5);
  s.vehicles.push({ id: 'V1', start: [0, 0] });
  s.stations.push({ id: 'ST', cells: [[2, 2], [2, 3]], capacity: 1 });
  s.tasks.push({ id: 'T1', pickup: { station: 'ST' }, dropoff: [4, 4], pickup_service: 1, dropoff_service: 0, release_step: 0 });
  check('站引用 locCells → 泊位格', JSON.stringify(locCells(s, { station: 'ST' })) === '[[2,2],[2,3]]');
  const j = JSON.parse(serializeAgvScene(s));
  check('序列化保留 stations 与 station 引用', j.stations?.length === 1 && j.tasks[0].pickup.station === 'ST');
  const badRef = JSON.parse(serializeAgvScene(s));
  badRef.tasks[0].pickup = { station: 'NOPE' };
  issues = precheckAgvScene(parseAgvScene(JSON.stringify(badRef)), { maxVehicles: 64, maxTasks: 128, maxCells: 16384, maxBudgetMs: 120000 });
  check('引用不存在的站 → E-TASK-UNKNOWN-STATION', issues.some((i) => i.code === 'E-TASK-UNKNOWN-STATION'));
}

// mock roundtrip
{
  const mockDir = join(labDir, 'public', 'mock');
  // public/mock 是**各领域共用**的目录：仓储 AS/RS 的 asrs-*.json 同样以 a 开头，
  // 按文件名前缀（旧的 /^[aw]/）挑 AGV mock 会把别的领域的问题文档一起扫进来，
  // 于是出现“用 AGV 解析器解析仓储文档”的假失败。改为按内容判定领域
  // （schema_version = agv-dispatch-problem/*），领域再多也不会误伤。
  const isAgvMock = (f) => {
    if (!f.endsWith('.json')) return false;
    try {
      const meta = JSON.parse(readFileSync(join(mockDir, f), 'utf8'));
      return typeof meta.schema_version === 'string' && meta.schema_version.startsWith('agv-dispatch-problem/');
    } catch {
      return false;
    }
  };
  const candidates = existsSync(mockDir)
    ? readdirSync(mockDir).filter((f) => /^(a\d|warehouse-)/.test(f) && f.endsWith('.json')).sort()
    : [];
  const files = candidates.filter(isAgvMock);
  check(`找到 AGV mock（${files.length} 个）`, files.length >= 13, files.join(' '));
  // 反向护栏：凡是按名字看应当属于 AGV 的 mock，都必须声明 AGV 契约；
  // 否则就是“按内容挑选”把文件悄悄漏掉了，不能只是数量变少却没人发现。
  const missing = candidates.filter((f) => !files.includes(f));
  check(`AGV 命名空间的 mock 全部声明 AGV 契约（缺 ${missing.length} 个）`, missing.length === 0, missing.join(' '));
  let okCount = 0;
  for (const f of files) {
    const text = readFileSync(join(mockDir, f), 'utf8');
    try {
      const d1 = parseAgvScene(text);
      const d2 = parseAgvScene(serializeAgvScene(d1));
      if (agvSceneEquivalent(d1, d2)) okCount += 1;
      else failures.push(`roundtrip 不等价：${f}`);
    } catch (err) {
      failures.push(`解析失败 ${f}: ${err.message}`);
    }
  }
  check(`全部 AGV mock roundtrip 语义等价（${okCount}/${files.length}）`, okCount === files.length);
  const warehousePath = join(mockDir, 'warehouse-studio.json');
  if (existsSync(warehousePath)) {
    try {
      const warehouse = parseAgvScene(readFileSync(warehousePath, 'utf8'));
      const issues = precheckAgvScene(warehouse, { maxVehicles: 64, maxTasks: 128, maxCells: 16384, maxBudgetMs: 120000 });
      check('warehouse-studio 原型通过 AGV 结构预检', !issues.some((issue) => issue.level === 'error'), issues.map((issue) => issue.code).join(', '));
    } catch (err) {
      check('warehouse-studio 原型通过 AGV 结构预检', false, err.message);
    }
  } else {
    check('warehouse-studio 原型已随 AGV mocks 同步', false);
  }
}

// ---- 2) 真实 WASM 集成（vendored 胶水 + dist 产物） ----
{
  const wasmPath = join(labDir, 'public', 'wasm', 'agv_engine.wasm');
  if (!existsSync(wasmPath)) {
    check('agv_engine.wasm 已同步进 lab（npm run sync）', false);
  } else {
    const { createEngine } = await import(pathToFileURL(join(labDir, 'src/vendor/agv-worker.js')).href);
    const engine = await createEngine(new Uint8Array(readFileSync(wasmPath)));
    check('引擎版本握手', typeof engine.version === 'string' && engine.version !== '');

    const a01 = readFileSync(join(labDir, 'public', 'mock', 'a01-single-task.json'), 'utf8');
    const r1 = engine.solve(a01);
    const sol = r1.solution;
    check('a01 求解 FEASIBLE', r1.status === 'FEASIBLE', r1.status);
    check('a01 pickup_done=5 / dropoff_done=11（与 CLI 验收同源）',
      sol?.plan?.tasks?.[0]?.pickup_done === 5 && sol?.plan?.tasks?.[0]?.dropoff_done === 11);
    check('a01 核验通过（独立验证器）', sol?.verified === true);
    check('a01 时间线逐格（长度 = horizon+1）', Array.isArray(sol?.plan?.vehicles?.[0]?.timeline) && sol.plan.vehicles[0].timeline.length === (sol.plan.horizon ?? -1) + 1);
    check('a01 missions 覆盖取送', (sol?.plan?.vehicles?.[0]?.missions ?? []).some((m) => m.phase === 'to_pickup' || m.phase === 'servicing_pickup'));

    const a07 = readFileSync(join(labDir, 'public', 'mock', 'a07-station-capacity.json'), 'utf8');
    const r7 = engine.solve(a07);
    check('a07 工作站容量 FEASIBLE+verified', r7.status === 'FEASIBLE' && r7.solution?.verified === true);

    const a10 = readFileSync(join(labDir, 'public', 'mock', 'a10-dynamic-task-add.json'), 'utf8');
    const r10 = engine.solve(a10);
    const dyn = r10.solution?.dynamic;
    check('a10 动态 FEASIBLE+verified', r10.status === 'FEASIBLE' && r10.solution?.verified === true);
    check('a10 动态汇总块（snapshot_time=3 / T3-new / 语义指纹）',
      dyn?.snapshot_time === 3 && dyn?.tasks_added?.[0] === 'T3-new' && String(dyn?.semantic_digest ?? '').startsWith('sha256:'));
    check('a10 完成任务数 = 3（含新增）', r10.solution?.metrics?.completed_tasks === 3);

    // M0 warehouse prototype: require the real engine, not UI-side path fabrication.
    const warehouse = readFileSync(join(labDir, 'public', 'mock', 'warehouse-studio.json'), 'utf8');
    const rw = engine.solve(warehouse);
    check('warehouse-studio 真实调度 FEASIBLE + 独立核验通过', rw.status === 'FEASIBLE' && rw.solution?.verified === true, rw.status);
    check('warehouse-studio 引擎结果包含 2 车 / 3 个完成任务',
      rw.solution?.plan?.vehicles?.length === 2 && rw.solution?.metrics?.completed_tasks === 3);

    // 确定性
    const again = engine.solve(a01);
    const semA = JSON.stringify({ status: sol.status, plan: sol.plan, search: sol.search });
    const semB = JSON.stringify({ status: again.solution?.status, plan: again.solution?.plan, search: again.solution?.search });
    check('同输入两次求解语义一致（确定性）', semA === semB);

    // 篡改必拒（独立核验器）
    const tampered = JSON.parse(r1.raw);
    tampered.plan.tasks[0].dropoff_done = 3;
    const bad = engine.verify(a01, JSON.stringify(tampered), { strict: false });
    check('篡改解被核验拒绝（ok=false + violations 非空 + 指标复算存在）',
      bad.report?.ok === false && Array.isArray(bad.report?.violations) && bad.report.violations.length > 0
      && typeof bad.report?.recomputed?.completed_tasks === 'number');

    // 参数覆盖
    const opt = engine.solve(a01, { algorithm: 'baseline' });
    check('参数覆盖求解（baseline）', opt.status === 'FEASIBLE');
  }
}

finish('✓ AGV Lab 测试全部通过');
