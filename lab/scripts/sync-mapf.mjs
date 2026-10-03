#!/usr/bin/env node
/**
 * MAPF 引擎同步：把 mapf/rust 的浏览器产物与 Mock 目录装配进 lab/public。
 * 与 aps 的 sync-engine.mjs 同一方法论（单一事实来源 = mapf/rust 构建目录）：
 *
 *   ../mapf/rust/dist/mapf_engine.wasm   → public/wasm/mapf_engine.wasm
 *   ../mapf/rust/web/mapf-worker.js      → public/wasm/mapf-worker.js（Worker 入口）
 *                                          src/vendor/mapf-worker.js（主线程胶水）
 *   ../mapf/mock/m*.json（问题文件）      → public/mock/（与 aps 共用数据目录，前缀不冲突）
 *   清单                                  → public/mapf-manifest.json
 *
 * 构建期自检：直接用 vendored 胶水加载 wasm 解 m01，OPTIMAL+soc6 才允许发布。
 *
 * 用法：
 *   node scripts/sync-mapf.mjs
 *   node scripts/sync-mapf.mjs --wasm /path/mapf_engine.wasm --cli /path/mapf
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

const mapfDir = resolve(arg('mapf', join(repoRoot, 'mapf')));
const wasmSrc = resolve(arg('wasm', process.env.MAPF_WASM ?? join(mapfDir, 'rust', 'dist', 'mapf_engine.wasm')));
const workerSrc = resolve(arg('worker', join(mapfDir, 'rust', 'web', 'mapf-worker.js')));
const mockDir = resolve(arg('mocks', join(mapfDir, 'mock')));
const publicDir = resolve(arg('out', join(labDir, 'public')));
const source = arg('source', process.env.MAPF_SOURCE ?? 'source:local-build');
const gitCommit = arg('commit', process.env.GITHUB_SHA ?? '');
const gitTag = arg('tag', process.env.MAPF_GIT_TAG ?? '');
const cliBin = arg('cli', process.env.MAPF_BIN ?? '');
const cargoToml = join(mapfDir, 'rust', 'Cargo.toml');

const fail = (msg) => {
  console.error(`✗ sync-mapf: ${msg}`);
  process.exit(1);
};
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

if (!existsSync(wasmSrc)) fail(`找不到 WASM 产物：${wasmSrc}\n  先运行：cd mapf/rust && bash scripts/build_wasm.sh`);
if (!existsSync(workerSrc)) fail(`找不到 JS 胶水：${workerSrc}`);
if (readFileSync(wasmSrc).subarray(0, 4).toString('latin1') !== '\0asm') fail('wasm 产物魔数不是 \\0asm');
const wasmStat = { bytes: readFileSync(wasmSrc).length, sha256: sha256(wasmSrc) };
if (wasmStat.bytes < 10_000) fail(`wasm 产物体积异常：${wasmStat.bytes} 字节`);

// 版本信息：CLI 优先（编译进产物的权威），否则 Cargo.toml
function engineMeta() {
  if (cliBin && existsSync(cliBin)) {
    try {
      const caps = JSON.parse(execFileSync(cliBin, ['capabilities', '--profile', 'wasm-light'], { encoding: 'utf8' }));
      if (caps.version) return { version: caps.version, engine: caps.engine ?? 'rust-ecbs-cbs', caps };
    } catch {
      /* 落到 Cargo.toml */
    }
  }
  if (existsSync(cargoToml)) {
    const text = readFileSync(cargoToml, 'utf8');
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(text)?.[1];
    if (version) return { version, engine: 'rust-ecbs-cbs' };
  }
  return { version: '0.0.0', engine: 'rust-ecbs-cbs' };
}

// ------------------------------------------------------------ 复制产物
mkdirSync(join(publicDir, 'wasm'), { recursive: true });
copyFileSync(wasmSrc, join(publicDir, 'wasm', 'mapf_engine.wasm'));
copyFileSync(workerSrc, join(publicDir, 'wasm', 'mapf-worker.js'));
mkdirSync(join(labDir, 'src', 'vendor'), { recursive: true });
copyFileSync(workerSrc, join(labDir, 'src', 'vendor', 'mapf-worker.js'));

// ------------------------------------------------------------ Mock 目录
// 问题文件（m01…m12）复制进 public/mock；`*-solution.json` 是核验夹具，不进实验室目录。
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
    const tags = parsed.tags ?? {};
    const robots = (parsed.robots ?? []).length;
    problems.push({
      file: `mock/${file}`,
      name: tags.name ?? file.replace(/\.json$/, ''),
      description: tags.description ?? tags.expect ?? '',
      expect: tags.expect,
      kind: tags.kind ?? (file.includes('invalid') || file.includes('unsupported') || file.includes('tampered') ? 'negative' : 'scenario'),
      sha256: sha256(src),
      robots,
      width: parsed.map?.width,
      height: parsed.map?.height,
    });
  }
}

// ------------------------------------------------------------ 构建期自检
async function selfCheck() {
  const { createEngine } = await import(`${resolve(labDir, 'src/vendor/mapf-worker.js')}?t=${Date.now()}`);
  const engine = await createEngine(new Uint8Array(readFileSync(wasmSrc)));
  const m01 = JSON.parse(readFileSync(join(publicDir, 'mock', 'm01-single-basic.json'), 'utf8'));
  const { status, solution } = engine.solve(JSON.stringify(m01));
  if (!(status === 'OPTIMAL' || status === 'FEASIBLE')) fail(`wasm 自检失败：m01 状态 ${status}`);
  if (solution?.soc !== 6) fail(`wasm 自检失败：m01 soc 应为 6，实际 ${solution?.soc}`);
  if (solution?.verified !== true) fail('wasm 自检失败：m01 verified 应为 true');
  if (!engine.hasAnalysis) fail('wasm 缺少分析类导出（mapf_verify/mapf_fingerprint/mapf_capabilities）');
  const caps = engine.capabilities();
  if (caps.engine !== 'rust-ecbs-cbs') fail(`capabilities.engine 应为 rust-ecbs-cbs，实际 ${caps.engine}`);
  return { status, version: engine.version, caps };
}
const check = await selfCheck();
const { version, engine, caps } = engineMeta();
if (check.version !== version) fail(`版本不一致：wasm 内嵌 ${check.version}，元数据 ${version}（请重新构建产物）`);

// ------------------------------------------------------------ 清单
const manifest = {
  schema_version: 'algorithm-lab-engine/1.0',
  module: 'path-planning',
  engine,
  version,
  profile: 'wasm-light',
  wasm: { file: 'wasm/mapf_engine.wasm', bytes: wasmStat.bytes, sha256: wasmStat.sha256 },
  worker: { file: 'wasm/mapf-worker.js', sha256: sha256(join(publicDir, 'wasm', 'mapf-worker.js')) },
  source,
  gitCommit: gitCommit || undefined,
  gitTag: gitTag || undefined,
  builtAt: new Date().toISOString(),
  capabilities: caps ?? check.caps,
  selfCheck: { status: check.status, soc: 6, problem: 'm01-single-basic' },
  mocks: problems,
};
writeFileSync(join(publicDir, 'mapf-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`✓ sync-mapf: wasm ${wasmStat.bytes} 字节（${wasmStat.sha256.slice(0, 16)}…）· 引擎 ${engine} v${version} · Mock ${problems.length} 个`);
console.log('  自检：m01 → OPTIMAL(soc=6) 已核验，分析类导出可用');
console.log('  清单：public/mapf-manifest.json');
