/**
 * 场景 I/O（两个新模块共用）：内置场景（引擎生成的 mock）+ 导入/导出 + 场景导出（生成器）。
 *
 * 内置场景由 `warehouse/rust` 的三合一 `generate` 命令离线生成并随包发布（`public/mock/`），
 * 每个文件都带有 `scenarioId / kind / name / goal / expect / scale / seed`，实验室只做展示与送解。
 */

import { useMemo, useState } from 'react';
import type {
  WarehouseManifest,
  WarehouseScenario,
  WarehouseScenarioCatalog,
} from '../../core/warehouse/types';

export interface MockEntry {
  file: string;
  id: string;
  name: string;
  kind: string;
  goal: string;
  expect: string;
  scale: string;
  description: string;
}

/**
 * 场景族的适用范围：场景清单里不含 `kind`（族是唯一线索），
 * 这里给出各族的主域；跨族（X 系列是无/空/超大等边界）由生成结果的 `kind` 兜底判定。
 */
const FAMILIES_FOR: Record<string, string[]> = {
  slotting: ['slotting', 'stress'],
  asrs: ['dispatch', 'event', 'stress'],
  joint: ['joint'],
};

/** 规模档位回退值（只在引擎尚未握手完成时使用，与 `scenario.rs::SCALES` 同序）。 */
const SCALE_FALLBACK = ['tiny', 'small', 'medium', 'large', 'extreme', 'stress'];

/** 浏览器侧档位上限的诚实提示（来自 `capabilities.tiers` 的 wasm-light 档）。 */
const HEAVY_HINT =
  '浏览器侧是 wasm-light 档位（60k SKU / 300k 库位 / 20k 任务）：超档会返回 UNSUPPORTED，不会静默缩小问题。大实例请在目标机器上用 native CLI 跑。';

export interface SceneIOProps {
  manifest: WarehouseManifest | null;
  assetUrl: (path: string) => string;
  kind: 'slotting' | 'asrs' | 'joint';
  activeFile: string | null;
  onLoad: (text: string, entry: MockEntry | null) => void;
  onGenerate?: (scenarioId: string, scale: string) => void;
  generating?: boolean;
  /**
   * 引擎场景清单（`wh_scenarios`，按族分组）：生成器的场景下拉直接读它，
   * 前端不硬编码任何场景编号（86 个场景与族的划分由 `warehouse/rust/src/scenario.rs` 决定）。
   */
  scenarioCatalog?: WarehouseScenarioCatalog | null;
  /** 引擎规模档位（`wh_scenarios.scales`）。 */
  scales?: Array<{ key: string; skus: number; tasks: number; locations?: number }>;
  draft: string;
  onDraft: (text: string) => void;
  draftError: string | null;
  disabled?: boolean;
}

export function useMocks(manifest: WarehouseManifest | null, kind: string): MockEntry[] {
  return useMemo(() => {
    const list = (manifest?.mocks ?? []).filter((mock) => mock.kind === kind);
    return list.map((mock) => ({
      file: mock.file,
      id: mock.id,
      name: mock.name,
      kind: mock.kind,
      goal: mock.goal,
      expect: mock.expect,
      scale: mock.scale,
      description: mock.description,
    }));
  }, [manifest, kind]);
}

