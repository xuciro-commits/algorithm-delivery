# Algorithm Lab 3D 资产与完整场景库 (3D Assets & Assembled Scenes Catalog)

> 本目录收录了专为 **Algorithm Lab（算法实验室）** 3D 数字沙盘与数字孪生建模定制的 **472 个高质量 low-poly GLB 模型与 13 套开箱即用完整大场景**。
> 所有资产均遵循 **CC0 1.0 Universal** 协议（公共领域，免版税，可商用，支持无署名再分发）。

## 🌟 推荐建模工作流：大场景基座 + 细分组件增删

为了避免从零手工搭建场景的繁琐工作，我们特别准备了 **`assembled-scenes/`** 目录：
1. **直接拖入大场景**：例如直接加载 `warehouse-high-bay-aisles.glb`（立体高位仓库）或 `car-assembly-plant-production-line.glb`（汽车产线流水线）。
2. **按需删减**：在 Three.js / Blender 中根据需求隐藏或移除不需要的节点（所有场景均为分层清晰命名的 node hierarchy）。
3. **补充微观元素**：从 `agv-warehouse/`、`aps-machining/`、`mapf-robotics/` 等分类中引入对应的 AGV、机械臂、传感器或工序件，实现高效率、高质量的沙盘构建。

## 1. 资产分类总览

| 目录 / 分类 | 模型数量 | 适用场景 / 核心内容 | 格式与技术规格 |
|---|---:|---|---|
| [`assembled-scenes/`](./assembled-scenes) · 成套完整大场景 / 沙盘基座 (Pre-Assembled Large Scenes & Environments) | **13** | 开箱即用的完整大场景沙盘（涵盖重工业机加工厂房、汽车总装流水... | GLB · 合计 34.97 MB |
| [`agv-warehouse/`](./agv-warehouse) · AGV 智能仓储与物流沙盘 (AGV & Smart Warehouse) | **110** | 包含低趴搬运 AGV、潜伏式顶升 AGV、牵引车、平衡重叉车... | GLB · 合计 15.21 MB |
| [`aps-machining/`](./aps-machining) · APS 智能制造与机加工单元 (APS Machining & Manufacturing) | **112** | 包含 CNC 数控加工中心、精密车床、立式铣床、重型冲压机、... | GLB · 合计 10.03 MB |
| [`mapf-robotics/`](./mapf-robotics) · MAPF 多智能体移动机器人与空间基建 (MAPF Mobile Robots & Telemetry) | **51** | 包含双足服务机器人、巡检机器人、配送机器人、四足机器狗、四驱... | GLB · 合计 1.32 MB |
| [`conveyors-logistics/`](./conveyors-logistics) · 连续输送与智能分拣网络 (Conveyors & Sorting Network) | **123** | 包含直段动力输送带、无动力滚筒输送线、90度弯道机、三向分流... | GLB · 合计 2.21 MB |
| [`lab-cleanroom/`](./lab-cleanroom) · 数字孪生实验室与洁净室仪器 (Digital Lab & Scientific Cleanroom) | **63** | 包含模块化实验室工作台、洁净室气淋室、生物安全柜、通风橱、高... | GLB · 合计 3.28 MB |
| **合计** | **472** | **全场景覆盖 (13 套完整大场景 + 459 个细分元模型)** | **合计 ~67.01 MB (极速加载)** |

> 注：清单（`ASSET-CATALOG.json`）中共有 475 条记录，其中 **3 个文件当前不在仓库中**（未列出，避免死链）：`assembled-scenes/car-factory-welding-framing-cell.glb`、`assembled-scenes/robot-drone-field-test-yard.glb`、`assembled-scenes/trade-counter-and-paint-mixing.glb`。补齐下载或更新清单后重跑 `python3 lab/scripts/generate-assets-doc.py`。

## 2. 13 套成套完整大场景速查 (`assembled-scenes/`)

