#!/usr/bin/env node
/**
 * 三维实验室（art-lab）静态一致性检查。
 *
 * 为什么需要它：本项目的构建脚本是 `tsc --noEmit && vite build`，但在受限环境里不一定
 * 跑得起来；而艺术化运行时是**跨文件契约密集**的（模式 / 角色 / 透明策略 / 模型清单 /
 * 三算法投影），任何一处改名都会静默变成运行时空白画面。这个脚本用纯文本分析兜住这些
 * 契约，不需要 npm 依赖，也不需要浏览器：
 *
 *   1. 相对 import 能解析到真实文件；
 *   2. 命名 import 在目标模块里确实被导出（捕获改名 / 漏导出）；
 *   3. art-lab 已接线：模块登记、App 路由与引擎上下文注入、全局模式条；
 *   4. 性能红线未被破坏（无后处理、单一 frameloop、dpr ≤ 2）；
 *   5. 模型清单完整：选择表 slug ↔ modelPaths 键 ↔ manifest 条目 ↔ 磁盘 GLB；
 *   6. 规则覆盖：清单里不得有未命中材质规则的模型（unknownMaterials 必须为空）。
 *
 * 用法：node lab/scripts/test-art-system.mjs [--verbose]
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const verbose = process.argv.includes('--verbose');

let checks = 0;
const failures = [];

function check(label, fn) {
  checks += 1;
  try {
    fn();
    if (verbose) console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`  FAIL ${label}`);
    console.log(`       ${error.message.split('\n')[0]}`);
  }
}

function read(rel) {
  return readFileSync(join(labDir, rel), 'utf8');
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** 文本级：收集一个模块文件对外导出的名字。 */
function exportsOf(file) {
  const text = readFileSync(file, 'utf8');
  const names = new Set();
  const push = (name) => {
    if (name && name !== 'type') names.add(name);
  };
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) push(m[1]);
  for (const m of text.matchAll(/export\s+(?:interface|type|enum)\s+([A-Za-z0-9_$]+)/g)) push(m[1]);
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const cleaned = part.replace(/^\s*type\s+/, '').trim();
      if (!cleaned) continue;
      const [local, exported] = cleaned.split(/\s+as\s+/);
      push((exported ?? local).trim());
    }
  }
  const hasStar = /export\s*\*\s*from/.test(text);
  if (/export\s+default/.test(text)) names.add('default');
  return { names, hasStar };
}

const exportCache = new Map();
function exportsCached(file) {
  if (!exportCache.has(file)) exportCache.set(file, exportsOf(file));
  return exportCache.get(file);
}

/**
 * 由同步脚本生成的运行时文件（`lab/src/vendor/*-worker.js` 等）不在版本库里，
 * 也不参与静态分析：它们的来源是 `lab/scripts/sync-*.mjs`。
 */
const GENERATED = [/(^|\/)src\/vendor\/[a-z-]+-worker\.js$/];

function isGeneratedSpecifier(fromFile, spec) {
  const resolved = resolve(dirname(fromFile), spec);
  return GENERATED.some((pattern) => pattern.test(resolved));
}

