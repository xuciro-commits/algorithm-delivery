/**
 * 回放时钟（M0 §7.1）：纯 TS，可注入虚拟 rAF 测试。
 * 基准步频 2 步/秒 × speed；只在步索引变化时通知（≤16 次/秒 @8×）。
 * 回放结束自动暂停（不循环）。
 */

export type Speed = 0.25 | 0.5 | 1 | 2 | 4 | 8;

export const BASE_STEPS_PER_SEC = 2;

export interface ClockListener {
  (t: number, playing: boolean): void;
}

/**
 * 帧监听器（V2 §三-3 / COMPONENT-DESIGN §3）：每一动画帧回调，携带
 * 「当前离散步 t」与「步内插值系数 frac ∈ [0,1)」。
 *
 * 红线：frac 只用于在引擎算出的相邻两步之间做视觉插值
 * （`lerp(timeline[t], timeline[t+1], frac)`），绝不越过引擎算出的步；
 * 暂停 / seek / 单步时 frac = 0（机器人精确落在该步）。
 * 3D 沙盘用它在场景内直接驱动位置（不触发 React 重渲染）。
 */
export interface FrameListener {
  (t: number, frac: number): void;
}

export class PlaybackClock {
  t = 0;
  maxT = 0;
  playing = false;
  speed: Speed = 1;
  private listener: ClockListener | null = null;
  private frameListener: FrameListener | null = null;
  private lastTs = 0;
  private acc = 0;
  private schedule: (cb: () => void) => void;

  constructor(schedule: (cb: () => void) => void = (cb) => requestAnimationFrame(cb)) {
    this.schedule = schedule;
  }

  onTick(listener: ClockListener | null): void {
    this.listener = listener;
  }

  /** 注册帧监听器（3D 沙盘步内插值专用）。 */
  onFrame(listener: FrameListener | null): void {
    this.frameListener = listener;
  }

  /** 步内插值系数（暂停 / 边界时为 0）。 */
  get frac(): number {
    if (!this.playing) return 0;
    return Math.max(0, Math.min(0.999, this.acc));
  }

  private emit(): void {
    this.listener?.(this.t, this.playing);
    this.frameListener?.(this.t, this.frac);
  }

  setRange(maxT: number, resetTo = 0): void {
    this.maxT = Math.max(0, maxT);
    this.pause();
    this.t = Math.min(resetTo, this.maxT);
    this.emit();
  }

  play(): void {
    if (this.playing || this.maxT === 0) return;
    if (this.t >= this.maxT) this.t = 0; // 重播语义
    this.playing = true;
    this.lastTs = 0;
    this.acc = 0;
    this.loop();
    this.emit();
  }

  private loop = (): void => {
    if (!this.playing) return;
    this.schedule(this.tick);
  };

  private tick = (ts?: number): void => {
    if (!this.playing) return;
    const now = ts ?? performance.now();
    if (this.lastTs === 0) this.lastTs = now;
    const dt = Math.max(0, now - this.lastTs);
    this.lastTs = now;
    this.acc += (dt / 1000) * BASE_STEPS_PER_SEC * this.speed;
    let changed = false;
    while (this.acc >= 1 && this.t < this.maxT) {
      this.acc -= 1;
      this.t += 1;
      changed = true;
    }
    if (this.t >= this.maxT) {
      this.playing = false;
      this.acc = 0;
      this.emit();
      return;
    }
    if (changed) this.emit();
    else this.frameListener?.(this.t, this.frac);
    this.loop();
  };

  pause(): void {
    this.playing = false;
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  step(delta: number): void {
    this.pause();
    this.t = Math.min(this.maxT, Math.max(0, this.t + delta));
    this.emit();
  }

  seek(t: number, keepPlaying = false): void {
    this.t = Math.min(this.maxT, Math.max(0, t));
    if (!keepPlaying) this.pause();
    else this.emit();
  }

  setSpeed(speed: Speed): void {
    this.speed = speed;
    this.emit();
  }

  dispose(): void {
    this.playing = false;
    this.listener = null;
  }
}

// ---------------------------------------------------------------------------
// 机器人 4 态判定（M0 §7.2）——由 path[] 派生，纯函数。
// ---------------------------------------------------------------------------

export type RobotPhase = 'moving' | 'waiting' | 'arrived' | 'staying';

export interface PathLike {
  path: Array<[number, number]>;
  arrival?: number | null;
}

export function phaseAt(r: PathLike, t: number): RobotPhase {
  const path = r.path ?? [];
  if (path.length === 0) return 'waiting';
  const arrival = r.arrival ?? path.length - 1;
  const cur = path[Math.min(t, path.length - 1)];
  if (t > arrival) return 'staying';
  if (t === arrival) return 'arrived';
  if (t === 0) return 'moving';
  const prev = path[Math.min(t - 1, path.length - 1)];
  return cur[0] === prev[0] && cur[1] === prev[1] ? 'waiting' : 'moving';
}

/** 等待步数（前后同格，未到 arrival 之前；不含终点驻留）。 */
export function waitSteps(r: PathLike): number {
  const path = r.path ?? [];
  const arrival = r.arrival ?? path.length - 1;
  let w = 0;
  for (let t = 1; t <= Math.min(arrival, path.length - 1); t++) {
    if (path[t][0] === path[t - 1][0] && path[t][1] === path[t - 1][1]) w += 1;
  }
  return w;
}
