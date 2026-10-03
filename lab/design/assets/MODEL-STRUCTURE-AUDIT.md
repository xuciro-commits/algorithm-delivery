# 已上传工业模型 · 结构审查报告

> 由 `lab/scripts/model-structure-audit.mjs` 自动生成，数据来自 `lab/design/assets/**` 的真实 GLB 与 glTF 元数据。
> 语义规则单一来源：`lab/src/art/part-roles.json`。**不要手工编辑本文件**。

- 生成时间：2026-10-03T21:32:42.291Z
- 资产总数：**472** 个 GLB，67.0 MB，合计 2,885,204 三角形（按实例计）
- 出现的材质名：54 种；未命中规则的材质名：无

## 1. 分类统计

| 类别 | 资产数 | 体积 | 三角形 | 含玻璃 | 含屋顶/墙体 | 含内部机构 | 含可控部件（门窗/护罩） |
|---|---:|---:|---:|---:|---:|---:|---:|
| agv-warehouse | 110 | 15.2 MB | 449,064 | 17 | 5 | 5 | 22 |
| aps-machining | 112 | 10.0 MB | 261,360 | 14 | 15 | 39 | 13 |
| assembled-scenes | 13 | 35.0 MB | 1,933,060 | 4 | 8 | 11 | 9 |
| conveyors-logistics | 123 | 2.2 MB | 62,392 | 1 | 4 | 13 | 2 |
| lab-cleanroom | 63 | 3.3 MB | 149,136 | 30 | 3 | 4 | 13 |
| mapf-robotics | 51 | 1.3 MB | 30,192 | 20 | 0 | 3 | 4 |

## 2. 材质 → 艺术化角色 覆盖表

| 角色 | 含义 | 三角形占比 | 艺术化处理方向 |
|---|---|---:|---|
| `shell` | 设备外壳/机罩：喷涂金属板（cream/blue/enamel/paint 等），艺术化后为冷银灰，可选择性半透明 | 11.00% | 冷银白 / 浅银灰漆面（可选择性半透明） |
| `frame` | 结构钢构/机架：steel，保持清晰机械轮廓，不做透明 | 20.85% | 深色钢构，保留清晰轮廓（不透明） |
| `graphite` | 深色金属结构件：dark/charcoal/graphite，用于压出层次 | 22.63% | 深石墨结构件（层次压暗） |
| `machined` | 精密加工金属件：cast/metal，主轴、台面、导轨等内部机构 | 6.93% | 精密加工金属（高光导轨/主轴） |
| `glazing` | 玻璃/透明件：观察窗、防护罩、门窗玻璃 | 3.10% | 冰蓝半透明工业玻璃 / 亚克力 |
| `rubber` | 橡胶/密封/轮胎 | 6.76% | 哑光深灰橡胶 |
| `hazard` | 安全色：黄/绿警示涂装 | 2.51% | 克制的琥珀安全色 |
| `accent` | 强调色：橙/红/琥珀（按钮、护罩、危险件） | 7.02% | 琥珀 / 珊瑚强调色 |
| `emissive` | 自发光件：glow/light/screen（状态灯、屏幕、灯具） | 0.95% | 青色 / 冰蓝柔和发光（对应真实状态） |
| `fluid` | 液体/水/冷却液 | 0.29% | 半透明冷色液体 |
| `polymer` | 塑料/复合/软性材料：soft/carcass/surface/white/grey | 10.16% | 冷灰聚合物 / 洁净面板 |
| `floor` | 地面与基础：floor/concrete/epoxy/deck | 1.60% | 科技地面（细网格 + 区域标识） |
| `organic` | 木材等自然材料：wood | 4.74% | 低饱和木色（弱化） |
| `metalWarm` | 有色金属：copper/brass | 0.40% | 暖色金属点缀 |
| `consumable` | 工件/被加工物：candy/choc/kraft 等 | 0.89% | 工件色（低饱和） |
| `skin` | 人形标尺的皮肤材质（机器人模型） | 0.16% | 人形标尺（弱化） |
| `unknown` | 未命中规则：审计会列出，必须显式扩展规则而不是静默兜底 | 0.00% | 未分类：必须补规则 |

## 3. 英雄设备候选（阶段一实验对象）

评分 = 结构复杂度(三角形) + 网格数(部件划分) + 材质数 + 玻璃占比 + 可控部件组(门窗/护罩) + 内部机构 + 传动件，再乘**设备占比**系数（抑制“房间式小场景”）。

