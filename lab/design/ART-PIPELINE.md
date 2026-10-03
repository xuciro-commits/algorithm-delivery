# 三维实验室（LAB / 02）：实现说明 · 审批落地 · 素材清单

> 本文档是**阶段一交付物 + 本轮审批意见的落地记录**，并给出阶段二之前的决策清单。
>
> 一句话：把 `lab/design/assets/` 里**已上传的工业模型**升级为 C4D 工业科技插画风格的
> 实时三维实验室（不重建几何），并把 AGV / MAPF / APS 三个**真实引擎**的解放进同一套
> 空间视觉语言里回放。界面拆成三个实验室，按钮与配色与三维场景同源。

---

## 一、三条不变式

1. **几何只来自上传资产**：`lab/design/assets/**` 只读；运行时由 `lab/scripts/sync-assets.mjs`
   复制到 `lab/public/models/**`（可重建、不进版本库）。艺术化只改材质、可见性与分层透明，
   **不改顶点、不重建网格、不替换设备**。
2. **三种视觉模式共用同一份几何与同一份算法数据**：A/B/C 只切换视觉配置
   （材质、透明、灯光、雾、曝光、泛光），不是三套模型；算法叠加层来自同一份引擎输出。
3. **算法可视化必须来自真实引擎输出**：路径、节点、状态光、进度弧、事件标记全部由
   AGV / MAPF / APS 引擎的真实解投影而来；没有结果时显示空叠加层，不用装饰动画充数。

---

## 二、页面结构：三个实验室（本轮全面改版）

| 实验室 | 定位 | 中央舞台 | 左栏 | 右栏 |
| --- | --- | --- | --- | --- |
| **01 英雄设备** | 单台设备艺术化重构与部件级核对 | 英雄实验台（可换设备 / 五组对照视图 / 5 个机位） | 6 台英雄设备（评分、三角形、尺寸） | 实测指标、角色分布条、部件清单（可高亮） |
| **02 透明厂房** | 厂房分层透明与空间关系 | 上传构件装配的厂房 + 29 处产线设备 | 分层透明开关与滑杆、厂房参数、地坪分区 | 设备布置表、工位泊位表、构件分组、透明策略 |
| **03 算法观察** | 真实解的空间回放 | 同一座厂房 + 算法叠加层 + 跟随镜头 | 三个算法（引擎状态 / 样例 / 运行）、空间语汇 | 运行指标、图例、泛光与叠加层控制 |

**外壳**（`src/App.tsx` + `src/styles.css`）改为机架式：顶栏（品牌 / 引擎状态 / 视觉模式簇）、
导航轨、主舞台、页脚状态。导航与实验室切换按钮都是**立体按钮**（凸起面 + 顶面高光 +
落地阴影 + 冰蓝发光描边），配色与 3D 场景同源（石墨底 / 冰蓝 / 青 / 银白 / 少量琥珀），
激活态像被按下并点亮。旧的扁平外壳样式已删除（`tests` 会断言旧类名不再出现）。

---

## 三、审批意见的落地结果

| 审批意见 | 落地方式 | 位置 |
| --- | --- | --- |
| **主展示模型：暂定 CNC 加工中心，最终看渲染效果** | 英雄设备按真实复杂度评分排序，`cnc-machining-centre-with-sliding-door` 默认选中；五组对照视图与机位可即时切换，便于横向比较 | `ArtLabPanel` / `HeroBench3D` |
| **模式 B 透明强度：采用中等透明，保证机械细节清晰** | 模式 B `structureTransparency 0.7` / `shellTransparency 0.6`（不再是 1.0），并叠加用户系数（默认 0.85 / 0.8）→ 有效 α ≈ 0.6 与 0.48；外壳基准 α 0.42 → 实际约 0.20 | `src/art/modes.ts` / `settings.ts` / `EquipmentModel.tsx` |
| **模式 B/C 默认隐藏或透明化屋面；模式 A 保留原貌** | `hideRoof` 默认 true：模式 B/C 在厂房与算法实验室默认隐去屋面与天窗；模式 A 恒为原貌（零透明、无泛光） | `settings.ts` / `ArtLabPanel` |
| **允许受控 Bloom，仅针对关键路径与状态灯，并提供关闭选项** | 新增 `src/components/sandbox/ArtBloom.tsx`：`three` 自带 EffectComposer + UnrealBloomPass + OutputPass；阈值 0.86（B）/ 0.72（C），模式 A 恒为 0；面板与顶栏均可一键关闭，强度可调 | `ArtBloom.tsx` / `SandboxScene.tsx` |
| **`gantry-crane-runway-rail-6-m` 归类为厂房结构** | 规则表新增 `crane-rail → structure`（更长命中优先，`handrail` 仍按护栏处理）；该模型组统计已从 `guard×4` 变为 `structure×4`，结构审查报告与清单已重新生成 | `src/art/part-roles.json` |

