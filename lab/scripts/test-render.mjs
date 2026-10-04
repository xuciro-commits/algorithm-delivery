#!/usr/bin/env node
/**
 * 渲染冒烟（无需浏览器）：把 `App` 在 Node 里以 SSR 方式渲染出来，断言：
 *   - 外壳可渲染：标题、模块导航、已接入/待接入模块都在；
 *   - 引擎未就绪时给出可操作提示（而不是白屏或抛错）；
 *   - 五个 ready 模块（APS / MAPF / AGV / 库位优化 / 密集立库）都渲染真面板，且**不渲染任何假数据**；
 *   - 各算法模块 Panel 缺省（未传引擎上下文）时不崩溃。
 *
 * 说明：这里覆盖不了“浏览器里点运行”的完整交互（那部分由 test:core / test:runner /
 * test:pages 用同一份引擎与同一份纯逻辑在 Node 里跑真实 WASM 覆盖）。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHarness } from './lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');

const { check, finish, failures } = createHarness('渲染冒烟');

const tmp = join(labDir, 'node_modules', '.lab-render-test');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const entry = join(tmp, 'entry.tsx');
writeFileSync(
  entry,
  `import { renderToStaticMarkup } from 'react-dom/server';
import App from ${JSON.stringify(join(labDir, 'src/App.tsx'))};
export function render(hash: string): string {
  (globalThis as any).location = { hash };
  return renderToStaticMarkup(<App />);
}
`,
);

const { build } = await import('esbuild');
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: join(tmp, 'render.mjs'),
  logLevel: 'warning',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  // React 由 Node 从 node_modules 解析（避免把 CJS 版 react-dom 打进 ESM 包）
  packages: 'external',
  // Vite 在构建期注入；Node 里给出等价定义
  define: {
    'import.meta.env.BASE_URL': '"/"',
    'import.meta.env.DEV': 'false',
    'import.meta.env.PROD': 'true',
  },
});

const { render } = await import(pathToFileURL(join(tmp, 'render.mjs')).href);

// ---- 1) 默认（APS）----
let html = render('');
check(
  '外壳标题与副标题渲染',
  html.includes('算法实验室') && html.includes('三维实时沙盘') && html.includes('视觉模式'),
  '机架式外壳：品牌区 + 视觉模式按钮组',
);
check('模块导航含五个已就绪模块（APS / MAPF / AGV / 库位优化 / 密集立库）',
  ['APS 计划排程', 'MAPF 路径规划', 'AGV 调度', '库位优化', '密集立库'].every((n) => html.includes(n)));
check('模块导航不再有待接入模块（两个仓储模块已接入真实引擎）', (html.match(/待接入/g) ?? []).length === 0);
check('引擎未就绪时给出等待提示', html.includes('引擎尚未就绪') || html.includes('正在加载引擎产物'));
check('参数区渲染完整（种子/时间/目标/规则/迭代/修复/严格核验）',
  ['种子 seed', '求解时间（ms）', '优化目标', '搜索规则', '迭代上限', '局部修复', '严格核验'].every((t) => html.includes(t)));
check('数据目录在 manifest 尚未加载时仍展示全部内置案例',
  ['基础车间（baseline）', '设备故障（machine-breakdown）', '到货延迟（material-delay）', '无解（infeasible-no-welder）'].every((name) => html.includes(name)));
check('标准 benchmark 与 JSON 导入入口可见',
  html.includes('选择文件') && html.includes('FJSPLib / Brandimarte') && html.includes('OR-Library JSSP'));
check('结果区为空态而非假数据', html.includes('还没有结果') || html.includes('还没有排程结果'));

// ---- 2) path-planning 已就绪：渲染 MAPF 面板（引擎横幅），且不含任何假数据 ----
html = render('#path-planning');
check('切到路径规划：渲染 MAPF 面板（引擎装载状态提示）',
  html.includes('MAPF 引擎') && (html.includes('引擎装载中') || html.includes('引擎未就绪')));
check('MAPF 面板在引擎就绪前不显示任何结果/图表', !html.includes('gantt-bar') && !html.includes('mapf-canvas'));
check('MAPF 面板渲染 Visual Lab 三栏骨架（mapf-visual）', html.includes('mapf-visual') && html.includes('mapf-workspace'));

// ---- 2b) agv-dispatch 已就绪（M4）：渲染 AGV 面板（引擎横幅），不含假数据 ----
html = render('#agv-dispatch');
check('切到 AGV 调度：渲染 AGV 面板（引擎装载状态提示）',
  html.includes('AGV 引擎') && (html.includes('引擎装载中') || html.includes('引擎未就绪')));
check('AGV 面板在引擎就绪前不显示任何求解结果（空态提示除外）', !html.includes('gantt-bar') && !html.includes('当前相位') && !html.includes('动态重调度汇总'));
check('AGV 面板渲染调度实验骨架（agv-panel + 场景库）', html.includes('agv-panel') && html.includes('场景库'));

// ---- 3) 未知 hash 回退到首个 ready 模块 ----
html = render('#does-not-exist');
check('未知 hash 回退到 APS 模块', html.includes('选择一个排程场景') && html.includes('求解配置'));

// ---- 3b) 仓储优化两个模块已就绪：渲染真面板（引擎横幅 + 空态），且不渲染假数据 ----
html = render('#slotting');
check('切到库位优化：渲染面板骨架与空态', html.includes('data-visual-module="slotting"') && html.includes('求解库位方案'));
check('库位优化面板在引擎就绪前不显示结果/指标', !html.includes('metrics-grid') && html.includes('还没有结果'));
html = render('#dense-asrs');
check('切到密集立库：渲染面板骨架与空态', html.includes('data-visual-module="dense-asrs"') && html.includes('求解调度'));
check('密集立库面板在引擎就绪前不显示结果/时间线', !html.includes('metrics-grid') && html.includes('还没有结果'));

finish('✓ 渲染冒烟通过');
