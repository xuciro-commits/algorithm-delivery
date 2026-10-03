/**
 * 真机截图与 A/B 对比导出（阶段四验收工具）。
 *
 * 这些函数**直接读取页面上的 WebGL canvas**（`preserveDrawingBuffer` 已开启），
 * 因此导出的就是浏览器真实渲染结果：既不是软件光栅化模拟，也不是材质参数截图。
 * 提供两种产物：
 *   1. 单张截图（可带模式/相机标注）；
 *   2. A/B 并排对比图（同一相机、同一几何、仅切换视觉模式），用于阶段一验收。
 */

export interface CapturedShot {
  label: string;
  dataUrl: string;
  meta?: Record<string, string | number>;
}

const PAD = 18;
const HEADER = 46;
const FOOTER = 30;

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法解码截图像素'));
    image.src = dataUrl;
  });
}

export function captureCanvas(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png');
}

/** 等待 n 个动画帧（用于切换模式后让 demand 渲染真正落屏）。 */
export function nextFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    let left = count;
    const step = () => {
      left -= 1;
      if (left <= 0) resolve();
      else globalThis.requestAnimationFrame(step);
    };
    globalThis.requestAnimationFrame(step);
  });
}

export function downloadDataUrl(filename: string, dataUrl: string): void {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** 把多张截图按同一高度并排合成一张对比图（带标题与页脚标注）。 */
export async function composeSideBySide(
  shots: CapturedShot[],
  options: { title?: string; note?: string; maxWidth?: number } = {},
): Promise<string> {
  if (shots.length === 0) throw new Error('没有可合成的截图');
  const images = await Promise.all(shots.map((shot) => loadImage(shot.dataUrl)));
  const cellWidth = Math.max(...images.map((image) => image.width));
  const cellHeight = Math.max(...images.map((image) => image.height));
  const width = cellWidth * images.length + PAD * (images.length + 1);
  const height = HEADER + cellHeight + FOOTER + PAD;
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(options.maxWidth ?? width, width);
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 合成上下文');

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#0d131c');
  gradient.addColorStop(1, '#05080c');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#edf4ff';
  ctx.font = '600 20px "DM Sans", system-ui, sans-serif';
  ctx.fillText(options.title ?? 'Algorithm Lab · 视觉模式对比（同一相机 / 同一几何）', PAD, 30);

  images.forEach((image, index) => {
    const x = PAD + (cellWidth + PAD) * index;
    const y = HEADER;
    ctx.drawImage(image, x, y, image.width, image.height);
    ctx.strokeStyle = 'rgba(127,215,255,0.28)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, image.width, image.height);

    const label = shots[index].label;
    ctx.font = '600 15px "DM Sans", system-ui, sans-serif';
    const metrics = ctx.measureText(label);
    ctx.fillStyle = 'rgba(6,11,22,0.78)';
    ctx.fillRect(x + 12, y + 12, metrics.width + 20, 26);
    ctx.fillStyle = '#7fd7ff';
    ctx.fillText(label, x + 22, y + 30);

    const meta = shots[index].meta;
    if (meta) {
      const text = Object.entries(meta)
        .map(([key, value]) => `${key}=${value}`)
        .join('  ');
      ctx.fillStyle = '#8296b0';
      ctx.font = '400 13px "DM Mono", ui-monospace, monospace';
      ctx.fillText(text, x + 12, y + image.height + 20);
    }
  });

  ctx.fillStyle = '#5d6d84';
  ctx.font = '400 13px "DM Sans", system-ui, sans-serif';
  ctx.fillText(
    options.note ??
      '由浏览器真实 WebGL 渲染直接导出（renderer 信息可在页面性能面板核对）；非软件光栅化模拟。',
    PAD,
    height - 12,
  );

  return canvas.toDataURL('image/png');
}

export function timestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
