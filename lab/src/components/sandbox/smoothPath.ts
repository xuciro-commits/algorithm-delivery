/**
 * 路径平滑（纯函数，Node 可测）：在栅格路径拐点插入圆角过渡。
 * 只做视觉圆角，不改变路径的格序语义（首末点与经过的格心保持不变）。
 */

export type Pt3 = [number, number, number];

/**
 * @param pts 格心坐标序列（已含悬浮高度 y）
 * @param radius 圆角半径（世界单位）；0 = 原样返回
 * @param seg 每个圆角的采样段数
 */
export function smoothPath(pts: Pt3[], radius = 0.32, seg = 5): Pt3[] {
  if (pts.length < 3 || radius <= 0) return pts;
  const out: Pt3[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const d1 = dist(cur, prev);
    const d2 = dist(cur, next);
    if (d1 === 0 || d2 === 0) continue;
    const r = Math.min(radius, d1 / 2, d2 / 2);
    const pA = lerp3(cur, prev, r / d1);
    const pB = lerp3(cur, next, r / d2);
    out.push(pA);
    for (let s = 1; s < seg; s++) {
      const t = s / seg;
      out.push(quadBezier(pA, cur, pB, t));
    }
    out.push(pB);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function dist(a: Pt3, b: Pt3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function lerp3(a: Pt3, b: Pt3, t: number): Pt3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function quadBezier(p0: Pt3, p1: Pt3, p2: Pt3, t: number): Pt3 {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    u * u * p0[2] + 2 * u * t * p1[2] + t * t * p2[2],
  ];
}

/** 栅格路径 → 格心世界坐标（XZ 平面 + 悬浮高度 y）。 */
export function cellsToWorld(cells: Array<[number, number]>, y: number): Pt3[] {
  return cells.map(([cx, cy]) => [cx + 0.5, y, cy + 0.5] as Pt3);
}

/**
 * 离散步插值（红线：只允许在引擎算出的相邻两步之间插值）。
 * @returns 位置与朝向角（atan2 弧度，XZ 平面）
 */
export function stepInterp(
  cells: Array<[number, number]>,
  tFloat: number,
): { x: number; z: number; heading: number } | null {
  if (cells.length === 0) return null;
  const clamp = Math.max(0, Math.min(cells.length - 1, tFloat));
  const i = Math.floor(clamp);
  const frac = clamp - i;
  const a = cells[i];
  const b = cells[Math.min(cells.length - 1, i + 1)];
  const x = a[0] + (b[0] - a[0]) * frac + 0.5;
  const z = a[1] + (b[1] - a[1]) * frac + 0.5;
  const heading = b[0] !== a[0] || b[1] !== a[1] ? Math.atan2(b[1] - a[1], b[0] - a[0]) : 0;
  return { x, z, heading };
}