export function SceneIO({
  manifest,
  assetUrl,
  kind,
  activeFile,
  onLoad,
  onGenerate,
  generating,
  scenarioCatalog,
  scales,
  draft,
  onDraft,
  draftError,
  disabled,
}: SceneIOProps) {
  const mocks = useMocks(manifest, kind);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [genScenario, setGenScenario] = useState(kind === 'slotting' ? 'S01' : kind === 'asrs' ? 'D01' : 'J01');
  const [genScale, setGenScale] = useState('small');

  // 分族下拉：只列本模块能开的族；族内序号按引擎清单顺序（不重排、不筛选场景）。
  const groups = useMemo(() => {
    const allowed = FAMILIES_FOR[kind] ?? [];
    const families = (scenarioCatalog?.families ?? []).filter((group) => allowed.includes(group.family));
    return families.map((group) => ({
      family: group.family,
      label: group.label,
      scenarios: group.scenarios ?? [],
    }));
  }, [scenarioCatalog, kind]);
  const catalogScenarios: WarehouseScenario[] = useMemo(
    () => groups.flatMap((group) => group.scenarios),
    [groups],
  );
  const selected: WarehouseScenario | null = useMemo(
    () => catalogScenarios.find((scenario) => scenario.id === genScenario) ?? null,
    [catalogScenarios, genScenario],
  );
  const scaleKeys = useMemo(
    () => (scales && scales.length > 0 ? scales.map((scale) => scale.key) : SCALE_FALLBACK),
    [scales],
  );
  // large/extreme/stress 都属于"浏览器侧多半会被档位上限拒绝"的档位：这里提前提示，
  // 真正的裁决仍然由引擎（UNSUPPORTED + 理由）给出，前端不预先替引擎做决定。
  const heavyScale = genScale === 'large' || genScale === 'extreme' || genScale === 'stress';
  const scenarioIdPattern = /^[SDJEX]\d{2}$/;

  const pickScenario = (id: string) => {
    setGenScenario(id);
    // 场景自带默认规模：选中即跟随（用户仍然可以改），避免"场景写 large、框里还是 small"。
    const found = catalogScenarios.find((scenario) => scenario.id === id);
    if (found && scaleKeys.includes(found.scale)) setGenScale(found.scale);
  };

  const pick = async (entry: MockEntry) => {
    setLoadError(null);
    try {
      const response = await fetch(assetUrl(`mock/${entry.file}`), { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      onLoad(await response.text(), entry);
    } catch (err) {
      setLoadError(`读取场景失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <section className="rail-group">
      <div className="section-heading section-heading-compact">
        <h4>场景</h4>
        <span className="muted small">{mocks.length} 个内置实例</span>
      </div>
      {loadError && <p className="bad-text small">{loadError}</p>}
      <div className="scene-list">
        {mocks.map((entry) => (
          <button
            key={entry.file}
            type="button"
            className={`scene-card${activeFile === entry.file ? ' tag--on' : ''}`}
            disabled={disabled}
            onClick={() => void pick(entry)}
            title={`${entry.goal}\n期望：${entry.expect}`}
          >
            <span className="scene-io-label">
              <strong>{entry.name}</strong>
              <span className="tag tag--tight">{entry.scale}</span>
            </span>
            <span className="muted small">{entry.description}</span>
            <span className="muted small">目标：{entry.goal} · 期望：{entry.expect}</span>
          </button>
        ))}
        {mocks.length === 0 && (
          <p className="muted small">
            还没有 {kind} 内置实例，请先运行 <code>node scripts/sync-warehouse.mjs</code>。
          </p>
        )}
      </div>

      {onGenerate && (
        <div className="presets">
          <label className="field">
            <span className="small">按场景生成（引擎 86 个标准场景）</span>
            <span className="btn-row">
              {groups.length > 0 ? (
                <select
                  className="input"
                  style={{ flex: 1, minWidth: 0 }}
                  value={genScenario}
                  onChange={(event) => pickScenario(event.target.value)}
                  disabled={disabled || generating}
                  aria-label="场景编号"
                >
                  {groups.map((group) => (
                    <optgroup key={group.family} label={`${group.label}（${group.scenarios.length}）`}>
                      {group.scenarios.map((scenario) => (
                        <option key={scenario.id} value={scenario.id}>
                          {scenario.id} · {scenario.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              ) : (
                <input
                  className="input"
                  style={{ width: 78 }}
                  value={genScenario}
                  onChange={(event) => setGenScenario(event.target.value.toUpperCase())}
                  disabled={disabled || generating}
                  aria-label="场景编号"
                  placeholder="S01"
                />
              )}
              <select
                value={genScale}
                onChange={(event) => setGenScale(event.target.value)}
                disabled={disabled || generating}
                aria-label="规模"
              >
                {scaleKeys.map((scale) => (
                  <option key={scale} value={scale}>
                    {scale}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn tiny"
                disabled={disabled || generating || !scenarioIdPattern.test(genScenario)}
                onClick={() => onGenerate(genScenario, genScale)}
              >
                {generating ? '生成中…' : '生成'}
              </button>
            </span>
          </label>
          {selected && (
            <p className="muted small">
              目标：{selected.goal}
              <br />
              期望：{selected.expect}
              <br />
              {selected.catalog ? `目录 ${selected.catalog} · ` : ''}
              {selected.algorithm ? `场景默认算法 ${selected.algorithm} · ` : ''}
              场景默认规模 {selected.scale}
              {selected.mustShow && selected.mustShow.length > 0 ? ` · 验收现象 ${selected.mustShow.join(' / ')}` : ''}
            </p>
          )}
          {groups.length === 0 && (
            <p className="muted small">
              场景清单尚未就绪（引擎握手后自动出现）：当前只能手工输入场景编号，或从上面的内置实例开始。
            </p>
          )}
          {heavyScale && <p className="muted small">{HEAVY_HINT}</p>}
        </div>
      )}

      <details className="mapf-details json-drawer">
        <summary>导入 / 导出问题 JSON</summary>
        <textarea
          className="raw-json"
          spellCheck={false}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          placeholder="粘贴契约问题 JSON…"
          aria-label="问题 JSON"
        />
        {draftError && <p className="bad-text small">{draftError}</p>}
        <div className="solve-row">
          <button
            type="button"
            className="btn tiny"
            disabled={disabled || draft.trim().length === 0}
            onClick={() => {
              try {
                const parsed = JSON.parse(draft) as { scenarioId?: string; name?: string; kind?: string };
                const issue = validate(parsed, kind);
                if (issue) {
                  onDraft(draft);
                  setLoadError(issue);
                  return;
                }
                setLoadError(null);
                onLoad(draft, {
                  file: '（导入）',
                  id: parsed.scenarioId ?? 'IMPORTED',
                  name: parsed.name ?? '导入实例',
                  kind,
                  goal: '导入后直接求解',
                  expect: '—',
                  scale: '导入',
                  description: '本地粘贴/拖入的契约问题',
                });
              } catch (err) {
                setLoadError(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
              }
            }}
          >
            载入草稿
          </button>
          <label className="file-btn">
            选择文件
            <input
              type="file"
              accept="application/json,.json"
              className="visually-hidden-file"
              disabled={disabled}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void file.text().then((text) => {
                  onDraft(text);
                  onLoad(text, {
                    file: file.name,
                    id: 'FILE',
                    name: file.name,
                    kind,
                    goal: '导入后直接求解',
                    expect: '—',
                    scale: '导入',
                    description: '本地文件',
                  });
                });
              }}
            />
          </label>
          <button type="button" className="btn tiny" onClick={() => onDraft('')}>
            清空
          </button>
        </div>
      </details>
    </section>
  );
}

function validate(parsed: { kind?: string; problem?: unknown }, expected: string): string | null {
  if (!parsed.kind) return '缺少 `kind` 字段';
  if (parsed.kind !== expected && !(expected === 'asrs' && parsed.kind === 'dense-asrs')) {
    return `这是 ${parsed.kind} 问题，本模块接收 ${expected}`;
  }
  if (expected === 'joint') {
    if (!(parsed as { slotting?: unknown }).slotting || !(parsed as { asrs?: unknown }).asrs) {
      return '联合问题需要同时提供 `slotting` 与 `asrs`';
    }
    return null;
  }
  if (!parsed.problem) return '缺少 `problem` 字段';
  return null;
}

/**
 * 生成失败时把引擎回执里的 `issues[]` 摘成一行（没有可读信息就返回空串）。
 *
 * 引擎在超档（wasm-light 上限）或参数非法时返回的是完整信封，面板照原样展示字段路径与原因，
 * 而不是丢一句"生成失败"——用户要能看出是**档位不够**还是**场景编号写错**。
 */
export function generationIssueText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { issues?: Array<{ path?: string; message?: string }> };
    const issues = parsed.issues ?? [];
    if (issues.length === 0) return '';
    return `：${issues
      .slice(0, 3)
      .map((issue) => `${issue.path ?? '?'} ${issue.message ?? ''}`.trim())
      .join('；')}`;
  } catch {
    return '';
  }
}
