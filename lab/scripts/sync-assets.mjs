#!/usr/bin/env node
/**
 * 把“三维实验室”选中的上传模型同步进实验室内置资源目录。
 *
 * 单一来源原则（与 sync-engine / sync-mapf / sync-agv 一致）：
 *   来源：lab/design/assets/<category>/<slug>.glb  ← 用户上传的原始工业模型，绝不修改
 *   选择：lab/design/assets/art-lab-selection.json（由 MODEL-STRUCTURE-AUDIT.json 的真实统计支撑）
 *   产物：lab/public/models/<category>/<slug>.glb
 *         lab/public/models/art-manifest.json     运行时可读的元数据（尺寸/材质/角色/部件表）
 *         lab/design/assets/ART-LAB-MODEL-SET.md  供评审的模型清单（随仓库提交）
 *
 * 复制而不是引用：Vite 只能打包 public/ 下的静态资源；同时保证运行时不依赖仓库其它目录、
 * 也不从任何第三方 CDN 取模型（ASSET-REGISTER 的既有约束）。
 *
 * 用法：
 *   node lab/scripts/sync-assets.mjs            # 同步（默认）
 *   node lab/scripts/sync-assets.mjs --check    # 只校验选择表与已同步产物是否一致（CI 用）
 *   node lab/scripts/sync-assets.mjs --clean    # 先清空 public/models 再同步
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeAsset, listGlbFiles, partsOfAsset } from './lib/gltf-structure.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const repoRoot = resolve(labDir, '..');
const assetsDir = resolve(labDir, 'design/assets');
const publicDir = resolve(labDir, 'public');
const outDir = resolve(publicDir, 'models');
const rules = JSON.parse(readFileSync(resolve(labDir, 'src/art/part-roles.json'), 'utf8'));

const check = process.argv.includes('--check');
const clean = process.argv.includes('--clean') || (!check && process.argv.includes('--rebuild'));

const selection = JSON.parse(readFileSync(resolve(assetsDir, 'art-lab-selection.json'), 'utf8'));

/** slug → 源文件（选择表允许同名不同类别时用 `category` 字段消歧）。 */
function resolveSource(entry) {
  const candidates = listGlbFiles(assetsDir).filter((file) => file.split('/').pop() === `${entry.slug}.glb`);
  if (entry.category) {
    const hit = candidates.find((file) => relative(assetsDir, file).startsWith(`${entry.category}/`));
    return hit ?? null;
  }
  return candidates[0] ?? null;
}

const models = [];
const problems = [];

for (const entry of selection.models) {
  const source = resolveSource(entry);
  if (!source) {
    problems.push(`选择表里的模型不存在：${entry.slug}${entry.category ? `（类别 ${entry.category}）` : ''}`);
    continue;
  }
  const category = relative(assetsDir, source).split('/')[0];
  const target = resolve(outDir, category, `${entry.slug}.glb`);
  const analysis = analyzeAsset(source, category, rules, repoRoot);
  const parts = partsOfAsset(source, rules);

  if (!check) {
    if (!existsSync(target) || statSync(target).size !== analysis.bytes) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }

  models.push({
    slug: entry.slug,
    role: entry.role,
    use: entry.use,
    category,
    /** 运行时 URL 相对 public 根（由调用方拼 BASE_URL，保证 Pages 子路径可用）。 */
    url: `models/${category}/${entry.slug}.glb`,
    bytes: analysis.bytes,
    triangles: analysis.triangles,
    uniqueTriangles: analysis.uniqueTriangles,
    meshes: analysis.meshCount,
    nodes: analysis.nodeCount,
    materials: analysis.materials,
    roles: analysis.roles,
    groups: analysis.groups,
    sizeMeters: analysis.sizeMeters,
    boundsMin: analysis.boundsMin,
    boundsMax: analysis.boundsMax,
    glassShare: analysis.glassShare,
    equipmentShare: analysis.equipmentShare,
    heroScore: analysis.heroScore,
    transparentCapable: analysis.hasTransparencyShell,
    internalMechanism: analysis.hasInternalMechanism,
    unknownMaterials: analysis.unknownMaterials,
    /** 部件表：英雄/设备模型给全量（用于部件检查与半透明控制），厂房模块只需组信息。 */
    parts: entry.role === 'hall'
      ? parts.slice(0, 6).map((p) => ({ name: p.name, group: p.group, roles: p.roles, triangles: p.triangles }))
      : parts.map((p) => ({ name: p.name, group: p.group, roles: p.roles, triangles: p.triangles, size: p.size })),
  });
}

