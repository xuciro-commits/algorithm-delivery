#!/usr/bin/env node
/**
 * 仓储两个模块的场景投影单测（纯 Node + esbuild，**不需要** Rust 工具链 / wasm / CLI）。
 *
 * 为什么单独一份：`slotting/scene.ts` 与 `dense-asrs/scene.ts` 是"把引擎输出摆到 3D 里"的
 * 唯一一层投影代码，也是最容易悄悄退化的一层（字段名错了不会报错，只是图层空掉）。
 * 这里用**手工构造的契约数据**把它们跑一遍，断言：
 *
 *   1) 落位来源：库位解读 `result.assignment`，联合解读 `result.slottingAssignment`（同一份口径）；
 *   2) 关联簇叠加：`clusterCells` 只取 `clusters.bySku` 里 ≥0 的 SKU，同簇同色、跨簇不同色，
 *      `clusterCount` / `clusterNote` 原样透传（前端不重聚类、不改写引擎结论）；
 *   3) 倒垛叠加：`locationStates` 里成对的"让空 + 落位"才配成一次让位，
 *      "入库完成"这类状态迁移**不得**被当成倒垛；事件数超过显示上限时如实截断但保留总数；
 *   4) 任务轨迹链路：任务标记的设备来自时间线 `tasks[].devices`（引擎键名，不是 `deviceIds`）。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHarness } from './lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const { check, note, finish } = createHarness('仓储场景投影测试');

const tmp = join(labDir, 'node_modules', '.lab-warehouse-scenes-test');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const entry = join(tmp, 'entry.ts');
const outfile = join(tmp, 'scenes.mjs');
writeFileSync(
  entry,
  `export * from ${JSON.stringify(join(labDir, 'src/modules/slotting/scene.ts'))};\n` +
    `export * from ${JSON.stringify(join(labDir, 'src/modules/dense-asrs/scene.ts'))};\n`,
);

const { build } = await import('esbuild');
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile,
  logLevel: 'warning',
});
const mod = await import(pathToFileURL(outfile).href);

/* ---------------------------------------------------------------- 夹具：拓扑 */

const RACK = {
  id: 'R1',
  aisleId: 'A1',
  origin: [0, 0, 0],
  bays: 2,
  depths: 2,
  bayAxis: [1, 0],
  depthAxis: [0, -1],
  levels: [
    { level: 1, y_m: 0.2, height_m: 1.8 },
    { level: 2, y_m: 2.1, height_m: 1.8 },
  ],
  locationSize: { width_m: 1.2, depth_m: 1.1, height_m: 1.8 },
};

const topology = {
  racks: [RACK],
  aisles: [
    { id: 'A1', level: 1, length_m: 12, axis: [1, 0], endNodeIds: ['N-A1-W', 'N-A1-E'], rackIds: ['R1'] },
  ],
  nodes: [
    { id: 'N-A1-W', position: [-2, 0, -1.2], kind: 'end', aisleId: 'A1' },
    { id: 'N-A1-E', position: [10, 0, -1.2], kind: 'end', aisleId: 'A1' },
    { id: 'N-ST1', position: [12, 0, -1.2], kind: 'station' },
  ],
  links: [
    { id: 'L1', from: 'N-A1-W', to: 'N-A1-E', mode: 'aisle', length_m: 12 },
    { id: 'L2', from: 'N-A1-E', to: 'N-ST1', mode: 'corridor', length_m: 2 },
  ],
  stations: [
    { id: 'ST1', nodeId: 'N-ST1', direction: 'inbound', bufferCapacity: 2, servedBy: ['SH1'] },
  ],
  devices: [{ id: 'SH1', kind: 'shuttle' }],
};

const LOC = (bay, level, depth) => `R1-${bay}-${level}-${depth}`;

/* ---------------------------------------------------------------- 夹具：库位解 */

const slottingProblem = {
  kind: 'slotting',
  scenarioId: 'S01',
  topology,
  skus: [
    { id: 'SKU-A', abcClass: 'A', turnoverPerDay: 9 },
    { id: 'SKU-B', abcClass: 'B', turnoverPerDay: 4 },
    { id: 'SKU-C', abcClass: 'C', turnoverPerDay: 1 },
  ],
  inventory: [
    { id: 'LU-1', skuId: 'SKU-A', locationId: LOC(1, 1, 1) },
    { id: 'LU-2', skuId: 'SKU-B', locationId: LOC(2, 1, 1) },
    { id: 'LU-3', skuId: 'SKU-C', locationId: LOC(1, 2, 2) },
  ],
};

const assignment = [
  { loadUnitId: 'LU-1', skuId: 'SKU-A', locationId: LOC(1, 1, 1) },
  { loadUnitId: 'LU-2', skuId: 'SKU-B', locationId: LOC(2, 1, 1) },
  { loadUnitId: 'LU-3', skuId: 'SKU-C', locationId: LOC(1, 2, 2) },
];

