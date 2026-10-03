# 三维实验室 · 模型集合（随构建同步）

> 由 `lab/scripts/sync-assets.mjs` 依据 `art-lab-selection.json` 生成；统计来自真实 GLB 结构。
> 原模型始终保留在 `lab/design/assets/**`，同步只是复制到 `lab/public/models/**`（构建产物，不入库）。

- 模型数：**43**（去重后），合计 3.12 MB / 78,160 三角形
- 生成时间：2026-10-03T21:39:22.980Z

## hero（6）

| 模型 | 用途 | 来源类别 | 大小 | 三角形 | 网格 | 尺寸(m) | 玻璃占比 | 关键部件组 |
|---|---|---|---:|---:|---:|---|---:|---|
| `cnc-machining-centre-with-sliding-door` | 阶段一主英雄：带滑动门与观察窗的加工中心（外壳/门/玻璃/内部机构可分离） | aps-machining | 351 KB | 8,736 | 13 | 3.36×2.955×2.128 | 2.3% | machine×10 aperture×5 |
| `engine-lathe-with-2-4-m-bed` | 车床：长床身 + 拖板箱，机械细节密度最高（16.7k 三角形） | aps-machining | 686 KB | 16,736 | 15 | 2.51×2×1.038 | 0.0% | machine×8 |
| `vertical-milling-machine` | 立式铣床：主轴箱 + 工作台 + 立柱，设备占比 100% | aps-machining | 462 KB | 11,148 | 12 | 1.395×2.59×1.39 | 0.0% | machine×8 drive×3 |
| `hydraulic-workshop-press-h-frame` | H 型液压机：纯结构件，用于验证“深色金属层次”表现 | aps-machining | 357 KB | 8,600 | 8 | 1.54×2.265×0.82 | 0.0% | machine×10 |
| `six-axis-welding-robot` | 六轴焊接机器人：细长机械臂轮廓，检验轮廓光与亚克力护罩 | aps-machining | 34 KB | 1,512 | 4 | 1.1×2.42×3.29 | 0.0% | robot×3 |
| `overhead-gantry-crane-bridge-with-trolley` | 天车桥架：跨厂房的机械轮廓，用于半透明厂房的层次对照 | aps-machining | 49 KB | 1,048 | 6 | 17.76×4.475×2.99 | 0.0% | roof×4 vehicle×4 |

## hall（12）

| 模型 | 用途 | 来源类别 | 大小 | 三角形 | 网格 | 尺寸(m) | 玻璃占比 | 关键部件组 |
|---|---|---|---:|---:|---:|---|---:|---|
| `hall-steel-column` | 钢柱（8 m，按 6 m 厂房高度做等比缩放） | aps-machining | 7 KB | 96 | 4 | 0.72×8×0.72 | 0.0% | structure×5 |
| `hall-roof-truss-bay-6-m` | 6 m 屋面桁架 | aps-machining | 11 KB | 228 | 1 | 6.05×0.78×0.27 | 0.0% | structure×2 |
| `hall-roof-cladding-bay-6-m` | 6 m 屋面板（透明化首要对象） | aps-machining | 7 KB | 144 | 1 | 6×0.17×6 | 0.0% | roof×2 |
| `hall-ridge-skylight-bay` | 屋脊天窗 | aps-machining | 9 KB | 144 | 3 | 6×1×1.9 | 16.7% | roof×4 |
| `hall-wall-bay-with-high-windows` | 带高窗墙板（厂房外观主立面） | aps-machining | 62 KB | 300 | 4 | 5.84×6×0.22 | 4.0% | aperture×5 |
| `hall-wall-cladding-bay-6-m` | 6 m 墙板 | aps-machining | 55 KB | 168 | 3 | 5.84×6×0.22 | 0.0% | structure×4 |
| `hall-window-band-bay` | 窗带墙板 | aps-machining | 24 KB | 504 | 3 | 5.6×8×0.35 | 2.4% | aperture×4 |
| `hall-roller-door-bay` | 卷帘门（物流出入口） | aps-machining | 22 KB | 408 | 4 | 5.6×8×0.52 | 0.0% | aperture×6 |
| `hall-personnel-door-bay` | 人行门 | aps-machining | 17 KB | 300 | 6 | 5.6×8×0.471 | 4.0% | aperture×8 |
| `high-bay-light-fitting` | 高棚工厂灯（工业局部光源的实体依据） | aps-machining | 15 KB | 284 | 3 | 0.6×1.25×0.585 | 0.0% | lighting×4 |
| `gantry-crane-runway-rail-6-m` | 天车轨道 | aps-machining | 8 KB | 120 | 3 | 6.12×0.53×0.2 | 0.0% | structure×4 |
| `mezzanine-floor-bay-with-handrail-6-m` | 夹层平台（次要结构的弱化对象） | aps-machining | 13 KB | 252 | 3 | 6×4.005×3.04 | 0.0% | structure×4 |

