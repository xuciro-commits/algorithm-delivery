import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * GitHub Pages 项目站点部署在子路径下（`https://<owner>.github.io/<repo>/`），
 * 因此**所有**静态资源与 wasm/worker 都必须以 `import.meta.env.BASE_URL` 为前缀解析。
 *
 * `LAB_BASE` 允许本地/其他部署形态覆盖：
 *   LAB_BASE=/ npm run build          → 部署在域名根目录
 *   LAB_BASE=/preview/ npm run build  → 任意子路径
 * 未设置时默认 /algorithm-delivery/（本仓库的 Pages 项目路径）。
 */
const base = process.env.LAB_BASE ?? '/algorithm-delivery/';

export default defineConfig({
  base,
  // Tailwind v4：styles.css 顶部 `@import 'tailwindcss'` + `@theme inline`
  // 把 V2 设计令牌暴露为工具类（bg-surface / text-muted / border-border …）。
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    // 子路径部署下不要生成绝对路径；base 已处理前缀
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    host: true,
    port: Number(process.env.PORT ?? 5173),
    // 沙箱/预览环境：允许代理域名访问
    allowedHosts: true,
  },
  preview: {
    host: true,
    port: Number(process.env.PORT ?? 4173),
    allowedHosts: true,
  },
});
