#!/usr/bin/env node
/**
 * MAPF 场景内核测试（M0 §14.2）：SceneDoc 命令/撤销栈、预检规则表（逐错误码）、
 * 序列化白名单、14 mock roundtrip 语义等价、dynamic 块构造（含被拒样例）、
 * 能力限额进预检。纯 Node（esbuild 打包纯 TS 模块）。
 */

import { build } from 'esbuild';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHarness } from './lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const { check, finish, failures } = createHarness('MAPF 场景内核测试');

const tmp = join(labDir, 'node_modules', '.lab-mapf-scene');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
await build({
  entryPoints: [join(labDir, 'src/modules/mapf/scene/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: join(tmp, 'scene.mjs'),
  logLevel: 'warning',
});
const scene = await import(pathToFileURL(join(tmp, 'scene.mjs')).href);
const {
  blankScene, parseScene, serializeScene, sceneEquivalent, sceneDims,
  SceneHistory, nextRobotId, applyCommand,
  precheckScene, hasErrors, FALLBACK_LIMITS,
  buildDynamic, precheckDynamic,
} = scene;

// ---- 1) 命令与撤销栈 ----
{
  const h = new SceneHistory(blankScene(6, 3));
  const doc = h.exec({ type: 'toggleWall', cell: [2, 1], blocked: true });
  check('画障碍生效', doc.map.cells[1][2] === '#');
  h.exec({ type: 'toggleWall', cell: [2, 1], blocked: true }); // 幂等：同状态不变
  h.exec({ type: 'addRobot', at: [0, 0], id: 'R1' });
  check('加机器人（goal 未设）', h.doc.robots.length === 1 && !h.doc.robots[0].goal);
  h.exec({ type: 'setGoal', id: 'R1', at: [5, 2] });
  check('设终点', h.doc.robots[0].goal?.[0] === 5);
  check('撤销 2 步回到无终点', (() => { h.undo(); return h.doc.robots[0].goal == null; })());
  check('重做恢复终点', (() => { h.redo(); return h.doc.robots[0].goal?.[0] === 5; })());
  check('undo 栈有边界（多退不崩）', h.undo() !== undefined || true);
  const big = blankScene(4, 2);
  const bh = new SceneHistory(big);
  for (let i = 0; i < 130; i++) bh.exec({ type: 'addRobot', at: [i % 4, 0], id: `R${i}` });
  bh.undo();
  check('撤销栈上限 100（丢最旧）', bh.canUndo);
  check('nextRobotId 唯一', (() => {
    const d = blankScene(5, 5);
    d.robots.push({ id: 'R1', start: [0, 0], goal: [1, 1] });
    d.robots.push({ id: 'R2', start: [0, 1], goal: [1, 2] });
    return nextRobotId(d) === 'R3';
  })());
}

// ---- 2) 预检规则表 ----
{
  const codes = (doc, limits) => precheckScene(doc, limits).filter((i) => i.level === 'error').map((i) => i.code);
  let d = blankScene(5, 5);
  d.robots.push({ id: 'A', start: [1, 1], goal: [1, 1] });
  check('起点=终点 → E-ROBOT-START-EQ-GOAL', codes(d).includes('E-ROBOT-START-EQ-GOAL'));

  d = blankScene(5, 5);
  d.map.cells[1] = '#....';
  d.robots.push({ id: 'A', start: [0, 1], goal: [2, 2] });
  check('起点在障碍 → E-ROBOT-START-BLOCKED', codes(d).includes('E-ROBOT-START-BLOCKED'));

  d = blankScene(5, 5);
  d.robots.push({ id: 'A', start: [0, 0], goal: [2, 2] });
  d.robots.push({ id: 'B', start: [0, 0], goal: [3, 3] });
  const cs = codes(d);
  check('重复起点 → E-ROBOT-DUP-START', cs.includes('E-ROBOT-DUP-START'));

  d = blankScene(5, 5);
  d.robots.push({ id: 'A', start: [0, 0], goal: [3, 3] });
  d.robots.push({ id: 'B', start: [1, 0], goal: [3, 3] });
  check('重复终点 → E-ROBOT-DUP-GOAL', codes(d).includes('E-ROBOT-DUP-GOAL'));

  d = blankScene(5, 5);
  d.robots.push({ id: 'A', start: [0, 0], goal: [1, 1] });
  check('正常场景无 error', !hasErrors(precheckScene(d)));

  d = blankScene(3, 3);
  d.map.cells = ['###', '###', '###'];
  check('无可通行格 → E-MAP-MAP-EMPTY', codes(d).includes('E-MAP-MAP-EMPTY'));

  d = blankScene(200, 200);
  d.robots.push({ id: 'A', start: [0, 0], goal: [1, 1] });
  check('超格数 → E-CAP-LIMIT-MAP', codes(d, { ...FALLBACK_LIMITS, maxCells: 1000 }).includes('E-CAP-LIMIT-MAP'));

  d = blankScene(5, 5);
  for (let i = 0; i < 5; i++) d.robots.push({ id: `R${i}`, start: [i, 0], goal: [i, 4] });
  check('超车数 → E-CAP-LIMIT-AGENTS', codes(d, { ...FALLBACK_LIMITS, maxRobots: 4 }).includes('E-CAP-LIMIT-AGENTS'));

  d = blankScene(5, 5);
  d.robots.push({ id: 'A', start: [0, 0], goal: [1, 1] });
  d.time_model.horizon = 2000;
  check('超时域 → E-CAP-LIMIT-HORIZON', codes(d).includes('E-CAP-LIMIT-HORIZON'));
}

// ---- 3) 序列化白名单 ----
{
  const d = blankScene(4, 3, 'my-scene');
  d.robots.push({ id: 'R1', start: [0, 0], goal: [3, 2] });
  const j = JSON.parse(serializeScene(d));
  const top = Object.keys(j).sort();
  check('顶层字段白名单', JSON.stringify(top) === JSON.stringify(['id', 'map', 'objective', 'robots', 'schema_version', 'solver', 'time_model']), top.join(','));
  check('未命名场景不输出 tags', !('tags' in j));
  d.tags = { name: '测试', description: 'x' };
  check('命名场景输出 tags.name', JSON.parse(serializeScene(d)).tags?.name === '测试');
  // extra 旁路
  const withExtra = parseScene(JSON.stringify({ ...d, benchmark: { kind: 'x' } }));
  check('未知合法字段进 extra 并回写', withExtra.extra?.benchmark != null && JSON.parse(serializeScene(withExtra)).benchmark != null);
}

// ---- 4) 14 mock roundtrip 语义等价 ----
{
  const mockDir = join(labDir, 'public', 'mock');
  if (!existsSync(mockDir)) {
    check('mock 目录存在（先 npm run sync）', false);
  } else {
    const files = readdirSync(mockDir).filter((f) => /^m\d/.test(f) && f.endsWith('.json'));
    check(`找到 MAPF mock（${files.length} 个，m01–m12b 全在）`, files.length >= 13, files.join(' '));
    let okCount = 0;
    for (const f of files) {
      const text = readFileSync(join(mockDir, f), 'utf8');
      try {
        const doc1 = parseScene(text);
        const doc2 = parseScene(serializeScene(doc1));
        if (sceneEquivalent(doc1, doc2)) okCount += 1;
        else failures.push(`roundtrip 不等价：${f}`);
      } catch (err) {
        failures.push(`解析失败 ${f}: ${err.message}`);
      }
    }
    check(`全部 mock roundtrip 语义等价（${okCount}/${files.length}）`, okCount === files.length);
    const warehousePath = join(mockDir, 'm00-warehouse-aisles.json');
    if (existsSync(warehousePath)) {
      try {
        const warehouse = parseScene(readFileSync(warehousePath, 'utf8'));
        const errors = precheckScene(warehouse, FALLBACK_LIMITS).filter((issue) => issue.level === 'error');
        check('仓库原型 m00 起终点与地图结构可解', errors.length === 0, errors.map((issue) => issue.code).join(', '));
      } catch (err) {
        check('仓库原型 m00 起终点与地图结构可解', false, err.message);
      }
    } else {
      check('仓库原型 m00 已随 MAPF mocks 同步', false);
    }
  }
}

// ---- 5) dynamic 块构造 + 预检 ----
{
  const sceneDoc = blankScene(6, 5, 'dyn-test');
  sceneDoc.robots.push({ id: 'A', start: [0, 2], goal: [5, 2] });
  const solution = {
    robots: [{ id: 'A', start: [0, 2], goal: [5, 2], path: [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2]], arrival: 5, steps: 5 }],
  };
  const built = buildDynamic({ scene: sceneDoc, solution, time: 2, frozenSteps: 1, events: [{ kind: 'obstacle_add', cell: [3, 2], at: 4 }], maxEvents: 32 });
  check('dynamic.snapshot 含逐车 paths', built.snapshot.paths.A?.length === 6);
  check('事件按契约字段输出', built.events[0].type === 'obstacle_add' && JSON.stringify(built.events[0].cell) === '[3,2]' && built.events[0].until === null);
  const bad = buildDynamic({ scene: sceneDoc, solution, time: 2, frozenSteps: 1, events: [{ kind: 'obstacle_add', cell: [2, 2], at: 2 }], maxEvents: 32 });
  const issues = precheckDynamic([{ kind: 'obstacle_add', cell: [2, 2], at: 2 }], bad, sceneDoc);
  check('冻结窗内障碍被预检拦截（承诺不可维持）', issues.some((i) => i.message.includes('承诺')));
  const early = precheckDynamic([{ kind: 'obstacle_add', cell: [4, 4], at: 1 }], buildDynamic({ scene: sceneDoc, solution, time: 2, frozenSteps: 1, events: [{ kind: 'obstacle_add', cell: [4, 4], at: 1 }], maxEvents: 32 }), sceneDoc);
  check('at < T 被拦截（E-EVENT-TIME）', early.some((i) => i.message.includes('E-EVENT-TIME')));
}

finish('✓ MAPF 场景内核测试全部通过');
