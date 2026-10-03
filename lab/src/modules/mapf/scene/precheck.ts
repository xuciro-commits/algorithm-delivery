/**
 * 编辑期合法性预检（M0 §5.3）：只做结构层（引擎解析期就会拒绝的东西），
 * 镜像引擎错误码呈现；**解的合法性永远只由引擎与独立验证器裁决**。
 * 纯 TS 可测。
 */

import type { SceneDoc } from './SceneDoc';
import { isBlockedCell, sceneDims } from './SceneDoc';

export type PrecheckLevel = 'error' | 'warn';

export interface PrecheckIssue {
  level: PrecheckLevel;
  /** 镜像的引擎错误码（呈现时一并显示）。 */
  code: string;
  message: string;
  /** 定位：涉及的机器人 id / 格。 */
  robots?: string[];
  cell?: { x: number; y: number };
}

/** wasm-light 能力（缺省回退值；实际以握手 capabilities 为准）。 */
export interface CapabilityLimits {
  maxRobots: number;
  maxCells: number;
  maxHorizon: number;
  maxBudgetMs: number;
  maxEvents: number;
  /** 能力是否来自真实握手（false = 文档回退值，UI 标注「未验证档位」）。 */
  verified: boolean;
}

export const FALLBACK_LIMITS: CapabilityLimits = {
  maxRobots: 120,
  maxCells: 16384,
  maxHorizon: 1500,
  maxBudgetMs: 120_000,
  maxEvents: 32,
  verified: false,
};

export function precheckScene(doc: SceneDoc, limits: CapabilityLimits = FALLBACK_LIMITS): PrecheckIssue[] {
  const issues: PrecheckIssue[] = [];
  const { width, height } = sceneDims(doc);
  const key = (x: number, y: number) => `${x},${y}`;

  if (width === 0 || height === 0) {
    issues.push({ level: 'error', code: 'E-MAP-MAP-EMPTY', message: '地图为空（至少 1×1）' });
    return issues;
  }
  if (width * height > limits.maxCells) {
    issues.push({
      level: 'error',
      code: 'E-CAP-LIMIT-MAP',
      message: `地图 ${width}×${height}=${width * height} 格，超过档位上限 ${limits.maxCells} 格`,
    });
  }
  if (doc.robots.length > limits.maxRobots) {
    issues.push({
      level: 'error',
      code: 'E-CAP-LIMIT-AGENTS',
      message: `机器人 ${doc.robots.length} 台，超过档位上限 ${limits.maxRobots} 台`,
    });
  }
  if (doc.time_model.horizon !== 'auto' && doc.time_model.horizon > limits.maxHorizon) {
    issues.push({
      level: 'error',
      code: 'E-CAP-LIMIT-HORIZON',
      message: `时域 ${doc.time_model.horizon} 超过档位上限 ${limits.maxHorizon}`,
    });
  }
  if (doc.solver.time_limit_ms > limits.maxBudgetMs) {
    issues.push({
      level: 'error',
      code: 'E-CAP-LIMIT-BUDGET',
      message: `预算 ${doc.solver.time_limit_ms} ms 超过档位上限 ${limits.maxBudgetMs} ms`,
    });
  }

  // 可通行格检查
  let passable = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isBlockedCell(doc, x, y)) passable += 1;
    }
  }
  if (passable === 0) {
    issues.push({ level: 'error', code: 'E-MAP-MAP-EMPTY', message: '地图没有任何可通行格' });
  }

  const startSeen = new Map<string, string>();
  const goalSeen = new Map<string, string>();
  for (const r of doc.robots) {
    if (!r.goal) {
      issues.push({ level: 'error', code: 'LOCAL-GOAL-MISSING', message: `机器人 ${r.id} 终点未设置`, robots: [r.id] });
      continue;
    }
    for (const [label, c, codeBlocked, seen, codeDup] of [
      ['起点', r.start, 'E-ROBOT-START-BLOCKED', startSeen, 'E-ROBOT-DUP-START'],
      ['终点', r.goal, 'E-ROBOT-GOAL-BLOCKED', goalSeen, 'E-ROBOT-DUP-GOAL'],
    ] as const) {
      const [x, y] = c;
      if (x < 0 || y < 0 || x >= width || y >= height) {
        issues.push({
          level: 'error',
          code: 'E-ROBOT-COORD-RANGE',
          message: `机器人 ${r.id} ${label} (${x},${y}) 越界`,
          robots: [r.id],
          cell: { x, y },
        });
        continue;
      }
      if (isBlockedCell(doc, x, y)) {
        issues.push({
          level: 'error',
          code: codeBlocked,
          message: `机器人 ${r.id} ${label} (${x},${y}) 落在障碍格`,
          robots: [r.id],
          cell: { x, y },
        });
      }
      const k = key(x, y);
      const other = seen.get(k);
      if (other !== undefined) {
        issues.push({
          level: 'error',
          code: codeDup,
          message: `机器人 ${other} 与 ${r.id} 的${label}重复在 (${x},${y})`,
          robots: [other, r.id],
          cell: { x, y },
        });
      } else {
        seen.set(k, r.id);
      }
    }
    if (r.goal && r.start[0] === r.goal[0] && r.start[1] === r.goal[1]) {
      issues.push({
        level: 'error',
        code: 'E-ROBOT-START-EQ-GOAL',
        message: `机器人 ${r.id} 起点 = 终点 (${r.start[0]},${r.start[1]})：本期契约拒绝退化输入`,
        robots: [r.id],
        cell: { x: r.start[0], y: r.start[1] },
      });
    }
  }
  return issues;
}

export function hasErrors(issues: PrecheckIssue[]): boolean {
  return issues.some((i) => i.level === 'error');
}
