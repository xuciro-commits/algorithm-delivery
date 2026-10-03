/**
 * 算法结果的空间可视化语言（需求 §六）。
 *
 * 统一语汇（三个算法共用，颜色语义来自 tokens.ts / GLOW）：
 *   半透明空间节点  `<ArtNode>`     —— 取送点、工作站、事件位置；
 *   纤细发光路径    `<ArtRoute>`    —— MAPF 路径 / AGV 行驶轨迹（已执行 / 计划中 / 冲突）；
 *   目标位置投影    `<ArtProjection>` —— 目标格在设备上的柔和投影（不是图钉）；
 *   设备状态光效    `<ArtStatusLight>` —— 运行 / 等待 / 阻塞 / 完成；
 *   任务载荷        `<ArtPayload>`  —— 只在引擎报告“已装载”时出现。
 *
 * 红线（与既有沙盘一致，也对应需求“装饰不能伪装成数据”）：
 *   - 本文件**不产生任何坐标**：所有点、路径、时刻都由调用方从引擎输出投影后传入；
 *   - 动画只做与真实时间步绑定的 dashOffset 光流，不虚构连续运动；
 *   - 发光 = 双层细线（核心 + 光晕）+ 自发光材质，不使用任何后处理泛光。
 */

import { Line } from '@react-three/drei';
import { useMemo } from 'react';
import { GLOW } from './tokens';

export type Pt3 = [number, number, number];

export interface ArtRouteProps {
  points: Pt3[];
  color: string;
  /** 已执行到的点索引（含）；null = 全部未执行。 */
  executedTo?: number | null;
  selected?: boolean;
  /** 光流偏移（由回放 tick 驱动，映射真实离散时间步）。 */
  flowOffset?: number;
  /** 计划中（未执行）路径用虚线。 */
  planned?: boolean;
  /** 冲突 / 违规路段：珊瑚色实心短段。 */
  conflict?: boolean;
  /** 悬浮高度（默认贴地 0.09）。 */
  y?: number;
}

/**
 * 纤细发光路径：核心线 + 外晕线（宽而极淡），可选虚线 + 光流。
 * 与既有 `GlowPath` 同一视觉语言，但用于**上传模型构成的三维实验室**，
 * 支持“冲突路段”“悬浮高度”两个额外语义。
 */
export function ArtRoute({
  points,
  color,
  executedTo = null,
  selected = false,
  flowOffset = 0,
  planned = false,
  conflict = false,
  y = 0.09,
}: ArtRouteProps) {
  const lifted = useMemo<Pt3[]>(() => points.map((p) => [p[0], p[1] + y, p[2]] as Pt3), [points, y]);
  const coreW = selected ? 2.6 : 1.7;
  const haloW = selected ? 9.5 : 7;
  const tone = conflict ? GLOW.alert : color;

  if (lifted.length < 2) return null;
  const cut = executedTo == null ? 1 : Math.max(2, Math.min(lifted.length, executedTo + 1));
  const executed = executedTo == null ? [] : lifted.slice(0, cut);
  const rest = executedTo == null ? lifted : lifted.slice(Math.max(0, cut - 1));

  return (
    <group>
      {executed.length >= 2 && (
        <>
          <Line points={executed} color={tone} lineWidth={haloW} transparent opacity={0.16} depthWrite={false} />
          <Line points={executed} color={tone} lineWidth={coreW} transparent opacity={selected ? 1 : 0.92} depthWrite={false} />
        </>
      )}
      {rest.length >= 2 && (
        <>
          <Line
            points={rest}
            color={tone}
            lineWidth={haloW * 0.75}
            transparent
            opacity={planned ? 0.12 : 0.09}
            dashed
            dashSize={0.34}
            gapSize={0.26}
            dashOffset={-flowOffset}
            depthWrite={false}
          />
          <Line
            points={rest}
            color={tone}
            lineWidth={coreW * 0.85}
            transparent
            opacity={selected ? 0.7 : 0.46}
            dashed
            dashSize={0.34}
            gapSize={0.26}
            dashOffset={-flowOffset}
            depthWrite={false}
          />
        </>
      )}
    </group>
  );
}

export interface ArtNodeProps {
  position: Pt3;
  color?: string;
  /** 半径（米）。 */
  radius?: number;
  /** 选中：加粗 + 附加内环。 */
  selected?: boolean;
  /** 完成态：实心内核 + 细环。 */
  filled?: boolean;
  /** 悬浮高度。 */
  y?: number;
  /** 携带的文本标记数量（例如该工作站排队的任务数）——不绘制文字，只用刻度环。 */
  ticks?: number;
  /** 在制工序完成度 0–1：以真实时间轴推导的进度弧（不是循环动画）。 */
  progress?: number;
}

