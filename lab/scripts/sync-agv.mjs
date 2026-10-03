#!/usr/bin/env node
/**
 * AGV 引擎同步：把 agv/rust 的浏览器产物与 Mock 目录装配进 lab/public。
 * 与 sync-mapf.mjs 同一方法论（单一事实来源 = agv/rust 构建目录）：
 *
 *   ../agv/rust/dist/agv_engine.wasm   → public/wasm/agv_engine.wasm
 *   ../agv/rust/web/agv-worker.js      → public/wasm/agv-worker.js（Worker 入口）
 *                                       src/vendor/agv-worker.js（主线程胶水）
 *   ../agv/mock/*.json（问题文件）      → public/mock/（与 aps/mapf 共用目录，前缀不冲突）
 *   清单                               → public/agv-manifest.json
 *
 * 构建期自检：直接用 vendored 胶水加载 wasm 解 a01 与 a10（动态），
 * FEASIBLE+verified 才允许发布。
 *
 * 用法：
 *   node scripts/sync-agv.mjs
 *   node scripts/sync-agv.mjs --wasm /path/agv_engine.wasm --cli /path/agv
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

const agvDir = resolve(arg('agv', join(repoRoot, 'agv')));
const wasmSrc = resolve(arg('wasm', process.env.AGV_WASM ?? join(agvDir, 'rust', 'dist', 'agv_engine.wasm')));
const workerSrc = resolve(arg('worker', join(agvDir, 'rust', 'web', 'agv-worker.js')));
const mockDir = resolve(arg('mocks', join(agvDir, 'mock')));
const publicDir = resolve(arg('out', join(labDir, 'public')));
const source = arg('source', process.env.AGV_SOURCE ?? 'source:local-build');
const gitCommit = arg('commit', process.env.GITHUB_SHA ?? '');
const gitTag = arg('tag', process.env.AGV_GIT_TAG ?? '');
const cliBin = arg('cli', process.env.AGV_BIN ?? '');
const cargoToml = join(agvDir, 'rust', 'Cargo.toml');

const fail = (msg) => {
  console.error(`✗ sync-agv: ${msg}`);
  process.exit(1);
};
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

if (!existsSync(wasmSrc)) fail(`找不到 WASM 产物：${wasmSrc}\n  先运行：cd agv/rust && bash scripts/build_wasm.sh`);
if (!existsSync(workerSrc)) fail(`找不到 JS 胶水：${workerSrc}`);
if (readFileSync(wasmSrc).subarray(0, 4).toString('latin1') !== '\0asm') fail('wasm 产物魔数不是 \\0asm');
const wasmStat = { bytes: readFileSync(wasmSrc).length, sha256: sha256(wasmSrc) };
if (wasmStat.bytes < 10_000) fail(`wasm 产物体积异常：${wasmStat.bytes} 字节`);

// 版本信息：CLI 优先（编译进产物的权威），否则 Cargo.toml
function engineMeta() {
  if (cliBin && existsSync(cliBin)) {
    try {
      const caps = JSON.parse(execFileSync(cliBin, ['capabilities', '--profile', 'wasm-light'], { encoding: 'utf8' }));
      if (caps.version) return { version: caps.version, engine: caps.engine ?? 'rust-agv-dispatch', caps };
    } catch {
      /* 落到 Cargo.toml */
    }
  }
  if (existsSync(cargoToml)) {
    const text = readFileSync(cargoToml, 'utf8');
    const version = /^\s*version\s*=\s*"([0-9.]+)"/m.exec(text)?.[1];
    if (version) return { version, engine: 'rust-agv-dispatch' };
  }
  return { version: '0.0.0', engine: 'rust-agv-dispatch' };
}

// ------------------------------------------------------------ 复制产物
mkdirSync(join(publicDir, 'wasm'), { recursive: true });
copyFileSync(wasmSrc, join(publicDir, 'wasm', 'agv_engine.wasm'));
copyFileSync(workerSrc, join(publicDir, 'wasm', 'agv-worker.js'));
mkdirSync(join(labDir, 'src', 'vendor'), { recursive: true });
copyFileSync(workerSrc, join(labDir, 'src', 'vendor', 'agv-worker.js'));

// ------------------------------------------------------------ Mock 目录
// 问题文件（a01…、warehouse-）复制进 public/mock（与 aps/mapf 共用目录，文件名前缀不冲突）。
const problems = [];
if (existsSync(mockDir)) {
  mkdirSync(join(publicDir, 'mock'), { recursive: true });
  for (const file of readdirSync(mockDir).filter((f) => f.endsWith('.json')).sort()) {
    if (/-solution\.json$/.test(file)) continue;
    const src = join(mockDir, file);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(src, 'utf8'));
    } catch {
      continue;
    }
    copyFileSync(src, join(publicDir, 'mock', file));
    problems.push({
      file: `mock/${file}`,
      id: parsed.id ?? file.replace(/\.json$/, ''),
      // 标题：取自导出时的语义（文件名分段），前端可读。
      name: prettify(file),
      description: describe(parsed),
      dynamic: Boolean(parsed.dynamic),
      vehicles: (parsed.vehicles ?? []).length,
      tasks: (parsed.tasks ?? []).length,
      width: parsed.map?.cells?.[0]?.length,
      height: parsed.map?.cells?.length,
      sha256: sha256(src),
    });
  }
}

