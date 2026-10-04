#!/usr/bin/env node
/**
 * Warehouse 引擎同步：把 warehouse/rust 的浏览器产物与 Mock 装配进 lab/public。
 * 与 sync-agv.mjs 同一方法论（单一事实来源 = warehouse/rust 构建目录）：
 *
 *   ../warehouse/rust/dist/warehouse_engine.wasm → public/wasm/warehouse_engine.wasm
 *   ../warehouse/rust/web/warehouse-worker.js    → public/wasm/warehouse-worker.js（Worker 入口）
 *                                                → src/vendor/warehouse-worker.js（主线程胶水）
 *   ../warehouse/mock/*.json                     → public/mock/（与 aps/mapf/agv 共用目录）
 *   清单                                          → public/warehouse-manifest.json
 *   能力快照（算法/目标/状态/档位）                → public/warehouse-capabilities.json
 *     （面板的算法下拉框只从这里取选项，不硬编码）
 *
 * 构建期自检（三条都必须过，否则不允许发布）：
 *   1. 库位优化 mock 求解 FEASIBLE 且独立核验通过；
 *   2. 立库调度 mock 求解 FEASIBLE、时间线含设备步骤、核验通过；
 *   3. 篡改后的调度时间线被 wh_verify 判为不通过（X12 对抗防线，防止"验证器永远说 OK"）。
 *
 * 用法：
 *   node scripts/sync-warehouse.mjs
 *   node scripts/sync-warehouse.mjs --wasm /path/warehouse_engine.wasm --cli /path/warehouse
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const repoRoot = resolve(labDir, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const prefixed = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (prefixed) return prefixed.slice(name.length + 3);
  return fallback;
}

const warehouseDir = resolve(arg('warehouse', join(repoRoot, 'warehouse')));
const wasmSrc = resolve(
  arg('wasm', process.env.WAREHOUSE_WASM ?? join(warehouseDir, 'rust', 'dist', 'warehouse_engine.wasm')),
);
const workerSrc = resolve(arg('worker', join(warehouseDir, 'rust', 'web', 'warehouse-worker.js')));
const mockDir = resolve(arg('mocks', join(warehouseDir, 'mock')));
const publicDir = resolve(arg('out', join(labDir, 'public')));
const source = arg('source', process.env.WAREHOUSE_SOURCE ?? 'source:local-build');
const gitCommit = arg('commit', process.env.GITHUB_SHA ?? '');
const cliBin = arg('cli', process.env.WAREHOUSE_BIN ?? '');
const cargoToml = join(warehouseDir, 'rust', 'Cargo.toml');

const fail = (msg) => {
  console.error(`✗ sync-warehouse: ${msg}`);
  process.exit(1);
};
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

if (!existsSync(wasmSrc)) {
  fail(`找不到 WASM 产物：${wasmSrc}\n  先运行：cd warehouse/rust && bash scripts/build_wasm.sh`);
}
if (!existsSync(workerSrc)) fail(`找不到 JS 胶水：${workerSrc}`);
const wasmBytes = readFileSync(wasmSrc);
if (wasmBytes.subarray(0, 4).toString('latin1') !== '\0asm') fail('wasm 产物魔数不是 \\0asm');
if (wasmBytes.length < 10_000) fail(`wasm 产物体积异常：${wasmBytes.length} 字节`);
const wasmStat = { bytes: wasmBytes.length, sha256: sha256(wasmSrc) };

function engineMeta() {
  if (cliBin && existsSync(cliBin)) {
    try {
      const caps = JSON.parse(execFileSync(cliBin, ['capabilities'], { encoding: 'utf8' }));
      if (caps.engineVersion) {
        return { version: caps.engineVersion, engine: caps.engine ?? 'rust-warehouse', caps };
      }
    } catch {
      /* 落到 Cargo.toml */
    }
  }
  if (existsSync(cargoToml)) {
    const text = readFileSync(cargoToml, 'utf8');
    const version = /^\s*version\s*=\s*"([0-9.]+)"/m.exec(text)?.[1];
    if (version) return { version, engine: 'rust-warehouse' };
  }
  return { version: '0.0.0', engine: 'rust-warehouse' };
}

