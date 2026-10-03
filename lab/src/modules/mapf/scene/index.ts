/**
 * 场景内核桶导出（纯 TS，Node 测试直接打包此模块）。
 */

export type { Coord, SceneDoc, SceneRobot } from './SceneDoc';
export { blankScene, cellOf, isBlockedCell, parseScene, sceneDims, sceneEquivalent, serializeScene, SCHEMA_VERSION } from './SceneDoc';
export { applyCommand, blankScene as blankSceneCommand, HISTORY_LIMIT, nextRobotId, SceneHistory } from './commands';
export type { SceneCommand } from './commands';
export { FALLBACK_LIMITS, hasErrors, precheckScene } from './precheck';
export type { CapabilityLimits, PrecheckIssue, PrecheckLevel } from './precheck';
export { buildDynamic, composeProblemWithDynamic, precheckDynamic } from '../dynamic/contractBlock';
export type { BuiltDynamic, DynamicEventInput } from '../dynamic/contractBlock';
export { deleteLocalScene, listLocalScenes, loadLocalScene, MAX_LOCAL_SCENES, memoryKV, saveLocalScene } from './storage';
export type { KV, LocalScene } from './storage';
