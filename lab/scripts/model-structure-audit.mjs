#!/usr/bin/env node
/**
 * 模型结构审查（任务第二步：审查已经上传的模型）。
 *
 * 目的：不打开浏览器、不做完整构建，就能把 `lab/design/assets/**` 里全部 GLB
 * 的真实结构读出来，用于本轮“工业模型 → C4D 风格艺术化”的素材决策：
 *
 *   - 每个资产的三角形数 / 网格数 / 节点数 / 真实米制包围盒（KHR_mesh_quantization 归一化后）；
 *   - 材质名清单 → 语义角色映射（材质名本身就是语义化的：steel / charcoal / glass / glow …）；
 *   - 节点名分组（cnc-door / hall-roof-truss-bay / conveyor …）判断**是否具备可单独控制的部件**：
 *     机械外壳、支架、内部机构、传送部件、防护罩、门窗玻璃；
 *   - 透明化潜力：glass 占比 + roof / wall / cladding 部件组；
 *   - 英雄设备候选评分（结构复杂、机械细节丰富、设备占比高 → 阶段一实验对象）；
 *   - 规则覆盖率：未命中的材质名必须显式补规则（脚本以退出码 1 报告）。
 *
 * 输出：
 *   lab/design/assets/MODEL-STRUCTURE-AUDIT.json   机器可读全量报告（随仓库提交）
 *   lab/design/assets/MODEL-STRUCTURE-AUDIT.md     人工审查报告（随仓库提交）
 *
 * 用法：
 *   node lab/scripts/model-structure-audit.mjs
 *   node lab/scripts/model-structure-audit.mjs --category aps-machining
 *   node lab/scripts/model-structure-audit.mjs --detail cnc-machining-centre-with-sliding-door
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeAsset, listGlbFiles, partsOfAsset } from './lib/gltf-structure.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const repoRoot = resolve(labDir, '..');
const assetsDir = resolve(labDir, 'design/assets');
const rulesPath = resolve(labDir, 'src/art/part-roles.json');
const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const prefixed = process.argv.find((a) => a.startsWith(`--${name}=`));
  return prefixed ? prefixed.slice(name.length + 3) : fallback;
};

const onlyCategory = arg('category');
const detailSlugs = arg('detail').split(',').map((s) => s.trim()).filter(Boolean);
/** 每个类别里额外输出逐部件明细的资产数量（默认英雄候选前 3 名）。 */
const detailTop = Number(arg('detail-top', '3'));

const files = listGlbFiles(assetsDir)
  .map((file) => ({ file, category: relative(assetsDir, file).split('/')[0] }))
  .filter((f) => !onlyCategory || f.category === onlyCategory)
  .sort((a, b) => a.category.localeCompare(b.category) || a.file.localeCompare(b.file));

const assets = [];
for (const { file, category } of files) {
  const asset = analyzeAsset(file, category, rules, repoRoot);
  if (asset.error) {
    console.warn(`  ! 跳过 ${relative(repoRoot, file)}：${asset.error}`);
    continue;
  }
  assets.push(asset);
}

// 逐部件明细：显式 --detail + 每类别英雄候选前 N
const byCategory = new Map();
for (const a of assets) {
  const list = byCategory.get(a.category) ?? [];
  list.push(a);
  byCategory.set(a.category, list);
}
const detailTargets = new Set(detailSlugs);
for (const [, list] of byCategory) {
  [...list]
    .sort((a, b) => b.heroScore - a.heroScore)
    .slice(0, detailTop)
    .forEach((a) => detailTargets.add(a.slug));
}
for (const asset of assets) {
  if (!detailTargets.has(asset.slug)) continue;
  asset.partDetail = partsOfAsset(resolve(repoRoot, asset.file), rules);
}