function prettify(file) {
  return file
    .replace(/\.json$/, '')
    .split('-')
    .map((s) => (/^\d/.test(s) ? s.toUpperCase() : s.charAt(0).toUpperCase() + s.slice(1)))
    .join(' ');
}

function describe(p) {
  const nv = (p.vehicles ?? []).length;
  const nt = (p.tasks ?? []).length;
  const w = p.map?.cells?.[0]?.length ?? '?';
  const h = p.map?.cells?.length ?? '?';
  const dyn = p.dynamic ? '，动态事件 ' + (p.dynamic?.events?.length ?? 0) + ' 个' : '';
  return `${w}×${h} 地图 · ${nv} 车 ${nt} 任务${dyn}`;
}

// ------------------------------------------------------------ 构建期自检
async function selfCheck() {
  const { createEngine } = await import(`${resolve(labDir, 'src/vendor/agv-worker.js')}?t=${Date.now()}`);
  const engine = await createEngine(new Uint8Array(readFileSync(wasmSrc)));
  const a01 = JSON.parse(readFileSync(join(publicDir, 'mock', 'a01-single-task.json'), 'utf8'));
  const { status, solution } = engine.solve(JSON.stringify(a01));
  if (status !== 'FEASIBLE') fail(`wasm 自检失败：a01 状态 ${status}`);
  if (solution?.verified !== true) fail('wasm 自检失败：a01 verified 应为 true');
  if (solution?.plan?.tasks?.[0]?.pickup_done !== 5) fail('wasm 自检失败：a01 pickup_done 应为 5');
  if (!engine.hasAnalysis) fail('wasm 缺少分析类导出（agv_verify/agv_fingerprint/agv_capabilities）');
  const caps = engine.capabilities();
  if (caps.engine !== 'rust-agv-dispatch') fail(`capabilities.engine 应为 rust-agv-dispatch，实际 ${caps.engine}`);
  if (caps.profile !== 'wasm-light') fail(`能力档位应为 wasm-light，实际 ${caps.profile}`);
  // 动态：a10 快照展开 + 汇总块
  const a10 = JSON.parse(readFileSync(join(publicDir, 'mock', 'a10-dynamic-task-add.json'), 'utf8'));
  const dyn = engine.solve(JSON.stringify(a10));
  if (dyn.status !== 'FEASIBLE' || dyn.solution?.verified !== true) fail(`wasm 自检失败：a10 动态求解 ${dyn.status}`);
  if (dyn.solution?.dynamic?.tasks_added?.[0] !== 'T3-new') fail('wasm 自检失败：a10 dynamic 汇总块不符');
  if (dyn.solution?.metrics?.completed_tasks !== 3) fail('wasm 自检失败：a10 应完成 3 个任务');
  return { status, version: engine.version, caps };
}
const check = await selfCheck();
const { version, engine, caps } = engineMeta();
if (check.version !== version) fail(`版本不一致：wasm 内嵌 ${check.version}，元数据 ${version}（请重新构建产物）`);

// ------------------------------------------------------------ 清单
const manifest = {
  schema_version: 'algorithm-lab-engine/1.0',
  module: 'agv-dispatch',
  engine,
  version,
  profile: 'wasm-light',
  wasm: { file: 'wasm/agv_engine.wasm', bytes: wasmStat.bytes, sha256: wasmStat.sha256 },
  worker: { file: 'wasm/agv-worker.js', sha256: sha256(join(publicDir, 'wasm', 'agv-worker.js')) },
  source,
  gitCommit: gitCommit || undefined,
  gitTag: gitTag || undefined,
  builtAt: new Date().toISOString(),
  capabilities: caps ?? check.caps,
  selfCheck: { status: check.status, pickupDone: 5, problem: 'a01-single-task', dynamic: 'a10-dynamic-task-add' },
  mocks: problems,
};
writeFileSync(join(publicDir, 'agv-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`✓ sync-agv: wasm ${wasmStat.bytes} 字节（${wasmStat.sha256.slice(0, 16)}…）· 引擎 ${engine} v${version} · Mock ${problems.length} 个`);
console.log('  自检：a01 → FEASIBLE(pickup_done=5) 已核验；a10 动态展开 + 汇总块通过；分析类导出可用');
console.log('  清单：public/agv-manifest.json');
