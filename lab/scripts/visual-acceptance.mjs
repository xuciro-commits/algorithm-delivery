#!/usr/bin/env node
/**
 * Production-build browser acceptance for the real APS / MAPF / AGV Three.js scenes.
 * Uses software-WebGL-compatible Chromium in CI; these screenshots are visual evidence,
 * never a proxy for frame-rate or desktop-GPU performance.
 */

import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const labDir = resolve(here, '..');
const repoRoot = resolve(labDir, '..');
const distDir = join(labDir, 'dist');
const artifactDir = resolve(process.env.VISUAL_ARTIFACT_DIR ?? join(labDir, 'artifacts', 'visual'));
const pathPrefix = '/algorithm-delivery/';
const modules = [
  { id: 'APS', route: 'aps', button: '运行排程', stage: '.aps-static-preview .aps-stage, .aps-stage' },
  { id: 'MAPF', route: 'path-planning', button: '求解', stage: '.mapf-stage-wrap' },
  { id: 'AGV', route: 'agv-dispatch', button: '求解调度', stage: '.mapf-stage-wrap' },
];
const referenceFiles = {
  APS: 'aps-lab-concept.png',
  MAPF: 'mapf-lab-concept.png',
  AGV: 'agv-lab-concept.png',
};
const results = [];
let server;
let browser;
let fatalError = null;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.hdr': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function safeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function startDistServer() {
  if (!existsSync(join(distDir, 'index.html'))) throw new Error(`Production build is missing: ${distDir}/index.html`);
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
      const localPath = pathname.startsWith(pathPrefix) ? pathname.slice(pathPrefix.length) : pathname.replace(/^\/+/, '');
      let filePath = resolve(distDir, localPath || 'index.html');
      if (filePath !== distDir && !filePath.startsWith(`${distDir}${sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      try {
        const details = await stat(filePath);
        if (details.isDirectory()) filePath = join(filePath, 'index.html');
        const body = await readFile(filePath);
        response.writeHead(200, {
          'content-type': contentTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        response.end(body);
      } catch {
        // SPA hash routes are served by the actual built index; unknown asset URLs stay 404.
        if (extname(localPath)) {
          response.writeHead(404).end('Not found');
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(await readFile(join(distDir, 'index.html')));
      }
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate local production-preview port');
  return `http://127.0.0.1:${address.port}${pathPrefix}`;
}

function analyseCanvasPng(buffer) {
  const image = PNG.sync.read(buffer);
  const { data, width, height } = image;
  const pixels = width * height;
  const corner = [data[0], data[1], data[2]];
  let lumaTotal = 0;
  let lit = 0;
  let nonBackground = 0;
  let nearBlack = 0;
  let clipped = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaTotal += luma;
    if (luma > 23) lit += 1;
    if (Math.max(Math.abs(r - corner[0]), Math.abs(g - corner[1]), Math.abs(b - corner[2])) > 18 && luma > 14) nonBackground += 1;
    if (luma < 5) nearBlack += 1;
    if (Math.min(r, g, b) > 248) clipped += 1;
  }
  return {
    width,
    height,
    meanLuma: Number((lumaTotal / pixels).toFixed(2)),
    litPixelRatio: Number((lit / pixels).toFixed(4)),
    nonBackgroundPixelRatio: Number((nonBackground / pixels).toFixed(4)),
    nearBlackPixelRatio: Number((nearBlack / pixels).toFixed(4)),
    clippedPixelRatio: Number((clipped / pixels).toFixed(4)),
    cornerRgb: corner,
  };
}