| 排名 | 资产 | 类别 | 评分 | 设备占比 | 三角形 | 网格 | 材质 | 尺寸(m) | 玻璃占比 | 关键部件组 |
|---:|---|---|---:|---:|---:|---:|---|---|---:|---|
| 1 | `framing-cell-and-press-feed` | agv-warehouse | 64 | 81% | 83,592 | 130 | epoxy/yellow/dark/steel/blue/orange/glass/glow/skin | 24×4.43×12.32 | 0.3% | conveyor×70 vehicle×27 panel×24 racking×18 floor×17 |
| 2 | `cleanroom-gowning-suite` | lab-cleanroom | 63 | 55% | 52,312 | 151 | white/grey/steel/blue/green/light/glass/dark/amber/wood/liquid/yellow | 8.028×2.82×8.048 | 16.7% | panel×89 workstation×66 aperture×46 floor×27 racking×13 |
| 3 | `vertical-milling-machine` | aps-machining | 61 | 100% | 11,148 | 12 | rubber/steel/enamel/charcoal/cream/red/cast | 1.395×2.59×1.39 | 0.0% | machine×8 drive×3 |
| 4 | `cnc-machining-centre-with-sliding-door` | aps-machining | 58 | 67% | 8,736 | 13 | rubber/steel/enamel/charcoal/cast/blue/cream/red/yellow/glass | 3.36×2.955×2.128 | 2.3% | machine×10 aperture×5 |
| 5 | `engine-lathe-with-2-4-m-bed` | aps-machining | 58 | 100% | 16,736 | 15 | rubber/steel/cast/enamel/charcoal/cream/red | 2.51×2×1.038 | 0.0% | machine×8 |
| 6 | `horizontal-metal-cutting-bandsaw` | aps-machining | 57 | 100% | 9,212 | 14 | rubber/steel/enamel/charcoal/cream/red/cast | 1.62×1.6×0.948 | 0.0% | machine×8 |
| 7 | `pillar-drill-press-floor-standing` | aps-machining | 57 | 100% | 9,260 | 8 | cast/charcoal/steel/enamel/cream/red | 0.846×2.16×0.68 | 0.0% | machine×7 drive×1 |
| 8 | `parts-washing-cabinet-with-lift-lid` | aps-machining | 56 | 100% | 8,756 | 11 | rubber/steel/enamel/charcoal/cream/red/cast/blue/wood | 0.975×1.32×0.805 | 0.0% | machine×10 |
| 9 | `trade-counter-and-paint-mixing-area` | agv-warehouse | 55 | 49% | 45,876 | 144 | floor/accent/dark/carcass/surface/metal/glass/soft | 9.07×2.4×6.081 | 4.3% | aperture×40 workstation×28 floor×9 machine×7 racking×6 |
| 10 | `welding-bay-and-stores-corner` | agv-warehouse | 55 | 60% | 59,396 | 179 | concrete/charcoal/yellow/cast/glass/steel/cream/red/rubber/enamel/blue/wood | 12.4×7.27×12.44 | 0.1% | machine×62 cargo×61 structure×50 racking×26 workstation×23 |
| 11 | `surface-grinder-with-magnetic-chuck` | aps-machining | 55 | 100% | 10,288 | 12 | rubber/steel/enamel/charcoal/cream/red/cast | 1.307×2×1.213 | 0.0% | machine×7 |
| 12 | `pedestal-bench-grinder` | aps-machining | 54 | 100% | 8,924 | 9 | cast/steel/enamel/charcoal/cream/glass/red | 0.64×1.245×0.48 | 4.6% | workstation×8 |
| 13 | `bench-lathe-on-a-cabinet-stand` | aps-machining | 53 | 100% | 10,920 | 9 | rubber/steel/enamel/charcoal/cream/red/cast | 1.31×1.49×0.728 | 0.0% | machine×8 |
| 14 | `press-brake-for-sheet-metal` | aps-machining | 53 | 100% | 8,748 | 10 | enamel/charcoal/steel/cast/yellow/cream/red | 2.34×2.099×1.38 | 0.0% | machine×8 |
| 15 | `sheet-metal-guillotine-shear` | aps-machining | 53 | 100% | 8,960 | 10 | enamel/charcoal/steel/cast/yellow/cream/red | 2.24×1.63×1.42 | 0.0% | machine×8 |
| 16 | `mig-welder-on-a-bottle-cart` | aps-machining | 51 | 100% | 8,428 | 8 | charcoal/rubber/steel/enamel/cream/cast/red/yellow | 0.753×1.34×0.84 | 0.0% | machine×9 |
| 17 | `connector-cases` | agv-warehouse | 50 | 50% | 45,116 | 55 | metal/dark/accent/surface/carcass/floor/glass | 10.24×6×21.675 | 0.9% | racking×30 aperture×21 floor×9 cargo×5 guard×4 |
| 18 | `abrasive-cut-off-saw` | aps-machining | 49 | 100% | 8,008 | 9 | rubber/steel/enamel/charcoal/cream/red/cast | 1.21×1.49×0.838 | 0.0% | machine×11 |
| 19 | `hydraulic-workshop-press-h-frame` | aps-machining | 49 | 100% | 8,600 | 8 | charcoal/yellow/steel/enamel/cast/cream | 1.54×2.265×0.82 | 0.0% | machine×10 |
| 20 | `linisher-belt-sander-on-a-stand` | aps-machining | 45 | 100% | 8,624 | 9 | rubber/steel/enamel/charcoal/cream/red/cast | 1.485×1.34×0.728 | 0.0% | conveyor×8 vessel×3 |
| 21 | `welding-table-with-clamps` | aps-machining | 44 | 100% | 8,024 | 5 | charcoal/steel/red/cast/yellow | 1.7×1.144×0.995 | 0.0% | machine×6 |
| 22 | `powder-coating-oven-with-hinged-door` | aps-machining | 43 | 58% | 8,464 | 10 | rubber/steel/cast/charcoal/cream/red | 1.7×2.6×1.62 | 0.0% | machine×7 aperture×5 |
| 23 | `process-utilities-installation` | aps-machining | 43 | 100% | 2,992 | 45 | steel/dark/copper/orange/cream/light/blue | 6.2×3.2×11.198 | 0.0% | machine×18 services×16 utilities×12 lighting×7 vessel×6 |
| 24 | `depot-dock-and-yard` | agv-warehouse | 42 | 27% | 13,372 | 206 | concrete/charcoal/yellow/paint/blue/steel/rubber/cream/red/glass/card | 16×4.62×16.495 | 0.7% | floor×64 aperture×53 vehicle×46 cargo×40 guard×32 |

## 4. 透明化潜力候选（厂房 / 建筑部件）

| 资产 | 类别 | 玻璃占比 | roof 部件 | structure 部件 | 三角形 |
|---|---|---:|---:|---:|---:|
| `car-assembly-plant-production-line` | assembled-scenes | 2.2% | 56 | 166 | 247,848 |
| `machine-shop-day-shift-hall` | assembled-scenes | 0.3% | 12 | 134 | 240,952 |
| `parcel-sorting-hub-logistics-hall` | assembled-scenes | 0.4% | 0 | 60 | 25,924 |
| `welding-bay-and-stores-corner` | agv-warehouse | 0.1% | 8 | 50 | 59,396 |
| `science-laboratory-cleanroom-floor` | assembled-scenes | 19.3% | 12 | 36 | 219,804 |
| `nuclear-station-central-control-room-plant` | assembled-scenes | 1.4% | 6 | 22 | 308,536 |
| `container-freight-inspection-yard` | assembled-scenes | 0.0% | 11 | 4 | 206,344 |
| `lab-fridge` | lab-cleanroom | 41.7% | 13 | 0 | 3,708 |
| `depot-dock-and-yard` | agv-warehouse | 0.7% | 0 | 10 | 13,372 |
| `pegboard-tool-wall-on-a-stand` | aps-machining | 0.0% | 0 | 6 | 532 |
| `fastener-bin-wall` | agv-warehouse | 0.0% | 0 | 5 | 6,560 |
| `trade-counter-and-paint-mixing-area` | agv-warehouse | 4.3% | 0 | 5 | 45,876 |
| `hall-steel-column` | aps-machining | 0.0% | 0 | 5 | 96 |
| `mezzanine-stair` | conveyors-logistics | 0.0% | 0 | 5 | 660 |
| `gantry-crane-runway-rail-6-m` | aps-machining | 0.0% | 0 | 4 | 120 |
| `hall-ridge-skylight-bay-6-m` | aps-machining | 5.9% | 4 | 0 | 204 |
| `hall-ridge-skylight-bay` | aps-machining | 16.7% | 4 | 0 | 144 |
| `hall-wall-cladding-bay-6-m` | aps-machining | 0.0% | 0 | 4 | 168 |
| `mezzanine-access-stair-3-m-rise` | aps-machining | 0.0% | 0 | 4 | 432 |
| `mezzanine-floor-bay-with-handrail-6-m` | aps-machining | 0.0% | 0 | 4 | 252 |