function resolveSpecifier(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.json`, join(base, 'index.ts'), join(base, 'index.tsx')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

const allSources = walk(join(labDir, 'src'));
const importedModules = [
  ...walk(join(labDir, 'src/art')),
  ...walk(join(labDir, 'src/modules/art-lab')),
  ...['src/App.tsx', 'src/modules/index.ts', 'src/components/hud/ArtModeBar.tsx', 'src/components/sandbox/SandboxScene.tsx']
    .map((rel) => join(labDir, rel))
    .filter((file) => existsSync(file)),
];

console.log('art-lab 静态一致性检查');
console.log(`  import 解析扫描 ${allSources.length} 个文件；契约校验 ${importedModules.length} 个文件`);

// —— 1 + 2：相对 import 解析 + 命名导出存在 ——
for (const file of importedModules) {
  const rel = file.slice(labDir.length + 1);
  const text = readFileSync(file, 'utf8');
  const statements = [...text.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g)];
  const bare = [...text.matchAll(/import\s+['"]([^'"]+)['"]/g)].map((m) => m[2]);
  for (const spec of bare) {
    if (!spec.startsWith('.')) continue;
    check(`${rel} → ${spec}`, () => assert.ok(resolveSpecifier(file, spec), `相对 import 找不到文件：${spec}`));
  }
  for (const [, clause, spec] of statements) {
    if (!spec.startsWith('.')) continue;
    const target = resolveSpecifier(file, spec);
    check(`${rel} → ${spec}`, () => assert.ok(target, `相对 import 找不到文件：${spec}`));
    if (!target || !/\.tsx?$/.test(target) || spec.endsWith('.json')) continue;
    const clauseText = clause.trim();
    const braces = clauseText.match(/\{([\s\S]*)\}/);
    const names = braces
      ? braces[1]
          .split(',')
          .map((part) => part.replace(/^\s*type\s+/, '').trim())
          .filter(Boolean)
          .map((part) => part.split(/\s+as\s+/)[0].replace(/^type\s+/, '').trim())
      : [];
    const { names: exported, hasStar } = exportsCached(target);
    for (const name of names) {
      check(`${rel} → ${spec} :: ${name}`, () => {
        assert.ok(hasStar || exported.has(name), `${target.slice(labDir.length + 1)} 未导出 ${name}`);
      });
    }
  }
}

// —— 2b：整个 src 的相对 import 都能解析（改名/移动文件最容易静默破坏这里）——
for (const file of allSources) {
  const rel = file.slice(labDir.length + 1);
  const text = readFileSync(file, 'utf8');
  const specs = [
    ...[...text.matchAll(/from\s*['"](\.[^'"]*)['"]/g)].map((m) => m[1]),
    ...[...text.matchAll(/import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ...[...text.matchAll(/import\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
  ];
  for (const spec of new Set(specs)) {
    if (isGeneratedSpecifier(file, spec)) continue;
    check(`${rel} → ${spec}`, () => assert.ok(resolveSpecifier(file, spec), `相对 import 找不到文件：${spec}`));
  }
}

// —— 2c：无未使用的命名 import（tsconfig 开了 noUnusedLocals，未使用会直接构建失败）——
for (const file of allSources) {
  const rel = file.slice(labDir.length + 1);
  const text = readFileSync(file, 'utf8');
  const removed = text.replace(/import\s+(?:type\s+)?[\s\S]*?from\s*['"][^'"]+['"];?/g, '');
  const names = [];
  for (const [, clause] of text.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s*from\s*['"][^'"]+['"]/g)) {
    const trimmed = clause.trim();
    if (trimmed.startsWith('{')) {
      for (const part of trimmed.replace(/^\{|\}$/g, '').split(',')) {
        const cleaned = part.replace(/^\s*type\s+/, '').trim();
        if (cleaned) names.push(cleaned.split(/\s+as\s+/).pop().trim());
      }
    } else if (!trimmed.startsWith('*')) {
      names.push(trimmed.split(',')[0].trim());
    }
  }
  const unused = [...new Set(names)].filter(
    (name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !new RegExp(`\\b${name}\\b`).test(removed),
  );
  check(`${rel} 无未使用 import`, () => assert.deepEqual(unused, [], `未使用的 import：${unused.join(', ')}（noUnusedLocals 会直接构建失败）`));
}

// —— 2d：命名空间 import 必须被使用（同样受 noUnusedLocals 约束）——
for (const file of allSources) {
  const rel = file.slice(labDir.length + 1);
  const text = readFileSync(file, 'utf8');
  const removed = text.replace(/import\s+(?:type\s+)?[\s\S]*?from\s*['"][^'"]+['"];?/g, '');
  const unused = [...text.matchAll(/import\s+(?:type\s+)?\*\s+as\s+([A-Za-z0-9_$]+)\s+from/g)]
    .map((m) => m[1])
    .filter((name) => !new RegExp(`\\b${name}\\s*\\.`).test(removed));
  check(`${rel} 无未使用命名空间 import`, () => assert.deepEqual(unused, [], `未使用的命名空间 import：${unused.join(', ')}`));
}

// —— 3：模块登记与外壳接线 ——
check('modules/index.ts 登记 art-lab', () => {
  const text = read('src/modules/index.ts');
  assert.match(text, /from '\.\/art-lab'/, '未 import artLabModule');
  assert.match(text, /registerModule\(artLabModule\)/, '未注册 artLabModule');
});

check('App.tsx 注入三套引擎上下文', () => {
  const text = read('src/App.tsx');
  for (const key of ['aps', 'mapf', 'agv']) {
    assert.match(
      text,
      new RegExp(`${key}: \\{[\\s\\S]*?assetUrl:`),
      `ArtLabEngineProps 缺少 ${key} 上下文（三段 assetUrl 都要在 art-lab 分支里出现）`,
    );
  }
  assert.match(text, /module\.id === 'art-lab'/, 'App.tsx 没有 art-lab 路由分支');
  assert.match(text, /<Panel \{\.\.\.artProps\} \/>/, '没有把 artProps 传给面板');
});

check('全局视觉模式条已挂载', () => {
  const app = read('src/App.tsx');
  assert.match(app, /<ArtModeBar \/>/, 'App.tsx 未挂载 ArtModeBar');
  const bar = read('src/components/hud/ArtModeBar.tsx');
  assert.match(bar, /ART_MODES/, '模式条必须读 ART_MODES，不能自己写死模式表');
  assert.match(bar, /options=\{ART_MODE_OPTIONS\}/, '模式选项必须来自 ART_MODE_OPTIONS（保持 ArtModeId 字面量类型）');
  const tokens = read('src/art/tokens.ts');
  assert.match(tokens, /ART_MODE_OPTIONS/, 'tokens.ts 必须导出 ART_MODE_OPTIONS');
  const panel = read('src/modules/art-lab/ArtLabPanel.tsx');
  assert.match(panel, /options=\{ART_MODE_OPTIONS\}/, '面板的模式切换必须复用 ART_MODE_OPTIONS');
});

check('三模式共用几何与数据（模式只切视觉配置）', () => {
  const modelsFile = read('src/art/modes.ts');
  assert.match(modelsFile, /export const ART_MODES/, 'ART_MODES 缺失');
  const sandbox = read('src/components/sandbox/SandboxScene.tsx');
  assert.match(sandbox, /const modeId = artMode \?\? globalMode/, 'SandboxScene 未跟随全局模式');
});

// —— 4：性能红线 ——
check('艺术化运行时无后处理依赖', () => {
  const offenders = [];
  for (const file of importedModules) {
    const text = readFileSync(file, 'utf8');
    for (const token of ['@react-three/postprocessing', 'EffectComposer', 'UnrealBloomPass', 'OutlinePass', 'SMAAPass']) {
      if (text.includes(token)) offenders.push(`${file.slice(labDir.length + 1)}: ${token}`);
    }
  }
  assert.deepEqual(offenders, [], `出现后处理引用：${offenders.join(' / ')}`);
});

check('frameloop 只有一处且按 active 切换', () => {
  const text = read('src/components/sandbox/SandboxScene.tsx');
  const hits = text.match(/frameloop=/g) ?? [];
  assert.equal(hits.length, 1, `SandboxScene 里 frameloop 出现 ${hits.length} 次`);
  assert.match(text, /frameloop=\{active \? 'always' : 'demand'\}/, 'frameloop 必须按 active 在 always/demand 之间切换');
  assert.match(text, /dpr=\{dpr\}/, 'dpr 必须来自 props');
  assert.match(text, /dpr = \[1, 2\]/, 'dpr 上限必须是 2');
});

// —— 5：模型清单完整性 ——
const selection = JSON.parse(read('design/assets/art-lab-selection.json'));
const selectionSlugs = new Set(selection.models.map((m) => m.slug));

check('modelPaths 的每个 slug 都在选择表里', () => {
  const text = read('src/art/modelPaths.ts');
  const block = text.match(/ART_MODEL_SLUGS = \{([\s\S]*?)\} as const/);
  assert.ok(block, '未找到 ART_MODEL_SLUGS 定义');
  const slugs = [...block[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(slugs.length >= 40, `期望至少 40 个逻辑键，实际 ${slugs.length}`);
  const missing = slugs.filter((slug) => !selectionSlugs.has(slug));
  assert.deepEqual(missing, [], `选择表里没有这些模型：${missing.join(', ')}`);
  assert.equal(new Set(slugs).size, slugs.length, 'ART_MODEL_SLUGS 存在重复 slug');
});

check('layout.ts 引用的模型键都存在', () => {
  const keysSource = read('src/art/modelPaths.ts');
  const block = keysSource.match(/ART_MODEL_SLUGS = \{([\s\S]*?)\} as const/);
  const keys = new Set([...block[1].matchAll(/^\s*([A-Za-z0-9_]+):\s*'/gm)].map((m) => m[1]));
  const layout = read('src/modules/art-lab/layout.ts');
  const used = [...layout.matchAll(/model:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(used.length > 20, `产线布置只用了 ${used.length} 个模型键，疑似漏写`);
  const unknown = [...new Set(used)].filter((key) => !keys.has(key));
  assert.deepEqual(unknown, [], `layout.ts 使用未定义的模型键：${unknown.join(', ')}`);
});

const manifestPath = join(labDir, 'public/models/art-manifest.json');

/** 读取清单模型数组（供规则覆盖 / 角色政策交叉校验共用）。 */
function manifestModels() {
  if (!existsSync(manifestPath)) return [];
  return JSON.parse(readFileSync(manifestPath, 'utf8')).models ?? [];
}
check('art-manifest.json 与磁盘 GLB 对齐', () => {
  assert.ok(existsSync(manifestPath), '缺少 public/models/art-manifest.json（运行 node lab/scripts/sync-assets.mjs）');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifestSlugs = manifest.models.map((m) => m.slug).sort();
  const expected = [...selectionSlugs].sort();
  assert.equal(manifest.totals.models, expected.length, '清单模型数与选择表唯一模型数不一致');
  assert.deepEqual(manifestSlugs, expected, '清单 slug 集合与选择表不一致');
  const missingFiles = manifest.models
    .map((m) => m.url)
    .filter((url) => !existsSync(join(labDir, 'public', url.replace(/^\//, ''))));
  assert.deepEqual(missingFiles, [], `清单里的 GLB 在磁盘上不存在：${missingFiles.join(', ')}`);
});

check('材质/节点规则覆盖全部清单模型', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const uncovered = manifest.models
    .filter((m) => (m.unknownMaterials ?? []).length > 0)
    .map((m) => `${m.slug}(${(m.unknownMaterials ?? []).join('/')})`);
  assert.deepEqual(uncovered, [], `有模型材质未命中规则：${uncovered.join(', ')}`);
  assert.equal(typeof manifest.audit, 'string', '清单必须注明规则审查来源（audit 路径）');
  assert.ok(existsSync(join(labDir, '..', manifest.audit)), `规则审查报告不存在：${manifest.audit}`);
  const withoutParts = manifest.models.filter((m) => !Array.isArray(m.parts) || m.parts.length === 0).map((m) => m.slug);
  assert.deepEqual(withoutParts, [], `这些模型缺少部件清单（透明分层无法工作）：${withoutParts.join(', ')}`);
  const withoutSize = manifest.models.filter((m) => !Array.isArray(m.sizeMeters) || m.sizeMeters.length !== 3).map((m) => m.slug);
  assert.deepEqual(withoutSize, [], `这些模型缺少真实尺寸（摆位会不可靠）：${withoutSize.join(', ')}`);
});

check('透明策略与角色表自洽', () => {
  const rules = JSON.parse(read('src/art/part-roles.json'));
  const policy = rules.transparencyPolicy ?? {};
  const entries = policy.rules ?? [];
  assert.ok(entries.length >= 4, '透明策略至少要有建筑层与设备外壳两组规则');
  for (const entry of entries) {
    assert.ok(['group', 'role'].includes(entry.kind), `透明规则 kind 非法：${entry.kind}`);
    assert.ok(['structure', 'equipment'].includes(entry.scope), `透明规则 scope 非法：${entry.scope}`);
    assert.equal(typeof entry.alpha, 'number', `透明规则缺少 alpha：${JSON.stringify(entry)}`);
  }
  const scopes = new Set(entries.map((entry) => entry.scope));
  assert.ok(scopes.has('structure') && scopes.has('equipment'), '透明策略必须同时覆盖建筑层与设备层（选择性透明）');
  const never = new Set(policy.never ?? []);
  assert.ok(never.size >= 4, 'never 列表为空：内部机构会被透明化');
  for (const role of ['machined', 'frame']) {
    assert.ok(never.has(role), `内部机构角色 ${role} 必须在 never 列表里（内部结构保持不透明）`);
  }
  const crossChecked = manifestModels().map((m) => m.roles).flatMap((r) => Object.keys(r ?? {}));
  const unknownPolicyRoles = [...new Set(crossChecked)].filter((role) => role === 'unknown');
  assert.deepEqual(unknownPolicyRoles, [], `清单里出现 unknown 角色：${unknownPolicyRoles.join(', ')}`);
});

check('阶段一对照视图齐全', () => {
  const bench = read('src/modules/art-lab/HeroBench3D.tsx');
  for (const view of ['original', 'art', 'shell', 'mechanism', 'parts']) {
    assert.ok(bench.includes(`'${view}'`), `英雄实验台缺少视图 ${view}`);
  }
  assert.match(bench, /modeOverride=\{view === 'original' \? 'A' : benchMode\}/, '原始材质视图必须强制 A 模式外观');
  assert.match(bench, /isolateRoles/, '内部机构视图必须通过 isolateRoles 隔离，而不是隐藏几何');
});

check('叠加层只消费真实解（无装饰性数据源）', () => {
  const overlay = read('src/modules/art-lab/overlay.ts');
  assert.match(overlay, /solution\.plan/, 'AGV 投影必须读真实解的 plan');
  assert.match(overlay, /solution\.robots/, 'MAPF 投影必须读真实解的 robots');
  assert.match(overlay, /operations/, 'APS 投影必须读真实解的工序区间');
  const panel = read('src/modules/art-lab/ArtLabPanel.tsx');
  assert.match(panel, /handle\.solve\(/, '面板必须调用真实引擎（AGV/MAPF）');
  assert.match(panel, /runner\.run\(/, '面板必须调用真实 APS 引擎');
  assert.match(panel, /EMPTY_OVERLAY/, '没有结果时必须回落到空叠加层，不能伪造数据');
});

check('阶段一文档存在', () => {
  assert.ok(existsSync(join(labDir, 'design/ART-PIPELINE-V2.md')), '缺少 lab/design/ART-PIPELINE-V2.md');
  const doc = read('design/ART-PIPELINE-V2.md');
  assert.ok(doc.length > 1500, '阶段一文档内容过短');
  for (const section of ['阶段一', '透明', '模式 A', '模式 B', '模式 C']) {
    assert.ok(doc.includes(section), `文档缺少章节关键词：${section}`);
  }
});

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 项检查失败（共 ${checks} 项）`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log(`✓ 全部通过（${checks} 项检查）`);