| 文件名 | 场景名称 | 尺寸 (X×Y×Z 米) | 面数 | 推荐算法与沙盘用途 |
|---|---|---|---:|---|
| [`warehouse-high-bay-aisles.glb`](./assembled-scenes/warehouse-high-bay-aisles.glb) | **高位立体仓储与叉车巷道大场景 (Warehouse High-Bay Racking & Aisles)** | 12.0 × 6.0 × 16.0 | 422,284 | 智能仓储 / AGV 调度 / 库位优化 |
| [`car-assembly-plant-production-line.glb`](./assembled-scenes/car-assembly-plant-production-line.glb) | **汽车总装与冲压焊接自动化产线大场景 (Automotive Assembly & Production Line)** | 24.0 × 8.0 × 36.0 | 345,948 | APS 生产排程 / 复杂多工序装配 / 机器人协同 |
| [`machine-shop-day-shift-hall.glb`](./assembled-scenes/machine-shop-day-shift-hall.glb) | **机加工车间与龙门吊厂房大场景 (Day Shift Machine Shop & Crane Hall)** | 36.0 × 9.0 × 24.0 | 435,580 | APS 经典车间排程 (JSSP / FJSP) / 重型加工 |
| [`machine-shop-welding-bay-stores.glb`](./assembled-scenes/machine-shop-welding-bay-stores.glb) | **焊接工段与备件备料库场景 (Welding Bay & Stores Corner)** | 12.0 × 4.0 × 8.0 | 24,150 | APS 人工辅助工序 / 备件缓冲 |
| [`parcel-sorting-hub-logistics-hall.glb`](./assembled-scenes/parcel-sorting-hub-logistics-hall.glb) | **快递物流自动分拣中心大场景 (Parcel Depot & Sorting Logistics Hall)** | 24.0 × 5.0 × 18.0 | 48,976 | 物流自动分拣 / 动态路径规划 / 输送线网络 |
| [`conveyor-network-production-floor.glb`](./assembled-scenes/conveyor-network-production-floor.glb) | **自动化连续输送与质检一体化车间 (Conveyor Network Production Floor)** | 12.0 × 3.9 × 12.6 | 2,692 | 轻量化快速流水线沙盘 / 输送线调度 |
| [`robotics-workshop-hangar.glb`](./assembled-scenes/robotics-workshop-hangar.glb) | **机器人与无人机研发整备机库大场景 (Robotics Workshop & Drone Hangar)** | 18.0 × 6.0 × 15.0 | 50,192 | MAPF 智能体整备基地 / 多机调度与路径仿真 |
| [`science-laboratory-cleanroom-floor.glb`](./assembled-scenes/science-laboratory-cleanroom-floor.glb) | **科研实验台与洁净分析室完整沙盘 (Science Laboratory & Cleanroom Floor)** | 18.0 × 2.8 × 12.0 | 97,496 | 数字孪生实验室 / 科学仪器风格界面 |
| [`data-center-server-operations-compound.glb`](./assembled-scenes/data-center-server-operations-compound.glb) | **密集服务器数据中心与机房运维基地大场景 (Data Centre Server Operations Compound)** | 18.0 × 3.7 × 15.0 | 167,268 | 算法算力中心 / 调度集群核心机房 |
| [`nuclear-station-central-control-room-plant.glb`](./assembled-scenes/nuclear-station-central-control-room-plant.glb) | **工业中控室大屏与动力车间剖切沙盘 (Central Control Room & Cutaway Plant Floor)** | 48.3 × 12.8 × 32.0 | 401,988 | 未来工业数字指挥中心 / 全局调度大屏 |
| [`container-freight-inspection-yard.glb`](./assembled-scenes/container-freight-inspection-yard.glb) | **智能集装箱堆场与货运过磅查验大场景 (Container Yard & Customs Inspection Freight)** | 30.0 × 8.0 × 24.0 | 185,600 | 堆场调度 / 集装箱配载 / 重型物流 |
| [`vertical-farm-automated-storage-packhouse.glb`](./assembled-scenes/vertical-farm-automated-storage-packhouse.glb) | **垂直立体密集仓储与穿梭车包装车间大场景 (Vertical Automated Storage & Packhouse)** | 16.0 × 6.5 × 14.0 | 216,576 | 密集立库 (AS/RS) / 四向穿梭车调度 |
| [`automated-food-processing-confectionery-line.glb`](./assembled-scenes/automated-food-processing-confectionery-line.glb) | **自动化连续食品流水线工厂大场景 (Automated Continuous Food Processing Line)** | 25.0 × 4.5 × 15.0 | 143,510 | 流程型与混合型 APS 排程 / 管道连续流 |

## 3. 使用方法 (Three.js & React Three Fiber)

### React Three Fiber 加载大场景基座