## 5. 部件划分审查样例（逐网格明细）

这些明细直接决定“能不能单独控制机械外壳 / 支架 / 内部机构 / 传送部件 / 防护罩”。

### framing-cell-and-press-feed（agv-warehouse）

- 网格 130 / 节点 265 / 三角形 83,592（唯一网格 50,584），尺寸 24×4.43×12.32 m
- 角色分布：floor 288 tris · hazard 11,128 tris · graphite 35,736 tris · frame 16,144 tris · shell 9,660 tris · accent 8,536 tris · glazing 216 tris · emissive 588 tris · skin 1,296 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `039-mesh-stillage/1` | other | graphite | 3,132 | 1.12×0.7×0.75 |
| `021-robot-fence-panel/0` | panel | graphite | 2,160 | 2.18×2.06×0.3 |
| `022-robot-fence-panel/0` | panel | graphite | 2,160 | 2.18×2.06×0.3 |
| `023-robot-fence-panel/0` | panel | graphite | 2,160 | 2.18×2.06×0.3 |
| `024-robot-fence-panel/0` | panel | graphite | 2,160 | 2.18×2.06×0.3 |
| `025-robot-fence-panel/0` | panel | graphite | 2,160 | 2.18×2.06×0.3 |
| `026-robot-fence-panel/0` | panel | graphite | 2,160 | 2.18×2.06×0.3 |
| `027-robot-fence-panel/0` | panel | graphite | 2,160 | 2.18×2.06×0.3 |
| `028-robot-fence-panel/0` | panel | graphite | 2,160 | 2.18×2.06×0.3 |
| `032-blank-stack/1` | other | frame | 1,944 | 1.54×0.48×1.2 |
| `037-line-side-rack/2` | racking | hazard | 1,620 | 2.14×1.25×0.03 |
| `031-stamped-roof-panel-rack/0` | racking | shell | 1,404 | 2.3×1.22×1.9 |
| `020-body-in-white-shell/0` | other | frame | 1,200 | 3.98×1.25×1.76 |
| `039-mesh-stillage/0` | other | shell | 1,188 | 1.2×1.11×0.87 |
| `029-robot-fence-gate/gate-leaf/dark` | aperture | graphite | 1,080 | 1.59×1.8×0.14 |
| `030-stamped-door-panel-rack/2` | racking | graphite | 1,080 | 1.68×0.85×0.93 |
| `037-line-side-rack/0` | racking | shell | 1,080 | 2.6×2.17×1 |
| `037-line-side-rack/1` | racking | frame | 1,080 | 2.28×1.49×0.63 |
| … 其余 198 个网格 | | | | |

### trade-counter-and-paint-mixing-area（agv-warehouse）

- 网格 144 / 节点 181 / 三角形 45,876（唯一网格 42,996），尺寸 9.07×2.4×6.081 m
- 角色分布：floor 192 tris · accent 12,344 tris · graphite 7,924 tris · polymer 9,136 tris · machined 14,296 tris · glazing 1,984 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `018-fastener-bin-wall/3` | structure | accent | 5,600 | 0.36×1.45×1.13 |
| `012-paint-tinting-shelf/0` | racking | machined | 3,688 | 1.4×1.7×0.42 |
| `017-key-cutting-booth/3` | other | machined | 2,052 | 0.46×0.8×1.13 |
| `022-flatbed-trolley/0` | vehicle | machined | 1,456 | 1.32×0.99×0.93 |
| `011-paint-mixing-machine/3` | machine | machined | 1,216 | 0.8×1.14×1.01 |
| `020-tool-pegboard-panel/1` | panel | graphite | 912 | 0×1.39×1.09 |
| `015-timber-cutting-saw-station/0` | workstation | machined | 888 | 2.75×2.12×0.9 |
| `012-paint-tinting-shelf/2` | racking | polymer | 840 | 1.32×1.01×0.4 |
| `021-returns-desk/4` | other | accent | 840 | 1.21×0.24×0.42 |
| `017-key-cutting-booth/1` | other | graphite | 812 | 0.54×1.79×1.4 |
| `020-tool-pegboard-panel/3` | panel | machined | 792 | 0.2×0.8×1.03 |
| `023-paint-roller-and-tray/0` | conveyor | graphite | 736 | 0.52×0.09×0.55 |
| `012-paint-tinting-shelf/3` | racking | accent | 712 | 0.91×1.13×0.16 |
| `000-aisle-floor-marking-tile/1` | floor | accent | 704 | 2×0.01×1.76 |
| `001-aisle-floor-marking-tile/1` | floor | accent | 704 | 2×0.01×1.76 |
| `002-aisle-floor-marking-tile/1` | floor | accent | 704 | 2×0.01×1.76 |
| `018-fastener-bin-wall/2` | structure | polymer | 704 | 0.43×1.72×1.12 |
| `010-trade-counter-queue-rail/0` | guard | machined | 580 | 3.15×1.03×0.29 |
| … 其余 137 个网格 | | | | |

### welding-bay-and-stores-corner（agv-warehouse）

