#!/usr/bin/env node
/**
 * MAPF 回放测试（M0 §14.2）：PlaybackClock（虚拟帧注入）——步进/速度/边界/
 * 结束自动暂停；机器人 4 态判定表（含 arrival=0、驻留、等待、冻结前缀）。
 */

import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const labDir = resolve(here, '..');
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const tmp = join(labDir, 'node_modules', '.lab-mapf-playback');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
await build({
  entryPoints: [join(labDir, 'src/modules/mapf/playback/clock.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: join(tmp, 'clock.mjs'),
  logLevel: 'warning',
});
const { PlaybackClock, phaseAt, waitSteps } = await import(pathToFileURL(join(tmp, 'clock.mjs')).href);

// —— 1）PlaybackClock：手动帧注入 ——
{
  const ticks = [];
  let now = 0;
  const frames = [];
  const clock = new PlaybackClock((cb) => frames.push(cb));
  clock.onTick((t, playing) => ticks.push([t, playing]));
  clock.setRange(10, 0);
  check('setRange 归零并暂停', clock.t === 0 && clock.playing === false);
  clock.setSpeed(1); // 2 步/秒
  clock.play();
  check('play 后 playing=true', clock.playing === true);
  // 驱动 1 秒 = 2 步（500ms/步）
  const drain = (totalMs, stepMs = 50) => {
    for (let acc = 0; acc < totalMs; acc += stepMs) {
      now += stepMs;
      const fs = frames.splice(0);
      for (const f of fs) f(now);
    }
  };
  // 注：play → 第一帧之间不计时（首帧 dt=0），断言按不变式而非精确帧数
  drain(2000);
  check('×1× 播放推进（≥2 步）', clock.t >= 2, `t=${clock.t}`);
  drain(10_000);
  check('到达上限 10 自动暂停', clock.t === 10 && clock.playing === false, `t=${clock.t} playing=${clock.playing}`);
  check('到达末尾自动暂停', clock.playing === false);
  clock.play();
  check('末尾再 play = 从头重播', clock.t === 0 && clock.playing === true);
  clock.pause();
  clock.step(3);
  check('单步前进', clock.t === 3);
  clock.step(-1);
  check('单步后退', clock.t === 2);
  clock.seek(7);
  check('seek', clock.t === 7 && clock.playing === false);
  // 8× 速度：1 秒 16 步 —— 通知频率仍受步上限约束
  ticks.length = 0;
  clock.seek(0);
  clock.setSpeed(8);
  clock.play();
  drain(600);
  check('8× 快于 1×（推进 ≥4 步）', clock.t >= 4, `t=${clock.t}`);
}

// —— 2）机器人 4 态判定表 ——
{
  const path = [[0, 0], [1, 0], [1, 0], [2, 0], [2, 0], [2, 0]];
  const arrival = 3;
  check('t=1 移动', phaseAt({ path, arrival }, 1) === 'moving');
  check('t=2 等待（前后同格）', phaseAt({ path, arrival }, 2) === 'waiting');
  check('t=3 到达（一次性）', phaseAt({ path, arrival }, 3) === 'arrived');
  check('t=5 驻留目标', phaseAt({ path, arrival }, 5) === 'staying');
  check('arrival=0 时 t=0 即到达', phaseAt({ path: [[1, 1], [1, 1]], arrival: 0 }, 0) === 'arrived');
  check('无 arrival 时末步=到达', phaseAt({ path: [[0, 0], [1, 0]] }, 1) === 'arrived');
  check('等待步数 = 1（t=2 一步）', waitSteps({ path, arrival }) === 1);
  check('空路径不崩', phaseAt({ path: [] }, 0) === 'waiting');
}

if (failures.length > 0) {
  console.error(`\n汇总: ${failures.length} 项失败\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\n✓ MAPF 回放测试全部通过');
