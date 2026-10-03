/**
 * 分层绘制调度器（M0 设计 §4.1 / §11.1）：
 *
 *  L0 基底（离屏缓存）—— 背景网格/障碍/静态地图文本，仅当地图/视口/主题变化时重绘；
 *  L1 —— 语义图层 A（路径/轨迹类，宿主每步绘制）；
 *  L2 —— 语义图层 B（实体当前位置类）；
 *  L3 —— 交互层（悬停/编辑预览/脉冲，指针事件节流）。
 *
 * MapRenderer 不知道任何算法语义：宿主注册「基底绘制器」与「动态绘制器」，
 * 基底只在失效时重画并缓存为位块；动态层按需整层重绘（culling 由宿主负责）。
 * 非 React 类：React 只在语义变化时调用 invalidate/invalidateBase。
 */

import { GRID_COLORS, MAX_DPR } from './types';
import type { GridDims, PixelSize, Viewport } from './types';
import { fitViewport, lodLevel } from './viewport';

export type BasePainter = (ctx: CanvasRenderingContext2D, vp: Viewport, size: PixelSize) => void;
export type LayerPainter = (ctx: CanvasRenderingContext2D, vp: Viewport, size: PixelSize) => void;

export class MapRenderer {
  private readonly layers: HTMLCanvasElement[] = [];
  private readonly ctxs: CanvasRenderingContext2D[] = [];
  private base: HTMLCanvasElement | null = null;
  private baseCtx: CanvasRenderingContext2D | null = null;
  private baseInvalid = true;
  private lastViewport: Viewport | null = null;
  private basePainter: BasePainter | null = null;
  private layerPainters: Array<LayerPainter | null> = [null, null, null];
  private rafId = 0;
  private disposed = false;

  /** 把 4 块叠层 canvas 挂进容器（同尺寸 position:absolute 由 CSS 保证）。 */
  attach(container: HTMLElement): void {
    this.dispose();
    this.disposed = false;
    for (let i = 0; i < 4; i++) {
      const c = document.createElement('canvas');
      c.className = `grid-canvas layer-${i}`;
      container.appendChild(c);
      this.layers.push(c);
      this.ctxs.push(c.getContext('2d')!);
    }
    this.base = document.createElement('canvas');
    this.baseCtx = this.base.getContext('2d'); // null-safe：离屏画布总是可用
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    for (const c of this.layers) c.remove();
    this.layers.length = 0;
    this.ctxs.length = 0;
    this.base = null;
    this.baseCtx = null;
    this.baseInvalid = true;
    this.lastViewport = null;
  }

  setBasePainter(p: BasePainter | null): void {
    this.basePainter = p;
    this.baseInvalid = true;
  }

  /** layer: 1=L1 轨迹，2=L2 实体，3=L3 交互。 */
  setLayerPainter(layer: 1 | 2 | 3, p: LayerPainter | null): void {
    this.layerPainters[layer - 1] = p;
  }

  /** 地图内容变化 → 基底缓存失效。 */
  invalidateBase(): void {
    this.baseInvalid = true;
  }