## equipment（23）

| 模型 | 用途 | 来源类别 | 大小 | 三角形 | 网格 | 尺寸(m) | 玻璃占比 | 关键部件组 |
|---|---|---|---:|---:|---:|---|---:|---|
| `cnc-machining-centre-with-sliding-door` | 加工中心工位 | aps-machining | 351 KB | 8,736 | 13 | 3.36×2.955×2.128 | 2.3% | machine×10 aperture×5 |
| `engine-lathe-with-2-4-m-bed` | 车削工位 | aps-machining | 686 KB | 16,736 | 15 | 2.51×2×1.038 | 0.0% | machine×8 |
| `vertical-milling-machine` | 铣削工位 | aps-machining | 462 KB | 11,148 | 12 | 1.395×2.59×1.39 | 0.0% | machine×8 drive×3 |
| `hydraulic-workshop-press-h-frame` | 压装工位 | aps-machining | 357 KB | 8,600 | 8 | 1.54×2.265×0.82 | 0.0% | machine×10 |
| `six-axis-welding-robot` | 焊接工位（机器人 + 防护栏） | aps-machining | 34 KB | 1,512 | 4 | 1.1×2.42×3.29 | 0.0% | robot×3 |
| `paint-robot-with-bell-atomiser` | 喷涂工位 | aps-machining | 32 KB | 1,284 | 5 | 1.1×2.42×3.12 | 0.0% | robot×3 |
| `glass-fitting-robot` | 装配工位 | aps-machining | 39 KB | 1,564 | 5 | 1.2×2.42×3.77 | 0.0% | robot×3 |
| `workbench-with-engineer-s-vice` | 钳工工作台 | aps-machining | 33 KB | 284 | 7 | 2.04×1.12×0.904 | 0.0% | workstation×6 |
| `assembly-workbench` | 总装工作台 | conveyors-logistics | 10 KB | 140 | 6 | 2×1.02×1.1 | 0.0% | workstation×1 lighting×1 |
| `mobile-tool-cabinet-with-drawers` | 工具柜 | aps-machining | 26 KB | 508 | 10 | 0.965×1.024×0.592 | 0.0% | workstation×12 |
| `line-side-rack` | 线边料架 | aps-machining | 87 KB | 4,320 | 4 | 2.6×2.17×1 | 0.0% | racking×5 |
| `pallet-racking-bay-two-levels` | 双层货架 | agv-warehouse | 36 KB | 396 | 5 | 2.9×3.722×1 | 0.0% | racking×6 |
| `powered-belt-conveyor-4-m-straight` | 4 m 直段输送线 | conveyors-logistics | 15 KB | 264 | 7 | 1.189×0.82×4 | 0.0% | conveyor×6 vessel×2 |
| `powered-belt-conveyor-90-degree-curve` | 90° 转弯输送线 | conveyors-logistics | 21 KB | 480 | 5 | 1.612×0.82×1.609 | 0.0% | conveyor×6 |
| `parcel-scanner-arch-over-a-belt` | 扫码门架 | conveyors-logistics | 20 KB | 408 | 8 | 1.51×2.44×2 | 0.0% | vessel×2 |
| `conveyor-leg-and-support-frame` | 输送线支腿 | conveyors-logistics | 11 KB | 168 | 4 | 0.94×0.75×0.68 | 0.0% | conveyor×5 |
| `robot-fence-panel` | 机器人防护围栏（半透明化对象） | conveyors-logistics | 52 KB | 2,592 | 2 | 2.18×2.2×0.3 | 0.0% | panel×3 |
| `steel-stillage-cage` | 工件料框 | aps-machining | 19 KB | 372 | 4 | 1.22×1×0.82 | 0.0% | cargo×5 |
| `pallet-of-stacked-cartons` | 托盘货物（工件，来自算法数据时才出现） | aps-machining | 31 KB | 276 | 3 | 1.2×1.03×1 | 0.0% | cargo×4 |
| `overhead-hoist-gantry` | 小型龙门吊 | conveyors-logistics | 14 KB | 232 | 4 | 4×3.8×1 | 0.0% | conveyor×1 |
| `mesh-stillage` | 网格料箱 | agv-warehouse | 88 KB | 4,428 | 3 | 1.2×1.105×0.87 | 0.0% |  |
| `hanging-aisle-number-panel` | 区域标识牌（空间分区） | agv-warehouse | 36 KB | 704 | 4 | 0.72×1.08×0.2 | 0.0% |  |
| `forklift-charging-point` | 充电工位（AGV 任务点实体） | agv-warehouse | 61 KB | 240 | 7 | 1.08×1.6×1.036 | 0.0% | vehicle×8 |

