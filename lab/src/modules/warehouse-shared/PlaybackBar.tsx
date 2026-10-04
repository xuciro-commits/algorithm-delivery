/** 回放条（两个新模块共用）：播放/暂停、步进、倍速、时间读数和进度。 */

import type { PlaybackState } from './usePlayback';
import { PLAYBACK_SPEEDS } from './usePlayback';

export interface PlaybackBarProps {
  clock: PlaybackState;
  boundaries?: Array<{ t: number; label: string }>;
  disabled?: boolean;
  extra?: React.ReactNode;
}

function fmtTime(t: number): string {
  if (!Number.isFinite(t)) return '—';
  if (t >= 3600) {
    const hours = Math.floor(t / 3600);
    const minutes = Math.floor((t % 3600) / 60);
    return `${hours}h${String(minutes).padStart(2, '0')}m`;
  }
  if (t >= 60) {
    const minutes = Math.floor(t / 60);
    const seconds = Math.floor(t % 60);
    return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  }
  return `${t.toFixed(1)}s`;
}

export function PlaybackBar({ clock, boundaries = [], disabled, extra }: PlaybackBarProps) {
  const list = boundaries.filter((item) => Number.isFinite(item.t) && item.t > 0).slice(0, 200);
  return (
    <div className="mapf-play">
      <button type="button" className="btn tiny" disabled={disabled} onClick={() => clock.seek(0)} title="回到开始">
        ⏮
      </button>
      <button type="button" className="btn tiny" disabled={disabled} onClick={() => clock.step(-1)} title="上一个节点（事件/冲突时刻）">
        ◀
      </button>
      <button type="button" className="btn tiny primary" disabled={disabled} onClick={() => clock.toggle()} title="播放 / 暂停">
        {clock.playing ? '⏸' : '▶'}
      </button>
      <button type="button" className="btn tiny" disabled={disabled} onClick={() => clock.step(1)} title="下一个节点（事件/冲突时刻）">
        ▶
      </button>
      <select
        value={clock.speed}
        disabled={disabled}
        onChange={(event) => clock.setSpeed(Number(event.target.value) as (typeof PLAYBACK_SPEEDS)[number])}
        aria-label="播放倍速"
        className="input tiny"
      >
        {PLAYBACK_SPEEDS.map((speed) => (
          <option key={speed} value={speed}>
            {speed}×
          </option>
        ))}
      </select>
      <span className="tabular-nums mapf-t-readout">
        {fmtTime(clock.t)} / {fmtTime(clock.horizon)}
      </span>
      <input
        type="range"
        className="scrub"
        min={0}
        max={Math.max(clock.horizon, 1e-6)}
        step={Math.max(clock.horizon / 2000, 1e-6)}
        value={clock.t}
        disabled={disabled}
        onChange={(event) => clock.seek(Number(event.target.value))}
        aria-label="时间轴"
      />
      {list.length > 0 && (
        <span className="muted small">
          {list.length} 个节点：
          {list.slice(0, 3).map((item) => (
            <button
              key={`${item.t}-${item.label}`}
              type="button"
              className="link-btn small"
              disabled={disabled}
              onClick={() => clock.seekToEvent(item.t)}
              title={item.label}
            >
              {fmtTime(item.t)}
            </button>
          ))}
        </span>
      )}
      {extra}
    </div>
  );
}