- 网格 179 / 节点 331 / 三角形 59,396（唯一网格 44,088），尺寸 12.4×7.27×12.44 m
- 角色分布：floor 108 tris · graphite 18,564 tris · hazard 1,380 tris · machined 5,476 tris · glazing 36 tris · frame 8,384 tris · shell 10,712 tris · accent 12,124 tris · rubber 1,376 tris · organic 1,236 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `030-machine-shop-and-factory-hall-welding-screen/2` | panel | accent | 5,832 | 1.83×1.62×0.06 |
| `031-machine-shop-and-factory-hall-welding-screen/2` | panel | accent | 5,832 | 0.06×1.62×1.83 |
| `028-machine-shop-and-factory-hall-welding-table/1` | machine | frame | 3,904 | 1.56×1.1×0.88 |
| `029-machine-shop-and-factory-hall-mig-welder-cart/0` | machine | graphite | 3,820 | 0.83×1.25×0.73 |
| `037-machine-shop-and-factory-hall-air-compressor/3` | utilities | shell | 3,636 | 0.39×0.5×0.97 |
| `028-machine-shop-and-factory-hall-welding-table/0` | machine | graphite | 2,932 | 1.7×0.95×0.99 |
| `037-machine-shop-and-factory-hall-air-compressor/1` | utilities | graphite | 2,260 | 0.6×1.34×1.5 |
| `029-machine-shop-and-factory-hall-mig-welder-cart/3` | machine | shell | 2,168 | 0.59×0.42×0.68 |
| `030-machine-shop-and-factory-hall-welding-screen/0` | panel | graphite | 2,040 | 1.9×1.85×0.44 |
| `031-machine-shop-and-factory-hall-welding-screen/0` | panel | graphite | 2,040 | 0.44×1.85×1.9 |
| `029-machine-shop-and-factory-hall-mig-welder-cart/4` | machine | shell | 912 | 0.58×1.07×0.48 |
| `028-machine-shop-and-factory-hall-welding-table/3` | machine | machined | 864 | 1.26×0.01×0.62 |
| `029-machine-shop-and-factory-hall-mig-welder-cart/2` | machine | frame | 748 | 0.73×0.77×0.71 |
| `037-machine-shop-and-factory-hall-air-compressor/0` | utilities | machined | 600 | 0.58×0.97×1.98 |
| `030-machine-shop-and-factory-hall-welding-screen/3` | panel | frame | 576 | 1.57×0.1×0.05 |
| `031-machine-shop-and-factory-hall-welding-screen/3` | panel | frame | 576 | 0.05×0.1×1.57 |
| `037-machine-shop-and-factory-hall-air-compressor/2` | utilities | frame | 516 | 0.5×1.19×1.2 |
| `032-machine-shop-and-factory-hall-floor-fan/0` | utilities | graphite | 380 | 0.64×1.49×0.61 |
| … 其余 240 个网格 | | | | |

### cnc-machining-centre-with-sliding-door（aps-machining）

- 网格 13 / 节点 15 / 三角形 8,736（唯一网格 8,736），尺寸 3.36×2.955×2.128 m
- 角色分布：rubber 416 tris · frame 604 tris · shell 1,736 tris · graphite 4,828 tris · machined 740 tris · accent 136 tris · hazard 72 tris · glazing 204 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `machine-shop-and-factory-hall-cnc-machining-centre_3` | machine | graphite | 4,136 | 2.9×2.4×2.13 |
| `machine-shop-and-factory-hall-cnc-machining-centre_6` | machine | shell | 868 | 0.49×1.56×1.8 |
| `cnc-door/charcoal` | aperture | graphite | 692 | 1.16×1.53×0.16 |
| `machine-shop-and-factory-hall-cnc-machining-centre_2` | machine | shell | 664 | 2.86×1.04×1.94 |
| `machine-shop-and-factory-hall-cnc-machining-centre_4` | machine | machined | 536 | 2.32×1.78×1.86 |
| `machine-shop-and-factory-hall-cnc-machining-centre_0` | machine | rubber | 416 | 2.63×0.11×1.57 |
| `machine-shop-and-factory-hall-cnc-machining-centre_1` | machine | frame | 400 | 2.01×1.9×1.71 |
| `machine-shop-and-factory-hall-cnc-machining-centre_5` | machine | shell | 204 | 0.6×0.5×0.7 |
| `cnc-door/cast` | aperture | machined | 204 | 1.12×1.46×0.1 |
| `cnc-door/glass` | aperture | glazing | 204 | 0.84×0.68×0.05 |
| `cnc-door/steel` | aperture | frame | 204 | 0.06×0.56×0.07 |
| `machine-shop-and-factory-hall-cnc-machining-centre_7` | machine | accent | 136 | 0.16×1.31×1.78 |
| `machine-shop-and-factory-hall-cnc-machining-centre_8` | machine | hazard | 72 | 0.16×0.12×0.16 |

### engine-lathe-with-2-4-m-bed（aps-machining）

- 网格 15 / 节点 19 / 三角形 16,736（唯一网格 16,736），尺寸 2.51×2×1.038 m
- 角色分布：rubber 224 tris · frame 5,048 tris · machined 504 tris · shell 5,052 tris · graphite 5,780 tris · accent 128 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `machine-shop-and-factory-hall-engine-lathe_1` | machine | frame | 3,784 | 2.41×1.85×0.93 |
| `machine-shop-and-factory-hall-engine-lathe_4` | machine | graphite | 3,476 | 2.33×1.6×1 |
| `machine-shop-and-factory-hall-engine-lathe_3` | machine | shell | 2,400 | 2.43×1.7×0.84 |
| `carriage-travel/charcoal` | other | graphite | 1,676 | 0.39×1.07×0.75 |
| `machine-shop-and-factory-hall-engine-lathe_5` | machine | shell | 1,344 | 0.42×1.34×0.25 |
| `carriage-travel/enamel` | other | shell | 1,200 | 0.5×0.78×0.68 |
| `chuck-spin/steel` | other | frame | 868 | 0.98×0.35×0.35 |
| `machine-shop-and-factory-hall-engine-lathe_2` | machine | machined | 504 | 2.44×1.74×0.92 |
| `handwheel-spin/charcoal` | other | graphite | 372 | 0.13×0.28×0.28 |
| `carriage-travel/steel` | other | frame | 348 | 0.06×0.93×0.66 |
| `chuck-spin/charcoal` | other | graphite | 256 | 0.3×0.37×0.37 |
| `machine-shop-and-factory-hall-engine-lathe_0` | machine | rubber | 224 | 2.15×0.03×0.77 |
| `machine-shop-and-factory-hall-engine-lathe_6` | machine | accent | 128 | 0.07×0.07×0.04 |
| `carriage-travel/cream` | other | shell | 108 | 0.01×0.04×0.01 |
| `handwheel-spin/steel` | other | frame | 48 | 0.1×0.03×0.03 |

### vertical-milling-machine（aps-machining）