```tsx
import { useGLTF } from "@react-three/drei";

export function WarehouseScene() {
  // 1. 载入立体仓库大场景基座
  const { scene } = useGLTF("./assembled-scenes/warehouse-high-bay-aisles.glb");

  return (
    <group>
      <primitive object={scene} />
      {/* 2. 在大场景上叠加自定义动态 AGV 单元 */}
      <DynamicAgvRobot position={[2, 0, 4]} />
    </group>
  );
}
useGLTF.preload("./assembled-scenes/warehouse-high-bay-aisles.glb");
```

## 4. 各细分分类元模型清单 (元模型库)

### AGV 智能仓储与物流沙盘 (AGV & Smart Warehouse) (`agv-warehouse/`, 共 110 个)

包含低趴搬运 AGV、潜伏式顶升 AGV、牵引车、平衡重叉车、手动液压托盘车、高位托盘货架、悬臂式货架、仓储笼、料箱托盘、地面导引线、安全防护栏、装卸货平台及叉车充电桩等。

| 文件名 | 名称 / 说明 | 尺寸 (X×Y×Z 米) | 面数 (Triangles) | 是否带动画 |
|---|---|---|---:|:---:|
| [`agv-loader.glb`](./agv-warehouse/agv-loader.glb) | Agv Loader (Robots and Drones Kit) | 0.70 × 0.87 × 0.90 | 620 | — |
| [`blank-stack.glb`](./agv-warehouse/blank-stack.glb) | Blank Stack (Car Factory Production Line) | 1.70 × 0.55 × 1.20 | 2,160 | — |
| [`wheel-and-tyre-stack.glb`](./agv-warehouse/wheel-and-tyre-stack.glb) | Wheel And Tyre Stack (Car Factory Production Line) | 1.66 × 0.98 × 1.63 | 1,880 | — |
| [`dashboard-delivery-cart.glb`](./agv-warehouse/dashboard-delivery-cart.glb) | Dashboard Delivery Cart (Car Factory Production Line) | 1.60 × 1.24 × 1.10 | 1,132 | — |
| [`battery-pack-on-pallet.glb`](./agv-warehouse/battery-pack-on-pallet.glb) | Battery Pack On Pallet (Car Factory Production Line) | 1.90 × 0.63 × 1.30 | 1,296 | — |
| [`kitting-cart.glb`](./agv-warehouse/kitting-cart.glb) | Kitting Cart (Car Factory Production Line) | 1.16 × 1.41 × 1.40 | 1,780 | — |
| [`forklift.glb`](./agv-warehouse/forklift.glb) | Forklift (Car Factory Production Line) | 1.42 × 2.65 × 3.10 | 2,728 | — |
| [`tugger-train-tractor.glb`](./agv-warehouse/tugger-train-tractor.glb) | Tugger Train Tractor (Car Factory Production Line) | 1.03 × 2.04 × 5.10 | 3,336 | — |
| [`pallet-with-parts-crates.glb`](./agv-warehouse/pallet-with-parts-crates.glb) | Pallet With Parts Crates (Car Factory Production Line) | 1.24 × 0.93 × 0.80 | 1,620 | — |
| [`mesh-stillage.glb`](./agv-warehouse/mesh-stillage.glb) | Mesh Stillage (Car Factory Production Line) | 1.20 × 1.10 × 0.87 | 4,428 | — |
| [`agv-mover.glb`](./agv-warehouse/agv-mover.glb) | AGV Mover (Car Factory Production Line) | 1.30 × 0.50 × 2.08 | 1,496 | — |
| [`seated-forklift-driver.glb`](./agv-warehouse/seated-forklift-driver.glb) | Seated Forklift Driver (Car Factory Production Line) | 0.75 × 1.57 × 0.93 | 2,052 | — |
| [`framing-cell-and-press-feed.glb`](./agv-warehouse/framing-cell-and-press-feed.glb) | Framing Cell and Press Feed (Car Factory Production Line) | 24.00 × 4.43 × 12.32 | 50,584 | — |
| [`concrete-floor-tile-with-walkway-lines-6-m.glb`](./agv-warehouse/concrete-floor-tile-with-walkway-lines-6-m.glb) | Concrete floor tile with walkway lines, 6 m (Machine Shop and Factory Hall) | 6.00 × 0.13 × 6.00 | 60 | — |
| [`concrete-floor-tile-plain-6-m.glb`](./agv-warehouse/concrete-floor-tile-plain-6-m.glb) | Concrete floor tile, plain 6 m (Machine Shop and Factory Hall) | 6.00 × 0.13 × 6.00 | 36 | — |
| [`pallet-racking-bay-two-levels.glb`](./agv-warehouse/pallet-racking-bay-two-levels.glb) | Pallet racking bay, two levels (Machine Shop and Factory Hall) | 2.90 × 3.72 × 1.00 | 396 | — |
| [`counterbalance-forklift-truck.glb`](./agv-warehouse/counterbalance-forklift-truck.glb) | Counterbalance forklift truck (Machine Shop and Factory Hall) | 1.34 × 2.54 × 3.26 | 3,376 | — |
| [`hand-pallet-truck.glb`](./agv-warehouse/hand-pallet-truck.glb) | Hand pallet truck (Machine Shop and Factory Hall) | 0.64 × 1.21 × 1.85 | 416 | — |
| [`yellow-safety-bollard.glb`](./agv-warehouse/yellow-safety-bollard.glb) | Yellow safety bollard (Machine Shop and Factory Hall) | 0.24 × 0.91 × 0.24 | 204 | — |
| [`welding-bay-and-stores-corner.glb`](./agv-warehouse/welding-bay-and-stores-corner.glb) | Welding bay and stores corner (Machine Shop and Factory Hall) | 12.40 × 7.27 × 12.44 | 44,088 | — |
| *(其余 90 个模型)* | *(见 `ASSET-CATALOG.json` 或对应目录)* | — | — | — |