async function waitForCanvas(page, canvasSelector) {
  await page.locator(canvasSelector).first().waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForFunction(
    (selector) => {
      const canvas = document.querySelector(selector);
      const meshes = Number(canvas?.dataset.sceneMeshes ?? 0);
      const triangles = Number(canvas?.dataset.sceneTriangles ?? 0);
      const drawCalls = Number(canvas?.dataset.webglDrawCalls ?? 0);
      return canvas?.dataset.webglReady === 'true'
        && canvas?.dataset.webglRendered === 'true'
        && canvas?.dataset.hdriReady === 'true'
        && meshes >= 8
        && triangles >= 100
        && drawCalls > 0;
    },
    canvasSelector,
    { timeout: 60_000 },
  );
  const health = await page.locator(canvasSelector).first().evaluate((canvas) => {
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const rect = canvas.getBoundingClientRect();
    return {
      contextAvailable: Boolean(gl),
      contextLost: gl?.isContextLost() ?? true,
      version: canvas.dataset.webglVersion ?? null,
      renderer: canvas.dataset.webglRenderer ?? null,
      vendor: canvas.dataset.webglVendor ?? null,
      sceneMeshes: Number(canvas.dataset.sceneMeshes ?? 0),
      sceneTriangles: Number(canvas.dataset.sceneTriangles ?? 0),
      drawCalls: Number(canvas.dataset.webglDrawCalls ?? 0),
      frames: Number(canvas.dataset.webglFrameCount ?? 0),
      hdriReady: canvas.dataset.hdriReady === 'true',
      cssWidth: Math.round(rect.width),
      cssHeight: Math.round(rect.height),
      bufferWidth: canvas.width,
      bufferHeight: canvas.height,
      devicePixelRatio: window.devicePixelRatio,
      cameraZoom: canvas.dataset.cameraZoom ?? null,
    };
  });
  if (!health.contextAvailable || health.contextLost) throw new Error('A real WebGL context is unavailable or lost');
  if (!health.hdriReady) throw new Error('The local HDR environment map has not initialized');
  if (health.cssWidth < 320 || health.cssHeight < 240 || health.bufferWidth < 320 || health.bufferHeight < 240) {
    throw new Error(`WebGL canvas is undersized: ${JSON.stringify(health)}`);
  }
  return health;
}

async function waitForRunnable(page, label) {
  await page.waitForFunction(
    (buttonName) => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === buttonName && !button.disabled),
    label,
    { timeout: 120_000 },
  );
}