---

## 四、三种视觉模式：模式 A / 模式 B / 模式 C（参数为当前实现值）

| 维度 | 模式 A 工业原貌 | 模式 B 工业科技艺术化（默认） | 模式 C 算法观察 |
| --- | --- | --- | --- |
| 材质 | **原始 glTF 材质**（无替换） | 冷色工业材质 + 分层金属 | 同 B + 次要对象弱化 |
| 背景 / 雾 | `GRAPHITE.deep`，无雾 | `GRAPHITE.base`，雾 18→74 m | `GRAPHITE.void`，雾 14→62 m |
| 曝光 | 1.12 | 1.06 | 1.00 |
| 建筑层透明 | 0 | 0.70 | 0.72 |
| 设备外壳透明 | 0 | 0.60 | 0.50 |
| 弱化 `deEmphasis` | 1 | 1 | 0.45 |
| 主光 / 补光 / 轮廓光 | 2.15 / 0.72 / 0（1024） | 2.45 / 0.78 / 1.5（2048） | 2.10 / 0.66 / 1.9（1024） |
| 地坪反射 | 0.24 | 0.42 | 0.30 |
| 发光倍率 | 1.0 | 1.0 | 1.4 |
| 泛光（强度 / 阈值） | **0（关）** | 0.4 / 0.86 | 0.62 / 0.72 |
| 接触阴影 | 0 | 0.55 | 0.35 |

用户侧还有三个实时倍率：建筑层透明、外壳透明、泛光强度，以及"透明厂房 / 泛光"两个总开关
（模式 A 下前者归零、后者恒关，保证"原貌"语义不被用户设置破坏）。

---

## 五、透明策略：选择性透明

唯一入口是 `src/art/roles.ts` + `part-roles.json` 的 `transparencyPolicy`：

| 规则 | 命中对象 | 作用域 | 基准 α |
| --- | --- | --- | --- |
| `group: roof` | 屋面、天窗 | 建筑层 | 0.10 |
| `group: structure` | 柱、屋架、墙板、楼层板、吊车轨道 | 建筑层 | 0.14 |
| `group: floor` | 地坪构件 | 建筑层 | 0（隐藏） |
| `role: glazing` | 玻璃门窗、观察窗 | 设备层 | 0.26 |
| `role: shell` | 设备外壳、防护罩 | 设备层 | 0.42 |
| `role: floor` | 设备自带地面 | 设备层 | 0（隐藏） |

**永不透明**（内部机构保持不透明金属）：`frame`、`graphite`、`machined`、`drive`、`robot`、
`conveyor`、`cargo`、`vessel`。

三道工程防线：透明件 `renderOrder = 12`（不透明之后绘制）、`depthWrite = false`、
有效 α ≤ 0.02 直接 `visible = false`。

---

## 六、丝滑与高级感是怎么做出来的

| 机制 | 实现 | 为什么"高级" |
| --- | --- | --- |
| 回放时钟 | `playback.ts`：requestAnimationFrame 推进 `t ∈ [0, steps]`，整数部分是第几步，小数部分是步内插值；支持 0.4–16 步/秒变速与拖动 | 不再是 220 ms 一跳的"幻灯片" |
| 步间缓动 | `overlay.ts` 的 `splitStep` + `lerpWorld`：车辆/机器人在相邻两步之间用 smoothstep 插值绘制 | 有机械起停感，而不是匀速滑行 |
| 光流 | 计划中路段虚线 `dashOffset = -t × 0.36`，与回放位置严格绑定 | 流向与时间一致，不是独立动画 |
| 镜头 | `SmoothOrbit`：机位切换**补间飞行**（0.75–0.85 s 多项式缓动），并提供"跟随载体"跟踪镜头 | 观感是摄像机在移动，不是画面被替换 |
| 进度弧 | `ArtNode.progress`：在制工序按引擎起止时刻画出 0–100% 的进度弧 | 数据密度高但不需要文字 |
| 受控泛光 | 只对越阈自发光生效 | 路径与状态灯发光，金属不会糊成一片 |
| 科技薄纱 | `.stage-veil`：暗角 + 极淡扫描线 + 四角括号（纯 CSS） | 未来感来自构图与克制，而不是堆特效 |

