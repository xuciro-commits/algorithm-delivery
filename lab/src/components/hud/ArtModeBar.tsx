/**
 * 全局视觉模式条（需求 §八：三种可切换的视觉模式）。
 *
 * 放在应用壳里而不是各个模块里：模式是**场景视觉配置**，三个实验室共用同一套几何与
 * 算法数据，切换后同时生效（既有 APS/MAPF/AGV 沙盘与新的三维实验室）。
 */

import { ART_MODES } from '../../art/modes';
import { ART_MODE_OPTIONS } from '../../art/tokens';
import { useArtStore } from '../../art/settings';
import { Segmented, ToolButton } from './Hud';

export function ArtModeBar() {
  const mode = useArtStore((s) => s.mode);
  const setMode = useArtStore((s) => s.setMode);
  const transparentFactory = useArtStore((s) => s.transparentFactory);
  const patch = useArtStore((s) => s.patch);
  const showOverlays = useArtStore((s) => s.showOverlays);
  const settings = ART_MODES[mode];

  return (
    <div className="art-mode-bar" role="group" aria-label="场景视觉模式">
      <span className="art-mode-title">视觉模式</span>
      <Segmented
        ariaLabel="视觉模式"
        options={ART_MODE_OPTIONS}
        value={mode}
        onChange={setMode}
      />
      <span className="art-mode-note">{settings.tagline}</span>
      <div className="hud-row">
        <ToolButton
          label="透明厂房"
          active={transparentFactory}
          title="建筑层（屋面/墙板/次要遮挡）进入半透明或隐藏，主要生产设备保持清晰"
          onClick={() => patch({ transparentFactory: !transparentFactory })}
        />
        <ToolButton label="算法叠加" active={showOverlays} title="路径 / 任务节点 / 状态光（全部来自引擎输出）" onClick={() => patch({ showOverlays: !showOverlays })} />
      </div>
    </div>
  );
}