// 去重（同一模型可能同时属于 hero 与 equipment），保留最完整的部件表。
// 注意：清单只能有一份 slug —— 运行时的 URL 解析、角色分组、部件检查都以 slug 为键，
// 重复条目会让英雄清单出现同一台设备两次。
const bySlug = new Map();
for (const model of models) {
  const existing = bySlug.get(model.slug);
  if (!existing) {
    bySlug.set(model.slug, { ...model, roleTags: [model.role] });
    continue;
  }
  // 同一模型出现在多个用途下：保留 hero 作为主角色（阶段一实验对象优先），
  // 并把所有用途记录下来，面板可以如实显示"这台设备也用于产线"。
  existing.roleTags = [...new Set([...(existing.roleTags ?? [existing.role]), model.role])];
  if (model.role === 'hero' && existing.role !== 'hero') {
    existing.role = 'hero';
    existing.use = model.use;
  }
  existing.transparentCapable = existing.transparentCapable || model.transparentCapable;
  existing.internalMechanism = existing.internalMechanism || model.internalMechanism;
}
const uniqueModels = [...bySlug.values()];

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: 'lab/scripts/sync-assets.mjs',
  selection: 'lab/design/assets/art-lab-selection.json',
  audit: 'lab/design/assets/MODEL-STRUCTURE-AUDIT.json',
  note: '全部模型为 3dassets.dev CC0 1.0 上传资产；本清单是运行时可读的精简元数据，完整结构见结构审查报告。',
  totals: {
    models: uniqueModels.length,
    bytes: uniqueModels.reduce((sum, m) => sum + m.bytes, 0),
    triangles: uniqueModels.reduce((sum, m) => sum + m.triangles, 0),
    byRole: ['hero', 'hall', 'equipment', 'vehicle'].map((role) => ({
      role,
      models: uniqueModels.filter((m) => m.role === role).length,
      bytes: uniqueModels.filter((m) => m.role === role).reduce((sum, m) => sum + m.bytes, 0),
    })),
  },
  models: uniqueModels,
};

if (check) {
  const manifestPath = resolve(outDir, 'art-manifest.json');
  if (!existsSync(manifestPath)) problems.push('缺少 public/models/art-manifest.json：先运行 node lab/scripts/sync-assets.mjs');
  else {
    const existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const model of uniqueModels) {
      const file = resolve(outDir, model.url.replace(/^models\//, ''));
      if (!existsSync(file)) problems.push(`产物缺失：${relative(repoRoot, file)}`);
      else if (statSync(file).size !== model.bytes) problems.push(`产物大小不一致（可能与选择表不同步）：${model.slug}`);
    }
    if (existing.totals?.models !== uniqueModels.length) {
      problems.push(`清单与选择表不一致：清单 ${existing.totals?.models ?? 0} 个，选择表 ${uniqueModels.length} 个`);
    }
  }
} else {
  if (clean && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'art-manifest.json'), `${JSON.stringify(manifest)}\n`);
}

// ---- 供评审的模型清单（随仓库提交） ----
const lines = [];
lines.push('# 三维实验室 · 模型集合（随构建同步）');
lines.push('');
lines.push('> 由 `lab/scripts/sync-assets.mjs` 依据 `art-lab-selection.json` 生成；统计来自真实 GLB 结构。');
lines.push('> 原模型始终保留在 `lab/design/assets/**`，同步只是复制到 `lab/public/models/**`（构建产物，不入库）。');
lines.push('');
lines.push(`- 模型数：**${uniqueModels.length}**（去重后），合计 ${(manifest.totals.bytes / 1024 / 1024).toFixed(2)} MB / ${manifest.totals.triangles.toLocaleString('en-US')} 三角形`);
lines.push(`- 生成时间：${manifest.generatedAt}`);
lines.push('');
for (const role of ['hero', 'hall', 'equipment', 'vehicle']) {
  const list = models.filter((m) => m.role === role);
  if (!list.length) continue;
  lines.push(`## ${role}（${list.length}）`);
  lines.push('');
  lines.push('| 模型 | 用途 | 来源类别 | 大小 | 三角形 | 网格 | 尺寸(m) | 玻璃占比 | 关键部件组 |');
  lines.push('|---|---|---|---:|---:|---:|---|---:|---|');
  for (const m of list) {
    const groups = Object.entries(m.groups ?? {}).filter(([g]) => g !== 'other').slice(0, 4).map(([g, n]) => `${g}×${n}`).join(' ');
    lines.push(`| \`${m.slug}\` | ${m.use} | ${m.category} | ${(m.bytes / 1024).toFixed(0)} KB | ${m.triangles.toLocaleString('en-US')} | ${m.meshes} | ${(m.sizeMeters ?? []).join('×')} | ${(m.glassShare * 100).toFixed(1)}% | ${groups} |`);
  }
  lines.push('');
}
lines.push('## 运行时加载策略（性能红线）');
lines.push('');
lines.push('- 英雄设备：同屏只载入当前选中的一台（切换时 dispose，材质复用共享库）；');
lines.push('- 厂房与产线：drei `useGLTF` 缓存保证同一个 GLB 只解析一次，每实例 `scene.clone(true)` 共享几何、独立节点，绝不改动缓存本身；');
lines.push('- 所有模型的四边形/三角形数上限由结构审查报告给出，禁止把 10 万三角形级的整合场景直接塞进实时画面。');
lines.push('');
// 校验模式只读：不重写清单文档（否则每次 `--check` 都会因为生成时间变化而弄脏工作区）
if (!check) {
  writeFileSync(resolve(assetsDir, 'ART-LAB-MODEL-SET.md'), `${lines.join('\n')}\n`);
}

if (problems.length) {
  console.error(`✗ sync-assets 失败 ${problems.length} 项：`);
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}

console.log(`✓ 三维实验室模型集合${check ? '校验' : '同步'}完成`);
console.log(`  · 模型 ${uniqueModels.length} 个（${(manifest.totals.bytes / 1024 / 1024).toFixed(2)} MB / ${manifest.totals.triangles.toLocaleString('en-US')} 三角形）`);
console.log(`  · ${check ? '校验对象' : '输出'}：${relative(repoRoot, outDir)}/${check ? 'art-manifest.json' : ''}`);
console.log(`  · 清单文档：${relative(repoRoot, resolve(assetsDir, 'ART-LAB-MODEL-SET.md'))}`);