**离散事实不被改写**：所有插值只发生在绘制阶段，面板同时显示"当前步"的整数部分与
"+x 步内插值"，可随时核对引擎原始步。

---

## 七、性能红线（`node lab/scripts/audit-perf.mjs` 持续断言）

- 泛光**只允许**出现在 `ArtBloom.tsx`，且不得引入 `@react-three/postprocessing`；
  关闭时直接走 `gl.render(scene, camera)`，与改造前逐像素一致；
- `dpr ≤ 2`；`frameloop` 只在 `active` 时 `always`，否则 `demand`；
  静止画面由 `RenderOnChange`（模式/视图/数据变化后补帧）与 `SmoothOrbit`（补间期间排帧）驱动；
- `useFrame` 内零分配（复用向量，不 new 几何/材质/颜色）；
- 发光线仍是两层细线（核心 + 光晕），没有粗管、没有线框化；
- 障碍场与地坪保持实例化/单 mesh。

---

## 八、素材清单（43 个上传模型，只读复用）

来源：`lab/design/assets/`（3dassets.dev CC0 1.0 上传资产，472 GLB，**只读**，禁止覆盖）。
入选集合：`art-lab-selection.json`；产物：`lab/public/models/**` + `art-manifest.json`；
逐件明细：`ART-LAB-MODEL-SET.md`；结构审查：`MODEL-STRUCTURE-AUDIT.md`。

| 角色 | 数量 | 体积 | 用途 |
| --- | --- | --- | --- |
| hero 英雄设备 | 6 | 1.98 MB | 阶段一单模型实验（CNC 加工中心为主） |
| hall 厂房构件 | 12 | 0.26 MB | 透明厂房装配（柱/桁架/屋面板/天窗/墙板/窗带/卷帘门/人行门/高棚灯/吊车轨道/夹层） |
| equipment 产线设备 | 18 | 0.65 MB | 29 处产线布置 |
| vehicle 移动对象 | 7 | 0.38 MB | AGV / 叉车 / 机器人（承载真实路径与位置） |
| **合计** | **43** | **3.12 MB** | 78,160 三角形 |

尺寸锚点（实测）：构件底面 y=0 且水平居中（柱 0.72×8×0.72 m、屋面板 6×0.17×6 m、
墙板 5.84×6×0.22 m、卷帘门 5.6×8×0.52 m）；设备以几何中心为原点。

---

## 九、算法空间语汇（全部来自真实引擎输出）

| 算法 | 真实来源字段 | 空间语汇 |
| --- | --- | --- |
| AGV 调度 | `solution.plan.vehicles[].timeline`、`plan.tasks[].{pickup_dock,dropoff_dock,*_arrival,*_done,flow_time,lateness,status}`、`missions[].{phase,from,to,dock}` | 已执行/计划轨迹（虚线 + 光流）、取送任务点、相位状态光（步间缓动）、`lateness > 0` 超期标记 |
| MAPF 路径 | `solution.robots[].path`、`arrival/steps/soc/makespan` | 每机器人独立配色轨迹、目标投影、到达状态环 |
| APS 排程 | `RunRecord.solution.operations[].{start_at,end_at,machine_id,order_id}`、`verify.violations` | 工位状态光 + **在制进度弧**、同订单工序流转线、核验违规标记、60 段等分时间回放 |

坐标换算只有一处：`layout.ts` 的 `createGridMapping → cellToWorld`（等比居中到 `ALGO_ZONE`）。
被排程使用的设备按"机器 → 泊位 → 设备"的确定性映射**强调**（提高反射与自发光），
不隐藏其它设备、不改几何。

---

## 十、验证方式

```bash
node lab/scripts/sync-assets.mjs --check     # 清单 ↔ 选择表 ↔ 磁盘 GLB ↔ 规则覆盖
node lab/scripts/test-art-system.mjs         # 933 项静态契约检查（无需浏览器/构建）
node lab/scripts/audit-perf.mjs              # 性能红线 + 受控泛光的四条约束
node lab/scripts/check-docs.mjs              # 文档链接 / 索引 / 生成物边界一致
node lab/scripts/model-structure-audit.mjs   # 472 个上传资产的结构审查
cd lab && npm run test:static                # 上面三条的组合（受限环境可跑）
cd lab && npm run build                      # 有依赖环境：tsc 类型检查 + vite 打包
cd lab && npm run test:post-build            # 构建后的全部 Lab 检查（CI 质量门用的就是这一条）
```

