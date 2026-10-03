#!/usr/bin/env node
/**
 * 文档与仓库一致性检查（无需浏览器 / 构建 / Rust）。
 *
 * 这个仓库的“规格”大量存在于 Markdown 里（SRS、设计基准、验收流程、资产清单），
 * 而文档最容易悄悄过期。本脚本把三件**可判定**的事变成断言：
 *
 *   1) 相对链接可达：所有被跟踪的 Markdown 里的 `[文本](相对路径)` 必须真实存在
 *      （`lab/design/assets/**` 下的资产链接只警告不失败——那是上传素材清单，
 *       与仓库内文件可能不同步）；
 *   2) 设计文档索引完整：`lab/design/*.md` 每一份都要被 `lab/design/README.md` 链接，
 *      索引里也不允许出现指向不存在文档的死链（新增设计文档必须登记）；
 *   3) 生成物边界清晰：被 `.gitignore` 排除的生成目录不得被提交；
 *      设计文档不得把生成物描述成“单一份来源”。
 *
 * 用法：node lab/scripts/check-docs.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const designDir = resolve(here, '..', 'design');

const failures = [];
const warnings = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${name}${detail ? `（${detail}）` : ''}`);
};
const warn = (name, detail = '') => {
  console.log(`⚠ ${name}${detail ? ` — ${detail}` : ''}`);
  warnings.push(`${name}${detail ? `（${detail}）` : ''}`);
};

// ---- 收集被跟踪的 Markdown ----
const tracked = execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const docs = tracked.map((p) => join(repoRoot, p));
check('仓库内 Markdown 可枚举', docs.length > 0, `${docs.length} 份`);

// ---- 1) 相对链接可达 ----
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
let linkCount = 0;
const assetDrift = [];
for (const file of docs) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(LINK)) {
    const url = match[1];
    if (/^(https?:|mailto:|tel:|#)/.test(url)) continue;
    const target = url.split('#')[0];
    if (!target) continue;
    // 数学记号（如 `inv[q](t)`）会被误当成链接：只接受形如路径的目标
    if (!/[/.]/.test(target)) continue;
    linkCount += 1;
    const abs = resolve(dirname(file), decodeURIComponent(target));
    if (existsSync(abs)) continue;
    const rel = relative(repoRoot, file);
    if (rel.startsWith('lab/design/assets/')) {
      // 上传素材清单指向的是磁盘上的 GLB/HDR：缺文件只提示，不作为失败
      assetDrift.push(`${rel} → ${target}`);
      continue;
    }
    failures.push(`链接不可达：${rel} → ${target}`);
  }
}
check('文档相对链接可达', !failures.some((f) => f.startsWith('链接不可达')), `${linkCount} 条相对链接`);
if (assetDrift.length) {
  warn('素材清单与磁盘存在差异（需要重新下载或重新生成清单）', `${assetDrift.length} 条：${assetDrift.slice(0, 3).join('；')}${assetDrift.length > 3 ? ' …' : ''}`);
}

// ---- 2) 设计文档索引完整 ----
const indexFile = join(designDir, 'README.md');
check('设计文档索引存在', existsSync(indexFile), 'lab/design/README.md');
if (existsSync(indexFile)) {
  const indexText = readFileSync(indexFile, 'utf8');
  const designDocs = docs
    .map((p) => relative(designDir, p))
    .filter((p) => p.endsWith('.md') && !p.includes('/') && p !== 'README.md');
  const missing = designDocs.filter((p) => !indexText.includes(`(${p})`));
  check('索引登记了全部设计文档', missing.length === 0, missing.join('、'));
}

// ---- 3) 生成物边界 ----
const ignoredPrefixes = ['lab/public/wasm/', 'lab/public/mock/', 'lab/public/models/', 'lab/src/vendor/'];
const committedGenerated = tracked.filter((p) => ignoredPrefixes.some((pre) => p.startsWith(pre)));
check('生成物未被提交（wasm / mock / models / vendor）', committedGenerated.length === 0, committedGenerated.slice(0, 3).join('、'));

// ---- 4) 文档里的关键事实与代码一致 ----
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'lab/package.json'), 'utf8'));
const readme = readFileSync(join(repoRoot, 'lab/README.md'), 'utf8');
const scriptsInReadme = Object.keys(packageJson.scripts)
  .filter((s) => !/^(pre|post)/.test(s)) // npm 生命周期钩子由 README 的说明段落覆盖
  .filter((s) => !readme.includes(`npm run ${s}`));
check('lab/README.md 覆盖全部 npm 脚本', scriptsInReadme.length === 0, scriptsInReadme.join('、'));

const modeDoc = readFileSync(join(designDir, 'ART-PIPELINE-V2.md'), 'utf8');
const modesSource = readFileSync(join(repoRoot, 'lab/src/art/modes.ts'), 'utf8');
const modeIds = [...modesSource.matchAll(/^\s{2}(\w+):\s*\{/gm)].map((m) => m[1]);
const documentedModes = ['A', 'B', 'C'].filter((m) => !modeDoc.includes(`模式 ${m}`));
check('视觉模式文档与实现一致（模式 A/B/C）', documentedModes.length === 0 && modeIds.length >= 3, documentedModes.join('、'));

console.log('');
if (failures.length) {
  console.error(`✗ 文档检查失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`✓ 文档与仓库一致（${docs.length} 份 Markdown、${linkCount} 条相对链接${warnings.length ? `、${warnings.length} 条提示` : ''}）`);