## vehicle（7）

| 模型 | 用途 | 来源类别 | 大小 | 三角形 | 网格 | 尺寸(m) | 玻璃占比 | 关键部件组 |
|---|---|---|---:|---:|---:|---|---:|---|
| `agv-mover` | AGV 搬运车（承载 AGV 引擎真实轨迹） | agv-warehouse | 35 KB | 1,496 | 13 | 1.3×0.5×2.08 | 0.0% | vehicle×6 |
| `agv-loader` | AGV 装卸车 | agv-warehouse | 19 KB | 620 | 19 | 0.7×0.87×0.9 | 1.9% | vehicle×6 |
| `counterbalance-forklift-truck` | 平衡重叉车 | agv-warehouse | 147 KB | 3,376 | 12 | 1.34×2.54×3.26 | 0.0% | vehicle×7 |
| `hand-pallet-truck` | 手动液压车 | agv-warehouse | 21 KB | 416 | 6 | 0.64×1.21×1.85 | 0.0% | cargo×7 |
| `service-robot-biped` | 双足服务机器人（MAPF 机器人实体） | mapf-robotics | 75 KB | 1,504 | 10 | 0.656×1.69×0.36 | 0.0% | robot×6 panel×1 |
| `robot-arm-floor` | 落地机械臂（工位机构） | mapf-robotics | 29 KB | 500 | 8 | 1×2.544×1.55 | 0.0% | floor×5 |
| `quadruped-carrier` | 四足载具（巡检） | mapf-robotics | 47 KB | 860 | 11 | 0.97×1.24×1.6 | 0.0% |  |

## 运行时加载策略（性能红线）

- 英雄设备：同屏只载入当前选中的一台（切换时 dispose，材质复用共享库）；
- 厂房与产线：drei `useGLTF` 缓存保证同一个 GLB 只解析一次，每实例 `scene.clone(true)` 共享几何、独立节点，绝不改动缓存本身；
- 所有模型的四边形/三角形数上限由结构审查报告给出，禁止把 10 万三角形级的整合场景直接塞进实时画面。