- 网格 12 / 节点 15 / 三角形 11,148（唯一网格 11,148），尺寸 1.395×2.59×1.39 m
- 角色分布：rubber 224 tris · frame 2,256 tris · shell 3,452 tris · graphite 4,600 tris · accent 128 tris · machined 488 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `machine-shop-and-factory-hall-milling-machine_3` | machine | graphite | 3,576 | 1.12×2.3×1.29 |
| `machine-shop-and-factory-hall-milling-machine_2` | machine | shell | 2,324 | 1×2.49×1.17 |
| `machine-shop-and-factory-hall-milling-machine_1` | machine | frame | 2,080 | 0.99×2.38×1.03 |
| `machine-shop-and-factory-hall-milling-machine_4` | machine | shell | 1,128 | 0.69×0.74×0.12 |
| `table-travel/charcoal` | other | graphite | 912 | 1.38×0.23×0.36 |
| `machine-shop-and-factory-hall-milling-machine_6` | machine | machined | 284 | 0.94×1.32×0.53 |
| `machine-shop-and-factory-hall-milling-machine_0` | machine | rubber | 224 | 0.87×0.04×0.97 |
| `table-travel/cast` | other | machined | 204 | 1.24×0.1×0.38 |
| `machine-shop-and-factory-hall-milling-machine_5` | machine | accent | 128 | 0.07×0.07×0.04 |
| `spindle-spin/steel` | drive | frame | 128 | 0.12×0.42×0.12 |
| `spindle-spin/charcoal` | drive | graphite | 112 | 0.1×0.16×0.1 |
| `table-travel/steel` | other | frame | 48 | 0.1×0.03×0.03 |

### machine-shop-day-shift-hall（assembled-scenes）

- 网格 388 / 节点 1203 / 三角形 240,952（唯一网格 195,820），尺寸 18.44×7.27×18.44 m
- 角色分布：floor 240 tris · graphite 90,720 tris · hazard 4,592 tris · machined 20,224 tris · glazing 672 tris · frame 44,440 tris · shell 59,888 tris · rubber 7,040 tris · accent 8,864 tris · organic 4,272 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `145-machine-shop-and-factory-hall-welding-screen/2` | panel | accent | 5,832 | 0.06×1.62×1.83 |
| `080-machine-shop-and-factory-hall-pillar-drill/1` | machine | graphite | 5,296 | 0.85×2.04×0.53 |
| `122-machine-shop-and-factory-hall-belt-sander/3` | conveyor | graphite | 4,524 | 1.39×1.06×0.73 |
| `095-machine-shop-and-factory-hall-cnc-machining-centre/3` | machine | graphite | 4,136 | 2.13×2.4×2.9 |
| `098-machine-shop-and-factory-hall-powder-coat-oven/3` | machine | graphite | 4,104 | 1.59×2.52×1.7 |
| `081-machine-shop-and-factory-hall-surface-grinder/3` | machine | graphite | 3,932 | 1.27×1.79×1.21 |
| `143-machine-shop-and-factory-hall-welding-table/1` | machine | frame | 3,904 | 1.56×1.1×0.88 |
| `144-machine-shop-and-factory-hall-mig-welder-cart/0` | machine | graphite | 3,820 | 0.83×1.25×0.73 |
| `062-machine-shop-and-factory-hall-engine-lathe/1` | machine | frame | 3,784 | 2.41×1.85×0.93 |
| `097-machine-shop-and-factory-hall-air-compressor/3` | utilities | shell | 3,636 | 0.39×0.5×0.97 |
| `094-machine-shop-and-factory-hall-hydraulic-press/2` | machine | frame | 3,604 | 1.24×1.92×0.7 |
| `079-machine-shop-and-factory-hall-milling-machine/3` | machine | graphite | 3,576 | 1.12×2.3×1.29 |
| `063-machine-shop-and-factory-hall-bench-lathe/3` | machine | graphite | 3,568 | 1.23×1.28×0.72 |
| `062-machine-shop-and-factory-hall-engine-lathe/4` | machine | graphite | 3,476 | 2.33×1.6×1 |
| `082-machine-shop-and-factory-hall-cut-off-saw/3` | machine | graphite | 3,460 | 1.16×1.26×0.84 |
| `129-machine-shop-and-factory-hall-sheet-metal-shear/1` | machine | graphite | 3,400 | 2.24×1.41×1.41 |
| `121-machine-shop-and-factory-hall-bench-grinder/2` | workstation | shell | 3,196 | 0.38×1.13×0.3 |
| `063-machine-shop-and-factory-hall-bench-lathe/1` | machine | frame | 3,068 | 1.23×1.24×0.64 |
| … 其余 950 个网格 | | | | |

### robotics-workshop-hangar（assembled-scenes）

- 网格 443 / 节点 653 / 三角形 22,888（唯一网格 20,544），尺寸 13.15×3.06×9 m
- 角色分布：floor 464 tris · hazard 1,344 tris · graphite 8,056 tris · shell 3,244 tris · glazing 264 tris · accent 1,952 tris · emissive 780 tris · rubber 3,524 tris · frame 3,260 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `046-cinewhoop-ducted/2` | services | graphite | 560 | 0.79×0.09×0.79 |
| `032-humanoid-worker/0` | other | graphite | 552 | 0.77×1.61×0.58 |
| `031-humanoid-android/0` | other | graphite | 540 | 0.66×1.56×0.37 |
| `033-service-robot-biped/0` | robot | graphite | 540 | 0.57×1.53×0.31 |
| `034-quadruped-scout/1` | other | graphite | 540 | 1.1×0.76×1.3 |
| `043-quadruped-carrier/1` | other | graphite | 540 | 1.33×0.89×1.72 |
| `031-humanoid-android/2` | other | shell | 432 | 0.62×1.61×0.36 |
| `032-humanoid-worker/2` | other | shell | 432 | 0.7×1.67×0.4 |
| `033-service-robot-biped/2` | robot | shell | 420 | 0.54×1.57×0.3 |
| `051-tool-wall-panel/1` | panel | rubber | 288 | 1.53×0.69×0.02 |
| `039-vacuum-bot/1` | other | shell | 268 | 0.67×0.26×0.67 |
| `031-humanoid-android/arm-left/graphite` | other | graphite | 240 | 0.15×0.57×0.14 |
| `032-humanoid-worker/arm-right/graphite` | other | graphite | 240 | 0.15×0.57×0.15 |
| `033-service-robot-biped/arm-left/graphite` | robot | graphite | 240 | 0.14×0.57×0.13 |
| `058-twin-boom-uav/0` | other | shell | 240 | 2.18×0.24×1.97 |
| `053-tracked-ugv/1` | racking | rubber | 192 | 1.23×0.28×1.49 |
| `050-robot-arm-bench/arm-main/orange` | workstation | accent | 168 | 0.2×0.2×0.2 |
| `068-hexapod-inspection/head/shell` | other | shell | 168 | 0.25×0.18×0.25 |
| … 其余 560 个网格 | | | | |

