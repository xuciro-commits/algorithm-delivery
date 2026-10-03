#!/usr/bin/env node
/**
 * 把仓库内已有的工业模型资产（`lab/design/assets/**`，CC0）**原样复制**成运行时资源集合，
 * 并生成 `lab/public/models/manifest.json`。
 *
 * 设计约束（对应本轮“不重新建模、不覆盖原始资产”）：
 *   - 只读取 `lab/design/assets`，从不写入、不改动、不重命名源文件；
 *   - 只复制被艺术化场景实际引用的一份（避免把 475 个模型全部塞进构建产物）；
 *   - 清单里记录真实尺寸（米）与源文件 sha256，便于验收与缓存指纹。
 *
 * 用法：
 *   node scripts/sync-visual-assets.mjs            # 复制 + 写清单
 *   node scripts/sync-visual-assets.mjs --check    # 只校验（CI：源文件与清单一致，不写盘）
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const sourceRoot = join(labDir, 'design/assets');
const outRoot = join(labDir, 'public/models');
const checkOnly = process.argv.includes('--check');

/**
 * 艺术化场景引用的模型集合。
 *
 * 每一条：`category/filename` + 角色用途（place）。真正的尺寸不会写死在这里——
 * 运行时从 `ASSET-CATALOG.json` 的 `sizeMeters` 取，保证与源资产一致。
 */