### APS 智能制造与机加工单元 (APS Machining & Manufacturing) (`aps-machining/`, 共 112 个)

包含 CNC 数控加工中心、精密车床、立式铣床、重型冲压机、数控折弯机、六轴焊接机器人、工装夹具、安灯状态指示塔、高空行车轨道及机加工件工序零件等。

| 文件名 | 名称 / 说明 | 尺寸 (X×Y×Z 米) | 面数 (Triangles) | 是否带动画 |
|---|---|---|---:|:---:|
| [`bare-rolling-chassis.glb`](./aps-machining/bare-rolling-chassis.glb) | Bare Rolling Chassis (Car Factory Production Line) | 1.74 × 0.97 × 3.57 | 2,936 | — |
| [`primed-shell.glb`](./aps-machining/primed-shell.glb) | Primed Shell (Car Factory Production Line) | 2.00 × 1.25 × 3.98 | 4,116 | — |
| [`painted-shell-on-skid.glb`](./aps-machining/painted-shell-on-skid.glb) | Painted Shell On Skid (Car Factory Production Line) | 2.00 × 1.72 × 3.98 | 4,548 | — |
| [`stamping-press.glb`](./aps-machining/stamping-press.glb) | Stamping Press (Car Factory Production Line) | 3.85 × 5.60 × 2.96 | 2,148 | — |
| [`steel-coil-on-cradle.glb`](./aps-machining/steel-coil-on-cradle.glb) | Steel Coil On Cradle (Car Factory Production Line) | 1.90 × 1.80 × 1.68 | 1,092 | — |
| [`stamped-door-panel-rack.glb`](./aps-machining/stamped-door-panel-rack.glb) | Stamped Door Panel Rack (Car Factory Production Line) | 2.30 × 1.64 × 1.10 | 2,052 | — |
| [`six-axis-welding-robot.glb`](./aps-machining/six-axis-welding-robot.glb) | Six Axis Welding Robot (Car Factory Production Line) | 1.10 × 2.42 × 3.29 | 1,512 | — |
| [`robot-fence-gate.glb`](./aps-machining/robot-fence-gate.glb) | Robot Fence Gate (Car Factory Production Line) | 2.18 × 2.20 × 0.35 | 2,052 | — |
| [`spot-weld-gun-on-balancer.glb`](./aps-machining/spot-weld-gun-on-balancer.glb) | Spot Weld Gun On Balancer (Car Factory Production Line) | 0.72 × 3.12 × 2.33 | 1,076 | — |
| [`tool-changer-rack.glb`](./aps-machining/tool-changer-rack.glb) | Tool Changer Rack (Car Factory Production Line) | 2.20 × 1.74 × 0.90 | 2,224 | — |
| [`paint-booth-module.glb`](./aps-machining/paint-booth-module.glb) | Paint Booth Module (Car Factory Production Line) | 5.00 × 4.40 × 6.00 | 2,592 | — |
| [`paint-robot-with-bell-atomiser.glb`](./aps-machining/paint-robot-with-bell-atomiser.glb) | Paint Robot With Bell Atomiser (Car Factory Production Line) | 1.10 × 2.42 × 3.12 | 1,284 | — |
| [`oven-tunnel-module.glb`](./aps-machining/oven-tunnel-module.glb) | Oven Tunnel Module (Car Factory Production Line) | 5.10 × 6.10 × 6.00 | 2,212 | — |
| [`oven-end-door-module.glb`](./aps-machining/oven-end-door-module.glb) | Oven End Door Module (Car Factory Production Line) | 5.00 × 4.40 × 1.48 | 1,080 | — |
| [`paint-mix-cabinet.glb`](./aps-machining/paint-mix-cabinet.glb) | Paint Mix Cabinet (Car Factory Production Line) | 2.40 × 2.34 × 0.92 | 1,620 | — |
| [`air-handling-unit.glb`](./aps-machining/air-handling-unit.glb) | Air Handling Unit (Car Factory Production Line) | 3.88 × 4.33 × 2.44 | 2,580 | — |
| [`colour-sample-board.glb`](./aps-machining/colour-sample-board.glb) | Colour Sample Board (Car Factory Production Line) | 1.20 × 1.70 × 0.60 | 1,188 | — |
| [`door-removal-fixture.glb`](./aps-machining/door-removal-fixture.glb) | Door Removal Fixture (Car Factory Production Line) | 1.40 × 1.52 × 1.00 | 1,188 | — |
| [`glass-fitting-robot.glb`](./aps-machining/glass-fitting-robot.glb) | Glass Fitting Robot (Car Factory Production Line) | 1.20 × 2.42 × 3.77 | 1,564 | — |
| [`wheel-fitting-station.glb`](./aps-machining/wheel-fitting-station.glb) | Wheel Fitting Station (Car Factory Production Line) | 2.53 × 2.76 × 1.45 | 1,296 | — |
| *(其余 92 个模型)* | *(见 `ASSET-CATALOG.json` 或对应目录)* | — | — | — |

