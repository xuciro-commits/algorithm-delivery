/**
 * 场景视觉配置的全局状态（视觉工作室 + 三个算法实验室共用）。
 *
 * 只保存**视觉选择**，不保存任何算法数据：模式/质量/透明强度/剖切与爆炸视图等。
 * 三个实验室与工作室读同一份 store，因此“模式 A/B/C 共用同一场景几何与真实数据”
 * 在实现层是同一件事，不存在三套模型。
 */

import { create } from 'zustand';
import type { QualityTier, VisualModeId } from './modes';

export type CameraPresetId = 'iso' | 'front' | 'side' | 'top' | 'detail';

export interface VisualState {
  mode: VisualModeId;
  quality: QualityTier;
  /** 半透明强度倍率：0 = 关闭半透明（只看外壳），1 = 模式默认，更高更透。 */
  shellScale: number;
  /** 爆炸视图（0–1）：沿部件中心向外平移，用于展示内部机构。 */
  explode: number;
  /** 是否显示外壳部件（关闭后即可直视内部机构）。 */
  showShells: boolean;
  /** 剖切平面偏移（null = 不剖切）。 */
  clip: number | null;
  camera: CameraPresetId;
  /** 当前高亮的部件 id（来自真实的部件清单，非伪造）。 */
  highlight: string | null;
  setMode: (mode: VisualModeId) => void;
  setQuality: (quality: QualityTier) => void;
  setShellScale: (value: number) => void;
  setExplode: (value: number) => void;
  setShowShells: (value: boolean) => void;
  setClip: (value: number | null) => void;
  setCamera: (preset: CameraPresetId) => void;
  setHighlight: (id: string | null) => void;
}

const STORAGE_KEY = 'lab.visual.v3';

interface Persisted {
  mode: VisualModeId;
  quality: QualityTier;
  shellScale: number;
  showShells: boolean;
}

function loadPersisted(): Partial<Persisted> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persist(state: VisualState): void {
  try {
    const payload: Persisted = {
      mode: state.mode,
      quality: state.quality,
      shellScale: state.shellScale,
      showShells: state.showShells,
    };
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 无 localStorage（SSR / 隐私模式）时静默降级
  }
}

const initial = loadPersisted();

export const useVisualStore = create<VisualState>((set, get) => {
  const update = (patch: Partial<VisualState>) => {
    set(patch as VisualState);
    persist(get());
  };
  return {
    mode: initial.mode ?? 'B',
    quality: initial.quality ?? 'balanced',
    shellScale: initial.shellScale ?? 1,
    explode: 0,
    showShells: initial.showShells ?? true,
    clip: null,
    camera: 'iso',
    highlight: null,
    setMode: (mode) => update({ mode }),
    setQuality: (quality) => update({ quality }),
    setShellScale: (shellScale) => update({ shellScale }),
    setExplode: (explode) => update({ explode }),
    setShowShells: (showShells) => update({ showShells }),
    setClip: (clip) => update({ clip }),
    setCamera: (camera) => update({ camera }),
    setHighlight: (highlight) => update({ highlight }),
  };
});

/** 供测试与非 React 代码使用的最小读取接口。 */
export function visualSnapshot(): Pick<VisualState, 'mode' | 'quality' | 'shellScale' | 'explode' | 'showShells'> {
  const state = useVisualStore.getState();
  return { mode: state.mode, quality: state.quality, shellScale: state.shellScale, explode: state.explode, showShells: state.showShells };
}