const SET = [
  // —— APS：机加工与产线主体 ——
  'aps-machining/cnc-machining-centre-with-sliding-door.glb',
  'aps-machining/engine-lathe-with-2-4-m-bed.glb',
  'aps-machining/vertical-milling-machine.glb',
  'aps-machining/hydraulic-forming-press.glb',
  'aps-machining/stamping-press.glb',
  'aps-machining/six-axis-welding-robot.glb',
  'aps-machining/glass-fitting-robot.glb',
  'aps-machining/press-brake-for-sheet-metal.glb',
  'aps-machining/guarded-band-saw.glb',
  'aps-machining/surface-grinder-with-magnetic-chuck.glb',
  'aps-machining/pillar-drill-press-floor-standing.glb',
  'aps-machining/andon-light-tower.glb',
  'aps-machining/line-side-rack.glb',
  'aps-machining/sheet-metal-storage-rack.glb',
  'aps-machining/overhead-gantry-crane-bridge-with-trolley.glb',
  'aps-machining/high-bay-light-fitting.glb',
  // —— 输送 / 物流 ——
  'conveyors-logistics/powered-belt-conveyor-4-m-straight.glb',
  'conveyors-logistics/powered-belt-conveyor-90-degree-curve.glb',
  'conveyors-logistics/free-roller-conveyor.glb',
  'conveyors-logistics/three-way-belt-splitter.glb',
  'conveyors-logistics/incline-belt-conveyor-1-5-m-rise.glb',
  'conveyors-logistics/barcode-scanning-arch.glb',
  'conveyors-logistics/assembly-workbench.glb',
  'conveyors-logistics/machine-safety-fence.glb',
  'conveyors-logistics/robot-fence-panel.glb',
  'conveyors-logistics/warehouse-pallet-rack.glb',
  'conveyors-logistics/palletizing-gantry.glb',
  'conveyors-logistics/robot-assembly-arm.glb',
  'conveyors-logistics/tool-storage-cabinet.glb',
  'conveyors-logistics/power-distribution-cabinet.glb',
  'conveyors-logistics/operator-control-pedestal.glb',
  'conveyors-logistics/three-state-signal-tower.glb',
  'conveyors-logistics/marked-factory-floor-module.glb',
  'conveyors-logistics/safety-bollard.glb',
  // —— 厂房外壳（透明厂房 = 分层的柱 / 桁架 / 墙板 / 天窗 / 卷帘门）——
  'aps-machining/hall-steel-column.glb',
  'aps-machining/hall-roof-truss-bay.glb',
  'aps-machining/hall-ridge-skylight-bay.glb',
  'aps-machining/hall-roller-door-bay.glb',
  'aps-machining/hall-wall-bay-with-high-windows.glb',
  'aps-machining/hall-roof-cladding-bay.glb',
  'conveyors-logistics/hall-wall-cladding-bay.glb',
  'aps-machining/mezzanine-floor-bay-with-handrail-6-m.glb',
  'aps-machining/gantry-crane-runway-rail-6-m.glb',
  'aps-machining/floor-tile-plain.glb',
  // —— AGV：仓储与车辆 ——
  'agv-warehouse/agv-mover.glb',
  'agv-warehouse/agv-loader.glb',
  'agv-warehouse/counterbalance-forklift-truck.glb',
  'agv-warehouse/pallet-racking-bay-two-levels.glb',
  'agv-warehouse/empty-pallet-stack.glb',
  'agv-warehouse/forklift-charging-bay.glb',
  'agv-warehouse/aisle-safety-barrier.glb',
  'agv-warehouse/aisle-floor-marking-tile.glb',
  'agv-warehouse/high-level-aisle-sign.glb',
  'agv-warehouse/aisle-entry-gate.glb',
  'agv-warehouse/concrete-floor-tile-plain-6-m.glb',
  'agv-warehouse/marked-walkway-floor-tile-4-m.glb',
  // —— MAPF：移动机器人 ——
  'mapf-robotics/delivery-bot.glb',
  'mapf-robotics/quadruped-scout.glb',
  'mapf-robotics/rover-4wd.glb',
  'mapf-robotics/service-robot-biped.glb',
  'mapf-robotics/robot-arm-floor.glb',
  'mapf-robotics/robot-arm-bench.glb',
  'mapf-robotics/charging-pad-square.glb',
  'mapf-robotics/storage-locker-tall.glb',
  'mapf-robotics/workbench-robotics.glb',
  'mapf-robotics/spotlight-tower.glb',
  'mapf-robotics/workshop-floor-tile.glb',
  // —— 完整产线（可整体载入的既有装配场景）——
  'assembled-scenes/conveyor-network-production-floor.glb',
  // —— 洁净实验室（同一材质语言在另一种空间里的对照）——
  'lab-cleanroom/fume-cupboard.glb',
  'lab-cleanroom/biosafety-cabinet.glb',
  'lab-cleanroom/bench-run-module.glb',
  'lab-cleanroom/lab-fridge.glb',
  'lab-cleanroom/cleanroom-wall-panel.glb',
  'lab-cleanroom/cleanroom-ceiling-filter-panel.glb',
];

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const catalogPath = join(sourceRoot, 'ASSET-CATALOG.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const byRel = new Map(catalog.assets.map((asset) => [asset.rel_path, asset]));

const entries = [];
const missing = [];
let bytes = 0;

for (const rel of SET) {
  const source = join(sourceRoot, rel);
  if (!existsSync(source)) {
    missing.push(rel);
    continue;
  }
  const asset = byRel.get(rel);
  const size = statSync(source).size;
  bytes += size;
  const entry = {
    id: asset?.id ?? rel,
    // 运行时 key：稳定且与文件名解耦
    key: rel.replace(/^.*\//, '').replace(/\.glb$/, ''),
    file: rel.replace(/\//g, '__'),
    source: `lab/design/assets/${rel}`,
    category: rel.split('/')[0],
    title: asset?.title ?? rel,
    summary: asset?.summary ?? '',
    license: asset?.license ?? 'CC0 1.0 Universal',
    bytes: size,
    sha256: sha256(source),
    /** 真实世界尺寸（米）：来自资产目录，运行时用它把模型归一到米制。 */
    sizeMeters: asset?.sizeMeters ?? null,
    triangles: asset?.stats?.triangles ?? null,
    materials: asset?.stats?.materials ?? null,
    animations: asset?.animations ?? [],
  };
  entries.push(entry);
}

if (missing.length) {
  console.error(`✗ sync-visual-assets: ${missing.length} 个模型不存在：\n  - ${missing.join('\n  - ')}`);
  process.exit(1);
}

const manifest = {
  version: 'visual-set/1.0',
  generatedAt: new Date().toISOString(),
  source: 'lab/design/assets（CC0 1.0 Universal，原样复制，未修改源文件）',
  total: entries.length,
  bytes,
  assets: entries,
};

if (checkOnly) {
  const target = join(outRoot, 'manifest.json');
  if (!existsSync(target)) {
    console.error(`✗ sync-visual-assets --check: 缺少 ${target}，请先运行 node scripts/sync-visual-assets.mjs`);
    process.exit(1);
  }
  const current = JSON.parse(readFileSync(target, 'utf8'));
  const currentByKey = new Map(current.assets.map((a) => [a.key, a]));
  const drift = entries.filter((entry) => currentByKey.get(entry.key)?.sha256 !== entry.sha256);
  if (drift.length) {
    console.error(`✗ sync-visual-assets --check: ${drift.length} 个模型与清单不一致：${drift.map((d) => d.key).join(', ')}`);
    process.exit(1);
  }
  for (const entry of entries) {
    if (!existsSync(join(outRoot, entry.file))) {
      console.error(`✗ sync-visual-assets --check: 缺少产物 ${entry.file}`);
      process.exit(1);
    }
  }
  console.log(`✓ sync-visual-assets --check: ${entries.length} 个模型与清单一致（${(bytes / 1024 / 1024).toFixed(1)} MB）`);
  process.exit(0);
}

// 只清理本脚本管理的目录，绝不触碰 design/assets 与其它 public 子目录
rmSync(join(outRoot), { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });
for (const entry of entries) {
  const rel = entry.source.replace(/^lab\/design\/assets\//, '');
  copyFileSync(join(sourceRoot, rel), join(outRoot, entry.file));
}
// 页面上要能直接到每种分类的目录列表（Studio 的资产浏览器用）
const byCategory = {};
for (const entry of entries) (byCategory[entry.category] ??= []).push(entry.key);
writeFileSync(join(outRoot, 'index.json'), `${JSON.stringify({ categories: byCategory }, null, 2)}\n`);
writeFileSync(join(outRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const relativeOut = relative(labDir, outRoot);
console.log(`✓ sync-visual-assets: ${entries.length} 个模型 → ${relativeOut}（${(bytes / 1024 / 1024).toFixed(1)} MB，原样复制）`);
console.log(`  分类：${Object.keys(byCategory).map((k) => `${k}(${byCategory[k].length})`).join(' ')}`);
void readdirSync;
