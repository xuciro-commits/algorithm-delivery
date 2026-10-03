/**
 * V3 视觉系统统一出口：材质 / 灯光 / 模式 / 舞台 / 资产清单 / 截图工具。
 * 三个算法实验室与视觉工作室都从这里取用，保证同一套美术语言。
 */

export { VP, VP_STATUS, VP_ALGO } from './palette';
export { classifyRole, collectNames, MECHANICAL_ROLES, SHELLABLE_ROLES, ROLE_RULES } from './roles';
export type { PartRole } from './roles';
export {
  VISUAL_MODES,
  VISUAL_MODE_LIST,
  QUALITY_TIERS,
  resolveMode,
  resolveQuality,
} from './modes';
export type { QualityConfig, QualityTier, VisualModeConfig, VisualModeId, ShellConfig, GroundConfig } from './modes';
export {
  roleMaterial,
  dimmedMaterial,
  emphasizedMaterial,
  haloMaterial,
  clearMaterialCache,
  materialCacheSize,
} from './materials';
export type { MaterialContext } from './materials';
export { useVisualStore, visualSnapshot } from './store';
export type { CameraPresetId, VisualState } from './store';
export { IndustrialRig } from './IndustrialRig';
export { TechDeck } from './TechDeck';
export { StageShell } from './StageShell';
export type { StageApi, StageBounds } from './StageShell';
export { ModelStage, useModelClone, inspectionBounds } from './ModelStage';
export type { ModelAssetRef } from './ModelStage';
export { inspectModel, partIdOf } from './inspect';
export type { ModelInspection, PartInfo } from './inspect';
export {
  HERO_MODEL_KEY,
  findAsset,
  loadVisualManifest,
  useVisualManifest,
  visualBaseUrl,
  visualModelUrl,
} from './manifest';
export type { VisualAsset, VisualManifest, ManifestState } from './manifest';
export { captureCanvas, composeSideBySide, downloadDataUrl, nextFrames, timestamp } from './capture';
export type { CapturedShot } from './capture';