const unknownMaterialNames = [...new Set(assets.flatMap((a) => a.unknownMaterials))].sort();
const totalTriangles = assets.reduce((sum, a) => sum + a.triangles, 0);

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: 'lab/scripts/model-structure-audit.mjs',
  rulesVersion: rules.version,
  totals: {
    assets: assets.length,
    bytes: assets.reduce((s, a) => s + a.bytes, 0),
    triangles: totalTriangles,
    materials: new Set(assets.flatMap((a) => a.materials)).size,
    unknownMaterialNames,
    categories: [...byCategory.entries()].map(([category, list]) => ({
      category,
      assets: list.length,
      bytes: list.reduce((s, a) => s + a.bytes, 0),
      triangles: list.reduce((s, a) => s + a.triangles, 0),
      withGlass: list.filter((a) => a.glassShare > 0.01).length,
      withRoofOrWall: list.filter((a) => (a.groups.roof ?? 0) + (a.groups.structure ?? 0) > 0).length,
      withInternalMechanism: list.filter((a) => a.hasInternalMechanism).length,
      withControllableParts: list.filter((a) => (a.groups.aperture ?? 0) > 0).length,
    })),
  },
  heroCandidates: assets
    .filter((a) => a.category !== 'assembled-scenes')
    .sort((a, b) => b.heroScore - a.heroScore)
    .slice(0, 24)
    .map((a) => ({
      slug: a.slug,
      category: a.category,
      heroScore: a.heroScore,
      triangles: a.triangles,
      meshes: a.meshCount,
      materials: a.materials,
      sizeMeters: a.sizeMeters,
      glassShare: a.glassShare,
      equipmentShare: a.equipmentShare,
      groups: a.groups,
    })),
  transparencyCandidates: assets
    .filter((a) => a.hasTransparencyShell)
    .sort((a, b) => (b.groups.roof ?? 0) + (b.groups.structure ?? 0) - ((a.groups.roof ?? 0) + (a.groups.structure ?? 0)))
    .slice(0, 20)
    .map((a) => ({
      slug: a.slug,
      category: a.category,
      glassShare: a.glassShare,
      roof: a.groups.roof ?? 0,
      structure: a.groups.structure ?? 0,
      triangles: a.triangles,
    })),
  assets: assets.map((a) => ({
    slug: a.slug,
    category: a.category,
    file: a.file,
    bytes: a.bytes,
    triangles: a.triangles,
    uniqueTriangles: a.uniqueTriangles,
    instances: a.instanceCount,
    meshes: a.meshCount,
    nodes: a.nodeCount,
    materials: a.materials,
    roles: a.roles,
    groups: a.groups,
    sizeMeters: a.sizeMeters,
    boundsMin: a.boundsMin,
    boundsMax: a.boundsMax,
    glassShare: a.glassShare,
    equipmentShare: a.equipmentShare,
    heroScore: a.heroScore,
    transparentCapable: a.hasTransparencyShell,
    internalMechanism: a.hasInternalMechanism,
    unknownMaterials: a.unknownMaterials,
    partDetail: a.partDetail,
  })),
};

const jsonOut = resolve(assetsDir, 'MODEL-STRUCTURE-AUDIT.json');
writeFileSync(jsonOut, `${JSON.stringify(report)}\n`);

