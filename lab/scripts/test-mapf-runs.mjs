#!/usr/bin/env node
/**
 * MAPF 运行历史与对比测试（M0 §14.2）：RunRecord 指纹分组（同 problem_hash
 * 才可对比）、diffRuns 指标差异、不同问题禁比。
 */

import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHarness } from './lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const { check, finish, failures } = createHarness('MAPF 运行历史测试');

const tmp = join(labDir, 'node_modules', '.lab-mapf-runs');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
await build({
  entryPoints: [join(labDir, 'src/modules/mapf/runs/runs.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: join(tmp, 'runs.mjs'),
  logLevel: 'warning',
});
const { makeRunRecord, runsGroupable, diffRuns } = await import(pathToFileURL(join(tmp, 'runs.mjs')).href);

const baseSol = {
  status: 'OPTIMAL',
  soc: 10,
  makespan: 6,
  verified: true,
  problem_hash: 'sha256:abc',
  fingerprint: 'sha256:fp1',
  metrics: { solve_ms: 84, first_feasible_ms: 31, peak_memory_bytes: 1048576 },
  robots: [
    { id: 'R1', start: [0, 0], goal: [3, 0], path: [[0, 0], [1, 0], [2, 0], [3, 0]], arrival: 3, steps: 3 },
    { id: 'R2', start: [3, 3], goal: [0, 3], path: [[3, 3], [2, 3], [1, 3], [0, 3]], arrival: 3, steps: 3 },
  ],
};

{
  const a = makeRunRecord(1, '{}', '{}', baseSol, 'soc/w=1.5/auto');
  check('RunRecord 字段投影', a.soc === 10 && a.problemHash === 'sha256:abc' && a.fingerprint === 'sha256:fp1');
  const b = makeRunRecord(2, '{}', '{}', { ...baseSol, soc: 9, metrics: { solve_ms: 90 } }, 'soc/w=1.0/auto');
  check('同 problem_hash 可对比', runsGroupable(a, b) === true);
  const c = makeRunRecord(3, '{}', '{}', { ...baseSol, problem_hash: 'sha256:zzz' }, 'soc/w=1.5/auto');
  check('不同 problem_hash 禁比', runsGroupable(a, c) === false);
  const d = makeRunRecord(4, '{}', '{}', { ...baseSol, problem_hash: null }, 'soc/w=1.5/auto');
  check('无 problem_hash（null）不可比', runsGroupable(a, d) === false);

  const { rows, robots } = diffRuns(a, b);
  const socRow = rows.find((r) => r.label === 'SOC');
  check('SOC 差异判定 better（9 < 10）', Boolean(socRow) && socRow.a === '10' && socRow.b === '9' && socRow.verdict === 'better');
  const statusRow = rows.find((r) => r.label === '状态');
  check('状态相同 = same', Boolean(statusRow) && statusRow.verdict === 'same');
  check('每车差异表覆盖全部机器人', robots.length === 2 && robots.every((r) => r.id === 'R1' || r.id === 'R2'));
}

finish('✓ MAPF 运行历史测试全部通过');
