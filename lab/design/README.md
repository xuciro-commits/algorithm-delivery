# 设计文档索引（lab/design）

> 本目录只放**设计决策**，不放实现细节的副本。代码里能查到的事实（参数、清单、结构）
> 一律由脚本生成或直接引用，避免"文档写了一套、代码跑了另一套"。
>
> 阅读顺序建议：**先方向（1）→ 再蓝图（2）→ 再落地记录（3）→ 最后验收状态（4）**。

## 1. 文档地图

| # | 文档 | 性质 | 它回答的问题 | 谁改它 |
| --- | --- | --- | --- | --- |
| 1 | [`VISUAL-DIRECTION.md`](VISUAL-DIRECTION.md) | **权威**（视觉基准） | 三个实验室要做成什么气质？颜色、发光线条、空间语言的红线是什么？ | 需审批后改 |
| 2 | [`COMPONENT-DESIGN.md`](COMPONENT-DESIGN.md) | **权威**（实施蓝图） | 用什么技术栈、哪些组件、性能红线、里程碑怎么切？ | 需审批后改 |
| 3 | [`ART-PIPELINE.md`](ART-PIPELINE.md) | 落地记录 + 决策台账 | 三维实验室每一轮改了什么？审批意见落在哪个文件哪一行？还有哪些待确认？ | 每轮追加 |
| 4 | [`VISUAL-ACCEPTANCE.md`](VISUAL-ACCEPTANCE.md) | 流程 + 状态 | 真实浏览器验收怎么做、当前**通过到什么程度**、哪些结论**没有**拿到？ | 每次验收后更新 |
| 5 | [`assets/README.md`](assets/README.md) | **生成物**（勿手改） | 上传素材总目录：分类、尺寸、面数、推荐用途 | `scripts/generate-assets-doc.py` |
| 6 | [`assets/ASSET-CATALOG.json`](assets/ASSET-CATALOG.json) | 数据 | 每件素材的元数据（程序读这个，不读 Markdown） | 下载脚本 |
| 7 | [`assets/ART-LAB-MODEL-SET.md`](assets/ART-LAB-MODEL-SET.md) | **生成物**（勿手改） | 运行时真正用到的 43 件模型（hero / hall / equipment / vehicle） | `npm run sync:assets` |
| 8 | [`assets/MODEL-STRUCTURE-AUDIT.md`](assets/MODEL-STRUCTURE-AUDIT.md) | **生成物**（勿手改） | 472 件上传资产的结构审查与透明策略命中情况 | `npm run audit:models` |
| 9 | [`assets/ASSET-REGISTER.md`](assets/ASSET-REGISTER.md) | 授权登记 | 素材来源、许可（CC0 1.0）、再分发说明 | 人工 |
| 10 | [`concepts/`](concepts) | 参考图 | 三张概念图，只定义方向，不约束最终布局 | 人工 |

## 2. 冲突时以谁为准

| 事实 | 权威来源 | 文档的角色 |
| --- | --- | --- |
| 颜色 / 材质语义 | `src/art/tokens.ts`、`src/art/materials.ts` | 记录设计意图，数值不复制 |
| 三种视觉模式的参数 | `src/art/modes.ts` | `ART-PIPELINE.md` 列出当前实现值，改代码要同步改表 |
| 透明策略（哪些部件可透明） | `src/art/part-roles.json` + `src/art/roles.ts` | 只描述规则，不复制 95 条明细 |
| 运行时用哪些模型 | `art-lab-selection.json` + `public/models/art-manifest.json` | `ART-LAB-MODEL-SET.md` 由脚本生成 |
| 上传素材本身 | `lab/design/assets/**`（**只读**） | `assets/README.md` 是它的目录说明 |
| 算法数据 | Rust/WASM 引擎输出 | 三维实验室只做投影；`ART-PIPELINE.md` 记录字段映射 |

**三条不变式**（任何一轮改造都不得破坏，见 `ART-PIPELINE.md` 第一节）：
几何只来自上传资产、三种模式共用同一份几何与数据、算法可视化只来自真实引擎输出。

## 3. 已知未闭环项

- **素材清单差异（已收敛一半）**：`assets/README.md` 已按磁盘实际内容重新生成
  （472 件 / 13 套完整大场景 + 459 件元模型，并在文首注明缺哪 3 个文件），
  但 `assets/ASSET-CATALOG.json` 仍保留 475 条记录（缺
  `car-factory-welding-framing-cell.glb`、`robot-drone-field-test-yard.glb`、
  `trade-counter-and-paint-mixing.glb`）。补齐下载后重跑
  `python3 lab/scripts/generate-assets-doc.py` 即可完全一致。
- **真实 GPU 验收**：见 `VISUAL-ACCEPTANCE.md`，目前只有 CI 的 SwiftShader 证据，
  桌面 GPU 上的画质与帧率结论仍待人工确认。
- **视觉验收覆盖**：Playwright 流程目前覆盖 APS / MAPF / AGV 三个算法面板，
  尚未覆盖 `#art-lab`（三维实验室）本身。