// ------------------------------------------------------------ 复制产物
mkdirSync(join(publicDir, 'wasm'), { recursive: true });
copyFileSync(wasmSrc, join(publicDir, 'wasm', 'warehouse_engine.wasm'));
copyFileSync(workerSrc, join(publicDir, 'wasm', 'warehouse-worker.js'));
mkdirSync(join(labDir, 'src', 'vendor'), { recursive: true });
copyFileSync(workerSrc, join(labDir, 'src', 'vendor', 'warehouse-worker.js'));

// ------------------------------------------------------------ Mock 目录
const problems = [];
if (existsSync(mockDir)) {
  mkdirSync(join(publicDir, 'mock'), { recursive: true });
  for (const file of readdirSync(mockDir).filter((f) => f.endsWith('.json')).sort()) {
    const src = join(mockDir, file);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(src, 'utf8'));
    } catch {
      continue;
    }
    copyFileSync(src, join(publicDir, 'mock', file));
    const stats = parsed.stats ?? {};
    problems.push({
      file: `mock/${file}`,
      id: parsed.scenarioId ?? file.replace(/\.json$/, ''),
      name: parsed.name ?? file.replace(/\.json$/, ''),
      kind: parsed.kind,
      goal: parsed.goal ?? '',
      expect: parsed.expect ?? '',
      scale: parsed.scale ?? 'small',
      description: `${stats.aisles ?? '?'} 巷道 · ${stats.locations ?? '?'} 库位 · ${stats.loadUnits ?? '?'} 货 · ${stats.tasks ?? '?'} 任务 · ${stats.devices ?? '?'} 设备`,
      sha256: sha256(src),
    });
  }
}

// ------------------------------------------------------------ 构建期自检
function loadMock(name) {
  const file = problems.find((p) => p.file.endsWith(name));
  if (!file) fail(`Mock 缺少 ${name}`);
  return JSON.parse(readFileSync(join(publicDir, file.file), 'utf8'));
}

/**
 * 核验文档的形状（与 `warehouse/rust/src/verify.rs` 的文档定位一致）：
 *   slotting → `{kind, problem, solution}`；asrs → `{kind, problem, timeline}`；
 *   joint    → `{kind, slotting, asrs, timeline, solution}`（两段各自过一遍验证器）。
 * 这里必须与前端 `lab/src/core/warehouse/engine.ts::buildVerifyDocument` 完全一致，
 * 否则"CI 里过了、面板里没过"这种最糟糕的不一致就会出现。
 */
function verifyDocument(problemDocument, envelope) {
  if (problemDocument.kind === 'slotting') {
    return { kind: 'slotting', problem: problemDocument.problem, solution: envelope.result };
  }
  if (problemDocument.kind === 'asrs') {
    return { kind: 'asrs', problem: problemDocument.problem, timeline: envelope.timeline };
  }
  const assignment = envelope.result?.slottingAssignment;
  return {
    kind: 'joint',
    slotting: problemDocument.slotting,
    asrs: problemDocument.asrs,
    timeline: envelope.timeline,
    solution: { assignment: Array.isArray(assignment) ? assignment : [] },
  };
}

