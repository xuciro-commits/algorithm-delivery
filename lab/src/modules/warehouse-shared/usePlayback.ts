/**
 * 时间轴回放（时间单位：秒）。
 *
 * 与 MAPF 的 `PlaybackClock` 的分工：
 *   * MAPF 的回放按**离散步索引**推进（路径规划的解是离散序列）；
 *   * 仓储调度的解是**连续时间**的步骤（每步有 start_s/end_s 与起止坐标），
 *     因此这里的时钟以秒为单位推进，按 speed 倍速前进，并在 [0, horizon] 内夹紧。
 *
 * 红线：`t` 只用来在引擎给出的相邻步骤之间做线性插值（`poseAt`），
 * 不越过步骤端点、不猜测停机时间之外的动作。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export const PLAYBACK_SPEEDS = [1, 2, 4, 8] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/** 每秒推进的"引擎秒"数：基准 1× 时按真实时间 1:1 播放，便于看清动作顺序。 */
const BASE_RATE = 1;

export interface PlaybackState {
  t: number;
  playing: boolean;
  speed: PlaybackSpeed;
  horizon: number;
  progress: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number) => void;
  step: (direction: 1 | -1) => void;
  setSpeed: (speed: PlaybackSpeed) => void;
  /** 跳到某个离散时刻（例如某条冲突/事件的时间）。 */
  seekToEvent: (t: number) => void;
}

export function usePlayback(horizon: number, boundaries: number[] = []): PlaybackState {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef(0);
  const tRef = useRef(0);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    if (horizon <= 0) {
      setPlaying(false);
      setT(0);
    } else if (t > horizon) {
      setT(horizon);
    }
  }, [horizon, t]);

  useEffect(() => {
    if (!playing) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    lastRef.current = performance.now();
    const tick = (now: number) => {
      const dt = (now - lastRef.current) / 1000;
      lastRef.current = now;
      const next = tRef.current + dt * speed * BASE_RATE;
      if (next >= horizon) {
        tRef.current = horizon;
        setT(horizon);
        setPlaying(false);
        return;
      }
      tRef.current = next;
      setT(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, speed, horizon]);

  const clamp = useCallback((value: number) => Math.max(0, Math.min(horizon, value)), [horizon]);

  const sorted = useMemo(() => boundaries.slice().sort((a, b) => a - b), [boundaries]);

  const step = useCallback(
    (direction: 1 | -1) => {
      setPlaying(false);
      if (sorted.length === 0) {
        setT((prev) => clamp(prev + direction * Math.max(1, horizon / 200)));
        return;
      }
      setT((prev) => {
        if (direction > 0) {
          const next = sorted.find((value) => value > prev + 1e-6);
          return next == null ? horizon : clamp(next);
        }
        const prevBoundary = [...sorted].reverse().find((value) => value < prev - 1e-6);
        return prevBoundary == null ? 0 : clamp(prevBoundary);
      });
    },
    [clamp, horizon, sorted],
  );

  return {
    t,
    playing,
    speed,
    horizon,
    progress: horizon > 0 ? t / horizon : 0,
    play: () => setPlaying(true),
    pause: () => setPlaying(false),
    toggle: () => setPlaying((value) => !value),
    seek: (value: number) => {
      setPlaying(false);
      setT(clamp(value));
    },
    step,
    setSpeed,
    seekToEvent: (value: number) => {
      setPlaying(false);
      setT(clamp(value));
    },
  };
}