### MAPF 多智能体移动机器人与空间基建 (MAPF Mobile Robots & Telemetry) (`mapf-robotics/`, 共 51 个)

包含双足服务机器人、巡检机器人、配送机器人、四足机器狗、四驱/六驱探索车、履带式 UGV、台面/落地机械臂、无线遥测基站、无人机起降坪及圆形/方形无线充电底座等。

| 文件名 | 名称 / 说明 | 尺寸 (X×Y×Z 米) | 面数 (Triangles) | 是否带动画 |
|---|---|---|---:|:---:|
| [`humanoid-android.glb`](./mapf-robotics/humanoid-android.glb) | Humanoid Android (Robots and Drones Kit) | 0.72 × 1.73 × 0.36 | 1,504 | — |
| [`humanoid-worker.glb`](./mapf-robotics/humanoid-worker.glb) | Humanoid Worker (Robots and Drones Kit) | 0.80 × 1.79 × 0.51 | 1,528 | — |
| [`service-robot-biped.glb`](./mapf-robotics/service-robot-biped.glb) | Service Robot Biped (Robots and Drones Kit) | 0.66 × 1.69 × 0.36 | 1,504 | — |
| [`security-patrol-bot.glb`](./mapf-robotics/security-patrol-bot.glb) | Security Patrol Bot (Robots and Drones Kit) | 0.67 × 1.71 × 0.87 | 644 | — |
| [`delivery-bot.glb`](./mapf-robotics/delivery-bot.glb) | Delivery Bot (Robots and Drones Kit) | 0.70 × 0.78 × 0.93 | 596 | — |
| [`vacuum-bot.glb`](./mapf-robotics/vacuum-bot.glb) | Vacuum Bot (Robots and Drones Kit) | 0.60 × 0.34 × 0.59 | 608 | — |
| [`quadruped-scout.glb`](./mapf-robotics/quadruped-scout.glb) | Quadruped Scout (Robots and Drones Kit) | 0.77 × 1.11 × 1.20 | 836 | — |
| [`quadruped-carrier.glb`](./mapf-robotics/quadruped-carrier.glb) | Quadruped Carrier (Robots and Drones Kit) | 0.97 × 1.24 × 1.60 | 860 | — |
| [`rover-4wd.glb`](./mapf-robotics/rover-4wd.glb) | Rover 4wd (Robots and Drones Kit) | 0.77 × 1.14 × 1.01 | 676 | — |
| [`rover-6wd.glb`](./mapf-robotics/rover-6wd.glb) | Rover 6wd (Robots and Drones Kit) | 0.80 × 0.64 × 1.52 | 736 | — |
| [`tracked-ugv.glb`](./mapf-robotics/tracked-ugv.glb) | Tracked Ugv (Robots and Drones Kit) | 0.96 × 1.06 × 1.28 | 1,036 | — |
| [`robot-arm-bench.glb`](./mapf-robotics/robot-arm-bench.glb) | Robot Arm Bench (Robots and Drones Kit) | 0.40 × 1.29 × 0.72 | 488 | — |
| [`robot-arm-floor.glb`](./mapf-robotics/robot-arm-floor.glb) | Robot Arm Floor (Robots and Drones Kit) | 1.00 × 2.54 × 1.55 | 500 | — |
| [`telepresence-bot.glb`](./mapf-robotics/telepresence-bot.glb) | Telepresence Bot (Robots and Drones Kit) | 0.50 × 1.60 × 0.30 | 368 | — |
| [`exoskeleton-frame.glb`](./mapf-robotics/exoskeleton-frame.glb) | Exoskeleton Frame (Robots and Drones Kit) | 0.52 × 1.33 × 0.50 | 168 | — |
| [`scrubber-bot.glb`](./mapf-robotics/scrubber-bot.glb) | Scrubber Bot (Robots and Drones Kit) | 0.63 × 0.71 × 0.77 | 340 | — |
| [`hexapod-inspection.glb`](./mapf-robotics/hexapod-inspection.glb) | Hexapod Inspection (Robots and Drones Kit) | 0.85 × 0.72 × 0.64 | 464 | — |
| [`quadcopter-camera.glb`](./mapf-robotics/quadcopter-camera.glb) | Quadcopter Camera (Robots and Drones Kit) | 0.83 × 0.46 × 0.57 | 508 | — |
| [`quadcopter-cargo.glb`](./mapf-robotics/quadcopter-cargo.glb) | Quadcopter Cargo (Robots and Drones Kit) | 1.14 × 0.61 × 0.74 | 580 | — |
| [`quadcopter-inspection.glb`](./mapf-robotics/quadcopter-inspection.glb) | Quadcopter Inspection (Robots and Drones Kit) | 0.57 × 0.38 × 0.43 | 652 | — |
| *(其余 31 个模型)* | *(见 `ASSET-CATALOG.json` 或对应目录)* | — | — | — |