async function selfCheck() {
  const { createEngine } = await import(`${resolve(labDir, 'src/vendor', 'warehouse-worker.js')}?t=${Date.now()}`);
  const engine = await createEngine(new Uint8Array(wasmBytes));
  if (!engine.hasAnalysis) fail('wasm 缺少分析类导出（wh_verify / wh_capabilities / wh_scenarios / wh_generate）');

  const caps = engine.capabilities();
  if (caps.engine !== 'rust-warehouse') fail(`capabilities.engine 应为 rust-warehouse，实际 ${caps.engine}`);
  if (caps.profile !== 'wasm-light') fail(`能力档位应为 wasm-light，实际 ${caps.profile}`);
  const scenarios = engine.scenarios();
  const scenarioCount = scenarios.count ?? 0;
  const flat = (scenarios.families ?? []).flatMap((family) => family.scenarios ?? []);
  if (scenarioCount < 80 || flat.length !== scenarioCount) {
    fail(`场景清单异常：count=${scenarioCount}，展开后 ${flat.length} 条`);
  }

  // 1) 库位优化
  const slotting = loadMock('slotting-small.json');
  const slottingOut = engine.solve(JSON.stringify(slotting), { includeTimeline: false });
  if (!['FEASIBLE', 'FEASIBLE_WITH_BOUND', 'OPTIMAL_PROVEN'].includes(slottingOut.status)) {
    fail(`库位优化 mock 求解状态 ${slottingOut.status}`);
  }
  // 库位优化：求解信封本身不带核验块（省时间），必须显式调用独立验证器 —— 这也是
  // 面板"重新核验"按钮走的同一条路径。
  const slottingVerify = engine.verify(JSON.stringify(verifyDocument(slotting, slottingOut.envelope)));
  if (slottingVerify.report?.ok !== true) {
    fail(`库位优化 mock 独立核验未通过：${JSON.stringify(slottingVerify.report?.violations ?? [])}`);
  }

  // 2) 立库调度（时间线 + 核验）
  const asrs = loadMock('asrs-small.json');
  const asrsOut = engine.solve(JSON.stringify(asrs), { includeTimeline: true });
  if (!['FEASIBLE', 'FEASIBLE_WITH_BOUND', 'OPTIMAL_PROVEN'].includes(asrsOut.status)) {
    fail(`立库调度 mock 求解状态 ${asrsOut.status}`);
  }
  const devices = asrsOut.envelope?.timeline?.devices ?? [];
  if (devices.length === 0) fail('立库调度 mock 未产出时间线设备');
  if (asrsOut.envelope?.verification?.ok !== true) fail('立库调度 mock 独立核验未通过');
  const done = asrsOut.envelope?.metrics?.tasksDone ?? 0;
  if (done <= 0) fail('立库调度 mock 完成数为 0（时间线可能是空的）');

  // 3) 对抗：篡改时间线后必须被拦下
  const tampered = JSON.parse(asrsOut.raw);
  const target = (tampered.timeline?.devices ?? []).find((d) => (d.steps ?? []).length > 0);
  if (!target) fail('对抗自检无法取得可篡改步骤');
  const step = target.steps[0];
  step.end_s = Math.max(0, Number(step.start_s ?? 0) + 0.01);
  const verify = engine.verify(JSON.stringify(verifyDocument(asrs, tampered)));
  if (verify.report?.ok !== false) fail('对抗自检失败：验证器放过了被篡改的时间线');

  return {
    caps,
    slottingStatus: slottingOut.status,
    asrsStatus: asrsOut.status,
    tasksDone: done,
    scenarioCount,
    engineVersion: caps.engineVersion,
  };
}

const check = await selfCheck();
const { version, engine: engineName, caps } = engineMeta();
if (check.engineVersion && check.engineVersion !== version) {
  fail(`版本不一致：wasm 内嵌 ${check.engineVersion}，元数据 ${version}（请重新构建产物）`);
}

// ------------------------------------------------------------ 清单
const manifest = {
  schema_version: 'algorithm-lab-engine/1.0',
  module: 'warehouse-suite',
  engine: engineName,
  version,
  profile: 'wasm-light',
  wasm: { file: 'wasm/warehouse_engine.wasm', bytes: wasmStat.bytes, sha256: wasmStat.sha256 },
  worker: { file: 'wasm/warehouse-worker.js', sha256: sha256(join(publicDir, 'wasm', 'warehouse-worker.js')) },
  source,
  gitCommit: gitCommit || undefined,
  builtAt: new Date().toISOString(),
  capabilities: caps ?? null,
  selfCheck: {
    slotting: check.slottingStatus,
    asrs: check.asrsStatus,
    tasksDone: check.tasksDone,
    scenarios: check.scenarioCount,
    tamperDetected: true,
    engineVersion: check.engineVersion,
  },
  mocks: problems,
};
writeFileSync(join(publicDir, 'warehouse-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// 能力快照：面板用它渲染算法/目标/档位选项；来源只能是引擎。
const capsSnapshot = caps ?? check.caps ?? null;
if (capsSnapshot) {
  writeFileSync(join(publicDir, 'warehouse-capabilities.json'), `${JSON.stringify(capsSnapshot, null, 2)}\n`);
}

console.log(
  `✓ sync-warehouse: wasm ${wasmStat.bytes} 字节（${wasmStat.sha256.slice(0, 16)}…）· 引擎 ${engineName} v${version} · Mock ${problems.length} 个`,
);
console.log(
  `  自检：库位优化 ${check.slottingStatus}；立库调度 ${check.asrsStatus}（${check.tasksDone} 任务完成，时间线含设备步骤）；篡改方案已被验证器拦下`,
);
console.log(`  场景清单：${check.scenarioCount} 个（来自引擎，非前端硬编码）`);
console.log('  清单：public/warehouse-manifest.json');