/** 半透明空间节点：细环 + 内核光点 + 柔和外晕（绝不是传统图钉）。 */
export function ArtNode({
  position,
  color = GLOW.active,
  radius = 0.34,
  selected = false,
  filled = true,
  y = 0.11,
  ticks = 0,
  progress,
}: ArtNodeProps) {
  const [x, , z] = position;
  return (
    <group position={[x, y, z]}>
      {/* 外晕：极低透明的加法光晕 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[radius * 1.25, radius * 1.85, 40]} />
        <meshBasicMaterial color={color} transparent opacity={0.16} depthWrite={false} blending={2} />
      </mesh>
      {/* 细环 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
        <ringGeometry args={[radius * 0.72, radius * 0.86, 40]} />
        <meshBasicMaterial color={color} transparent opacity={selected ? 1 : 0.78} depthWrite={false} />
      </mesh>
      {/* 内核光点 */}
      {filled && (
        <mesh position={[0, 0.01, 0]}>
          <sphereGeometry args={[radius * 0.3, 16, 12]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2.1} roughness={0.3} metalness={0.1} />
        </mesh>
      )}
      {/* 在制工序进度弧：角度由引擎的起止时刻推导（无数据则不画） */}
      {typeof progress === 'number' && progress > 0.01 && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]}>
          <ringGeometry args={[radius * 1.02, radius * 1.12, 56, 1, -Math.PI / 2, Math.min(1, progress) * Math.PI * 2]} />
          <meshBasicMaterial color={GLOW.active} transparent opacity={0.92} depthWrite={false} side={2} />
        </mesh>
      )}
      {/* 计数刻度环：任务数 / 容量占用（真实数量，不是装饰） */}
      {ticks > 0 &&
        Array.from({ length: Math.min(ticks, 12) }).map((_, i) => {
          const angle = (i / Math.min(ticks, 12)) * Math.PI * 2;
          return (
            <mesh
              key={`tick-${i}`}
              position={[Math.cos(angle) * radius * 1.05, 0.004, Math.sin(angle) * radius * 1.05]}
              rotation={[-Math.PI / 2, 0, 0]}
            >
              <ringGeometry args={[radius * 0.09, radius * 0.16, 12]} />
              <meshBasicMaterial color={color} transparent opacity={0.85} depthWrite={false} />
            </mesh>
          );
        })}
    </group>
  );
}

export interface ArtProjectionProps {
  position: Pt3;
  color?: string;
  /** 投射半径（米）：按被占用资源尺寸给出，而不是固定值。 */
  radius?: number;
  y?: number;
}

/** 目标位置投影：柔和的地面光斑（比节点更大更淡，表示“这是目标区域”）。 */
export function ArtProjection({ position, color = GLOW.planned, radius = 0.9, y = 0.035 }: ArtProjectionProps) {
  const [x, , z] = position;
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x, y, z]} name="art-projection">
      <circleGeometry args={[radius, 40]} />
      <meshBasicMaterial color={color} transparent opacity={0.12} depthWrite={false} />
    </mesh>
  );
}

export type StatusTone = 'running' | 'idle' | 'blocked' | 'done';

export interface ArtStatusLightProps {
  position: Pt3;
  tone: StatusTone;
  /** 高度（贴在设备顶部）。 */
  size?: number;
}

const STATUS_COLOR: Record<StatusTone, string> = {
  running: GLOW.active,
  idle: GLOW.planned,
  blocked: GLOW.alert,
  done: GLOW.done,
};

/** 设备状态光效：竖直细柱 + 底部光斑（状态来自引擎，不是装饰灯）。 */
export function ArtStatusLight({ position, tone, size = 0.07 }: ArtStatusLightProps) {
  const [x, y, z] = position;
  const color = STATUS_COLOR[tone];
  const height = tone === 'running' ? 0.42 : 0.26;
  return (
    <group position={[x, y, z]} name="art-status-light">
      <mesh position={[0, height / 2, 0]}>
        <cylinderGeometry args={[size, size, height, 10]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={tone === 'blocked' ? 2.6 : 1.9} roughness={0.3} metalness={0.1} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <circleGeometry args={[size * 3.4, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0.22} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** 任务载荷：仅在引擎报告“已装载”时出现（AGV 载货 / 工件在制）。 */
export function ArtPayload({ position, color = GLOW.task, size = 0.34 }: { position: Pt3; color?: string; size?: number }) {
  return (
    <mesh position={position} name="art-payload">
      <boxGeometry args={[size, size * 0.7, size * 0.9]} />
      <meshStandardMaterial color="#8c8577" emissive={color} emissiveIntensity={0.16} roughness={0.85} metalness={0.05} />
    </mesh>
  );
}

/** 事件标记：动态重调度 / 冲突事件位置（矮柱 + 扩散环）。 */
export function ArtEventMark({ position, color = GLOW.event, radius = 0.5 }: { position: Pt3; color?: string; radius?: number }) {
  const [x, , z] = position;
  return (
    <group position={[x, 0.05, z]} name="art-event-mark">
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[radius, radius * 1.1, 36]} />
        <meshBasicMaterial color={color} transparent opacity={0.55} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.24, 0]}>
        <cylinderGeometry args={[0.018, 0.018, 0.48, 8]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2.2} roughness={0.3} metalness={0.1} />
      </mesh>
    </group>
  );
}