### 连续输送与智能分拣网络 (Conveyors & Sorting Network) (`conveyors-logistics/`, 共 123 个)

包含直段动力输送带、无动力滚筒输送线、90度弯道机、三向分流器、四向分拣交叉口、条码扫描拱门、动态称重输送机、垂直升降机及包裹滑槽等。

| 文件名 | 名称 / 说明 | 尺寸 (X×Y×Z 米) | 面数 (Triangles) | 是否带动画 |
|---|---|---|---:|:---:|
| [`trimmed-body-on-carrier.glb`](./conveyors-logistics/trimmed-body-on-carrier.glb) | Trimmed Body On Carrier (Car Factory Production Line) | 2.00 × 1.31 × 4.04 | 6,484 | — |
| [`stamped-roof-panel-rack.glb`](./conveyors-logistics/stamped-roof-panel-rack.glb) | Stamped Roof Panel Rack (Car Factory Production Line) | 2.30 × 1.22 × 1.90 | 2,268 | — |
| [`robot-fence-panel.glb`](./conveyors-logistics/robot-fence-panel.glb) | Robot Fence Panel (Car Factory Production Line) | 2.18 × 2.20 × 0.30 | 2,592 | — |
| [`framing-station-jig.glb`](./conveyors-logistics/framing-station-jig.glb) | Framing Station Jig (Car Factory Production Line) | 3.90 × 3.86 × 3.10 | 2,592 | — |
| [`body-carrier-skid.glb`](./conveyors-logistics/body-carrier-skid.glb) | Body Carrier Skid (Car Factory Production Line) | 1.54 × 0.72 × 4.20 | 1,424 | — |
| [`skid-conveyor-straight.glb`](./conveyors-logistics/skid-conveyor-straight.glb) | Skid Conveyor Straight (Car Factory Production Line) | 1.48 × 0.69 × 2.00 | 1,604 | — |
| [`skid-conveyor-curve.glb`](./conveyors-logistics/skid-conveyor-curve.glb) | Skid Conveyor Curve (Car Factory Production Line) | 1.78 × 0.61 × 1.78 | 4,172 | — |
| [`sealer-station.glb`](./conveyors-logistics/sealer-station.glb) | Sealer Station (Car Factory Production Line) | 3.18 × 3.57 × 1.06 | 1,692 | — |
| [`e-coat-dip-tank.glb`](./conveyors-logistics/e-coat-dip-tank.glb) | E Coat Dip Tank (Car Factory Production Line) | 7.10 × 3.47 × 3.58 | 2,592 | — |
| [`overhead-rail-straight.glb`](./conveyors-logistics/overhead-rail-straight.glb) | Overhead Rail Straight (Car Factory Production Line) | 1.93 × 4.62 × 6.00 | 1,836 | — |
| [`overhead-rail-curve.glb`](./conveyors-logistics/overhead-rail-curve.glb) | Overhead Rail Curve (Car Factory Production Line) | 4.52 × 4.40 × 4.52 | 1,432 | — |
| [`overhead-carrier-hanger.glb`](./conveyors-logistics/overhead-carrier-hanger.glb) | Overhead Carrier Hanger (Car Factory Production Line) | 1.66 × 2.05 × 2.14 | 1,456 | — |
| [`marriage-station-lift.glb`](./conveyors-logistics/marriage-station-lift.glb) | Marriage Station Lift (Car Factory Production Line) | 5.25 × 2.46 × 2.61 | 2,160 | — |
| [`skillet-conveyor-platform.glb`](./conveyors-logistics/skillet-conveyor-platform.glb) | Skillet Conveyor Platform (Car Factory Production Line) | 3.14 × 0.43 × 4.00 | 1,512 | — |
| [`hall-wall-cladding-bay.glb`](./conveyors-logistics/hall-wall-cladding-bay.glb) | Hall Wall Cladding Bay (Car Factory Production Line) | 5.60 × 8.00 × 0.31 | 252 | — |
| [`mezzanine-walkway-bay.glb`](./conveyors-logistics/mezzanine-walkway-bay.glb) | Mezzanine Walkway Bay (Car Factory Production Line) | 6.00 × 4.70 × 2.21 | 360 | — |
| [`mezzanine-stair.glb`](./conveyors-logistics/mezzanine-stair.glb) | Mezzanine Stair (Car Factory Production Line) | 1.54 × 4.37 × 4.71 | 660 | — |
| [`straight-powered-conveyor.glb`](./conveyors-logistics/straight-powered-conveyor.glb) | Straight powered conveyor (Factory Conveyor Network) | 1.20 × 0.93 × 2.00 | 192 | — |
| [`free-roller-conveyor.glb`](./conveyors-logistics/free-roller-conveyor.glb) | Free roller conveyor (Factory Conveyor Network) | 1.20 × 0.96 × 2.00 | 480 | — |
| [`short-bridge-conveyor.glb`](./conveyors-logistics/short-bridge-conveyor.glb) | Short bridge conveyor (Factory Conveyor Network) | 1.20 × 0.93 × 1.00 | 144 | — |
| *(其余 103 个模型)* | *(见 `ASSET-CATALOG.json` 或对应目录)* | — | — | — |

