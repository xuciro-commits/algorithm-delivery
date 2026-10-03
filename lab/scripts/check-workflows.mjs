#!/usr/bin/env node
/**
 * CI 工作流自检（无需依赖、离线可跑）。
 *
 * GitHub Actions 的 YAML 本地没有解析器可用时最容易犯两类错：
 *   1) 缩进写坏 → 整个工作流直接失效（推送后才在网页上看到红色横幅）；
 *   2) action 版本落后 → 出现 “Node.js 20 is deprecated” 之类的运行时告警，
 *      甚至被强制切到新运行时后行为变化。
 *
 * 本脚本用一个**只覆盖本仓库用到的 YAML 子集**的解析器把工作流读成对象，
 * 然后断言这些约定：
 *   - 每个 job 必须有 `runs-on` 或 `uses`；
 *   - 跑在 runner 上的 job 必须有 `timeout-minutes`（防止挂死白烧额度）；
 *   - `push` / `pull_request` 触发必须带 `paths` / `branches` 收敛范围；
 *   - 所有 `actions/*` 必须使用支持 Node 24 的主版本；
 *   - `setup-node` 的 `node-version` 不得低于 24。
 *
 * 解析器只支持：块映射、块序列、标量、块标量（| 与 >）、行内数组、注释。
 * 遇到不支持的结构会直接报错退出——宁可不检查，也不要假装检查过。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workflowDir = resolve(here, '..', '..', '.github', 'workflows');

// ---- 支持 Node 24 的 action 主版本下限（低于此值会出现运行时告警）----
const ACTION_MIN_MAJOR = {
  'actions/checkout': 5,
  'actions/setup-node': 5,
  'actions/upload-artifact': 6,
  'actions/download-artifact': 8,
  'actions/cache': 6,
  'actions/upload-pages-artifact': 5,
  'actions/deploy-pages': 5,
  'actions/configure-pages': 6,
};

// ---------------------------------------------------------------- YAML 子集解析
function parseYaml(text, file) {
  const raw = text.split('\n');
  /** 去掉整行注释与空行，但保留块标量内容 */
  const lines = [];
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    lines.push({ indent: line.length - line.trimStart().length, text: trimmed, no: i + 1 });
  }

  let pos = 0;
  const fail = (msg, line) => {
    const at = line ? ` (第 ${line.no} 行: ${line.text})` : '';
    throw new Error(`${file}${at} — ${msg}`);
  };
  const stripComment = (value) => {
    // 只处理 ` #` 之后是注释的情况（不动引号里的 #）
    let out = '';
    let quote = null;
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (quote) {
        if (ch === quote) quote = null;
        out += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === '#' && (i === 0 || value[i - 1] === ' ')) break;
      out += ch;
    }
    return out.trimEnd();
  };
  const scalar = (value) => {
    const v = stripComment(value).trim();
    if (v === '') return null;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    if (v.startsWith('[') && v.endsWith(']')) {
      return v
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter((s) => s !== '');
    }
    return v;
  };

  /** 读一个键的值：嵌套块 / 块标量（| >）/ 普通标量 */
  function readValue(valueText, keyIndent) {
    if (valueText.trim() === '') {
      return pos < lines.length && lines[pos].indent > keyIndent ? parseBlock(lines[pos].indent) : null;
    }
    if (/^\s*[|>][-+]?\s*$/.test(valueText)) {
      const body = [];
      const bodyIndent = pos < lines.length && lines[pos].indent > keyIndent ? lines[pos].indent : keyIndent + 1;
      while (pos < lines.length && lines[pos].indent >= bodyIndent) {
        body.push(lines[pos].text);
        pos += 1;
      }
      return body.join('\n');
    }
    return scalar(valueText);
  }

  function parseBlock(indent) {
    if (pos >= lines.length) return null;
    const first = lines[pos];
    if (first.indent < indent) return null;
    return first.text.startsWith('- ') || first.text === '-' ? parseSeq(first.indent) : parseMap(first.indent);
  }

  function parseSeq(indent) {
    const arr = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith('- ') || lines[pos].text === '-')) {
      const line = lines[pos];
      const rest = line.text.slice(1).trim();
      pos += 1;
      if (rest === '') {
        arr.push(parseBlock(indent + 1) ?? null);
      } else if (/^[A-Za-z0-9_$."'-]+:(\s|$)/.test(rest)) {
        // 序列中的映射：`- name: x`，后续同缩进的键归入同一个对象
        const obj = {};
        const [k, ...v] = rest.split(':');
        obj[k.trim()] = readValue(v.join(':'), indent + 1);
        while (pos < lines.length && lines[pos].indent === indent + 2 && !lines[pos].text.startsWith('- ')) {
          const child = lines[pos];
          const idx = child.text.indexOf(':');
          if (idx < 0) fail('映射行缺少冒号', child);
          const key = child.text.slice(0, idx).trim();
          const value = child.text.slice(idx + 1);
          const lineNo = child;
          pos += 1;
          if (Object.prototype.hasOwnProperty.call(obj, key)) fail(`重复键 ${key}`, lineNo);
          obj[key] = readValue(value, indent + 2);
        }
        arr.push(obj);
      } else {
        arr.push(scalar(rest));
      }
    }
    return arr;
  }

  function parseMap(indent) {
    const obj = {};
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith('- ')) {
      const line = lines[pos];
      const idx = line.text.indexOf(':');
      if (idx < 0) fail('映射行缺少冒号', line);
      const key = line.text.slice(0, idx).trim();
      const value = line.text.slice(idx + 1);
      pos += 1;
      if (Object.prototype.hasOwnProperty.call(obj, key)) fail(`重复键 ${key}`, line);
      obj[key] = readValue(value, indent);
    }
    return obj;
  }

  const doc = parseBlock(0);
  if (pos !== lines.length) fail('存在无法解析的尾随内容', lines[pos]);
  return doc;
}