const clusters = {
  count: 2,
  bySku: { 'SKU-A': 0, 'SKU-B': 1, 'SKU-C': -1 },
  note: '按订单共出库权重聚类',
};

const slottingEnvelope = {
  engine: 'rust-warehouse',
  status: 'FEASIBLE',
  metrics: {},
  result: { kind: 'slotting', assignment, clusters },
};

const scene = mod.buildSlottingScene(slottingProblem, slottingEnvelope);

check('库位场景：落位来自 result.assignment', scene.occupant.get(LOC(1, 1, 1))?.skuId === 'SKU-A');
check('库位场景：热力格来自问题数据的周转率', scene.heat.length === 3 && scene.hot.length === 3);
check('库位场景：冷热归一化落在 [0,1]', scene.heat.every((cell) => cell.ratio >= 0 && cell.ratio <= 1));
check(
  '关联簇：只画簇号 ≥0 的 SKU（-1=未成簇不画）',
  scene.clusterCells.length === 2 &&
    scene.clusterCells.every((cell) => cell.cluster >= 0) &&
    !scene.clusterCells.some((cell) => cell.skuId === 'SKU-C'),
  `cells=${scene.clusterCells.map((cell) => `${cell.skuId}#${cell.cluster}`).join(',')}`,
);
check(
  '关联簇：同簇同色、跨簇不同色',
  new Set(scene.clusterCells.map((cell) => cell.color)).size === scene.clusterCells.length,
);
check('关联簇：count / note 原样透传（前端不改写引擎结论）', scene.clusterCount === 2 && scene.clusterNote === '按订单共出库权重聚类');
const sameSceneAgain = mod.buildSlottingScene(slottingProblem, slottingEnvelope);
check(
  '关联簇：同一簇号在不同场景里颜色一致（不会因为实例不同而跳色）',
  sameSceneAgain.clusterCells[0].color === scene.clusterCells[0].color,
);

// 联合解：落位在 result.slottingAssignment 下也必须被画出来（否则联合画布是空的）
const jointScene = mod.buildSlottingScene(slottingProblem, {
  ...slottingEnvelope,
  result: { kind: 'joint', slottingAssignment: assignment, clusters },
});
check('库位场景（联合解）：读 result.slottingAssignment', jointScene.occupant.get(LOC(2, 1, 1))?.skuId === 'SKU-B');

// 没有簇信息时：不画、也不编造
const noClusterScene = mod.buildSlottingScene(slottingProblem, {
  ...slottingEnvelope,
  result: { kind: 'slotting', assignment },
});
check('关联簇：引擎没给 clusters 时这一层是空的（不占位、不猜）', noClusterScene.clusterCells.length === 0);

/* ---------------------------------------------------------------- 夹具：调度解 */

const step = (id, kind, start, end, from, to, extra = {}) => ({
  id,
  deviceId: 'SH1',
  taskId: extra.taskId ?? null,
  kind,
  start_s: start,
  end_s: end,
  distanceM: extra.distanceM ?? 0,
  from,
  to,
});

const at = (locationId) => ({
  x: 0,
  y: 0.6,
  z: 0,
  level: 1,
  aisleId: 'A1',
  nodeId: null,
  locationId,
});

const asrsProblem = {
  kind: 'asrs',
  topology,
  tasks: [
    { id: 'T1', kind: 'inbound', fromLocationId: null, toLocationId: LOC(1, 1, 1), release_s: 0 },
    { id: 'T2', kind: 'outbound', fromLocationId: LOC(2, 1, 1), toLocationId: null, release_s: 5 },
  ],
  events: [
    { type: 'aisle-closure', at_s: 20, until_s: 40, targetId: 'A1', note: '临时封闭' },
    { type: 'device-breakdown', at_s: 30, until_s: 35, targetId: 'SH1', note: '停机检修' },
  ],
};

const asrsTimeline = {
  horizon_s: 60,
  devices: [
    {
      deviceId: 'SH1',
      steps: [
        step('S1', 'travel', 0, 3, { ...at(null), locationId: null }, at(LOC(1, 1, 1))),
        step('S2', 'load', 3, 4, at(LOC(1, 1, 1)), at(LOC(1, 1, 1)), { taskId: 'T1' }),
      ],
    },
  ],
  tasks: [
    // 引擎的任务轨迹里设备 id 数组的键名是 `devices`
    { taskId: 'T1', kind: 'inbound', status: 'done', priority: 1, devices: ['SH1'], steps: ['S1', 'S2'], start_s: 0, end_s: 4, release_s: 0, deadline_s: '60' },
    { taskId: 'T2', kind: 'outbound', status: 'unserved', priority: 2, devices: [], steps: [], start_s: 5, end_s: 5, release_s: 5, deadline_s: null },
  ],
  bufferStates: [
    { at_s: 0, bufferId: 'ST1-B1', occupancy: 0, capacity: 2, reason: '初始' },
    { at_s: 4, bufferId: 'ST1-B1', occupancy: 1, capacity: 2, reason: '入库完成' },
    { at_s: 12, bufferId: 'ST1-B1', occupancy: 0, capacity: 2, reason: '离站' },
  ],
  locationStates: [
    // 与倒垛无关的状态迁移：绝不能被当成倒垛
    { at_s: 4, locationId: LOC(1, 1, 1), loadUnitId: 'LU-1', reason: '入库完成' },
    // 一次真实的深位让位（成对出现）
    { at_s: 20, locationId: LOC(1, 2, 2), loadUnitId: null, reason: '倒垛：为 T7 让出深位' },
    { at_s: 26, locationId: LOC(2, 2, 1), loadUnitId: 'LU-3', reason: '倒垛落位（来自 R1-1-2-2）' },
  ],
};

