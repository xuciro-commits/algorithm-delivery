/**
 * 模型逻辑键 → 上传模型 slug 的映射。
 *
 * 为什么用 slug 而不是硬编码路径：类别目录由同步脚本从 `lab/design/assets` 实测得出，
 * slug 是稳定标识；运行时的 URL 由 `art-manifest.json` 解析（`resolveModelUrls`），
 * 因此**不会出现“代码里写死一个不存在的路径”**——清单里没有的模型会被如实报告，
 * 而不是静默画一个占位方块。
 *
 * 自检：`lab/scripts/test-art-system.mjs` 会断言这里的每个 slug 都真实存在于
 * 结构审查报告与选择表里。
 */

import type { ArtManifest } from './manifest';

export const ART_MODEL_SLUGS = {
  // 厂房构件
  hallSteelColumn: 'hall-steel-column',
  hallRoofTruss: 'hall-roof-truss-bay-6-m',
  hallRoofCladding: 'hall-roof-cladding-bay-6-m',
  hallRidgeSkylight: 'hall-ridge-skylight-bay',
  hallWallHighWindows: 'hall-wall-bay-with-high-windows',
  hallWallCladding: 'hall-wall-cladding-bay-6-m',
  hallWindowBand: 'hall-window-band-bay',
  hallRollerDoor: 'hall-roller-door-bay',
  hallPersonnelDoor: 'hall-personnel-door-bay',
  highBayLight: 'high-bay-light-fitting',
  gantryRail: 'gantry-crane-runway-rail-6-m',
  mezzanineBay: 'mezzanine-floor-bay-with-handrail-6-m',

  // 产线设备与工位
  cncCentre: 'cnc-machining-centre-with-sliding-door',
  engineLathe: 'engine-lathe-with-2-4-m-bed',
  verticalMill: 'vertical-milling-machine',
  hydraulicPress: 'hydraulic-workshop-press-h-frame',
  weldingRobot: 'six-axis-welding-robot',
  paintRobot: 'paint-robot-with-bell-atomiser',
  glassRobot: 'glass-fitting-robot',
  workbench: 'workbench-with-engineer-s-vice',
  assemblyBench: 'assembly-workbench',
  toolCabinet: 'mobile-tool-cabinet-with-drawers',
  lineSideRack: 'line-side-rack',
  rackingBay: 'pallet-racking-bay-two-levels',
  conveyorStraight: 'powered-belt-conveyor-4-m-straight',
  conveyorCurve: 'powered-belt-conveyor-90-degree-curve',
  scannerArch: 'parcel-scanner-arch-over-a-belt',
  conveyorLeg: 'conveyor-leg-and-support-frame',
  robotFence: 'robot-fence-panel',
  stillage: 'steel-stillage-cage',
  meshStillage: 'mesh-stillage',
  cartonPallet: 'pallet-of-stacked-cartons',
  hoistGantry: 'overhead-hoist-gantry',
  areaPanel: 'hanging-aisle-number-panel',
  chargingPoint: 'forklift-charging-point',

  // 英雄设备（阶段一）
  gantryCraneBridge: 'overhead-gantry-crane-bridge-with-trolley',

  // 移动对象（算法数据载体）
  agvMover: 'agv-mover',
  agvLoader: 'agv-loader',
  forklift: 'counterbalance-forklift-truck',
  palletTruck: 'hand-pallet-truck',
  serviceRobot: 'service-robot-biped',
  robotArm: 'robot-arm-floor',
  quadruped: 'quadruped-carrier',
} as const;

export type ArtModelPathKey = keyof typeof ART_MODEL_SLUGS;

export function slugOf(key: ArtModelPathKey): string {
  return ART_MODEL_SLUGS[key];
}

/** slug → 运行时 URL（来自清单）。清单缺失的 slug 不会出现在结果里。 */
export function resolveModelUrls(manifest: ArtManifest | null): Partial<Record<ArtModelPathKey, string>> {
  const bySlug = new Map<string, string>();
  for (const model of manifest?.models ?? []) bySlug.set(model.slug, model.url);
  const out: Partial<Record<ArtModelPathKey, string>> = {};
  for (const [key, slug] of Object.entries(ART_MODEL_SLUGS) as Array<[ArtModelPathKey, string]>) {
    const url = bySlug.get(slug);
    if (url) out[key] = url;
  }
  return out;
}

/** 清单里缺失的模型键（面板会如实提示，而不是画占位几何）。 */
export function missingModelKeys(urls: Partial<Record<ArtModelPathKey, string>>): ArtModelPathKey[] {
  return (Object.keys(ART_MODEL_SLUGS) as ArtModelPathKey[]).filter((key) => !urls[key]);
}