// ---------------------------------------------------------------- 断言
const { check, note, finish, failures } = createHarness('CI 工作流自检');
const notes = [];

const files = readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f)).sort();
check('工作流文件可枚举', files.length > 0, `${files.length} 个`);

const actionPins = [];
const nodeVersions = [];
for (const file of files) {
  const path = join(workflowDir, file);
  let doc;
  try {
    doc = parseYaml(readFileSync(path, 'utf8'), file);
  } catch (error) {
    failures.push(`解析失败：${error.message}`);
    console.log(`✗ 解析 ${file} — ${error.message}`);
    continue;
  }

  const jobs = doc?.jobs ?? {};
  const jobNames = Object.keys(jobs);
  check(`${file} 解析成功`, true, `${jobNames.length} 个 job`);

  // 触发范围
  for (const trigger of ['push', 'pull_request']) {
    const conf = doc?.on?.[trigger];
    if (!conf) continue;
    const scoped = Boolean(
      conf.paths || conf['paths-ignore'] || conf.branches || conf['branches-ignore'] || conf.tags || conf['tags-ignore'],
    );
    check(`${file} 的 ${trigger} 触发有范围收敛`, scoped, scoped ? '' : '没有 paths / branches 过滤，会为无关改动烧 runner');
  }

  // 遍历 job 内部所有 uses / node-version
  const walk = (node, visit) => {
    if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
    else if (node && typeof node === 'object') {
      visit(node);
      Object.values(node).forEach((n) => walk(n, visit));
    }
  };
  walk(jobs, (node) => {
    if (typeof node.uses === 'string' && node.uses.startsWith('actions/')) {
      const [repo, ref] = node.uses.split('@');
      const major = Number.parseInt(String(ref).replace(/^v/, ''), 10);
      actionPins.push({ file, uses: node.uses, repo, major });
    }
    if (node['node-version'] !== undefined) nodeVersions.push({ file, version: String(node['node-version']) });
  });

  // job 结构约定
  for (const [name, job] of Object.entries(jobs)) {
    if (!job) {
      failures.push(`${file} → ${name} 是空 job`);
      continue;
    }
    check(`${file} → ${name} 有 runs-on 或 uses`, Boolean(job['runs-on'] || job.uses), '');
    check(
      `${file} → ${name} 有 timeout-minutes`,
      !(job['runs-on'] && job['timeout-minutes'] === undefined),
      job['runs-on'] && job['timeout-minutes'] === undefined ? '挂死时会一直占用 runner' : '',
    );
  }
  // 可复用工作流不应自带 push 触发
  if (Object.keys(jobs).every((n) => jobs[n]?.uses === undefined) && doc?.on?.workflow_call && !doc?.on?.push && !doc?.on?.pull_request) {
    notes.push(`${file}: 仅 workflow_call`);
  }
}

// action 版本
for (const pin of actionPins) {
  const min = ACTION_MIN_MAJOR[pin.repo];
  if (min === undefined) {
    notes.push(`未登记版本下限的 action：${pin.uses}（${pin.file}）`);
    continue;
  }
  check(`${pin.uses} 支持 Node 24`, pin.major >= min, pin.major >= min ? '' : `应 ≥ v${min}（当前 ${pin.uses}）`);
}

// Node 运行时
check('workflow 里的 node-version 不低于 24', nodeVersions.every((n) => Number.parseInt(n.version, 10) >= 24),
  nodeVersions.map((n) => `${n.file}:${n.version}`).join('、'));
if (nodeVersions.length) console.log(`  · setup-node 版本：${[...new Set(nodeVersions.map((n) => n.version))].join('、')}`);

for (const line of notes) note(line);
finish(`CI 工作流自检通过（${files.length} 个文件、${actionPins.length} 处 action 引用）`);