const asrsEnvelope = {
  engine: 'rust-warehouse',
  status: 'FEASIBLE',
  metrics: {
    deviceUtilization: [{ deviceId: 'SH1', busySeconds: 4, utilization: 0.4 }],
  },
  timeline: asrsTimeline,
  result: { kind: 'asrs' },
};

const asrsScene = mod.buildAsrsScene(asrsProblem, asrsEnvelope);

check('调度场景：设备轨迹按时间线聚合', asrsScene.devices.length === 1 && asrsScene.devices[0].track?.steps.length === 2);
check(
  '调度场景：任务标记的设备来自时间线 tasks[].devices（引擎键名）',
  asrsScene.tasks.find((task) => task.taskId === 'T1')?.deviceIds.join(',') === 'SH1',
  JSON.stringify(asrsScene.tasks.map((task) => [task.taskId, task.deviceIds])),
);
check('调度场景：deadline 是字符串也能读成数（引擎口径）', asrsScene.tasks[0].deadline_s === 60);
check('调度场景：任务状态原样透传（unserved 不美化）', asrsScene.tasks[1].status === 'unserved');
check('调度场景：封闭巷道与停机事件被标注', asrsScene.closedAisles.includes('A1') && asrsScene.outages.length === 1);
check(
  '倒垛：只有成对的"让空 + 落位"才算一次（入库状态迁移被排除）',
  asrsScene.relocationEvents === 1 && asrsScene.relocations.length === 1,
  `events=${asrsScene.relocationEvents}`,
);
check(
  '倒垛：让空格与落位格配对正确',
  asrsScene.relocations[0].vacatedLocationId === LOC(1, 2, 2) &&
    asrsScene.relocations[0].placedLocationId === LOC(2, 2, 1) &&
    asrsScene.relocations[0].vacatedPosition !== null &&
    asrsScene.relocations[0].placedPosition !== null,
  JSON.stringify(asrsScene.relocations[0]),
);
check('倒垛：时刻取配对中较晚的一条（落位完成才算搬完）', asrsScene.relocations[0].at_s === 26);

// 只有"让空"、没有"落位"时：仍如实记录，但不编造接收格
const halfScene = mod.buildAsrsScene(asrsProblem, {
  ...asrsEnvelope,
  timeline: {
    ...asrsTimeline,
    locationStates: [{ at_s: 20, locationId: LOC(1, 2, 2), loadUnitId: null, reason: '倒垛：为 T7 让出深位' }],
  },
});
check(
  '倒垛：缺落位格时如实留 null（不猜同列关系）',
  halfScene.relocationEvents === 1 && halfScene.relocations[0].placedLocationId === null,
);

// 显示上限：只画最近的一批，但总数如实保留
const manyStates = [];
for (let index = 0; index < 405; index += 1) {
  manyStates.push({ at_s: index * 2, locationId: LOC(1, 1, 1), loadUnitId: null, reason: `倒垛：为 T${index} 让出深位` });
  manyStates.push({ at_s: index * 2 + 1, locationId: LOC(2, 1, 1), loadUnitId: 'LU-1', reason: `倒垛落位（来自 R1-1-1-1）` });
}
const capScene = mod.buildAsrsScene(asrsProblem, {
  ...asrsEnvelope,
  timeline: { ...asrsTimeline, locationStates: manyStates },
});
check(
  '倒垛：显示上限 400，但事件总数如实报告',
  capScene.relocations.length === 400 && capScene.relocationEvents === 405,
  `显示 ${capScene.relocations.length} / 共 ${capScene.relocationEvents}`,
);

// 没有时间线时：不画设备也不报错（未求解状态）
const emptyScene = mod.buildAsrsScene(asrsProblem, null);
check('调度场景：未求解时不编造设备轨迹与倒垛', emptyScene.devices.every((device) => device.track === null) && emptyScene.relocationEvents === 0);

note('夹具为手工构造的契约片段；断言只针对投影层（读哪个字段、怎么落位、怎么截断）');
finish('仓储场景投影测试通过（含关联簇与倒垛两个新图层）');
