#!/usr/bin/env node
/**
 * APS 3D 产线投影测试（V2 §五-03 / COMPONENT-DESIGN §5）：
 *  1) 投影零伪造：opId/orderId/machineId/区间原样透传，设备顺序 = 工序出现顺序，
 *     未排产设备从资源清单补齐，无数据时返回空投影（不编造设备）；
 *  2) 在制判定：闭区间包含 now 才算在制，零长区间不算（边界可预期）；
 *  3) 面板读数口径：回放步 → 毫秒时刻换算与在制数量一致。
 */

import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHarness } from './lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const { check, finish, failures } = createHarness('APS 3D 产线投影测试');

const tmp = join(labDir, 'node_modules', '.lab-aps-line');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
await build({
  entryPoints: [join(labDir, 'src/modules/aps/projection.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: join(tmp, 'projection.mjs'),
  logLevel: 'warning',
});
const { projectApsLine, opsBusyAt } = await import(pathToFileURL(join(tmp, 'projection.mjs')).href);

/** 与 ApsPanel 相同的回放步 → 毫秒换算。 */
const APS_STEPS = 240;
const stepToMs = (minMs, maxMs, step) => minMs + ((maxMs - minMs) * step) / Math.max(1, APS_STEPS);

const bar = (opId, orderId, machineId, startMs, endMs) => ({ opId, orderId, machineId, startMs, endMs });
const gantt = {
  rows: [
    { orderId: 'O1', bars: [bar('O1-1', 'O1', 'M2', 1000, 2000), bar('O1-2', 'O1', 'M1', 2000, 3500)] },
    { orderId: 'O2', bars: [bar('O2-1', 'O2', 'M2', 3500, 4200)] },
  ],
  minMs: 0,
  maxMs: 5000,
};

{
  const p = projectApsLine(gantt, []);
  check('设备顺序 = 工序出现顺序（M2 先于 M1）', p.machines.join(',') === 'M2,M1', p.machines.join(','));
  check('工序原样透传（3 道）', p.ops.length === 3 && p.ops[0].opId === 'O1-1' && p.ops[0].startMs === 1000 && p.ops[0].endMs === 2000);
  check('区间不重排、不取整', p.ops.every((o) => Number.isInteger(o.startMs) && Number.isInteger(o.endMs)));
}

{
  const p = projectApsLine(gantt, [
    { id: 'M3', kind: 'machine', capabilities: [], busyMin: 0, availableMin: 1, utilization: 0, operations: 0 },
    { id: 'W1', kind: 'worker', capabilities: [], busyMin: 0, availableMin: 1, utilization: 0, operations: 0 },
    { id: 'M1', kind: 'machine', capabilities: [], busyMin: 0, availableMin: 1, utilization: 0, operations: 0 },
  ]);
  check('未排产设备从资源清单补齐（M3）', p.machines.includes('M3'), p.machines.join(','));
  check('资源清单不去重重复设备（M1 只出现一次）', p.machines.filter((m) => m === 'M1').length === 1);
  check('工人不进设备网格', !p.machines.includes('W1'));
}

{
  const empty = projectApsLine(null, []);
  check('无结果 = 空投影（不编造设备）', empty.machines.length === 0 && empty.ops.length === 0 && empty.maxMs === 1);
}

{
  const p = projectApsLine(gantt, []);
  check('t=1500 时 O1-1 在制', opsBusyAt(p.ops, 1500).map((o) => o.opId).join(',') === 'O1-1');
  check('t=2000 时 O1-1/O1-2 同时在制（闭区间）', opsBusyAt(p.ops, 2000).length === 2);
  check('t=5000 时无在制', opsBusyAt(p.ops, 5000).length === 0);
  check('零长区间不算在制', opsBusyAt([bar('X', 'O', 'M', 10, 10)], 10).length === 0);
  // 面板读数口径一致
  const step = Math.round((1500 / 5000) * APS_STEPS);
  check('回放步 → 毫秒换算与在制判定一致', opsBusyAt(p.ops, stepToMs(p.minMs, p.maxMs, step)).map((o) => o.opId).join(',') === 'O1-1', `step=${step}`);
  check('step=0 → minMs', stepToMs(0, 5000, 0) === 0);
  check('step=APS_STEPS → maxMs', stepToMs(0, 5000, APS_STEPS) === 5000);
}

finish('✓ APS 3D 产线投影测试全部通过');