### science-laboratory-cleanroom-floor（assembled-scenes）

- 网格 433 / 节点 1299 / 三角形 219,804（唯一网格 97,496），尺寸 18.03×2.82×12.016 m
- 角色分布：polymer 87,740 tris · graphite 25,172 tris · shell 12,648 tris · frame 33,716 tris · hazard 4,028 tris · emissive 628 tris · glazing 42,440 tris · accent 8,152 tris · fluid 4,572 tris · organic 708 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `135-sample-vial-rack/2` | racking | glazing | 3,200 | 0.13×0.05×0.13 |
| `177-sample-vial-rack/2` | racking | glazing | 3,200 | 0.13×0.05×0.13 |
| `194-sample-vial-rack/2` | racking | glazing | 3,200 | 0.13×0.05×0.13 |
| `128-fraction-collector/carousel/glass` | other | glazing | 3,072 | 0.3×0.08×0.3 |
| `113-test-tube-rack/1` | racking | glazing | 1,920 | 0.22×0.11×0.07 |
| `175-test-tube-rack/1` | racking | glazing | 1,920 | 0.22×0.11×0.07 |
| `198-test-tube-rack/1` | racking | glazing | 1,920 | 0.22×0.11×0.07 |
| `223-test-tube-rack/1` | racking | glazing | 1,920 | 0.22×0.11×0.07 |
| `149-biosafety-cabinet/0` | workstation | frame | 1,620 | 1.2×1.75×0.71 |
| `114-tip-box-stack/1` | other | polymer | 1,584 | 0.28×0.24×0.12 |
| `129-tip-box-stack/1` | other | polymer | 1,584 | 0.28×0.24×0.12 |
| `178-tip-box-stack/1` | other | polymer | 1,584 | 0.28×0.24×0.12 |
| `195-tip-box-stack/1` | other | polymer | 1,584 | 0.28×0.24×0.12 |
| `151-lab-fridge/4` | roof | glazing | 1,536 | 0.02×0.77×0.06 |
| `118-petri-dish-stack/1` | other | glazing | 1,296 | 0.28×0.09×0.17 |
| `143-petri-dish-stack/1` | other | glazing | 1,296 | 0.28×0.09×0.17 |
| `179-petri-dish-stack/1` | other | glazing | 1,296 | 0.28×0.09×0.17 |
| `193-petri-dish-stack/1` | other | glazing | 1,296 | 0.28×0.09×0.17 |
| … 其余 1053 个网格 | | | | |

### conveyor-connection-examples（conveyors-logistics）

- 网格 20 / 节点 32 / 三角形 1,504（唯一网格 1,168），尺寸 11.81×3.15×7 m
- 角色分布：graphite 884 tris · frame 96 tris · rubber 172 tris · accent 304 tris · shell 36 tris · emissive 12 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `001-factory-conveyor-network-belt-corner/dark` | conveyor | graphite | 216 | 2.64×0.86×2.64 |
| `003-factory-conveyor-network-belt-t-split/dark` | conveyor | graphite | 156 | 1.14×1.24×1.94 |
| `000-factory-conveyor-network-belt-straight/dark` | conveyor | graphite | 144 | 1.14×0.85×1.94 |
| `002-factory-conveyor-network-belt-straight/dark` | conveyor | graphite | 144 | 1.94×0.85×1.14 |
| `004-factory-conveyor-network-belt-cross/dark` | conveyor | graphite | 144 | 1.14×0.85×1.94 |
| `001-factory-conveyor-network-belt-corner/rubber` | conveyor | rubber | 100 | 2.5×0.12×2.5 |
| `003-factory-conveyor-network-belt-t-split/orange` | conveyor | accent | 92 | 2×0.21×2 |
| `004-factory-conveyor-network-belt-cross/orange` | conveyor | accent | 80 | 1.2×0.1×2 |
| `005-factory-conveyor-network-belt-lift/dark` | conveyor | graphite | 80 | 1.54×3.05×1.54 |
| `001-factory-conveyor-network-belt-corner/orange` | conveyor | accent | 72 | 2.63×0.14×2.63 |
| `000-factory-conveyor-network-belt-straight/orange` | conveyor | accent | 24 | 1.2×0.1×2 |
| `002-factory-conveyor-network-belt-straight/orange` | conveyor | accent | 24 | 2×0.1×1.2 |
| `003-factory-conveyor-network-belt-t-split/steel` | conveyor | frame | 24 | 2×0.12×2 |
| `003-factory-conveyor-network-belt-t-split/rubber` | conveyor | rubber | 24 | 2×0.08×2 |
| `004-factory-conveyor-network-belt-cross/steel` | conveyor | frame | 24 | 2.4×0.12×2 |
| `004-factory-conveyor-network-belt-cross/rubber` | conveyor | rubber | 24 | 2.4×0.08×2 |
| `005-factory-conveyor-network-belt-lift/steel` | conveyor | frame | 24 | 1.6×0.64×1.6 |
| `005-factory-conveyor-network-belt-lift/blue` | conveyor | shell | 24 | 1.62×3×0.18 |
| … 其余 7 个网格 | | | | |

### counterbalance-forklift-with-raising-forks（conveyors-logistics）

- 网格 25 / 节点 32 / 三角形 908（唯一网格 908），尺寸 1.33×2.88×3.17 m
- 角色分布：hazard 48 tris · graphite 236 tris · shell 108 tris · frame 280 tris · accent 12 tris · rubber 224 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `parcel-depot-and-sorting-hall-forklift-truck_2` | vehicle | shell | 108 | 1.1×2.52×1.89 |
| `parcel-depot-and-sorting-hall-forklift-truck_1` | vehicle | graphite | 96 | 1.1×1.3×1.45 |
| `wheel-roll-1/rubber` | other | rubber | 56 | 0.22×0.68×0.66 |
| `wheel-roll-2/rubber` | other | rubber | 56 | 0.22×0.68×0.66 |
| `wheel-roll-3/rubber` | other | rubber | 56 | 0.22×0.48×0.47 |
| `wheel-roll-4/rubber` | other | rubber | 56 | 0.22×0.48×0.47 |
| `parcel-depot-and-sorting-hall-forklift-truck_3` | vehicle | frame | 48 | 0.92×2.1×0.63 |
| `wheel-roll-1/steel` | other | frame | 40 | 0.24×0.34×0.32 |
| `wheel-roll-2/steel` | other | frame | 40 | 0.24×0.34×0.32 |
| `wheel-roll-3/steel` | other | frame | 40 | 0.24×0.24×0.23 |
| `wheel-roll-4/steel` | other | frame | 40 | 0.24×0.24×0.23 |
| `parcel-depot-and-sorting-hall-forklift-truck_0` | vehicle | hazard | 36 | 1.06×1.94×1.85 |
| `wheel-roll-1/charcoal` | other | graphite | 32 | 0.26×0.15×0.15 |
| `wheel-roll-2/charcoal` | other | graphite | 32 | 0.26×0.15×0.15 |
| `wheel-roll-3/charcoal` | other | graphite | 32 | 0.26×0.11×0.11 |
| `wheel-roll-4/charcoal` | other | graphite | 32 | 0.26×0.11×0.11 |
| `parcel-depot-and-sorting-hall-forklift-truck_4` | vehicle | accent | 12 | 0.12×0.12×0.1 |
| `hood/yellow` | other | hazard | 12 | 0.98×0.3×0.66 |
| … 其余 7 个网格 | | | | |