// ---- 人工审查报告（Markdown，随仓库提交，便于评审） ----
const lines = [];
lines.push('# 已上传工业模型 · 结构审查报告');
lines.push('');
lines.push('> 由 `lab/scripts/model-structure-audit.mjs` 自动生成，数据来自 `lab/design/assets/**` 的真实 GLB 与 glTF 元数据。');
lines.push('> 语义规则单一来源：`lab/src/art/part-roles.json`。**不要手工编辑本文件**。');
lines.push('');
lines.push(`- 生成时间：${report.generatedAt}`);
lines.push(`- 资产总数：**${report.totals.assets}** 个 GLB，${(report.totals.bytes / 1024 / 1024).toFixed(1)} MB，合计 ${report.totals.triangles.toLocaleString('en-US')} 三角形（按实例计）`);
lines.push(`- 出现的材质名：${report.totals.materials} 种；未命中规则的材质名：${unknownMaterialNames.length ? `\`${unknownMaterialNames.join('`, `')}\`` : '无'}`);
lines.push('');
lines.push('## 1. 分类统计');
lines.push('');
lines.push('| 类别 | 资产数 | 体积 | 三角形 | 含玻璃 | 含屋顶/墙体 | 含内部机构 | 含可控部件（门窗/护罩） |');
lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const c of report.totals.categories) {
  lines.push(`| ${c.category} | ${c.assets} | ${(c.bytes / 1024 / 1024).toFixed(1)} MB | ${c.triangles.toLocaleString('en-US')} | ${c.withGlass} | ${c.withRoofOrWall} | ${c.withInternalMechanism} | ${c.withControllableParts} |`);
}
lines.push('');
lines.push('## 2. 材质 → 艺术化角色 覆盖表');
lines.push('');
const roleTris = new Map();
for (const a of assets) for (const [role, tris] of Object.entries(a.roles)) roleTris.set(role, (roleTris.get(role) ?? 0) + tris);
lines.push('| 角色 | 含义 | 三角形占比 | 艺术化处理方向 |');
lines.push('|---|---|---:|---|');
const roleIntent = {
  shell: '冷银白 / 浅银灰漆面（可选择性半透明）',
  frame: '深色钢构，保留清晰轮廓（不透明）',
  graphite: '深石墨结构件（层次压暗）',
  machined: '精密加工金属（高光导轨/主轴）',
  glazing: '冰蓝半透明工业玻璃 / 亚克力',
  rubber: '哑光深灰橡胶',
  hazard: '克制的琥珀安全色',
  accent: '琥珀 / 珊瑚强调色',
  emissive: '青色 / 冰蓝柔和发光（对应真实状态）',
  fluid: '半透明冷色液体',
  polymer: '冷灰聚合物 / 洁净面板',
  floor: '科技地面（细网格 + 区域标识）',
  organic: '低饱和木色（弱化）',
  metalWarm: '暖色金属点缀',
  consumable: '工件色（低饱和）',
  skin: '人形标尺（弱化）',
  unknown: '未分类：必须补规则',
};
for (const role of Object.keys(rules.roles)) {
  const tris = roleTris.get(role) ?? 0;
  const share = totalTriangles > 0 ? ((tris / totalTriangles) * 100).toFixed(2) : '0.00';
  lines.push(`| \`${role}\` | ${rules.roles[role]} | ${share}% | ${roleIntent[role] ?? '—'} |`);
}
lines.push('');
lines.push('## 3. 英雄设备候选（阶段一实验对象）');
lines.push('');
lines.push('评分 = 结构复杂度(三角形) + 网格数(部件划分) + 材质数 + 玻璃占比 + 可控部件组(门窗/护罩) + 内部机构 + 传动件，再乘**设备占比**系数（抑制“房间式小场景”）。');
lines.push('');
lines.push('| 排名 | 资产 | 类别 | 评分 | 设备占比 | 三角形 | 网格 | 材质 | 尺寸(m) | 玻璃占比 | 关键部件组 |');
lines.push('|---:|---|---|---:|---:|---:|---:|---|---|---:|---|');
report.heroCandidates.forEach((a, i) => {
  const groups = Object.entries(a.groups).filter(([g]) => g !== 'other').slice(0, 5).map(([g, n]) => `${g}×${n}`).join(' ');
  lines.push(`| ${i + 1} | \`${a.slug}\` | ${a.category} | ${a.heroScore} | ${(a.equipmentShare * 100).toFixed(0)}% | ${a.triangles.toLocaleString('en-US')} | ${a.meshes} | ${a.materials.join('/')} | ${(a.sizeMeters ?? []).join('×')} | ${(a.glassShare * 100).toFixed(1)}% | ${groups} |`);
});
lines.push('');
lines.push('## 4. 透明化潜力候选（厂房 / 建筑部件）');
lines.push('');
lines.push('| 资产 | 类别 | 玻璃占比 | roof 部件 | structure 部件 | 三角形 |');
lines.push('|---|---|---:|---:|---:|---:|');
for (const a of report.transparencyCandidates) {
  lines.push(`| \`${a.slug}\` | ${a.category} | ${(a.glassShare * 100).toFixed(1)}% | ${a.roof} | ${a.structure} | ${a.triangles.toLocaleString('en-US')} |`);
}
lines.push('');
lines.push('## 5. 部件划分审查样例（逐网格明细）');
lines.push('');
lines.push('这些明细直接决定“能不能单独控制机械外壳 / 支架 / 内部机构 / 传送部件 / 防护罩”。');
lines.push('');
for (const a of assets.filter((x) => x.partDetail)) {
  lines.push(`### ${a.slug}（${a.category}）`);
  lines.push('');
  lines.push(`- 网格 ${a.meshCount} / 节点 ${a.nodeCount} / 三角形 ${a.triangles.toLocaleString('en-US')}（唯一网格 ${a.uniqueTriangles.toLocaleString('en-US')}），尺寸 ${(a.sizeMeters ?? []).join('×')} m`);
  lines.push(`- 角色分布：${Object.entries(a.roles).map(([r, t]) => `${r} ${t.toLocaleString('en-US')} tris`).join(' · ') || '—'}`);
  lines.push('');
  lines.push('| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |');
  lines.push('|---|---|---|---:|---|');
  for (const p of a.partDetail.slice(0, 18)) {
    lines.push(`| \`${p.name}\` | ${p.group} | ${p.roles.join('/')} | ${p.triangles.toLocaleString('en-US')} | ${(p.size ?? []).join('×')} |`);
  }
  if (a.partDetail.length > 18) lines.push(`| … 其余 ${a.partDetail.length - 18} 个网格 | | | | |`);
  lines.push('');
}

const mdOut = resolve(assetsDir, 'MODEL-STRUCTURE-AUDIT.md');
writeFileSync(mdOut, `${lines.join('\n')}\n`);

console.log(`✓ 审查完成：${assets.length} 个 GLB`);
console.log(`  · ${relative(repoRoot, jsonOut)}（${(readFileSync(jsonOut).length / 1024).toFixed(0)} KB）`);
console.log(`  · ${relative(repoRoot, mdOut)}`);
console.log(`  · 未命中材质规则：${unknownMaterialNames.length ? unknownMaterialNames.join(', ') : '无'}`);
if (unknownMaterialNames.length) {
  console.log('  请在 lab/src/art/part-roles.json 的 materialRules 中显式补上这些材质名。');
  process.exitCode = 1;
}
if (!existsSync(rulesPath)) console.error(`✗ 找不到规则文件：${rulesPath}`);
mkdirSync(assetsDir, { recursive: true });
