#!/usr/bin/env node
/**
 * AGV 动态事件与运行对比测试（V2 §5 / COMPONENT-DESIGN-V2 §5）：
 *  1) 笔画级撤销：一笔拖刷 = 一个撤销步（与 MAPF SceneHistory 同构）；
 *  2) dynamic 契约块：快照投影（pos/path 覆盖 0..=T 且 path[T]==pos）、事件序列化；
 *  3) 提交前预检镜像引擎语义（任务 id 冲突 / 取消已完成 / 快照越界 / 障碍压历史）；
 *  4) 运行历史：RunRecord 投影 + 同问题才可对比 + diff 方向语义。
 * 纯 TS 逻辑，不需要 Rust/WASM。
 */

import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const tmp = join(labDir, 'node_modules', '.lab-agv-dynamic');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
await build({
  entryPoints: [
    join(labDir, 'src/modules/agv/scene.ts'),
    join(labDir, 'src/modules/agv/dynamic/contractBlock.ts'),
    join(labDir, 'src/modules/agv/runs.ts'),
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outdir: tmp,
  logLevel: 'warning',
});
const sceneMod = await import(pathToFileURL(join(tmp, 'scene.js')).href);
const dynMod = await import(pathToFileURL(join(tmp, 'dynamic', 'contractBlock.js')).href);
const runsMod = await import(pathToFileURL(join(tmp, 'runs.js')).href);

const { blankAgvScene, AgvSceneHistory } = sceneMod;
const { buildAgvDynamic, precheckAgvDynamic, withDynamicBlock } = dynMod;
const { makeAgvRunRecord, agvRunsGroupable, diffAgvRuns } = runsMod;

// ---- 1) 笔画级撤销 ----
{
  const h = new AgvSceneHistory(blankAgvScene(8, 5));
  h.beginStroke();
  for (const x of [1, 2, 3, 4]) h.exec({ type: 'toggleWall', cell: [x, 1], blocked: true });
  h.endStroke();
  check('一笔四格 = 一个撤销步', h.steps === 1 && h.canUndo, `steps=${h.steps}`);
  const after = h.doc.map.cells[1];
  h.undo();
  check('撤销整笔（四格一起回退）', h.doc.map.cells[1] === '........', h.doc.map.cells[1]);
  check('撤销前该笔确实画了四格', after === '.####...', after);
  // 空笔不入栈
  const h2 = new AgvSceneHistory(blankAgvScene(8, 5));
  h2.beginStroke();
  h2.endStroke();
  check('空笔不入撤销栈', h2.steps === 0 && !h2.canUndo);
  // 非笔画命令照常逐步入栈
  const h3 = new AgvSceneHistory(blankAgvScene(8, 5));
  h3.exec({ type: 'toggleWall', cell: [0, 0], blocked: true });
  h3.exec({ type: 'toggleWall', cell: [1, 0], blocked: true });
  check('非笔画命令仍逐格入栈', h3.steps === 2, `steps=${h3.steps}`);
}

// ---- 2) dynamic 契约块构造 ----
const scene = blankAgvScene(8, 6, 'agv-dyn-test');
scene.vehicles = [{ id: 'V1', start: [0, 0] }, { id: 'V2', start: [0, 5] }];
scene.tasks = [
  { id: 'T1', pickup: [4, 1], dropoff: [6, 1], pickup_service: 1, dropoff_service: 1, release_step: 0, priority: 1 },
  { id: 'T2', pickup: [4, 4], dropoff: [6, 4], pickup_service: 0, dropoff_service: 0, release_step: 0, priority: 1 },
];
const solution = {
  status: 'FEASIBLE',
  plan: {
    vehicles: [
      { id: 'V1', timeline: [[0, 0], [1, 0], [2, 0], [3, 0]], missions: [{ task: 'T1', phase: 'to_pickup', from: 0, to: 3, dock: null }] },
      { id: 'V2', timeline: [[0, 5], [0, 4], [1, 4], [2, 4]], missions: [{ task: 'T2', phase: 'to_pickup', from: 0, to: 3, dock: null }] },
    ],
    tasks: [
      { id: 'T1', status: 'assigned', vehicle: 'V1', pickup_dock: [4, 1], dropoff_dock: [6, 1], pickup_arrival: 6, pickup_done: 7, dropoff_arrival: 11, dropoff_done: 12, flow_time: null, lateness: null, reason: null },
      { id: 'T2', status: 'assigned', vehicle: 'V2', pickup_dock: [4, 4], dropoff_dock: [6, 4], pickup_arrival: 6, pickup_done: 7, dropoff_arrival: 11, dropoff_done: 12, flow_time: null, lateness: null, reason: null },
    ],
  },
};

{
  const T = 2;
  const events = [
    { kind: 'vehicle_pause', vehicle: 'V2' },
    { kind: 'task_priority', task: 'T1', priority: 3 },
    { kind: 'obstacle_add', cell: [5, 2], until: null },
  ];
  const built = buildAgvDynamic({ scene, solution, time: T, events, maxEvents: 16 });
  check('快照时刻 T', built.snapshot.time === 2);
  check('快照覆盖两辆车', Object.keys(built.snapshot.vehicles).length === 2);
  const v1 = built.snapshot.vehicles.V1;
  check('V1 快照位置 = timeline[T]', v1.pos[0] === 2 && v1.pos[1] === 0, JSON.stringify(v1.pos));
  check('V1 path 覆盖 0..=T 且 path[T]==pos', v1.path.length === T + 1 && v1.path[T][0] === 2 && v1.path[T][1] === 0);
  check('V1 phase 为契约枚举', ['idle', 'to_pickup', 'servicing_pickup', 'to_dropoff', 'servicing_dropoff', 'parking', 'paused'].includes(v1.phase), v1.phase);
  check('V1 task = T1', v1.task === 'T1');
  check('任务快照含状态与 dock', built.snapshot.tasks.T1.status === 'assigned' && built.snapshot.tasks.T1.pickup_dock[0] === 4);
  check('事件按契约序列化', built.events.length === 3 && built.events[0].type === 'vehicle_pause' && built.events[1].priority === 3);
  check('无 until 的障碍事件不带 until 字段', !('until' in built.events[2]));
  const issues = precheckAgvDynamic({ scene, solution, time: T, events, maxEvents: 16 }, built);
  check('合法事件预检通过', issues.length === 0, issues.map((i) => i.message).join(' | '));

  // 并入问题文本（导出即契约）
  const merged = JSON.parse(withDynamicBlock('{"schema_version":"agv-dispatch-problem/1.0","id":"x"}', built));
  check('dynamic 块可并入问题 JSON', merged.dynamic.snapshot.time === 2 && merged.dynamic.events.length === 3);
}

// ---- 3) 预检镜像引擎语义 ----
{
  const T = 2;
  // 3.1 快照时刻越界（时间线只到 t=3，T=5 超出）
  const tooLate = buildAgvDynamic({
    scene,
    solution,
    time: 5,
    events: [{ kind: 'vehicle_pause', vehicle: 'V1' }],
    maxEvents: 16,
  });
  const lateIssues = precheckAgvDynamic({ scene, solution, time: 5, events: [{ kind: 'vehicle_pause', vehicle: 'V1' }], maxEvents: 16 }, tooLate);
  check('快照时刻超出时间线被拦截', lateIssues.some((i) => i.message.includes('超出其已执行范围')), lateIssues[0]?.message ?? '');

  // 3.2 task_add id 与既有车辆冲突
  const clash = buildAgvDynamic({
    scene,
    solution,
    time: T,
    events: [
      { kind: 'task_add', taskId: 'V1', pickup: [1, 1], dropoff: [2, 2], pickupService: 0, dropoffService: 0, releaseStep: 0, priority: 1, dueStep: null, requiredCapability: null },
    ],
    maxEvents: 16,
  });
  const clashIssues = precheckAgvDynamic(
    { scene, solution, time: T, events: [{ kind: 'task_add', taskId: 'V1', pickup: [1, 1], dropoff: [2, 2], pickupService: 0, dropoffService: 0, releaseStep: 0, priority: 1, dueStep: null, requiredCapability: null }], maxEvents: 16 },
    clash,
  );
  check('task_add id 与车辆冲突被拦截', clashIssues.some((i) => i.message.includes('车辆冲突')));

  // 3.3 取消已完成任务
  const doneSol = JSON.parse(JSON.stringify(solution));
  doneSol.plan.tasks[0].status = 'done';
  const cancelBuilt = buildAgvDynamic({ scene, solution: doneSol, time: T, events: [{ kind: 'task_cancel', task: 'T1' }], maxEvents: 16 });
  const cancelIssues = precheckAgvDynamic({ scene, solution: doneSol, time: T, events: [{ kind: 'task_cancel', task: 'T1' }], maxEvents: 16 }, cancelBuilt);
  check('取消已完成任务被拦截', cancelIssues.some((i) => i.message.includes('不可取消')));

  // 3.4 障碍压在车辆已执行历史上（V1 在 t=2 位于 (2,0)）
  const histBuilt = buildAgvDynamic({ scene, solution, time: T, events: [{ kind: 'obstacle_add', cell: [2, 0], until: null }], maxEvents: 16 });
  const histIssues = precheckAgvDynamic({ scene, solution, time: T, events: [{ kind: 'obstacle_add', cell: [2, 0], until: null }], maxEvents: 16 }, histBuilt);
  check('障碍压在车辆历史上被拦截', histIssues.some((i) => i.message.includes('已执行历史矛盾')));

  // 3.5 空事件列表
  const emptyBuilt = buildAgvDynamic({ scene, solution, time: T, events: [], maxEvents: 16 });
  const emptyIssues = precheckAgvDynamic({ scene, solution, time: T, events: [], maxEvents: 16 }, emptyBuilt);
  check('空事件列表被拦截', emptyIssues.some((i) => i.message.includes('还没有添加任何动态事件')));

  // 3.6 新任务取货点在障碍格
  scene.map.cells[1] = '###.....';
  const blockedBuilt = buildAgvDynamic({
    scene,
    solution,
    time: T,
    events: [{ kind: 'task_add', taskId: 'T9', pickup: [0, 1], dropoff: [6, 4], pickupService: 0, dropoffService: 0, releaseStep: 0, priority: 1, dueStep: null, requiredCapability: null }],
    maxEvents: 16,
  });
  const blockedIssues = precheckAgvDynamic(
    {
      scene,
      solution,
      time: T,
      events: [{ kind: 'task_add', taskId: 'T9', pickup: [0, 1], dropoff: [6, 4], pickupService: 0, dropoffService: 0, releaseStep: 0, priority: 1, dueStep: null, requiredCapability: null }],
      maxEvents: 16,
    },
    blockedBuilt,
  );
  check('新任务落在障碍格被拦截', blockedIssues.some((i) => i.message.includes('障碍格')));
  scene.map.cells[1] = '........';
}

// ---- 4) 运行历史与对比 ----
{
  const mk = (seq, hash, metrics, params) =>
    makeAgvRunRecord(seq, '{}', '{}', { status: 'FEASIBLE', problem_hash: hash, fingerprint: `fp${seq}`, metrics }, params);
  const a = mk(1, 'h1', { completed_tasks: 2, total_tasks: 3, makespan: 12, total_flow_time: 20, empty_travel_steps: 6, avg_utilization: 0.5, total_ms: 30 }, 'insertion-ls/t=5000');
  const b = mk(2, 'h1', { completed_tasks: 3, total_tasks: 3, makespan: 10, total_flow_time: 18, empty_travel_steps: 4, avg_utilization: 0.62, total_ms: 42 }, 'baseline/t=5000');
  const c = mk(3, 'h2', { completed_tasks: 1, total_tasks: 2, makespan: 8 }, 'baseline/t=5000');
  check('同问题可对比', agvRunsGroupable(a, b));
  check('不同问题不可对比', !agvRunsGroupable(a, c));
  check('problem_hash 为空不可对比', !agvRunsGroupable(mk(4, null, {}, 'x'), mk(5, null, {}, 'x')));
  const rows = diffAgvRuns(a, b);
  const verdict = (label) => rows.find((r) => r.label === label)?.verdict;
  check('完成数越大越好', verdict('完成/总任务') === 'better');
  check('makespan 越小越好', verdict('Makespan') === 'better');
  check('空驶越小越好', verdict('空驶步数') === 'better');
  check('利用率越大越好', verdict('平均利用率') === 'better');
  check('耗时不给方向', verdict('求解 ms') === '');
  check('动态标记投影', a.dynamic === false && makeAgvRunRecord(6, '{}', '{}', { status: 'FEASIBLE', dynamic: { snapshot_time: 3 }, metrics: {} }, 'x').dynamic === true);
}

console.log('');
if (failures.length) {
  console.error(`✗ AGV 动态/对比测试失败 ${failures.length} 项：${failures.join('；')}`);
  process.exit(1);
}
console.log('✓ AGV 动态事件与运行对比测试全部通过');