  /** 动态层（L1/L2/L3）需要重绘；合并到下一帧。 */
  invalidate(): void {
    if (this.disposed || this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.paint();
    });
  }

  /** 立即同步重绘（测试/截图路径）。 */
  paintNow(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.paint();
  }

  resize(size: PixelSize): void {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, MAX_DPR);
    for (const c of this.layers) {
      c.width = Math.max(1, Math.round(size.w * dpr));
      c.height = Math.max(1, Math.round(size.h * dpr));
      c.style.width = `${size.w}px`;
      c.style.height = `${size.h}px`;
    }
    if (this.base) {
      this.base.width = Math.max(1, Math.round(size.w * dpr));
      this.base.height = Math.max(1, Math.round(size.h * dpr));
    }
    this.baseInvalid = true;
    this.invalidate();
  }

  private paint(): void {
    if (this.disposed || this.layers.length < 4) return;
    const c0 = this.layers[0];
    const size = { w: Number(c0.style.width.replace('px', '')) || 1, h: Number(c0.style.height.replace('px', '')) || 1 };
    const dpr = c0.width / Math.max(1, size.w);
    const vp = this.lastViewport;
    if (!vp) return;

    // L0：视口/主题/地图变化 → 重建缓存
    if (this.baseInvalid && this.base && this.baseCtx && this.basePainter) {
      const b: CanvasRenderingContext2D = this.baseCtx;
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.clearRect(0, 0, this.base.width, this.base.height);
      b.setTransform(dpr, 0, 0, dpr, 0, 0);
      b.fillStyle = GRID_COLORS.background;
      b.fillRect(0, 0, size.w, size.h);
      this.basePainter(b, vp, size);
      this.baseInvalid = false;
    }
    const l0 = this.ctxs[0];
    if (l0) {
      l0.setTransform(1, 0, 0, 1, 0, 0);
      l0.clearRect(0, 0, this.layers[0].width, this.layers[0].height);
      if (this.base) l0.drawImage(this.base, 0, 0);
    }
    // L1–L3
    for (let i = 1; i < 4; i++) {
      const ctx = this.ctxs[i];
      if (!ctx) continue;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.layers[i].width, this.layers[i].height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const p = this.layerPainters[i - 1];
      if (p) p(ctx, vp, size);
    }
  }

  /** 视口更新（每帧外部传入；变化时基底失效 + 全层重绘）。 */
  setViewport(vp: Viewport, size: PixelSize): void {
    const changed =
      !this.lastViewport ||
      this.lastViewport.cellPx !== vp.cellPx ||
      Math.abs(this.lastViewport.tx - vp.tx) > 0.01 ||
      Math.abs(this.lastViewport.ty - vp.ty) > 0.01;
    const sized = this.layers[0] ? this.layers[0].style.width !== `${size.w}px` : true;
    if (sized) this.resize(size);
    this.lastViewport = vp;
    if (changed) {
      this.baseInvalid = true;
      this.invalidate();
    }
  }

  get viewport(): Viewport | null {
    return this.lastViewport;
  }
}

/** 默认基底绘制器：背景 + 网格线（LOD）+ 障碍格（宿主给的 blocked 谓词）。 */
export function gridBasePainter(
  dims: GridDims,
  isBlocked: (x: number, y: number) => boolean,
  opts: { showGrid?: (cellPx: number) => boolean; gridStep?: (cellPx: number) => number } = {},
): BasePainter {
  return (ctx, vp, _size) => {
    const lod = lodLevel(vp.cellPx);
    const showGrid = opts.showGrid ? opts.showGrid(vp.cellPx) : lod <= 2;
    const step = opts.gridStep ? opts.gridStep(vp.cellPx) : lod === 2 ? 2 : 1;
    // 网格线
    if (showGrid && vp.cellPx >= 3) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = GRID_COLORS.gridLine;
      ctx.beginPath();
      for (let x = 0; x <= dims.width; x += step) {
        const sx = Math.round(vp.tx + x * vp.cellPx) + 0.5;
        ctx.moveTo(sx, vp.ty);
        ctx.lineTo(sx, vp.ty + dims.height * vp.cellPx);
      }
      for (let y = 0; y <= dims.height; y += step) {
        const sy = Math.round(vp.ty + y * vp.cellPx) + 0.5;
        ctx.moveTo(vp.tx, sy);
        ctx.lineTo(vp.tx + dims.width * vp.cellPx, sy);
      }
      ctx.stroke();
    }
    // 障碍
    const pad = vp.cellPx >= 8 ? 0.5 : 0;
    for (let y = 0; y < dims.height; y++) {
      for (let x = 0; x < dims.width; x++) {
        if (!isBlocked(x, y)) continue;
        ctx.fillStyle = GRID_COLORS.wall;
        ctx.fillRect(vp.tx + x * vp.cellPx, vp.ty + y * vp.cellPx, vp.cellPx + pad, vp.cellPx + pad);
      }
    }
  };
}

export { fitViewport };
