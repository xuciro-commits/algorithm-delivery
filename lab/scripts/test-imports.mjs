#!/usr/bin/env node
/**
 * APS data-catalog and public benchmark adapter tests (no Rust toolchain/WASM required).
 * Bundles the exact TypeScript modules used by the UI, then exercises their exported APIs.
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const repoRoot = resolve(labDir, '..');
const tmp = join(labDir, 'node_modules', '.lab-import-test');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const entry = join(tmp, 'entry.ts');
const outfile = join(tmp, 'imports.mjs');
writeFileSync(
  entry,
  `export * from ${JSON.stringify(join(labDir, 'src/core/aps/mocks.ts'))};\n` +
    `export * from ${JSON.stringify(join(labDir, 'src/core/aps/benchmarkImport.ts'))};\n`,
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
const core = await import(pathToFileURL(outfile).href);

const builtIns = core.entriesFromManifest(null);
assert.equal(builtIns.length, 4, 'missing manifest still exposes all four built-in cases');
assert.equal(builtIns[0].id, 'mock/baseline.json', 'baseline is the first/default case');
assert.equal(builtIns[0].operations, 24);
assert.ok(builtIns.every((entry) => entry.inline), 'built-in data is bundled, not fetched');

const manifest = {
  mocks: [
    { file: 'mock/baseline.json', name: 'Baseline from manifest', description: 'manifest detail', kind: 'baseline', operations: 24, orders: 8, machines: 5 },
    { file: 'mock/bench-240.json', name: 'Generated stress case', description: 'generated', kind: 'benchmark', operations: 240, orders: 80, machines: 20 },
  ],
};
const merged = core.entriesFromManifest(manifest);
assert.equal(merged[0].name, 'Baseline from manifest');
assert.ok(merged[0].inline, 'manifest metadata must not replace the bundled PlanProblem');
assert.equal(merged.at(-1).url, 'mock/bench-240.json', 'generated cases remain URL-backed');

const baselineText = await import('node:fs').then(({ readFileSync }) =>
  readFileSync(join(repoRoot, 'aps/mock/baseline.json'), 'utf8'),
);
assert.equal(core.importProblem(baselineText, 'baseline.json').ok, true, 'PlanProblem JSON import remains supported');
assert.equal(core.importProblem(`\uFEFF${baselineText}`, 'baseline-bom.json').ok, true, 'UTF-8 BOM is accepted');

// FJSPLib / Brandimarte FJSP token grammar, with a synthetic fixture and optional average-flexibility header.
const fjsp = `2 2 2.0\n2 2 1 5 2 7 2 1 4 2 6\n1 1 2 8\n`;
const fjspResult = core.importProblem(fjsp, 'tiny.fjs');
assert.equal(fjspResult.ok, true, fjspResult.error);
assert.equal(fjspResult.entry.kind, 'standard-benchmark');
assert.equal(fjspResult.entry.orders, 2);
assert.equal(fjspResult.entry.operations, 3);
assert.equal(fjspResult.entry.machines, 2);
assert.equal(fjspResult.entry.source, 'FJSPLib · Brandimarte / FJSP text format');
const fjspProblem = fjspResult.entry.inline;
assert.equal(fjspProblem.meta.resolution_min, 1, 'standard integer processing times need not align to 15-minute APS mock ticks');
assert.equal(fjspProblem.objective.strategy, 'makespan');
assert.deepEqual(fjspProblem.orders[0].operations[0].alternatives, [
  { machine_id: 'M01', duration_min: 5 },
  { machine_id: 'M02', duration_min: 7 },
]);
assert.deepEqual(fjspProblem.orders[0].operations[1].predecessors, ['J001-O001']);
assert.equal(fjspProblem.workers.length, fjspProblem.machines.length);
assert.deepEqual(fjspProblem.tools, []);
assert.deepEqual(fjspProblem.materials, []);
assert.match(fjspResult.entry.description, /连续日历/);

// OR-Library jobshop1 supports a downloaded collection file: each `instance NAME` block becomes a case.
const orLibrary = `
This is a compact jobshop1 excerpt.
instance tiny-a
Synthetic JSSP sample
2 2
0 3 1 1
1 2 0 4
++++++++++++++++++++++++
instance tiny-b
Another synthetic sample
2 2
1 2 0 3
0 1 1 5
`;
const jspResult = core.importProblem(orLibrary, 'jobshop1.txt');
assert.equal(jspResult.ok, true, jspResult.error);
assert.equal(jspResult.entries.length, 2);
assert.equal(jspResult.entries[0].name, 'JSP · tiny-a');
assert.equal(jspResult.entries[0].operations, 4);
assert.deepEqual(jspResult.entries[0].inline.orders[0].operations[0].alternatives, [
  { machine_id: 'M01', duration_min: 3 },
]);
assert.deepEqual(jspResult.entries[1].inline.orders[1].operations[1].predecessors, ['J002-O001']);
assert.equal(jspResult.entries[0].source, 'OR-Library · jobshop1 / JSSP format');

// One-instance FJSPLib text with only a two-field header is accepted as well.
const twoFieldHeader = core.importProblem('1 1\n1 1 1 7\n', 'tiny.fjsp');
assert.equal(twoFieldHeader.ok, true, twoFieldHeader.error);
assert.equal(twoFieldHeader.entry.operations, 1);
assert.equal(twoFieldHeader.entry.inline.orders[0].operations[0].alternatives[0].duration_min, 7);

assert.equal(core.importProblem('{"meta":{}}', 'bad.json').ok, false, 'invalid PlanProblem JSON is rejected');
assert.equal(core.importProblem('1 1\n1 2 1 7\n', 'bad.fjs').ok, false, 'invalid machine references are rejected');
assert.equal(core.importProblem('not data', 'bad.fjs').ok, false, 'unrecognized benchmark text is rejected');

console.log('✓ 本地内置目录回退、PlanProblem 导入、Brandimarte/FJSPLib FJSP、OR-Library JSSP collection 均通过');