async function captureModule(module, baseUrl) {
  const page = await browser.newPage({
    viewport: { width: 1680, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const log = { console: [], pageErrors: [], failedRequests: [], httpErrors: [] };
  page.on('console', (message) => {
    log.console.push({ type: message.type(), text: message.text(), location: message.location() });
  });
  page.on('pageerror', (error) => log.pageErrors.push({ message: error.message, stack: error.stack }));
  page.on('requestfailed', (request) => log.failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? 'unknown' }));
  page.on('response', (response) => {
    if (response.status() >= 400) log.httpErrors.push({ status: response.status(), url: response.url() });
  });

  const lower = module.id.toLowerCase();
  const moduleDir = join(artifactDir, module.id);
  await mkdir(moduleDir, { recursive: true });
  const canvasSelector = '.sandbox-stage canvas';
  const stageSelector = module.stage;
  const record = { module: module.id, route: module.route, screenshots: {}, log, failed: false };

  try {
    await page.goto(`${baseUrl}#${module.route}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const stage = page.locator(stageSelector).first();
    await stage.waitFor({ state: 'visible', timeout: 60_000 });
    await waitForCanvas(page, canvasSelector);
    await stage.scrollIntoViewIfNeeded();
    const initialCanvas = page.locator(canvasSelector).first();
    const initialHealth = await initialCanvas.evaluate((canvas) => ({
      zoom: Number(canvas.dataset.cameraZoom ?? 0),
      rect: canvas.getBoundingClientRect().toJSON(),
    }));

    const fullPath = join(moduleDir, `${lower}-01-full-scene.png`);
    const fullBuffer = await stage.screenshot({ path: fullPath, animations: 'disabled' });
    const fullPixels = analyseCanvasPng(await initialCanvas.screenshot());
    record.screenshots.fullScene = relative(artifactDir, fullPath);
    record.fullScene = { ...initialHealth, pixels: fullPixels, webgl: await waitForCanvas(page, canvasSelector) };
    if (fullPixels.meanLuma < 10 && fullPixels.litPixelRatio < 0.005) {
      throw new Error(`Rendered canvas appears black (luma=${fullPixels.meanLuma}, lit=${fullPixels.litPixelRatio})`);
    }
    if (fullPixels.nonBackgroundPixelRatio < 0.006) {
      throw new Error(`Rendered canvas is nearly flat/empty (${fullPixels.nonBackgroundPixelRatio} non-background pixels)`);
    }

    await waitForRunnable(page, module.button);
    await page.getByRole('button', { name: module.button, exact: true }).click();
    await page.waitForFunction(
      (id) => {
        const root = document.querySelector(`[data-visual-module="${id.toLowerCase()}"]`);
        const status = root?.getAttribute('data-solution-status') ?? 'idle';
        const count = Number(root?.getAttribute(id === 'APS' ? 'data-solution-operations' : id === 'MAPF' ? 'data-solution-agents' : 'data-solution-vehicles') ?? 0);
        return status !== 'idle' && status !== '' && count > 0;
      },
      module.id,
      { timeout: 120_000 },
    );
    await waitForCanvas(page, canvasSelector);
    const result = await page.locator(`[data-visual-module="${module.id.toLowerCase()}"]`).evaluate((root) => ({
      status: root.getAttribute('data-solution-status'),
      count: Number(root.getAttribute('data-solution-operations') ?? root.getAttribute('data-solution-agents') ?? root.getAttribute('data-solution-vehicles') ?? 0),
      text: root.textContent?.slice(0, 1400) ?? '',
    }));
    record.solution = result;
    if (!['OPTIMAL', 'FEASIBLE'].includes(String(result.status).toUpperCase())) {
      throw new Error(`Actual engine solve did not produce a feasible status: ${JSON.stringify(result)}`);
    }

    const runPath = join(moduleDir, `${lower}-03-running-state.png`);
    await page.locator(stageSelector).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: runPath, animations: 'disabled' });
    record.screenshots.runningState = relative(artifactDir, runPath);

    // The close-up is created by the real OrbitControls wheel interaction, not a crop
    // or a substituted image. Verify that the orthographic camera actually zooms.
    const liveCanvas = page.locator(canvasSelector).first();
    const beforeZoom = Number(await liveCanvas.getAttribute('data-camera-zoom')) || Number((await liveCanvas.evaluate((c) => c.dataset.cameraZoom)) ?? 0);
    const rect = await liveCanvas.boundingBox();
    if (!rect) throw new Error('WebGL canvas has no browser bounding box');
    await page.mouse.move(rect.x + rect.width * 0.52, rect.y + rect.height * 0.5);
    await page.mouse.wheel(0, -360);
    await page.waitForFunction(
      ({ selector, before }) => Number(document.querySelector(selector)?.dataset.cameraZoom ?? 0) > before * 1.04,
      { selector: canvasSelector, before: beforeZoom },
      { timeout: 10_000 },
    );
    const detailPath = join(moduleDir, `${lower}-02-model-detail.png`);
    await page.locator(stageSelector).first().screenshot({ path: detailPath, animations: 'disabled' });
    record.screenshots.modelDetail = relative(artifactDir, detailPath);
    record.detailZoom = await liveCanvas.evaluate((canvas) => Number(canvas.dataset.cameraZoom ?? 0));

    const finalHealth = await waitForCanvas(page, canvasSelector);
    if (log.pageErrors.length > 0) throw new Error(`Browser page errors: ${log.pageErrors.map((e) => e.message).join(' | ')}`);
    const consoleErrors = log.console.filter((message) => message.type === 'error');
    if (consoleErrors.length > 0) throw new Error(`Browser console errors: ${consoleErrors.map((e) => e.text).join(' | ')}`);
    if (log.failedRequests.length > 0) throw new Error(`Failed browser requests: ${log.failedRequests.map((e) => e.url).join(' | ')}`);
    if (log.httpErrors.length > 0) throw new Error(`HTTP errors: ${log.httpErrors.map((e) => `${e.status} ${e.url}`).join(' | ')}`);
    if (finalHealth.contextLost) throw new Error('WebGL context was lost during interaction');
    record.finalHealth = finalHealth;
    record.passed = true;
    // Keep a byte-size trail in the report so reviewers can distinguish a true capture
    // from an empty/zero-byte placeholder.
    record.screenshotBytes = {
      fullScene: fullBuffer.length,
      modelDetail: (await stat(detailPath)).size,
      runningState: (await stat(runPath)).size,
    };
  } catch (error) {
    record.failed = true;
    record.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    // Failure screenshots and telemetry are still part of the artifact.
    try {
      const currentCanvas = page.locator(canvasSelector).first();
      if (await currentCanvas.count()) {
        const failureCanvasPath = join(moduleDir, `${lower}-failure-canvas.png`);
        await currentCanvas.screenshot({ path: failureCanvasPath, timeout: 10_000 });
        record.screenshots.failureCanvas = relative(artifactDir, failureCanvasPath);
      }
      const failurePagePath = join(moduleDir, `${lower}-failure-page.png`);
      await page.screenshot({ path: failurePagePath, fullPage: false, timeout: 10_000 });
      record.screenshots.failurePage = relative(artifactDir, failurePagePath);
    } catch (captureError) {
      record.failureCaptureError = String(captureError);
    }
  } finally {
    await writeFile(join(moduleDir, `${lower}-console.json`), `${JSON.stringify(log, null, 2)}\n`);
    await page.close();
  }
  return record;
}

async function writeComparisonReport(baseUrl) {
  const sections = modules.map((module) => {
    const reference = `references/${referenceFiles[module.id]}`;
    const full = results.find((result) => result.module === module.id)?.screenshots?.fullScene;
    const detail = results.find((result) => result.module === module.id)?.screenshots?.modelDetail;
    const run = results.find((result) => result.module === module.id)?.screenshots?.runningState;
    return `<section class="module">
      <h2>${safeHtml(module.id)} <small>${safeHtml(module.route)}</small></h2>
      <div class="pair"><figure><figcaption>仓库内视觉概念参考</figcaption><img src="${safeHtml(reference)}" alt="${safeHtml(module.id)} concept reference"></figure>
      <figure><figcaption>生产构建 · 求解前完整场景（真实 WebGL）</figcaption>${full ? `<a href="${safeHtml(full)}"><img src="${safeHtml(full)}" alt="${safeHtml(module.id)} full scene"></a>` : '<p>未能取得场景截图，见测试日志。</p>'}</figure></div>
      <div class="pair small-pair"><figure><figcaption>真实相机缩放 · 模型细节</figcaption>${detail ? `<a href="${safeHtml(detail)}"><img src="${safeHtml(detail)}" alt="${safeHtml(module.id)} model detail"></a>` : '<p>无细节截图。</p>'}</figure>
      <figure><figcaption>真实 WASM 求解后的运行状态</figcaption>${run ? `<a href="${safeHtml(run)}"><img src="${safeHtml(run)}" alt="${safeHtml(module.id)} running state"></a>` : '<p>无运行截图。</p>'}</figure></div>
    </section>`;
  }).join('\n');
  const passed = results.filter((result) => result.passed).length;
  const failures = results.filter((result) => result.failed);
  const report = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Algorithm Delivery · Three.js Visual Acceptance</title><style>
  :root{color-scheme:dark;font:14px/1.5 system-ui,sans-serif;background:#07101b;color:#e7eef6}body{margin:0 auto;max-width:1500px;padding:24px}h1{font-size:24px;margin:0 0 6px}h2{font-size:18px;margin:0 0 14px}h2 small{color:#8fa4b7;font-size:12px;font-weight:400}p,.note{color:#a7b6c4}.summary{padding:14px 16px;border:1px solid #284153;border-radius:12px;background:#101c29;margin:18px 0 22px}.pass{color:#72d8b2}.fail{color:#ff8e8e}.module{border-top:1px solid #284153;padding:22px 0 28px}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:10px 0 16px}figure{margin:0;min-width:0;padding:10px;border:1px solid #223747;border-radius:10px;background:#0c1723}figcaption{font-size:12px;color:#b8c7d5;margin:0 0 8px}img{display:block;width:100%;height:auto;max-height:640px;object-fit:contain;background:#080e17;border-radius:5px}a{color:inherit}.note{font-size:12px}@media(max-width:780px){.pair{grid-template-columns:1fr}body{padding:14px}}
  </style><body><h1>Algorithm Delivery · 三维视觉验收</h1><p class="note">Built output: <code>${safeHtml(baseUrl)}</code> · Generated ${safeHtml(new Date().toISOString())}. Browser WebGL evidence only; CI software-GPU results are not desktop performance measurements.</p>
  <div class="summary"><b class="${failures.length ? 'fail' : 'pass'}">${passed}/${modules.length} modules passed</b><p>每个运行截图由当前 Vite production build 直接生成；需要真实 WebGL context、已加载本地 HDRI、实际三角形/绘制调用、非黑屏像素和真实引擎求解。参考图来自仓库中的已交付概念图，配对图用于人工视觉审查，不代表自动美术评分。</p>${failures.length ? `<ul>${failures.map((entry) => `<li class="fail">${safeHtml(entry.module)}: ${safeHtml(entry.error ?? 'failed')}</li>`).join('')}</ul>` : ''}</div>${sections}
  </body></html>`;
  await writeFile(join(artifactDir, 'visual-comparison.html'), report);
  await writeFile(join(artifactDir, 'visual-summary.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    productionBuild: true,
    browser: 'Playwright Chromium · WebGL via SwiftShader (software GPU; CI visual evidence only)',
    desktopPerformanceMeasured: false,
    references: referenceFiles,
    results,
  }, null, 2)}\n`);
}

async function main() {
  await mkdir(artifactDir, { recursive: true });
  await mkdir(join(artifactDir, 'references'), { recursive: true });
  for (const [id, file] of Object.entries(referenceFiles)) {
    const source = join(repoRoot, 'lab', 'design', 'concepts', file);
    if (!existsSync(source)) throw new Error(`Visual reference not delivered in the repository: ${source}`);
    const info = await stat(source);
    if (info.size < 10_000) throw new Error(`Visual reference is unexpectedly small: ${source} (${info.size} bytes)`);
    await copyFile(source, join(artifactDir, 'references', file));
  }
  const baseUrl = await startDistServer();
  try {
    const configuredArgs = process.env.PLAYWRIGHT_CHROMIUM_ARGS
      ? JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS)
      : [];
    if (!Array.isArray(configuredArgs) || configuredArgs.some((arg) => typeof arg !== 'string')) {
      throw new Error('PLAYWRIGHT_CHROMIUM_ARGS must be a JSON array of strings');
    }
    const configuredExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    browser = await chromium.launch({
      headless: true,
      ...(configuredExecutable ? { executablePath: configuredExecutable } : {}),
      args: [
        ...configuredArgs,
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage',
      ],
    });
    for (const module of modules) results.push(await captureModule(module, baseUrl));
  } catch (error) {
    fatalError = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolveClose) => server.close(resolveClose));
  }
  await writeComparisonReport(baseUrl);
  if (fatalError) {
    await writeFile(join(artifactDir, 'runner-error.txt'), `${fatalError}\n`);
    console.error(`✗ visual acceptance runner: ${fatalError}`);
    process.exitCode = 1;
    return;
  }
  const failed = results.filter((result) => result.failed);
  console.log(`\nVisual acceptance: ${results.length - failed.length}/${results.length} modules passed`);
  for (const result of results) console.log(`${result.passed ? '✓' : '✗'} ${result.module}: ${result.solution?.status ?? 'no solution'}${result.error ? ` — ${result.error.split('\n')[0]}` : ''}`);
  console.log(`Artifact report: ${join(artifactDir, 'visual-comparison.html')}`);
  if (failed.length) process.exitCode = 1;
}

main().catch(async (error) => {
  fatalError = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, 'runner-error.txt'), `${fatalError}\n`);
  console.error(fatalError);
  process.exitCode = 1;
});
