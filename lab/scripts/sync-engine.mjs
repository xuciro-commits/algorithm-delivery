#!/usr/bin/env node
/**
 * 把算法引擎产物“同步”进实验室：**单一来源，实验室不手工维护副本**。
 *
 * 输入（默认取本仓库 APS 引擎）：
 *   ../aps/rust/dist/aps_engine.wasm     WASM 产物（由 aps/rust/scripts/build_wasm.sh 生成，
 *                                        CI 里也可能来自某个正式 Release）
 *   ../aps/rust/web/aps-worker.js        JS 胶水（手写 C ABI 绑定）
 *   ../aps/mock/*.json                   已有 Mock 场景（PlanProblem）
 *
 * 输出：
 *   public/wasm/aps_engine.wasm          页面运行时加载（子路径部署，见 vite base）
 *   public/wasm/aps-worker.js            Worker 入口（用 URL 构造 Worker）
 *   src/vendor/aps-worker.js             同一份胶水（供主线程预编译/直接调用）
 *   public/engine-manifest.json          引擎版本 / sha256 / 数据目录（页面显示“当前引擎版本”）
 *   public/mock/*.json + index.json      Mock 目录（含工序数、看点、sha256）
 *   public/mock/bench-*.json             规模/竞争型基准（可选，见 LAB_BENCH_SIZES）
 *
 * 用法：
 *   node scripts/sync-engine.mjs                      # 本地默认
 *   node scripts/sync-engine.mjs --source release:v1.0.0 --tag v1.0.0
 *   LAB_BENCH_SIZES=off node scripts/sync-engine.mjs  # 跳过基准生成（离线构建）
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

const wasmSrc = resolve(arg('wasm', join(repoRoot, 'aps/rust/dist/aps_engine.wasm')));
const workerSrc = resolve(arg('worker', join(repoRoot, 'aps/rust/web/aps-worker.js')));
const mockDir = resolve(arg('mocks', join(repoRoot, 'aps/mock')));
const publicDir = resolve(arg('out', join(labDir, 'public')));
const source = arg('source', 'source:local-build');
const gitTag = arg('tag', process.env.LAB_GIT_TAG ?? '');
const gitCommit = arg('commit', process.env.GITHUB_SHA ?? process.env.LAB_GIT_COMMIT ?? '');
const cargoToml = resolve(arg('cargo-toml', join(repoRoot, 'aps/rust/Cargo.toml')));
const cliBin = arg('cli', process.env.LAB_APS_BIN ?? '');

const problems = [];
const fail = (msg) => {
  console.error(`✗ sync-engine: ${msg}`);
  process.exit(1);
};

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function engineVersion() {
  // 优先问 CLI（唯一权威：编译进产物里的 CARGO_PKG_VERSION），否则退回 Cargo.toml
  if (cliBin && existsSync(cliBin)) {
    try {
      const out = execFileSync(cliBin, ['capabilities', '--profile', 'wasm-light', '--json'], {
        encoding: 'utf8',
      });
      const caps = JSON.parse(out);
      if (caps.version) return { version: caps.version, engine: caps.engine ?? 'rust-heuristic', caps };
    } catch {
      /* 落到 Cargo.toml */
    }
  }
  if (existsSync(cargoToml)) {
    const text = readFileSync(cargoToml, 'utf8');
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(text)?.[1];
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1];
    if (version) return { version, engine: name ?? 'aps-engine' };
  }
  return { version: '0.0.0', engine: 'aps-engine' };
}

function ensure(cond, msg) {
  if (!cond) fail(msg);
}

// ---------------------------------------------------------------- 校验输入
ensure(existsSync(wasmSrc), `找不到 WASM 产物：${wasmSrc}\n  先运行：cd aps/rust && bash scripts/build_wasm.sh`);
ensure(existsSync(workerSrc), `找不到 JS 胶水：${workerSrc}`);
ensure(readFileSync(wasmSrc).subarray(0, 4).toString('latin1') === '\0asm', 'wasm 产物魔数不是 \\0asm');
const wasmStat = { bytes: readFileSync(wasmSrc).length, sha256: sha256(wasmSrc) };
ensure(wasmStat.bytes > 10_000, `wasm 产物体积异常：${wasmStat.bytes} 字节`);

// ------------------------------------------------- 内置自检：wasm 真能求解
// 构建期就验证“产物可用”，避免把坏产物发到 Pages（CI 里同时还有 aps accept / 冒烟测试）。
async function selfCheck() {
  const { createEngine } = await import(`${resolve(labDir, 'src/vendor/aps-worker.js')}?t=${Date.now()}`);
  const engine = await createEngine(new Uint8Array(readFileSync(wasmSrc)));
  const baseline = join(mockDir, 'baseline.json');
  const problem = JSON.parse(readFileSync(baseline, 'utf8'));
  problem.objective = { ...(problem.objective ?? {}), time_limit_ms: 500 };
  const { status, solution } = engine.solve(JSON.stringify(problem));
  ensure(
    status === 'FEASIBLE' || status === 'OPTIMAL',
    `wasm 自检失败：baseline 求解状态为 ${status}`,
  );
  ensure((solution?.operations ?? []).length === 24, 'wasm 自检失败：baseline 应产出 24 道工序');
  ensure(engine.hasAnalysis, 'wasm 缺少分析类导出（核验/指纹/能力声明）');
  const caps = engine.capabilities();
  ensure(caps.version === engine.version, `能力声明版本 ${caps.version} 与 aps_version ${engine.version} 不一致`);
  return { status, version: engine.version, caps };
}

