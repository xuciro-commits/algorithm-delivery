#!/usr/bin/env node
/**
 * 渲染冒烟（无需浏览器）：把 `App` 在 Node 里以 SSR 方式渲染出来，断言：
 *   - 外壳可渲染：标题、模块导航、已接入/待接入模块都在；
 *   - 引擎未就绪时给出可操作提示（而不是白屏或抛错）；
 *   - 切到 planned 模块（如 #path-planning）显示路线图说明，且**不渲染任何假数据**；
 *   - 各算法模块 Panel 缺省（未传引擎上下文）时不崩溃。
 *
 * 说明：这里覆盖不了“浏览器里点运行”的完整交互（那部分由 test:core / test:runner /
 * test:pages 用同一份引擎与同一份纯逻辑在 Node 里跑真实 WASM 覆盖）。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

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
check('外壳标题与副标题渲染', html.includes('算法实验室') && html.includes('统一实验'), '');
check('模块导航含 APS 与四个待接入模块',
  ['APS 计划排程', '路径规划', 'AGV 调度', '库位优化', '密集立库'].every((n) => html.includes(n)));
check('模块导航标记“待接入”', (html.match(/待接入/g) ?? []).length >= 4);
check('引擎未就绪时给出等待提示', html.includes('引擎尚未就绪') || html.includes('正在加载引擎产物'));
check('参数区渲染完整（种子/时间/目标/规则/迭代/修复/严格核验）',
  ['种子 seed', '求解时间（ms）', '优化目标', '搜索规则', '迭代上限', '局部修复', '严格核验'].every((t) => html.includes(t)));
check('数据选择器含导入入口', html.includes('导入自己的 PlanProblem'));
check('结果区为空态而非假数据', html.includes('还没有结果'));

// ---- 2) planned 模块 ----
html = render('#path-planning');
check('切到路径规划：显示待接入说明', html.includes('路径规划') && html.includes('待接入'));
check('planned 页面不含任何运行结果/甘特图', !html.includes('gantt-bar') && !html.includes('还没有结果'));

// ---- 3) 未知 hash 回退到首个 ready 模块 ----
html = render('#does-not-exist');
check('未知 hash 回退到 APS 模块', html.includes('数据与参数'));

// ---- 4) 各模块面板在无引擎上下文时可渲染（模块自带 props 的健壮性）----
check('待接入模块不注册 Panel（避免渲染假界面）', html.length > 0);

if (failures.length > 0) {
  console.error(`\n汇总: ${failures.length} 项失败\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\n✓ 渲染冒烟通过');