> 本仓库**没有** vitest/jest 之类的测试框架：所有检查都是 `lab/scripts/*.mjs` 里的
> 纯 Node 断言脚本（受限环境也能跑）。早期版本的本节曾写成 `npx vitest run`，属于笔误，已删除。

`test-art-system.mjs` 会断言：相对 import 可达、命名导出存在、无未使用 import
（`noUnusedLocals` 会直接让构建失败）、相对路径正确、模式与透明策略自洽、
滑杆确实被消费、泛光只在授权文件、旧外壳类名不再出现、清单与磁盘一致，
以及**全部 `.tsx` 的 JSX 标签配平**（自建词法扫描器：正确剥离注释、字符串与正则字面量，
不把泛型实参、比较表达式、转义实体、片段与自闭合标签误判成结构错误）。

> 本轮它抓出并修复的真实缺陷包括：`SandboxScene` + `ArtStage` 相对路径少一级（构建必然失败）、
> `modes.ts` 从错误的模块导入 `ArtModeId`、清单中 5 个模型重复条目、以及
> "透明强度滑杆不生效"（`effectiveAlphaScales` 未接线）。

---

## 十一、已知限制（现状）

| # | 限制 | 状态 |
| --- | --- | --- |
| 1 | **开发环境不编译**：沙箱无 Rust / tsc / 浏览器，验证以静态断言 + 数据核对为主 | 持续：`npm run test:static` 是这一层的边界；类型检查、构建、真实 WebGL 由 CI（`lab.yml` + `lab-visual-acceptance.yml`）承担 |
| 2 | **整装厂房的三角形预算**：多跨大厂房全量实例化会显著增长，当前按需装配（构件级复用） | 开放：若第三轮要铺更大厂房，需要实例化 / LOD |
| 3 | **泛光刻意克制**：阈值取高、模式 B 强度 0.4（用户倍率 0.6） | 开放：若要更强的电影感辉光需放宽阈值，代价是金属高光也参与泛光 |
| 4 | **主英雄待渲染确认**：默认 CNC 加工中心 | 开放：面板可一键切换 6 台英雄设备机位对照，换主角不需要改代码结构 |
| 5 | **模型覆盖面**：472 件上传资产中入选 43 件 | 开放：改 `art-lab-selection.json` + 重跑 `sync:assets` 即可扩充 |
| 6 | **真实 GPU 画质未验收**：目前只有静态证据与 CI SwiftShader 截图 | 开放：见 `VISUAL-ACCEPTANCE.md`，含 `#art-lab` 需要补进 Playwright 流程 |
| 7 | **素材清单与磁盘不一致**：`design/assets/README.md` 声称 16 套大场景 / 475 件，磁盘上为 13 套 / 472 件 | 开放：`npm run check:docs` 以提示方式报告，需补齐下载或重新生成清单 |

## 十二、第三轮候选（按价值排序，均需审批）

1. **真实渲染评审**：在有 GPU 的机器上跑 `npm run test:visual`，用真实截图确定 CNC 主英雄与模式 B 的透明强度。
2. **把 `#art-lab` 纳入视觉验收**：为三维实验室加一条"只取场景截图 + 模式 A/B/C 对照截图"的 Playwright 步骤。
3. **时间轴书签**：算法观察实验室跳转到关键事件（超期、违规、到达、重调度）。
4. **多跨厂房 + 完整产线全时段回放**：需要先解决限制 2（实例化 / LOD）。
5. ~~**美术语言收口**~~：已完成 —— `art/tokens.ts` 是唯一色板来源，`components/sandbox/theme.ts`
   只做转出；`test-art-system.mjs` 断言二者不得再各自定义颜色。
6. **运行历史/方案对比骨架收口**：已完成 —— `src/core/runs/` 提供 `RunDiffRow` / `sameProblem` /
   `lowerBetter` / `higherBetter` 等公共件，MAPF 与 AGV 只保留各自指标集（APS 有自己的状态机，暂不合并）。
7. **脚本外壳收口**：已完成 —— `scripts/lib/harness.mjs` 统一 `check / note / warn / finish` 与退出码。