// ---------------------------------------------------------------- 复制产物
mkdirSync(join(publicDir, 'wasm'), { recursive: true });
copyFileSync(wasmSrc, join(publicDir, 'wasm', 'aps_engine.wasm'));
copyFileSync(workerSrc, join(publicDir, 'wasm', 'aps-worker.js'));
mkdirSync(join(labDir, 'src', 'vendor'), { recursive: true });
copyFileSync(workerSrc, join(labDir, 'src', 'vendor', 'aps-worker.js'));

// ---------------------------------------------------------------- Mock 目录
const MOCK_META = {
  'baseline.json': { description: '基础完整车间：8 订单 / 24 工序 / 5 机器 / 8 人员', expect: '可证明最优（makespan = 下界）', name: '基础车间（baseline）', kind: 'baseline' },
  'machine-breakdown.json': { description: '设备故障：WELD-02 在 10-05 下午停机，验证排程避开停机窗口', expect: '避开停机区间并给出相对基线的变更', name: '设备故障（machine-breakdown）', kind: 'scenario' },
  'material-delay.json': { description: '到货延迟：物料到货推迟，验证事件序账本非负', expect: '物料账本全程非负（H07）', name: '到货延迟（material-delay）', kind: 'scenario' },
  'infeasible-no-welder.json': { description: '无解场景：缺少具备焊接技能的资源', expect: 'INFEASIBLE + NO_ELIGIBLE_WORKER 证书', name: '无解（infeasible-no-welder）', kind: 'scenario' },
};

function countProblem(problem) {
  let operations = 0;
  for (const order of problem.orders ?? []) operations += (order.operations ?? []).length;
  return {
    operations,
    orders: (problem.orders ?? []).length,
    machines: (problem.machines ?? []).length,
    workers: (problem.workers ?? []).length,
  };
}

mkdirSync(join(publicDir, 'mock'), { recursive: true });
if (existsSync(mockDir)) {
  for (const file of readdirSync(mockDir).filter((f) => f.endsWith('.json')).sort()) {
    const src = join(mockDir, file);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(src, 'utf8'));
    } catch {
      continue;
    }
    copyFileSync(src, join(publicDir, 'mock', file));
    const meta = MOCK_META[file] ?? {};
    const counts = countProblem(parsed);
    problems.push({
      file: `mock/${file}`,
      name: meta.name ?? file.replace(/\.json$/, ''),
      description: meta.description ?? '自定义测试数据',
      kind: meta.kind ?? 'custom',
      expect: meta.expect,
      sha256: sha256(src),
      ...counts,
    });
  }
}

// ------------------------------------------------- 规模与竞争型基准（可选）
const benchSizes = (process.env.LAB_BENCH_SIZES ?? '240,c48').trim();
if (benchSizes !== 'off' && cliBin && existsSync(cliBin)) {
  const baseline = join(publicDir, 'mock', 'baseline.json');
  for (const spec of benchSizes.split(',').map((s) => s.trim()).filter(Boolean)) {
    const coupled = spec.startsWith('c');
    const n = Number(spec.replace(/^c/, ''));
    if (!Number.isFinite(n) || n <= 0) continue;
    const file = coupled ? `bench-coupled-${n}.json` : `bench-${n}.json`;
    const out = join(publicDir, 'mock', file);
    const args = ['benchmark', '--baseline', baseline, '--operations', String(n), '--out', out];
    if (coupled) args.push('--coupled');
    try {
      execFileSync(cliBin, args, { stdio: 'pipe' });
      const parsed = JSON.parse(readFileSync(out, 'utf8'));
      const counts = countProblem(parsed);
      problems.push({
        file: `mock/${file}`,
        name: coupled ? `资源竞争型基准（${n} 订单）` : `规模压测（${n} 工序，独立单元）`,
        description: coupled
          ? '共享机器/人员/工装，投放速率高于产能：用于看求解质量与下界差距'
          : '由相互独立的车间单元复制而成：用于压模型规模、序列化与内存',
        kind: 'benchmark',
        expect: coupled ? '规模越大差距越小；小规模下界偏弱' : '关注首解时间与峰值内存',
        sha256: sha256(out),
        ...counts,
      });
    } catch (err) {
      console.warn(`· 跳过基准 ${file}：${String(err.message).split('\n')[0]}`);
    }
  }
} else if (benchSizes !== 'off') {
  console.warn('· 未提供 --cli/aps 二进制，跳过基准数据生成（LAB_BENCH_SIZES=off 可显式关闭）');
}

// ---------------------------------------------------------------- 自检 + 清单
const check = await selfCheck();
const { version, engine, caps } = engineVersion();
ensure(
  check.version === version,
  `版本不一致：wasm 内嵌 ${check.version}，元数据来源给出 ${version}（请重新构建产物）`,
);

const manifest = {
  schema_version: 'algorithm-lab-engine/1.0',
  engine,
  version,
  profile: 'wasm-light',
  wasm: { file: 'wasm/aps_engine.wasm', bytes: wasmStat.bytes, sha256: wasmStat.sha256 },
  worker: { file: 'wasm/aps-worker.js', sha256: sha256(join(publicDir, 'wasm', 'aps-worker.js')) },
  source,
  gitCommit: gitCommit || undefined,
  gitTag: gitTag || undefined,
  builtAt: new Date().toISOString(),
  capabilities: caps ?? check.caps,
  selfCheck: { status: check.status, operations: 24 },
  mocks: problems,
};
writeFileSync(join(publicDir, 'engine-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// 目录里不再使用的历史基准文件不清理（避免误删用户自建数据），只提示
console.log(
  `✓ sync-engine: wasm ${wasmStat.bytes} 字节（${wasmStat.sha256.slice(0, 16)}…）· 引擎 ${engine} v${version} · Mock ${problems.length} 个`,
);
console.log(`  自检：baseline → ${check.status}（24 工序），分析类导出可用`);
console.log(`  清单：public/engine-manifest.json`);
