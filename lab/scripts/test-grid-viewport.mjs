#!/usr/bin/env node
/**
 * 网格视口测试（M0 §4.2 的回归网）。
 *
 * 为什么需要：`fitViewport` 是「格 ↔ 像素」的唯一换算入口，2D 舞台的观感全在它手里。
 * 曾经出过的真实问题：2×2 的极小 MAPF 场景被按真实尺寸全屏适配，cellPx 放大到几百
 * 像素，格内的起点方框/终点菱形糊满整屏（看起来像渲染坏掉）。现在加了 `minExtent`
 * 最小视野，这条用例就是防止它被改回去。
 *
 * 纯 Node（esbuild 打包纯 TS 模块），不需要浏览器。
 */

import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHarness } from './lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const { check, finish } = createHarness('网格视口测试');

const tmp = join(labDir, 'node_modules', '.lab-grid-viewport');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
await build({
  entryPoints: [join(labDir, 'src/components/grid-map/viewport.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: join(tmp, 'viewport.mjs'),
  logLevel: 'warning',
});
const { cellToPx, fitViewport, lodLevel, pxToCell, visibleCells, zoomAt } = await import(
  pathToFileURL(join(tmp, 'viewport.mjs')).href
);

const size = { w: 800, h: 600 };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// —— 1) 默认行为：8×8 + margin 1 → 10 格视野 ——
{
  const vp = fitViewport({ width: 8, height: 8 }, size);
  check('8×8 默认适配 cellPx = min(800/10, 600/10)', near(vp.cellPx, 60), String(vp.cellPx));
  check('8×8 居中：tx/ty 按真实尺寸算', near(vp.tx, (800 - 480) / 2) && near(vp.ty, (600 - 480) / 2), `${vp.tx},${vp.ty}`);
}

// —— 2) 回归：极小地图不得被放大（minExtent = 8）——
{
  const tiny = fitViewport({ width: 2, height: 2 }, size, 1, { minExtent: 8 });
  const normal = fitViewport({ width: 8, height: 8 }, size, 1, { minExtent: 8 });
  check('2×2 的适配 cellPx 不超过 8×8 的 cellPx', tiny.cellPx <= normal.cellPx + 1e-9, `${tiny.cellPx} vs ${normal.cellPx}`);
  check('2×2 仍按真实尺寸居中（不偏移）', near(tiny.tx, (800 - 2 * tiny.cellPx) / 2), String(tiny.tx));
  check('2×2 的格子不再是“巨框”（cellPx ≤ 舞台短边 / 8）', tiny.cellPx <= 600 / 8 + 1e-9, String(tiny.cellPx));
  const big = fitViewport({ width: 32, height: 32 }, size, 1, { minExtent: 8 });
  check('minExtent 不影响大图（32×32 仍是真实适配）', near(big.cellPx, Math.min(800 / 34, 600 / 34)), String(big.cellPx));
}

// —— 3) zoomAt：以 fit 为基准的上下限 ——
{
  const fit = fitViewport({ width: 8, height: 8 }, size);
  const ax = 400;
  const ay = 300;
  const zin = zoomAt(fit, ax, ay, 2, 0.3, 8, fit.cellPx);
  check('放大有上限（≤ fit × 8）', zin.cellPx <= fit.cellPx * 8 + 1e-6, String(zin.cellPx));
  const zout = zoomAt(fit, ax, ay, 0.001, 0.3, 8, fit.cellPx);
  check('缩小有下限（≥ fit × 0.3）', zout.cellPx >= fit.cellPx * 0.3 - 1e-6, String(zout.cellPx));
  const cellBefore = pxToCell(fit, ax, ay);
  const cellAfter = pxToCell(zin, ax, ay);
  check(
    '锚点缩放：锚点像素下的格保持不变',
    cellAfter.x === cellBefore.x && cellAfter.y === cellBefore.y,
    `${JSON.stringify(cellBefore)} → ${JSON.stringify(cellAfter)}`,
  );
}

// —— 4) 坐标换算互逆 + culling 不越界 ——
{
  const vp = fitViewport({ width: 5, height: 7 }, size);
  for (const cell of [{ x: 0, y: 0 }, { x: 4, y: 6 }, { x: 2, y: 3 }]) {
    const px = cellToPx(vp, cell);
    const back = pxToCell(vp, px.x + vp.cellPx / 2, px.y + vp.cellPx / 2);
    check(`格 ↔ 像素互逆 (${cell.x},${cell.y})`, back.x === cell.x && back.y === cell.y, JSON.stringify(back));
  }
  const vis = visibleCells(vp, size, { width: 5, height: 7 });
  check('可视范围落在图内', vis.x0 >= 0 && vis.y0 >= 0 && vis.x1 <= 4 && vis.y1 <= 6, JSON.stringify(vis));
}

// —— 5) LOD 档位（与 M0 §4.3 常量一致）——
{
  check('LOD：≥22 → 0', lodLevel(22) === 0 && lodLevel(40) === 0);
  check('LOD：14–22 → 1', lodLevel(14) === 1 && lodLevel(21.9) === 1);
  check('LOD：8–14 → 2', lodLevel(8) === 2 && lodLevel(13.9) === 2);
  check('LOD：< 8 → 3', lodLevel(7.99) === 3);
}

finish('全部通过');