### 数字孪生实验室与洁净室仪器 (Digital Lab & Scientific Cleanroom) (`lab-cleanroom/`, 共 63 个)

包含模块化实验室工作台、洁净室气淋室、生物安全柜、通风橱、高速离心机、高压灭菌锅、超低温冷冻柜、分析天平、分光光度计、试管架及移液器等。

| 文件名 | 名称 / 说明 | 尺寸 (X×Y×Z 米) | 面数 (Triangles) | 是否带动画 |
|---|---|---|---:|:---:|
| [`bench-run-module.glb`](./lab-cleanroom/bench-run-module.glb) | Bench Run Module (Science Laboratory and Cleanroom) | 1.00 × 0.90 × 0.77 | 1,308 | — |
| [`bench-run-drawer-module.glb`](./lab-cleanroom/bench-run-drawer-module.glb) | Bench Run Drawer Module (Science Laboratory and Cleanroom) | 1.00 × 0.90 × 0.77 | 1,416 | — |
| [`bench-corner-module.glb`](./lab-cleanroom/bench-corner-module.glb) | Bench Corner Module (Science Laboratory and Cleanroom) | 1.00 × 0.90 × 1.02 | 972 | — |
| [`wash-up-sink-unit.glb`](./lab-cleanroom/wash-up-sink-unit.glb) | Wash Up Sink Unit (Science Laboratory and Cleanroom) | 1.00 × 1.17 × 0.75 | 2,400 | — |
| [`reagent-shelf-over-bench.glb`](./lab-cleanroom/reagent-shelf-over-bench.glb) | Reagent Shelf Over Bench (Science Laboratory and Cleanroom) | 1.00 × 0.87 × 0.28 | 1,580 | — |
| [`fume-cupboard.glb`](./lab-cleanroom/fume-cupboard.glb) | Fume Cupboard (Science Laboratory and Cleanroom) | 1.50 × 2.70 × 0.88 | 3,160 | — |
| [`fume-cupboard-sash-open.glb`](./lab-cleanroom/fume-cupboard-sash-open.glb) | Fume Cupboard Sash Open (Science Laboratory and Cleanroom) | 1.50 × 2.70 × 0.88 | 3,160 | — |
| [`biosafety-cabinet.glb`](./lab-cleanroom/biosafety-cabinet.glb) | Biosafety Cabinet (Science Laboratory and Cleanroom) | 1.30 × 1.97 × 0.83 | 2,472 | — |
| [`eyewash-station.glb`](./lab-cleanroom/eyewash-station.glb) | Eyewash Station (Science Laboratory and Cleanroom) | 0.36 × 1.64 × 0.40 | 944 | — |
| [`safety-shower.glb`](./lab-cleanroom/safety-shower.glb) | Safety Shower (Science Laboratory and Cleanroom) | 0.40 × 2.19 × 0.79 | 1,348 | — |
| [`gas-tap-service-spine.glb`](./lab-cleanroom/gas-tap-service-spine.glb) | Gas Tap Service Spine (Science Laboratory and Cleanroom) | 1.00 × 0.56 × 0.17 | 1,688 | — |
| [`chemical-store-cabinet.glb`](./lab-cleanroom/chemical-store-cabinet.glb) | Chemical Store Cabinet (Science Laboratory and Cleanroom) | 0.90 × 2.09 × 0.66 | 2,308 | — |
| [`chemical-store-cabinet-open.glb`](./lab-cleanroom/chemical-store-cabinet-open.glb) | Chemical Store Cabinet Open (Science Laboratory and Cleanroom) | 1.01 × 2.09 × 1.06 | 2,308 | — |
| [`solvent-bottle-shelf.glb`](./lab-cleanroom/solvent-bottle-shelf.glb) | Solvent Bottle Shelf (Science Laboratory and Cleanroom) | 0.94 × 0.77 × 0.34 | 3,024 | — |
| [`sharps-bin.glb`](./lab-cleanroom/sharps-bin.glb) | Sharps Bin (Science Laboratory and Cleanroom) | 0.32 × 0.43 × 0.30 | 540 | — |
| [`waste-bin-set.glb`](./lab-cleanroom/waste-bin-set.glb) | Waste Bin Set (Science Laboratory and Cleanroom) | 1.16 × 0.74 × 0.40 | 1,740 | — |
| [`lab-stool.glb`](./lab-cleanroom/lab-stool.glb) | Lab Stool (Science Laboratory and Cleanroom) | 0.49 × 0.60 × 0.51 | 888 | — |
| [`lab-stool-tall.glb`](./lab-cleanroom/lab-stool-tall.glb) | Lab Stool Tall (Science Laboratory and Cleanroom) | 0.49 × 0.82 × 0.51 | 888 | — |
| [`document-desk-with-monitor.glb`](./lab-cleanroom/document-desk-with-monitor.glb) | Document Desk With Monitor (Science Laboratory and Cleanroom) | 1.30 × 1.32 × 0.70 | 2,508 | — |
| [`whiteboard.glb`](./lab-cleanroom/whiteboard.glb) | Whiteboard (Science Laboratory and Cleanroom) | 1.62 × 1.83 × 0.50 | 1,652 | — |
| *(其余 43 个模型)* | *(见 `ASSET-CATALOG.json` 或对应目录)* | — | — | — |

