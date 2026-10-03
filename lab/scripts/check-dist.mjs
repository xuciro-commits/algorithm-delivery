#!/usr/bin/env node
/**
 * 构建产物校验（CI 在 deploy 之前必须通过）：
 *
 *  1. `dist/` 存在且包含 index.html、wasm、worker、engine-manifest.json、mock 数据；
 *  2. **子路径部署**：index.html 里的资源引用必须以配置的 base 开头
 *     （否则 Pages 上会 404 —— 这是最容易犯又最难本地发现的错误）；
 *  3. 清单里的 sha256 与实际 wasm 文件一致（防止“清单写的是另一版产物”）；
 *  4. 构建后的 JS 里出现 base 前缀的清单/数据路径（说明运行时会走子路径）；
 *  5. `dist` 内不得出现只在开发期存在的东西（node_modules / 绝对 file:// 路径）。
 *
 * 用法：node scripts/check-dist.mjs [--base /algorithm-delivery/]
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const distDir = resolve(labDir, 'dist');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const prefixed = process.argv.find((a) => a.startsWith(`--${name}=`));
  return prefixed ? prefixed.slice(name.length + 3) : fallback;
}

const base = arg('base', process.env.LAB_BASE ?? '/algorithm-delivery/');

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

if (!existsSync(distDir)) {
  console.error(`✗ 找不到构建产物目录：${distDir}（先运行 npm run build）`);
  process.exit(2);
}

const indexHtml = join(distDir, 'index.html');
check('index.html 存在', existsSync(indexHtml));

const manifestPath = join(distDir, 'engine-manifest.json');
check('engine-manifest.json 存在（引擎版本随产物发布）', existsSync(manifestPath));

const wasmPath = join(distDir, 'wasm', 'aps_engine.wasm');
const workerPath = join(distDir, 'wasm', 'aps-worker.js');
check('wasm 产物存在', existsSync(wasmPath));
check('Worker 入口存在', existsSync(workerPath));

if (existsSync(indexHtml)) {
  const html = readFileSync(indexHtml, 'utf8');
  // 资源引用必须以 base 开头（Vite 会把 base 写进 <script>/<link> 的 href/src）
  const assetRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const localRefs = assetRefs.filter((u) => !/^https?:|^data:|^#/.test(u));
  const wrong = localRefs.filter((u) => !u.startsWith(base));
  check(
    `index.html 资源引用均以 base 开头（${base}）`,
    localRefs.length > 0 && wrong.length === 0,
    wrong.length ? `离线引用：${wrong.slice(0, 3).join(', ')}` : `${localRefs.length} 条`,
  );
  // base='/' 时资源本来就是 /assets/...，这个检查只对子路径部署有意义
  if (base !== '/') {
    check('index.html 未硬编码站点根路径（/assets 之类）', !localRefs.some((u) => /^\/assets\//.test(u)));
  }
}

let manifest = null;
if (existsSync(manifestPath)) {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  check('清单含引擎名与版本', Boolean(manifest.engine) && Boolean(manifest.version), `${manifest.engine} v${manifest.version}`);
  check('清单含 wasm 体积与 sha256', typeof manifest.wasm?.bytes === 'number' && /^[0-9a-f]{64}$/.test(manifest.wasm?.sha256 ?? ''));
  check('清单含数据目录（Mock/基准）', Array.isArray(manifest.mocks) && manifest.mocks.length > 0, `${manifest.mocks?.length ?? 0} 条`);
  check('清单标注来源（源码构建 / Release）', typeof manifest.source === 'string' && manifest.source.length > 0, manifest.source);
}

if (existsSync(wasmPath) && manifest?.wasm?.sha256) {
  const bytes = readFileSync(wasmPath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  check('产物 wasm 与清单 sha256 一致', digest === manifest.wasm.sha256, digest.slice(0, 16) + '…');
  check('产物 wasm 体积与清单一致', bytes.length === manifest.wasm.bytes, `${bytes.length} 字节`);
}

if (existsSync(workerPath) && manifest?.worker?.sha256) {
  const digest = createHash('sha256').update(readFileSync(workerPath)).digest('hex');
  check('产物 Worker 与清单 sha256 一致', digest === manifest.worker.sha256);
}

// 数据文件与清单对齐
if (manifest?.mocks) {
  const missing = manifest.mocks.filter((m) => !existsSync(join(distDir, m.file)));
  check('清单里的数据文件都已打包', missing.length === 0, missing.map((m) => m.file).join(', '));
}

// 运行时是否真的会走子路径：构建产物里应出现 `${base}engine-manifest.json`
const assetsDir = join(distDir, 'assets');
let jsText = '';
if (existsSync(assetsDir)) {
  for (const f of readdirSync(assetsDir).filter((f) => f.endsWith('.js'))) {
    jsText += readFileSync(join(assetsDir, f), 'utf8');
  }
}
check('构建产物包含 base 前缀的清单路径（子路径加载）', jsText.includes(`${base}engine-manifest.json`) || jsText.includes(`${base}"`), base);
check('构建产物未残留 file:// 绝对路径', !jsText.includes('file:///'));

// 体积概览（便于发现“误把大文件打进包”）
let total = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else total += st.size;
  }
};
walk(distDir);
check('产物总体积 < 30 MB（避免误打包）', total < 30 * 1024 * 1024, `${(total / 1048576).toFixed(1)} MB`);

if (failures.length > 0) {
  console.error(`\n汇总: ${failures.length} 项失败\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\n✓ dist 校验通过（base=${base}，总体积 ${(total / 1048576).toFixed(1)} MB）`);
