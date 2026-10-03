/**
 * 按需渲染的“补帧器”。
 *
 * 场景统一走 `frameloop="demand"`（静止零 GPU 负载，性能红线要求）。但材质替换、
 * 部件隔离、叠加层更新都是**命令式**发生在 effect 里，R3F 不会为它们自动排帧。
 * 这里在关键输入变化后主动 invalidate，并连补若干帧，保证：
 *   - 切换视觉模式 / 视图 / 相机预设后画面立刻更新；
 *   - 切换英雄设备后，模型解码与材质应用完成后画面不会停在空白帧。
 *
 * 注意：`watch` 是**序列化后的依赖串**，不是 props 值本身——避免依赖数组身份
 * 变化导致的重复补帧。
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';

export interface RenderOnChangeProps {
  /** 序列化后的依赖串（如 `${mode}|${preset}|${count}`）。 */
  watch: string;
  /** 变化后连续补的帧数（默认 3，覆盖材质应用与贴图解码的时序）。 */
  frames?: number;
}

export function RenderOnChange({ watch, frames = 3 }: RenderOnChangeProps) {
  const invalidate = useThree((state) => state.invalidate);
  const pending = useRef(frames);

  useEffect(() => {
    pending.current = frames;
    invalidate();
  }, [watch, frames, invalidate]);

  useFrame(() => {
    if (pending.current > 0) {
      pending.current -= 1;
      invalidate();
    }
  });

  return null;
}