### trimmed-body-on-carrier（conveyors-logistics）

- 网格 18 / 节点 24 / 三角形 6,484（唯一网格 6,484），尺寸 1.999×1.315×4.041 m
- 角色分布：shell 2,604 tris · graphite 2,476 tris · glazing 1,296 tris · frame 108 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `trimmed-body-on-carrier_1` | other | graphite | 1,612 | 1.71×0.9×4.04 |
| `trimmed-body-on-carrier_0` | other | shell | 876 | 1.76×1.24×3.98 |
| `trimmed-body-on-carrier_2` | other | glazing | 648 | 1.71×0.65×3.57 |
| `trimmed-body-on-carrier_17` | other | shell | 432 | 1.32×0.07×1.92 |
| `car-door-fr/paintA` | aperture | shell | 324 | 0.16×0.53×1.02 |
| `car-door-fl/paintA` | aperture | shell | 324 | 0.16×0.53×1.02 |
| `car-door-fr/dark` | aperture | graphite | 216 | 0.08×0.11×0.96 |
| `car-door-fr/glass` | aperture | glazing | 216 | 0.16×0.32×0.94 |
| `car-door-rr/paintA` | aperture | shell | 216 | 0.11×0.44×1.02 |
| `car-door-rr/dark` | aperture | graphite | 216 | 0.08×0.11×0.96 |
| `car-door-fl/dark` | aperture | graphite | 216 | 0.08×0.11×0.96 |
| `car-door-fl/glass` | aperture | glazing | 216 | 0.16×0.32×0.94 |
| `car-door-rl/paintA` | aperture | shell | 216 | 0.11×0.44×1.02 |
| `car-door-rl/dark` | aperture | graphite | 216 | 0.08×0.11×0.96 |
| `bonnet` | other | shell | 216 | 1.6×0.08×1.16 |
| `trimmed-body-on-carrier_3` | other | frame | 108 | 0.52×0.12×0.04 |
| `car-door-rr/glass` | aperture | glazing | 108 | 0.03×0.3×0.9 |
| `car-door-rl/glass` | aperture | glazing | 108 | 0.03×0.3×0.9 |

### cleanroom-gowning-suite（lab-cleanroom）

- 网格 151 / 节点 341 / 三角形 52,312（唯一网格 36,472），尺寸 8.028×2.82×8.048 m
- 角色分布：polymer 23,936 tris · frame 8,864 tris · shell 2,576 tris · hazard 620 tris · emissive 188 tris · glazing 8,744 tris · graphite 4,752 tris · accent 1,268 tris · organic 344 tris · fluid 1,020 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `047-sample-vial-rack/2` | racking | glazing | 3,200 | 0.13×0.05×0.13 |
| `051-test-tube-rack/1` | racking | glazing | 1,920 | 0.22×0.11×0.07 |
| `048-tip-box-stack/1` | other | polymer | 1,584 | 0.28×0.24×0.12 |
| `046-petri-dish-stack/1` | other | glazing | 1,296 | 0.28×0.09×0.17 |
| `034-gowning-bench-and-locker/1` | workstation | polymer | 1,188 | 1.24×1.9×0.5 |
| `035-gowning-bench-and-locker/1` | workstation | polymer | 1,188 | 1.24×1.9×0.5 |
| `062-flask-set/1` | other | glazing | 948 | 0.37×0.2×0.18 |
| `029-interlocked-door-pair/0` | aperture | polymer | 864 | 2×2.7×1.42 |
| `036-air-shower-vestibule/1` | other | frame | 796 | 1.4×2.19×1.63 |
| `047-sample-vial-rack/0` | racking | polymer | 732 | 0.17×0.07×0.17 |
| `050-beaker-set/1` | other | glazing | 688 | 0.33×0.14×0.13 |
| `021-pass-through-hatch/1` | aperture | frame | 648 | 0.5×0.62×0.7 |
| `041-bench-run-module/2` | workstation | polymer | 648 | 1×0.77×0.71 |
| `042-bench-run-module/2` | workstation | polymer | 648 | 1×0.77×0.71 |
| `043-bench-run-module/2` | workstation | polymer | 648 | 1×0.77×0.71 |
| `044-bench-run-module/2` | workstation | polymer | 648 | 1×0.77×0.71 |
| `046-petri-dish-stack/2` | other | accent | 648 | 0.26×0.07×0.15 |
| `058-bench-run-module/2` | workstation | polymer | 648 | 1×0.77×0.71 |
| … 其余 257 个网格 | | | | |

### measuring-cylinder-set（lab-cleanroom）

- 网格 4 / 节点 5 / 三角形 912（唯一网格 912），尺寸 0.265×0.298×0.16 m
- 角色分布：polymer 252 tris · glazing 492 tris · fluid 168 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `measuring-cylinder-set_1` | drive | glazing | 492 | 0.25×0.29×0.11 |
| `measuring-cylinder-set_2` | drive | fluid | 168 | 0.11×0.11×0.05 |
| `measuring-cylinder-set_3` | drive | polymer | 144 | 0.16×0.11×0.02 |
| `measuring-cylinder-set_0` | drive | polymer | 108 | 0.26×0.01×0.16 |

### sample-vial-rack（lab-cleanroom）

