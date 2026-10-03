#!/usr/bin/env node
/**
 * V2 性能红线审计（R6，无需浏览器）：静态扫描 `src/`，把设计文档里的硬约束
 * 变成可执行断言——
 *   1) 需求渲染：不允许裸 `frameloop="always"`，Canvas 一律 `demand`（active 才常驻）；
 *   2) dpr ≤ 2（禁止 dpr={3} / [1,3] 之类）；
 *   3) 禁后处理：不得引入 EffectComposer / Bloom / SMAA / postprocessing 依赖；
 *   4) 实例化：障碍场 / 底板必须 InstancedMesh（一格一 mesh 会随地图线性掉帧）；
 *   5) 发光 = 细两层级 Line2（不发丝粗线、不实体粗管）；
 *   6) 每帧零分配：useFrame 回调里不得 new 向量/颜色/几何体；
 *   7) 3D 场景必须挂在 `active` 开关上（不活动即 0 GPU 负载）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, '..', 'src');
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|css)$/.test(entry)) out.push(p);
  }
  return out;
}

const files = walk(srcDir);
const text = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

/** 去掉块注释与行注释后再做代码级扫描（文档注释里出现关键字不算违规）。 */
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const code = new Map([...text.entries()].map(([f, t]) => [f, stripComments(t)]));
const all = [...code.values()].join('\n');

// ---- 1) 需求渲染 ----
const alwaysMode = [...code.entries()].filter(([, t]) => /frameloop=["']always/.test(t));
check('没有裸 frameloop="always"（一律 demand，active 才常驻）', alwaysMode.length === 0, alwaysMode.map(([f]) => f).join(','));
const demandMode = [...code.entries()].filter(([, t]) => /frameloop=\{active \? 'always' : 'demand'\}/.test(t));
check('SandboxScene 使用 demand + active 开关', demandMode.length === 1, `${demandMode.length} 处`);
// V3 视觉舞台（透视艺术化场景）同样必须 active 驱动，且不允许裸 frameloop
const stageShell = code.get(join(srcDir, 'visual/StageShell.tsx')) ?? '';
check('StageShell 用 active 驱动的 demand 渲染', /const frameLoop = active \? 'always' : 'demand'/.test(stageShell) && /frameloop=\{frameLoop\}/.test(stageShell));

// ---- 2) dpr ≤ 2 ----
const badDpr = [...code.entries()].filter(([, t]) => /dpr=\{?\[?\s*\d+\s*,\s*[3-9]|dpr=\{?[3-9]/.test(t));
check('dpr 不超过 2', badDpr.length === 0, badDpr.map(([f]) => f).join(','));
const dprOk = /dpr = \[1, 2\]/.test(stripComments(text.get(join(srcDir, 'components/sandbox/SandboxScene.tsx')) ?? ''));
check('SandboxScene 默认 dpr=[1,2]', dprOk);

// ---- 3) 禁后处理 ----
const post = /EffectComposer|UnrealBloomPass|@react-three\/postprocessing|SMAA|OutlinePass/.test(all);
check('未引入后处理/泛光（glow 由 Line2 两层级实现）', !post);

// ---- 4) 实例化 ----
const obstacle = text.get(join(srcDir, 'components/sandbox/ObstacleField.tsx')) ?? '';
check('障碍场使用 Instances（实例化渲染）', /<Instances/.test(obstacle) && /<Instance\b/.test(obstacle));
const ground = text.get(join(srcDir, 'components/sandbox/GroundPlate.tsx')) ?? '';
check('底板为单 mesh（不逐格实例化）', /planeGeometry|boxGeometry/.test(ground));

// ---- 5) 发光线 = Line2 细两层级（drei Line：核心线 + 低透明宽晕线）----
const glow = code.get(join(srcDir, 'components/sandbox/GlowPath.tsx')) ?? '';
const lineUses = (glow.match(/<Line\b/g) ?? []).length;
// lineWidth 可能写成字面量或 {coreW}/{haloW} 变量：把变量定义里的数字一并取出核对
const widthExprs = [...glow.matchAll(/lineWidth=\{?([^}\n]+)\}?/g)].map((m) => m[1].trim());
const widthNums = widthExprs.flatMap((e) => [...e.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])));
for (const name of ['coreW', 'haloW']) {
  const def = glow.match(new RegExp(`const ${name} = ([^;]+);`));
  if (def) widthNums.push(...([...def[1].matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]))));
}
check('GlowPath 为细两层级（核心线 + 宽晕线各一对）', lineUses >= 4 && widthExprs.length >= 4, `Line×${lineUses} widths=${widthExprs.join(' / ')}`);
check('发光线保持细（所有 lineWidth ≤ 10，无霓虹粗线）', widthNums.length > 0 && widthNums.every((w) => w > 0 && w <= 10), widthNums.join('/'));
const hasHalo = /lineWidth=\{haloW/.test(glow) && /lineWidth=\{coreW/.test(glow);
check('晕线宽于核心线（halo > core）', hasHalo);
const thick = [...code.entries()].filter(([f, t]) => /tubeGeometry/.test(t));
check('没有用粗管/粗线冒充发光', thick.length === 0, thick.map(([f]) => f).join(','));
const dashFlow = /dashOffset=\{-flowOffset\}/.test(glow);
check('光流只做 dashOffset（与真实时间步绑定）', dashFlow);

// ---- 6) 每帧零分配 ----
const frameAlloc = [...text.entries()].filter(([f, t]) => {
  const blocks = t.split('useFrame(').slice(1);
  return blocks.some((b) => {
    const body = b.slice(0, b.indexOf('});') + 3);
    return /new (THREE\.)?(Vector[23]|Color|Material|Geometry)\b/.test(body);
  });
});
check('useFrame 回调内不 new 向量/颜色/材质', frameAlloc.length === 0, frameAlloc.map(([f]) => f).join(','));

// ---- 7) 3D 场景都受 active 控制 ----
const stages = [...text.entries()].filter(([f, t]) => /<SandboxScene/.test(t));
const withoutActive = stages.filter(([, t]) => {
  const uses = t.match(/<SandboxScene[\s\S]{0,400}?>/g) ?? [];
  return uses.some((u) => !/active=/.test(u));
});
check('每处 SandboxScene 都显式传 active', withoutActive.length === 0, withoutActive.map(([f]) => f).join(','));
const stageUsages = [...text.entries()].filter(([f, t]) => /<StageShell/.test(t));
const stageWithoutActive = stageUsages.filter(([, t]) => {
  const uses = t.match(/<StageShell[\s\S]{0,700}?>/g) ?? [];
  return uses.some((u) => !/active=/.test(u));
});
check('每处 StageShell 都显式传 active', stageUsages.length >= 1 && stageWithoutActive.length === 0, stageWithoutActive.map(([f]) => f).join(','));
check('存在 3D 沙盘装配（MAPF/AGV/APS）', stages.length >= 3, `${stages.length} 处`);

// ---- 8) 轻量 2D 回退仍在 ----
const panels = ['modules/mapf/MapfPanel.tsx', 'modules/agv/AgvPanel.tsx'].map((p) => text.get(join(srcDir, p)) ?? '');
check('MAPF/AGV 保留 2D 回退（MapStage）', panels.every((t) => /MapStage/.test(t)) && /view3d/.test(panels[0]) && /view3d/.test(panels[1]));

console.log('');
if (failures.length) {
  console.error(`✗ 性能红线审计失败 ${failures.length} 项：${failures.join('；')}`);
  process.exit(1);
}
console.log(`✓ V2 性能红线审计通过（扫描 ${files.length} 个源文件）`);
