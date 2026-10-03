#!/usr/bin/env node
/**
 * GitHub Pages 子路径**仿真**测试。
 *
 * 做法：把 `dist/` 放到一个临时目录的 `<base>/` 子路径下（模拟
 * `https://<owner>.github.io/algorithm-delivery/`），用内置 HTTP 服务器提供，
 * 然后：
 *   1. 抓 `index.html`，解析出所有本地资源引用并**逐个请求**，要求 200；
 *   2. 抓 `engine-manifest.json`，校验 wasm/worker/数据文件的 URL 在子路径下可访问；
 *   3. 把 wasm 字节与清单 sha256 比对（证明“Pages 上跑的确实是这一版产物”）；
 *   4. 用同一份胶水在 Node 里实例化这些字节并求解 baseline（端到端链路：页面同源资源 → WASM → 解）。
 *
 * 这能在部署前抓出“本地根路径能跑、Pages 子路径 404”的经典问题。
 *
 * 用法：node scripts/check-pages.mjs [--base /algorithm-delivery/]
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHarness } from './lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const prefixed = process.argv.find((a) => a.startsWith(`--${name}=`));
  return prefixed ? prefixed.slice(name.length + 3) : fallback;
}

const base = arg('base', process.env.LAB_BASE ?? '/algorithm-delivery/');
const distDir = resolve(labDir, 'dist');

const { check, finish, failures } = createHarness('Pages 子路径仿真');

if (!existsSync(distDir)) {
  console.error(`✗ 找不到 dist：${distDir}（先运行 npm run build）`);
  process.exit(2);
}

// ---- 组装“站点根目录”：<root>/<base 去掉首尾斜杠>/ = dist ----
const siteRoot = mkdtempSync(join(tmpdir(), 'lab-pages-'));
const subPath = normalize(base).replace(/^\/+|\/+$/g, '');
const mounted = join(siteRoot, subPath);
cpSync(distDir, mounted, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = decodeURIComponent(url.pathname);
  const filePath = join(siteRoot, rel);
  if (!filePath.startsWith(siteRoot)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end(`not found: ${rel}`);
    return;
  }
  const body = readFileSync(filePath);
  res.writeHead(200, {
    'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'content-length': body.length,
    // GitHub Pages 的行为：不缓存 HTML，静态资源长缓存
    'cache-control': rel.endsWith('.html') ? 'max-age=0' : 'max-age=600',
  });
  res.end(body);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
const baseUrl = `${origin}${base}`;

try {
  // ---- 1) index.html 的所有本地引用都能取到 ----
  const indexRes = await fetch(`${baseUrl}index.html`);
  check('子路径下 index.html 可访问', indexRes.ok, `${baseUrl}index.html → ${indexRes.status}`);
  const html = await indexRes.text();

  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^https?:|^data:|^#/.test(u));
  check('index.html 引用了本地资源', refs.length > 0, refs.join(', '));

  for (const ref of refs) {
    const url = new URL(ref, baseUrl).href;
    const res = await fetch(url);
    check(`资源可访问 ${ref}`, res.ok, `HTTP ${res.status}`);
  }

  // ---- 2) 清单与运行时资源 ----
  const manifestUrl = `${baseUrl}engine-manifest.json`;
  const manifestRes = await fetch(manifestUrl);
  check('子路径下 engine-manifest.json 可访问', manifestRes.ok, `HTTP ${manifestRes.status}`);
  if (!manifestRes.ok) {
    // 清单缺失时后面所有校验都无从谈起：给出明确结论并退出，而不是抛 JSON 解析栈。
    finish(`Pages 子路径仿真（base=${base}）`);
    throw new Error('engine-manifest.json 缺失，页面仿真无法继续');
  }
  const manifest = await manifestRes.json();

  const wasmUrl = `${baseUrl}${manifest.wasm.file}`;
  const wasmRes = await fetch(wasmUrl);
  const wasmBytes = new Uint8Array(await wasmRes.arrayBuffer());
  check('子路径下 wasm 可访问', wasmRes.ok, `HTTP ${wasmRes.status}`);
  check(
    'wasm 以 application/wasm 提供（instantiateStreaming 需要）',
    (wasmRes.headers.get('content-type') ?? '').includes('wasm'),
    wasmRes.headers.get('content-type') ?? '',
  );
  const digest = createHash('sha256').update(wasmBytes).digest('hex');
  check('页面取到的 wasm 与清单 sha256 一致', digest === manifest.wasm.sha256, digest.slice(0, 16) + '…');

  const workerRes = await fetch(`${baseUrl}${manifest.worker.file}`);
  check('子路径下 Worker 入口可访问', workerRes.ok, `HTTP ${workerRes.status}`);
  check(
    'Worker 以 JS MIME 提供（module worker 需要）',
    (workerRes.headers.get('content-type') ?? '').includes('javascript'),
    workerRes.headers.get('content-type') ?? '',
  );

  for (const mock of manifest.mocks ?? []) {
    const res = await fetch(`${baseUrl}${mock.file}`);
    check(`数据文件可访问 ${mock.file}`, res.ok, `HTTP ${res.status}`);
  }

  // ---- 3) 端到端：用页面同源取到的字节跑一次求解 ----
  const glueUrl = `${baseUrl}${manifest.worker.file}`;
  const glue = await import(`${pathToFileURL(join(mounted, manifest.worker.file)).href}`);
  const engine = await glue.createEngine(wasmBytes);
  check('用页面字节可实例化引擎', typeof engine.version === 'string', `v${engine.version}`);

  const baseline = manifest.mocks.find((m) => m.kind === 'baseline') ?? manifest.mocks[0];
  const problem = JSON.parse(readFileSync(join(mounted, baseline.file), 'utf8'));
  problem.objective = { ...(problem.objective ?? {}), time_limit_ms: 500 };
  const solved = engine.solve(JSON.stringify(problem));
  check(
    '端到端求解成功（页面同源数据 → WASM → 解）',
    solved.status === 'FEASIBLE' || solved.status === 'OPTIMAL',
    `${solved.status} · ${solved.solution?.operations?.length ?? 0} 工序`,
  );

  // ---- 4) MAPF 引擎：Pages 上同样必须真实可跑（存在清单即全链路校验） ----
  const mapfManifestRes = await fetch(`${baseUrl}mapf-manifest.json`);
  if (mapfManifestRes.ok) {
    const mm = await mapfManifestRes.json();
    check('子路径下 mapf-manifest.json 可访问', true, `${mm.engine} v${mm.version}`);
    const mWasmRes = await fetch(`${baseUrl}${mm.wasm.file}`);
    const mWasmBytes = new Uint8Array(await mWasmRes.arrayBuffer());
    check('子路径下 MAPF wasm 可访问且 MIME 正确', mWasmRes.ok && (mWasmRes.headers.get('content-type') ?? '').includes('wasm'));
    const mDigest = createHash('sha256').update(mWasmBytes).digest('hex');
    check('页面取到的 MAPF wasm 与清单 sha256 一致', mDigest === mm.wasm.sha256, mDigest.slice(0, 16) + '…');
    const mWorkerRes = await fetch(`${baseUrl}${mm.worker.file}`);
    check('MAPF Worker 入口以 JS MIME 提供', mWorkerRes.ok && (mWorkerRes.headers.get('content-type') ?? '').includes('javascript'));
    for (const mock of (mm.mocks ?? []).slice(0, 4)) {
      const res = await fetch(`${baseUrl}${mock.file}`);
      check(`MAPF 数据文件可访问 ${mock.file}`, res.ok, `HTTP ${res.status}`);
    }
    const mGlue = await import(`${pathToFileURL(join(mounted, 'wasm', 'mapf-worker.js')).href}?t=${Date.now()}`);
    const mEngine = await mGlue.createEngine(mWasmBytes);
    check('MAPF：页面字节可实例化', typeof mEngine.version === 'string', `v${mEngine.version}`);
    const m01Entry = (mm.mocks ?? []).find((m) => m.file.includes('m01'));
    const m01 = JSON.parse(readFileSync(join(mounted, m01Entry.file), 'utf8'));
    const mSolved = mEngine.solve(JSON.stringify(m01));
    check(
      'MAPF：端到端求解成功（页面同源数据 → WASM → 解，OPTIMAL 且内嵌核验通过）',
      (mSolved.status === 'OPTIMAL' || mSolved.status === 'FEASIBLE') && mSolved.solution?.verified === true,
      `${mSolved.status} · soc=${mSolved.solution?.soc}`,
    );
  } else {
    console.log('· 站点未部署 mapf-manifest.json：跳过 MAPF 运行时校验');
  }

  // ---- 5) AGV 引擎：Pages 上同样必须真实可跑（存在清单即全链路校验） ----
  const agvManifestRes = await fetch(`${baseUrl}agv-manifest.json`);
  if (agvManifestRes.ok) {
    const am = await agvManifestRes.json();
    check('子路径下 agv-manifest.json 可访问', true, `${am.engine} v${am.version}`);
    const aWasmRes = await fetch(`${baseUrl}${am.wasm.file}`);
    const aWasmBytes = new Uint8Array(await aWasmRes.arrayBuffer());
    check('子路径下 AGV wasm 可访问且 MIME 正确', aWasmRes.ok && (aWasmRes.headers.get('content-type') ?? '').includes('wasm'));
    const aDigest = createHash('sha256').update(aWasmBytes).digest('hex');
    check('页面取到的 AGV wasm 与清单 sha256 一致', aDigest === am.wasm.sha256, aDigest.slice(0, 16) + '…');
    const aWorkerRes = await fetch(`${baseUrl}${am.worker.file}`);
    check('AGV Worker 入口以 JS MIME 提供', aWorkerRes.ok && (aWorkerRes.headers.get('content-type') ?? '').includes('javascript'));
    for (const mock of (am.mocks ?? []).slice(0, 4)) {
      const res = await fetch(`${baseUrl}${mock.file}`);
      check(`AGV 数据文件可访问 ${mock.file}`, res.ok, `HTTP ${res.status}`);
    }
    const aGlue = await import(`${pathToFileURL(join(mounted, 'wasm', 'agv-worker.js')).href}?t=${Date.now()}`);
    const aEngine = await aGlue.createEngine(aWasmBytes);
    check('AGV：页面字节可实例化', typeof aEngine.version === 'string', `v${aEngine.version}`);
    const a01Entry = (am.mocks ?? []).find((m) => m.file.includes('a01'));
    const a01 = JSON.parse(readFileSync(join(mounted, a01Entry.file), 'utf8'));
    const aSolved = aEngine.solve(JSON.stringify(a01));
    check(
      'AGV：端到端求解成功（页面同源数据 → WASM → 解，FEASIBLE 且内嵌核验通过）',
      aSolved.status === 'FEASIBLE' && aSolved.solution?.verified === true,
      `${aSolved.status} · completed=${aSolved.solution?.metrics?.completed_tasks}`,
    );
    const a10Entry = (am.mocks ?? []).find((m) => m.file.includes('a10-dynamic'));
    const a10 = JSON.parse(readFileSync(join(mounted, a10Entry.file), 'utf8'));
    const a10Solved = aEngine.solve(JSON.stringify(a10));
    check(
      'AGV：动态重调度端到端成功（快照展开 + 汇总块 + 语义指纹）',
      a10Solved.status === 'FEASIBLE' && a10Solved.solution?.dynamic?.semantic_digest?.startsWith('sha256:'),
      `${a10Solved.status} · snapshot_t=${a10Solved.solution?.dynamic?.snapshot_time}`,
    );
  } else {
    console.log('· 站点未部署 agv-manifest.json：跳过 AGV 运行时校验');
  }
} finally {
  server.close();
  rmSync(siteRoot, { recursive: true, force: true });
}

finish(`✓ Pages 子路径仿真通过（base=${base}）`);
