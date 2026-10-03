/**
 * 场景视觉配置（全局、单一来源）：模式 A/B/C + 半透明层开关 + 发光/发光强度。
 *
 * 为什么要放在全局 store 而不是各模块的 props：
 * 需求 §八 要求三种模式**共用同一套场景几何与实际算法数据**。把它做成一个全局
 * 视觉配置后，APS / MAPF / AGV 的既有 3D 沙盘与新的“三维实验室”都读同一份配置，
 * 切换模式时三个实验室同时改变观感，而不是各维护一套。
 *
 * 该 store 不做任何算法计算，也不产生任何几何：只描述“怎么画”。
 */

import { create } from 'zustand';
import type { ArtModeId } from './tokens';

export interface ArtSettings {
  mode: ArtModeId;
  /** 透明厂房：建筑层（墙体/屋顶/次要遮挡）进入半透明或隐藏。 */
  transparentFactory: boolean;
  /** 隐藏屋顶与顶棚（配合透明厂房观察内部生产线）。 */
  hideRoof: boolean;
  /** 建筑层透明强度系数 0–1（0 = 保留原始外观）。 */
  structureAlpha: number;
  /** 设备外壳/防护罩半透明强度系数 0–1。 */
  shellAlpha: number;
  /** 高质量玻璃：启用 MeshPhysicalMaterial transmission（更贵，用于近距离展示）。 */
  physicalGlass: boolean;
  /** 工程网格地面。 */
  showGrid: boolean;
  /** 柔和接触阴影（AO 投影），增强“沙盘感”。 */
  contactShadow: boolean;
  /** 算法叠加层（路径 / 任务节点 / 状态光）。 */
  showOverlays: boolean;
  /** 模式 C 的弱化：非关键设备与建筑压暗到背景层。 */
  deEmphasize: boolean;
  /** 比例标尺与坐标参考（沙盘标注）。 */
  showScaleMarks: boolean;
  /** 受控泛光总开关（审批：允许受控使用，但必须可以关掉）。 */
  bloomEnabled: boolean;
  /** 泛光强度倍率 0–1（0 = 完全关闭后处理）。 */
  bloomStrength: number;
}

export const DEFAULT_ART_SETTINGS: ArtSettings = {
  // 主目标形态是模式 B；模式 A / C 在界面上随时可切（几何与算法数据完全共用）。
  mode: 'B',
  transparentFactory: true,
  // 审批：模式 B/C 默认把屋面隐去（透明厂房），模式 A 一律保留原貌。
  hideRoof: true,
  // 中等透明：外壳与建筑保留可读的实体感，机械细节优先。
  structureAlpha: 0.85,
  shellAlpha: 0.8,
  physicalGlass: false,
  showGrid: true,
  contactShadow: true,
  showOverlays: true,
  deEmphasize: true,
  showScaleMarks: true,
  bloomEnabled: true,
  bloomStrength: 0.6,
};

interface ArtStore extends ArtSettings {
  setMode: (mode: ArtModeId) => void;
  patch: (patch: Partial<ArtSettings>) => void;
  reset: () => void;
}

export const useArtStore = create<ArtStore>((set) => ({
  ...DEFAULT_ART_SETTINGS,
  setMode: (mode) => set({ mode }),
  patch: (patch) => set(patch),
  reset: () => set({ ...DEFAULT_ART_SETTINGS }),
}));

/** 便捷读取（非 React 环境 / 事件回调里使用）。 */
export function artSettingsSnapshot(): ArtSettings {
  const { mode, transparentFactory, hideRoof, structureAlpha, shellAlpha, physicalGlass, showGrid, contactShadow, showOverlays, deEmphasize, showScaleMarks, bloomEnabled, bloomStrength } =
    useArtStore.getState();
  return { mode, transparentFactory, hideRoof, structureAlpha, shellAlpha, physicalGlass, showGrid, contactShadow, showOverlays, deEmphasize, showScaleMarks, bloomEnabled, bloomStrength };
}

/** 由设置推导出的最终透明强度（模式本身也会把强度置 0 —— 模式 A 不做任何透明）。 */
export function effectiveAlphaScales(mode: { structureTransparency: number; shellTransparency: number }, settings: ArtSettings) {
  return {
    structure: mode.structureTransparency * (settings.transparentFactory ? settings.structureAlpha : 0),
    shell: mode.shellTransparency * settings.shellAlpha,
  };
}