- 网格 6 / 节点 7 / 三角形 4,620（唯一网格 4,620），尺寸 0.172×0.083×0.172 m
- 角色分布：polymer 732 tris · frame 80 tris · glazing 3,200 tris · shell 224 tris · hazard 192 tris · accent 192 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `sample-vial-rack_2` | racking | glazing | 3,200 | 0.13×0.05×0.13 |
| `sample-vial-rack_0` | racking | polymer | 732 | 0.17×0.07×0.17 |
| `sample-vial-rack_3` | racking | shell | 224 | 0.14×0.01×0.14 |
| `sample-vial-rack_4` | racking | hazard | 192 | 0.14×0.01×0.14 |
| `sample-vial-rack_5` | racking | accent | 192 | 0.14×0.01×0.14 |
| `sample-vial-rack_1` | racking | frame | 80 | 0.17×0.01×0.06 |

### drone-field-test-yard（mapf-robotics）

- 网格 179 / 节点 247 / 三角形 6,872（唯一网格 6,112），尺寸 8.895×2.744×6.85 m
- 角色分布：floor 180 tris · hazard 396 tris · graphite 1,676 tris · shell 444 tris · emissive 156 tris · accent 1,160 tris · frame 1,456 tris · rubber 1,200 tris · glazing 204 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `014-fixed-wing-uav/0` | other | shell | 276 | 2.51×0.27×1.87 |
| `012-hexacopter-heavy/3` | other | accent | 192 | 2.06×0.09×2.21 |
| `013-blimp-patrol/3` | other | accent | 192 | 1.06×0.69×2.66 |
| `012-hexacopter-heavy/1` | other | graphite | 168 | 1.95×0.72×2.07 |
| `024-quadcopter-cargo/3` | other | accent | 140 | 1.01×0.41×1.01 |
| `017-quadcopter-inspection/1` | other | graphite | 132 | 0.5×0.36×0.5 |
| `017-quadcopter-inspection/3` | other | accent | 128 | 0.58×0.09×0.58 |
| `017-quadcopter-inspection/17` | other | glazing | 120 | 0.14×0.11×0.14 |
| `024-quadcopter-cargo/1` | other | graphite | 120 | 0.92×0.54×0.92 |
| `025-cable-reel/2` | services | rubber | 76 | 0.96×0.52×0.68 |
| `012-hexacopter-heavy/7` | other | rubber | 72 | 1.3×0.04×1.47 |
| `013-blimp-patrol/1` | other | frame | 72 | 0.28×2.02×0.64 |
| `022-security-patrol-bot/head/red` | other | accent | 64 | 0.05×0.05×0.05 |
| `025-cable-reel/0` | services | accent | 64 | 0.6×0.4×0.6 |
| `014-fixed-wing-uav/5` | other | frame | 56 | 0.45×0.29×0.67 |
| `018-scrubber-bot/wheel-left/rubber` | other | rubber | 56 | 0.27×0.28×0.26 |
| `018-scrubber-bot/wheel-right/rubber` | other | rubber | 56 | 0.27×0.28×0.26 |
| `020-rover-6wd/wheel-lr/rubber` | other | rubber | 56 | 0.17×0.3×0.31 |
| … 其余 202 个网格 | | | | |

### service-robot-biped（mapf-robotics）

- 网格 10 / 节点 12 / 三角形 1,504（唯一网格 1,504），尺寸 0.656×1.69×0.36 m
- 角色分布：graphite 780 tris · rubber 128 tris · shell 500 tris · emissive 72 tris · frame 24 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `service-robot-biped_0` | robot | graphite | 540 | 0.57×1.53×0.31 |
| `service-robot-biped_2` | robot | shell | 420 | 0.54×1.57×0.3 |
| `arm-left/graphite` | other | graphite | 240 | 0.14×0.57×0.13 |
| `service-robot-biped_1` | robot | rubber | 116 | 0.52×1.5×0.34 |
| `arm-left/shell` | other | shell | 80 | 0.11×0.67×0.1 |
| `service-robot-biped_3` | robot | emissive | 36 | 0.38×0.57×0.29 |
| `service-robot-biped_4` | robot | emissive | 24 | 0.16×0.25×0.06 |
| `arm-left/steel` | other | frame | 24 | 0.11×0.1×0.06 |
| `arm-left/screen` | panel | emissive | 12 | 0.11×0.06×0.11 |
| `arm-left/rubber` | other | rubber | 12 | 0.11×0.04×0.07 |

### tracked-ugv（mapf-robotics）

- 网格 23 / 节点 33 / 三角形 1,100（唯一网格 1,036），尺寸 0.956×1.06×1.28 m
- 角色分布：graphite 260 tris · rubber 528 tris · hazard 24 tris · frame 240 tris · shell 24 tris · emissive 12 tris · glazing 12 tris

| 部件（网格） | 所属组 | 角色 | 三角形 | 尺寸(m) |
|---|---|---|---:|---|
| `tracked-ugv_1` | racking | rubber | 192 | 0.85×0.28×1.28 |
| `tracked-ugv_0` | racking | graphite | 68 | 0.84×0.76×1 |
| `wheel-lr/rubber` | other | rubber | 56 | 0.05×0.17×0.17 |
| `wheel-lm/rubber` | other | rubber | 56 | 0.05×0.17×0.17 |
| `wheel-lf/rubber` | other | rubber | 56 | 0.05×0.17×0.17 |
| `wheel-rr/rubber` | other | rubber | 56 | 0.05×0.17×0.17 |
| `wheel-rm/rubber` | other | rubber | 56 | 0.05×0.17×0.17 |
| `wheel-rf/rubber` | other | rubber | 56 | 0.05×0.17×0.17 |
| `wheel-lr/steel` | other | frame | 40 | 0.06×0.09×0.09 |
| `wheel-lm/steel` | other | frame | 40 | 0.06×0.09×0.09 |
| `wheel-lf/steel` | other | frame | 40 | 0.06×0.09×0.09 |
| `wheel-rr/steel` | other | frame | 40 | 0.06×0.09×0.09 |
| `wheel-rm/steel` | other | frame | 40 | 0.06×0.09×0.09 |
| `wheel-rf/steel` | other | frame | 40 | 0.06×0.09×0.09 |
| `wheel-lr/graphite` | other | graphite | 32 | 0.04×0.04×0.07 |
| `wheel-lm/graphite` | other | graphite | 32 | 0.04×0.04×0.07 |
| `wheel-lf/graphite` | other | graphite | 32 | 0.04×0.04×0.07 |
| `wheel-rr/graphite` | other | graphite | 32 | 0.04×0.04×0.07 |
| … 其余 7 个网格 | | | | |

