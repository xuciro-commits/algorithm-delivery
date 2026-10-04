/**
 * 仓储拓扑生成与派生（SRS §2.1 / §2.4）。
 *
 * 三条不可让步的规则：
 *   1. **库位由拓扑推导**：`racks × levels × bays × depths`，不接受调用方直接给库位数；
 *   2. **不同拓扑 ≠ 同一模型**：多层穿梭车 + 货物提升机、四向穿梭车 + 跨层转运、
 *      单深位 / 多深位货架 是**不同的物理结构**，在设备能力（capability）与可达性上分开表达；
 *   3. **坐标与距离由几何推导**：巷道运行距离、层间提升距离、跨巷横移距离都来自真实尺度，
 *      不允许"用欧氏距离近似设备运行成本"（SRS §1.3）。
 *
 * 坐标约定（全仓库统一，实验室三维场景直接使用）：
 *   x = 巷道长度方向（bay 递进方向）
 *   y = 竖直方向（层高递进方向）
 *   z = 巷道宽度方向（aisle 并排方向；深度 depth 在货架内沿 ±z 递进）
 */

import type {
  AisleSpec,
  AreaSpec,
  BufferSpec,
  DeviceSpec,
  LevelSpec,
  LocationRecord,
  RackSpec,
  StationSpec,
  WarehouseLink,
  WarehouseNode,
  WarehouseTopology,
} from '../contract/types.ts';
import { round } from '../contract/util.ts';

export type TopologyTemplate =
  | 'manual-hybrid'
  | 'asrs-single-deep'
  | 'asrs-double-deep'
  | 'asrs-multi-deep'
  | 'asrs-two-block'
  | 'asrs-four-way'
  | 'asrs-hybrid-multi-area';

export interface TopologyParams {
  template: TopologyTemplate;
  /** 巷道数（每个巷道两侧各一排货架）。 */
  aisles: number;
  /** 层数（多层立库）。 */
  levels: number;
  /** 每排货架的 bay 数（沿巷道长度方向的库位列数）。 */
  bays: number;
  /** 深度：1 = 单深位，2 = 双深位，≥3 = 多深位。 */
  depths: number;
  /** 每条巷道的穿梭车数量（每个受服务层）。 */
  shuttlesPerAisle: number;
  /** 提升机配置：'pallet' = 货物提升机（运货），'shuttle' = 巷道提升机（运穿梭车）。 */
  liftMode: 'pallet' | 'shuttle' | 'both';
  /** 提升机数量（每个货架块 / 每条巷道）。 */
  liftsPerBlock: number;
  /** 手工拣选区是否包含（多区域场景）。 */
  includeManualArea: boolean;
  /** 手工拣选区的货位数（货架位，非立库库位）。 */
  manualLocations: number;
  /** 出入库站台数（每侧）。 */
  inboundStations: number;
  outboundStations: number;
  /** 站台缓存位数。 */
  stationBuffer: number;
  /** 缓存区容量（立库端）。 */
  bufferCapacity: number;
  /** 输送机速度（m/s），0 = 不建输送机（纯穿梭车 + 提升机形态）。 */
  conveyorSpeed_mps: number;
  /** 是否允许四向穿梭车走横巷（四向拓扑必须为 true）。 */
  crossAisle: boolean;
  /** bay 间距（米）。 */
  bayWidth_m: number;
  /** 层高（米）。 */
  levelHeight_m: number;
  /** 库位进深（米）。 */
  depth_m: number;
  /** 库位宽度（米，通常与 bay 间距一致或略小）。 */
  locationWidth_m: number;
  /** 库位最大载重（kg）与容积（m³）。 */
  maxWeight_kg: number;
  maxVolume_m3: number;
  /** 巷道两端预留的横巷宽度（米）。 */
  crossAisleWidth_m: number;
  /** 站台区深度（米）。 */
  stationDepth_m: number;
  /** 站台交接时间（秒）。 */
  handover_s: number;
}

/** 输入输出结合的分区（同一批货物在不同分区里走不同的物理路径）。 */
export interface TopologyResult {
  topology: WarehouseTopology;
  locations: LocationRecord[];
  /** 结构化统计（面板与实验室直接显示，避免前端重算）。 */
  stats: {
    locations: number;
    availableLocations: number;
    aisles: number;
    levels: number;
    bays: number;
    depths: number;
    devices: number;
    stations: number;
    footprint_m2: number;
    /** 立库区体积（用于空间利用率的分母）。 */
    asrsVolume_m3: number;
    manualLocations: number;
  };
}

const DEFAULTS: TopologyParams = {
  template: 'asrs-single-deep',
  aisles: 4,
  levels: 4,
  bays: 24,
  depths: 1,
  shuttlesPerAisle: 1,
  liftMode: 'pallet',
  liftsPerBlock: 1,
  includeManualArea: false,
  manualLocations: 0,
  inboundStations: 2,
  outboundStations: 2,
  stationBuffer: 4,
  bufferCapacity: 8,
  conveyorSpeed_mps: 0.8,
  crossAisle: false,
  bayWidth_m: 1.4,
  levelHeight_m: 1.8,
  depth_m: 1.1,
  locationWidth_m: 1.3,
  maxWeight_kg: 1000,
  maxVolume_m3: 1.6,
  crossAisleWidth_m: 3.2,
  stationDepth_m: 6,
  handover_s: 12,
};

export const TOPOLOGY_TEMPLATE_LABEL: Record<TopologyTemplate, string> = {
  'manual-hybrid': '人工拣选 + 单层货架',
  'asrs-single-deep': '单深位立库（多层穿梭车 + 货物提升机）',
  'asrs-double-deep': '双深位立库（含整列倒垛）',
  'asrs-multi-deep': '多深位密集立库（3–4 深位，遮挡与临时搬迁）',
  'asrs-two-block': '双货架块 + 共享提升机（提升机不可互相穿越）',
  'asrs-four-way': '四向穿梭车网格（横巷交叉口与单车道互斥）',
  'asrs-hybrid-multi-area': '多区域混合仓（收货/拣选/立库/出库）',
};

export function makeTopologyParams(partial: Partial<TopologyParams> & { template: TopologyTemplate }): TopologyParams {
  const merged = { ...DEFAULTS, ...partial };
  // 拓扑自洽修正：四向穿梭车必须能走横巷；多深位必须允许整列倒垛。
  if (merged.template === 'asrs-four-way') merged.crossAisle = true;
  if (merged.template === 'asrs-two-block' && merged.liftMode === 'pallet') merged.liftMode = 'both';
  if (merged.depths >= 2 && merged.liftMode === 'shuttle') merged.liftMode = 'both';
  merged.aisles = Math.max(1, Math.round(merged.aisles));
  merged.levels = Math.max(1, Math.round(merged.levels));
  merged.bays = Math.max(2, Math.round(merged.bays));
  merged.depths = Math.max(1, Math.round(merged.depths));
  return merged;
}

function levelsOf(count: number, height_m: number): LevelSpec[] {
  const out: LevelSpec[] = [];
  for (let i = 0; i < count; i += 1) out.push({ level: i + 1, y_m: round(height_m * i, 4) });
  return out;
}

/**
 * 生成拓扑（模板 → 区域 / 货架 / 巷道 / 节点 / 通道 / 站台 / 缓存 / 设备）。
 *
 * 生成过程是**纯函数**：同样的参数必然得到同样的拓扑与同样的库位 id，
 * 这样"场景 → 问题 → 解"三者可以逐位复现（SRS §6.3）。
 */
export function buildTopology(params: TopologyParams): TopologyResult {
  const p = makeTopologyParams(params);
  const nodes: WarehouseNode[] = [];
  const links: WarehouseLink[] = [];
  const racks: RackSpec[] = [];
  const aisles: AisleSpec[] = [];
  const areas: AreaSpec[] = [];
  const stations: StationSpec[] = [];
  const buffers: BufferSpec[] = [];
  const devices: DeviceSpec[] = [];

  const levels = levelsOf(p.levels, p.levelHeight_m);
  const aisleLength_m = p.bays * p.bayWidth_m;
  const blockDepthPerSide = p.depths * p.depth_m;
  // 巷道中心线间隔 = 两侧货架深度 + 巷道净宽（2.0 m，工程常见值）
  const aislePitch = blockDepthPerSide * 2 + 2.0;
  const isAsrs = p.template !== 'manual-hybrid';
  const hasCross = p.crossAisle || p.template === 'asrs-four-way' || p.template === 'asrs-two-block';

  const originX = 0;
  const originZ = 0;

  /* ---------------- 区域 ---------------- */
  const asrsArea: AreaSpec = {
    id: 'AREA-ASRS',
    name: '自动化立库区',
    kind: 'asrs',
    center: [originX + aisleLength_m / 2, originZ + ((p.aisles - 1) * aislePitch) / 2],
    size: [aisleLength_m + p.crossAisleWidth_m * 2, p.aisles * aislePitch],
    height_m: p.levels * p.levelHeight_m + 1.2,
    trafficSpeed_mps: 2.2,
  };
  if (isAsrs) areas.push(asrsArea);

  const inboundArea: AreaSpec = {
    id: 'AREA-IN',
    name: '收货 / 入库区',
    kind: 'receiving',
    center: [originX - p.crossAisleWidth_m / 2 - p.stationDepth_m / 2 - 1, asrsArea.center[1]],
    size: [p.stationDepth_m, Math.max(6, p.aisles * aislePitch * 0.6)],
    height_m: 5.5,
    trafficSpeed_mps: 1.6,
  };
  const outboundArea: AreaSpec = {
    id: 'AREA-OUT',
    name: '出库 / 发运区',
    kind: 'shipping',
    center: [originX + aisleLength_m + p.crossAisleWidth_m / 2 + p.stationDepth_m / 2 + 1, asrsArea.center[1]],
    size: [p.stationDepth_m, Math.max(6, p.aisles * aislePitch * 0.6)],
    height_m: 5.5,
    trafficSpeed_mps: 1.6,
  };
  areas.push(inboundArea, outboundArea);

  let manualArea: AreaSpec | null = null;
  if (p.includeManualArea) {
    manualArea = {
      id: 'AREA-MANUAL',
      name: '人工拣选区',
      kind: 'picking',
      center: [originX + aisleLength_m / 2, originZ - (p.aisles * aislePitch) / 2 - 8],
      size: [aisleLength_m, 12],
      height_m: 3.6,
      trafficSpeed_mps: 1.2,
    };
    areas.push(manualArea);
  }

  /* ---------------- 货架 + 巷道 ---------------- */
  // 货架块数量：默认每 2 条巷道为一块（共享提升机），asrs-two-block 强制 2 块。
  const blocks = p.template === 'asrs-two-block' ? 2 : Math.max(1, Math.ceil(p.aisles / 4));
  const aislesPerBlock = Math.max(1, Math.ceil(p.aisles / blocks));

  for (let a = 0; a < p.aisles; a += 1) {
    const aisleId = `A${String(a + 1).padStart(2, '0')}`;
    const blockIndex = Math.min(blocks - 1, Math.floor(a / aislesPerBlock));
    const zCenter = originZ + a * aislePitch;
    for (const side of ['F', 'B'] as const) {
      const rackId = `${aisleId}${side}`;
      const sign = side === 'F' ? -1 : 1;
      // 深度 1 的库位中心：从巷道中心线向外偏移 (0.5·depth + 巷道半宽 1.0)
      const zFirst = zCenter + sign * (1.0 + p.depth_m / 2);
      racks.push({
        id: rackId,
        areaId: isAsrs ? asrsArea.id : manualArea?.id ?? asrsArea.id,
        aisleId,
        kind: p.depths === 1 ? 'single-deep' : p.depths === 2 ? 'double-deep' : 'multi-deep',
        bays: p.bays,
        depths: p.depths,
        levels,
        locationSize: { width_m: p.locationWidth_m, depth_m: p.depth_m, height_m: p.levelHeight_m },
        maxWeight_kg: p.maxWeight_kg,
        maxVolume_m3: p.maxVolume_m3,
        origin: [originX + p.bayWidth_m / 2, levels[0].y_m, zFirst],
        bayAxis: [1, 0],
        depthAxis: [0, sign],
        supportsRestack: p.depths >= 2,
      });
    }
    aisles.push({
      id: aisleId,
      areaId: asrsArea.id,
      endNodeIds: [`N-${aisleId}-L1-W`, `N-${aisleId}-L1-E`],
      axis: [1, 0],
      length_m: aisleLength_m,
      bidirectional: true,
      level: 1,
      rackIds: [`${aisleId}F`, `${aisleId}B`],
    });
    void blockIndex;
  }

  if (manualArea) {
    // 人工拣选：单层货架（拣选位），深度 1，两层。
    const manualBays = Math.max(2, Math.round(p.manualLocations / 2 / 2));
    racks.push({
      id: 'MP01',
      areaId: manualArea.id,
      aisleId: 'A-MANUAL',
      kind: 'shelving',
      bays: manualBays,
      depths: 1,
      levels: [
        { level: 1, y_m: 0 },
        { level: 2, y_m: 1.6 },
      ],
      locationSize: { width_m: 0.8, depth_m: 0.6, height_m: 0.4 },
      maxWeight_kg: 120,
      maxVolume_m3: 0.25,
      origin: [manualArea.center[0] - manualArea.size[0] / 2 + 0.6, 0, manualArea.center[1]],
      bayAxis: [1, 0],
      depthAxis: [0, 1],
      supportsRestack: false,
    });
    aisles.push({
      id: 'A-MANUAL',
      areaId: manualArea.id,
      endNodeIds: ['N-MANUAL-W', 'N-MANUAL-E'],
      axis: [1, 0],
      length_m: manualBays * 0.8,
      bidirectional: true,
      level: 1,
      rackIds: ['MP01'],
    });
  }

  /* ---------------- 节点与通道 ---------------- */
  const addNode = (node: WarehouseNode) => {
    nodes.push(node);
  };
  const addLink = (link: Omit<WarehouseLink, 'length_m'> & { length_m?: number }) => {
    const from = nodes.find((n) => n.id === link.from);
    const to = nodes.find((n) => n.id === link.to);
    if (!from || !to) return;
    const dx = to.position[0] - from.position[0];
    const dy = to.position[1] - from.position[1];
    const dz = to.position[2] - from.position[2];
    const length_m = link.length_m ?? Math.hypot(dx, dy, dz);
    links.push({ ...link, length_m: round(length_m, 4) });
  };

  const blockLeftX = originX - p.crossAisleWidth_m / 2;
  const blockRightX = originX + aisleLength_m + p.crossAisleWidth_m / 2;

  // 每条巷道的两端节点（多层 = 每层两个端点；层间通过提升机连接）
  for (let a = 0; a < p.aisles; a += 1) {
    const aisleId = `A${String(a + 1).padStart(2, '0')}`;
    const z = originZ + a * aislePitch;
    const levelsServed = isAsrs ? levels : [{ level: 1, y_m: 0 }];
    for (const lvl of levelsServed) {
      for (const [suffix, x] of [['W', blockLeftX], ['E', blockRightX]] as const) {
        addNode({
          id: `N-${aisleId}-L${lvl.level}-${suffix}`,
          position: [round(x, 4), round(lvl.y_m, 4), round(z, 4)],
          kind: 'aisle-end',
          areaId: asrsArea.id,
          aisleId,
          level: lvl.level,
        });
      }
      // 巷道内关键 bay 的轨道节点：每 4 个 bay 一个节点，保证路径可视化的精度与图规模平衡
      for (let b = 1; b <= p.bays; b += 4) {
        const x = originX + (b - 0.5) * p.bayWidth_m;
        addNode({
          id: `N-${aisleId}-L${lvl.level}-B${String(b).padStart(3, '0')}`,
          position: [round(x, 4), round(lvl.y_m, 4), round(z, 4)],
          kind: 'aisle-rail',
          areaId: asrsArea.id,
          aisleId,
          level: lvl.level,
        });
      }
    }
  }

  /** 巷道内轨道连接：端点到第一个 bay 节点，bay 节点之间，最后到另一端。 */
  function connectAisle(aisleId: string, bays: number, bayWidth: number, levelList: LevelSpec[], x0: number, z: number) {
    for (const lvl of levelList) {
      const west = `N-${aisleId}-L${lvl.level}-W`;
      const east = `N-${aisleId}-L${lvl.level}-E`;
      let prev = west;
      for (let b = 1; b <= bays; b += 4) {
        const id = `N-${aisleId}-L${lvl.level}-B${String(b).padStart(3, '0')}`;
        addLink({
          id: `K-${aisleId}-L${lvl.level}-${prev}->${id}`,
          from: prev,
          to: id,
          bidirectional: true,
          mode: 'rail',
          capacity: 1,
          allowMeeting: false,
        });
        prev = id;
      }
      addLink({
        id: `K-${aisleId}-L${lvl.level}-${prev}->${east}`,
        from: prev,
        to: east,
        bidirectional: true,
        mode: 'rail',
        capacity: 1,
        allowMeeting: false,
      });
      void x0;
      void z;
    }
  }
  for (let a = 0; a < p.aisles; a += 1) {
    const aisleId = `A${String(a + 1).padStart(2, '0')}`;
    connectAisle(aisleId, p.bays, p.bayWidth_m, isAsrs ? levels : [{ level: 1, y_m: 0 }], originX, 0);
  }
  if (manualArea) {
    connectAisle(
      'A-MANUAL',
      Math.max(2, Math.round(p.manualLocations / 2 / 2)),
      0.8,
      [
        { level: 1, y_m: 0 },
        { level: 2, y_m: 1.6 },
      ],
      manualArea.center[0] - manualArea.size[0] / 2,
      manualArea.center[1],
    );
  }

  // 横巷（cross aisle）：把同一层的所有巷道端点连起来。单车道互斥 = capacity 1。
  if (hasCross) {
    for (let lvl = 1; lvl <= (isAsrs ? p.levels : 1); lvl += 1) {
      for (const suffix of ['W', 'E'] as const) {
        for (let a = 0; a + 1 < p.aisles; a += 1) {
          const from = `N-A${String(a + 1).padStart(2, '0')}-L${lvl}-${suffix}`;
          const to = `N-A${String(a + 2).padStart(2, '0')}-L${lvl}-${suffix}`;
          addLink({
            id: `K-CROSS-L${lvl}-${suffix}-A${a + 1}A${a + 2}`,
            from,
            to,
            bidirectional: true,
            mode: p.template === 'asrs-four-way' ? 'rail' : 'road',
            capacity: p.template === 'asrs-two-block' ? 1 : 2,
            allowMeeting: p.template === 'asrs-two-block' ? false : true,
          });
        }
      }
    }
    // 交叉口节点（四向穿梭车场景：显式的路口争用点）
    for (let lvl = 1; lvl <= (isAsrs ? p.levels : 1); lvl += 1) {
      for (let a = 1; a <= p.aisles; a += 1) {
        for (const suffix of ['W', 'E'] as const) {
          const id = `N-X${String(a).padStart(2, '0')}-L${lvl}-${suffix}`;
          addNode({
            id,
            position: [
              round(suffix === 'W' ? blockLeftX - 1.6 : blockRightX + 1.6, 4),
              round(levels[Math.min(lvl - 1, levels.length - 1)].y_m, 4),
              round(originZ + (a - 1) * aislePitch, 4),
            ],
            kind: 'crossing',
            areaId: asrsArea.id,
            level: lvl,
          });
          addLink({
            id: `K-X${String(a).padStart(2, '0')}-L${lvl}-${suffix}`,
            from: `N-A${String(a).padStart(2, '0')}-L${lvl}-${suffix}`,
            to: id,
            bidirectional: true,
            mode: 'rail',
            capacity: 1,
            allowMeeting: false,
          });
        }
      }
    }
  }

  /* ---------------- 提升机（货物提升机 / 巷道提升机） ---------------- */
  const liftIds: string[] = [];
  const palletLiftIds: string[] = [];
  const aisleLiftIds: string[] = [];
  const wantsPalletLift = isAsrs && (p.liftMode === 'pallet' || p.liftMode === 'both');
  const wantsShuttleLift = isAsrs && (p.liftMode === 'shuttle' || p.liftMode === 'both');

  if (wantsPalletLift || wantsShuttleLift) {
    for (let blk = 0; blk < blocks; blk += 1) {
      const blockAisles: string[] = [];
      for (let a = blk * aislesPerBlock; a < Math.min(p.aisles, (blk + 1) * aislesPerBlock); a += 1) {
        blockAisles.push(`A${String(a + 1).padStart(2, '0')}`);
      }
      if (blockAisles.length === 0) continue;
      // 提升机竖井放在该块第一条巷道的东端（真实立库常见的"巷道端提升"）
      const headAisle = blockAisles[0];
      const shaftX = blockRightX + 1.6;
      const shaftZ = originZ + (Number(headAisle.slice(1)) - 1) * aislePitch;
      for (let i = 0; i < Math.max(1, p.liftsPerBlock); i += 1) {
        const suffix = i === 0 ? '' : String(i + 1);
        if (wantsPalletLift) {
          const id = `PL-${String(blk + 1).padStart(2, '0')}${suffix}`;
          palletLiftIds.push(id);
          liftIds.push(id);
          for (let lvl = 1; lvl <= p.levels; lvl += 1) {
            addNode({
              id: `N-${id}-L${lvl}`,
              position: [round(shaftX + i * 2.2, 4), round(levels[lvl - 1].y_m, 4), round(shaftZ, 4)],
              kind: 'lift-shaft',
              areaId: asrsArea.id,
              level: lvl,
            });
            addLink({
              id: `K-${id}-L${lvl}`,
              from: `N-${headAisle}-L${lvl}-E`,
              to: `N-${id}-L${lvl}`,
              bidirectional: true,
              mode: 'lift-shaft',
              capacity: 1,
              allowMeeting: false,
            });
          }
          devices.push({
            id,
            kind: 'pallet-lift',
            name: `货物提升机 ${id}`,
            homeNodeId: `N-${id}-L1`,
            capability: {
              aisles: [...blockAisles],
              levels: levels.map((l) => l.level),
              areas: [asrsArea.id],
              capacity_loads: p.template === 'asrs-two-block' ? 2 : 1,
              capacity_kg: 1200,
            },
            motion: { speed_mps: 0.9, accel_mps2: 0.7, transfer_s: 8, handover_s: p.handover_s },
            coupling: {
              // 同一竖井的提升机不可互相穿越：共享升降空间，必须靠调度保证顺序。
              sharesSpaceWith: p.liftsPerBlock > 1 ? [`PL-${String(blk + 1).padStart(2, '0')}${p.liftsPerBlock > 1 ? '2' : ''}`] : [],
              cannotPass: p.liftsPerBlock > 1 ? [`PL-${String(blk + 1).padStart(2, '0')}2`] : [],
              exclusiveResources: [`SHAFT-${blk}`],
            },
            energy: { kwh_per_move: 0.02, kwh_per_meter: 0.004 },
          });
        }
        if (wantsShuttleLift) {
          const id = `AL-${String(blk + 1).padStart(2, '0')}${suffix}`;
          aisleLiftIds.push(id);
          liftIds.push(id);
          for (let lvl = 1; lvl <= p.levels; lvl += 1) {
            addNode({
              id: `N-${id}-L${lvl}`,
              position: [round(shaftX + 4.4 + i * 2.2, 4), round(levels[lvl - 1].y_m, 4), round(shaftZ, 4)],
              kind: 'lift-shaft',
              areaId: asrsArea.id,
              level: lvl,
            });
            addLink({
              id: `K-${id}-L${lvl}`,
              from: `N-${headAisle}-L${lvl}-E`,
              to: `N-${id}-L${lvl}`,
              bidirectional: true,
              mode: 'lift-shaft',
              capacity: 1,
              allowMeeting: false,
            });
          }
          devices.push({
            id,
            kind: 'aisle-lift',
            name: `巷道提升机 ${id}（穿梭车跨层转运）`,
            homeNodeId: `N-${id}-L1`,
            capability: {
              aisles: [...blockAisles],
              levels: levels.map((l) => l.level),
              areas: [asrsArea.id],
              capacity_loads: 1, // 承载一台穿梭车
              capacity_kg: 1500,
            },
            motion: { speed_mps: 1.1, accel_mps2: 0.8, transfer_s: 10, handover_s: p.handover_s, change_level_s: 8 },
            coupling: { exclusiveResources: [`SHAFT-AL-${blk}`] },
            energy: { kwh_per_move: 0.03, kwh_per_meter: 0.005 },
          });
        }
      }
    }
  }

  // 到站台的地面通道（从块右端横巷到出库站台，从左端到入库站台）
  for (let a = 1; a <= p.aisles; a += 1) {
    const aisleId = `A${String(a).padStart(2, '0')}`;
    const z = originZ + (a - 1) * aislePitch;
    addNode({
      id: `N-${aisleId}-TRANSFER-E`,
      position: [round(blockRightX + 8.2, 4), 0, round(z, 4)],
      kind: 'transfer',
      areaId: outboundArea.id,
      aisleId,
      level: 1,
    });
    addLink({
      id: `K-${aisleId}-TRANSFER-E`,
      from: `N-${aisleId}-L1-E`,
      to: `N-${aisleId}-TRANSFER-E`,
      bidirectional: true,
      mode: p.conveyorSpeed_mps > 0 ? 'conveyor' : 'road',
      capacity: p.conveyorSpeed_mps > 0 ? 2 : 1,
      allowMeeting: p.conveyorSpeed_mps > 0,
    });
    addNode({
      id: `N-${aisleId}-TRANSFER-W`,
      position: [round(blockLeftX - 8.2, 4), 0, round(z, 4)],
      kind: 'transfer',
      areaId: inboundArea.id,
      aisleId,
      level: 1,
    });
    addLink({
      id: `K-${aisleId}-TRANSFER-W`,
      from: `N-${aisleId}-L1-W`,
      to: `N-${aisleId}-TRANSFER-W`,
      bidirectional: true,
      mode: p.conveyorSpeed_mps > 0 ? 'conveyor' : 'road',
      capacity: p.conveyorSpeed_mps > 0 ? 2 : 1,
      allowMeeting: p.conveyorSpeed_mps > 0,
    });
  }

  /* ---------------- 站台与缓存 ---------------- */
  const stationZSpread = (count: number, index: number): number =>
    originZ + ((p.aisles - 1) * aislePitch) / 2 + (index - (count - 1) / 2) * 4.0;

  for (let i = 0; i < p.inboundStations; i += 1) {
    const id = `ST-IN-${String(i + 1).padStart(2, '0')}`;
    const nodeId = `N-${id}`;
    const z = stationZSpread(p.inboundStations, i);
    addNode({
      id: nodeId,
      position: [round(inboundArea.center[0], 4), 0, round(z, 4)],
      kind: 'station',
      areaId: inboundArea.id,
      level: 1,
    });
    // 站台连到最近的巷道西端（双链路，避免单点瓶颈）
    for (let a = 1; a <= Math.min(p.aisles, 4); a += 1) {
      addLink({
        id: `K-${id}-A${String(a).padStart(2, '0')}`,
        from: nodeId,
        to: `N-A${String(a).padStart(2, '0')}-L1-W`,
        bidirectional: true,
        mode: 'road',
        capacity: 2,
        allowMeeting: true,
      });
    }
    stations.push({
      id,
      name: `入库站台 ${i + 1}`,
      areaId: inboundArea.id,
      nodeId,
      direction: 'inbound',
      bufferCapacity: p.stationBuffer,
      handover_s: p.handover_s,
      designThroughputPerHour: 160,
      servedBy: liftIds.slice(0, 2),
    });
    buffers.push({
      id: `BUF-${id}`,
      nodeId,
      areaId: inboundArea.id,
      capacity: p.bufferCapacity,
      dwellLimit_s: 900,
    });
  }

  for (let i = 0; i < p.outboundStations; i += 1) {
    const id = `ST-OUT-${String(i + 1).padStart(2, '0')}`;
    const nodeId = `N-${id}`;
    const z = stationZSpread(p.outboundStations, i);
    addNode({
      id: nodeId,
      position: [round(outboundArea.center[0], 4), 0, round(z, 4)],
      kind: 'station',
      areaId: outboundArea.id,
      level: 1,
    });
    for (let a = 1; a <= Math.min(p.aisles, 4); a += 1) {
      addLink({
        id: `K-${id}-A${String(a).padStart(2, '0')}`,
        from: nodeId,
        to: `N-A${String(a).padStart(2, '0')}-L1-E`,
        bidirectional: true,
        mode: 'road',
        capacity: 2,
        allowMeeting: true,
      });
    }
    stations.push({
      id,
      name: `出库站台 ${i + 1}`,
      areaId: outboundArea.id,
      nodeId,
      direction: 'outbound',
      bufferCapacity: p.stationBuffer,
      handover_s: p.handover_s,
      designThroughputPerHour: 200,
      servedBy: liftIds.slice(0, 2),
    });
    buffers.push({
      id: `BUF-${id}`,
      nodeId,
      areaId: outboundArea.id,
      capacity: p.bufferCapacity,
      dwellLimit_s: 900,
    });
  }

  /* ---------------- 穿梭车 ---------------- */
  if (isAsrs) {
    for (let a = 1; a <= p.aisles; a += 1) {
      const aisleId = `A${String(a).padStart(2, '0')}`;
      const z = originZ + (a - 1) * aislePitch;
      const shuttleLevels = p.liftMode === 'shuttle' || p.template === 'asrs-four-way'
        ? levels.map((l) => l.level)
        : [1]; // 货物提升机形态：穿梭车只在底层服务，货物靠提升机上下
      for (let s = 1; s <= p.shuttlesPerAisle; s += 1) {
        for (const lvl of shuttleLevels) {
          const id = `SH-${aisleId}-${s}-L${lvl}`;
          const fourWay = p.template === 'asrs-four-way';
          devices.push({
            id,
            kind: fourWay ? 'four-way-shuttle' : p.levels > 1 ? 'layer-shuttle' : 'aisle-shuttle',
            name: fourWay ? `四向穿梭车 ${id}` : `穿梭车 ${id}`,
            homeNodeId: `N-${aisleId}-L${lvl}-W`,
            capability: {
              aisles: fourWay ? undefined : [aisleId],
              levels: [lvl],
              areas: [asrsArea.id],
              loadUnits: ['pallet', 'tote'],
              capacity_loads: 1,
              capacity_kg: 1000,
            },
            motion: {
              speed_mps: fourWay ? 2.8 : 2.6,
              accel_mps2: 1.3,
              transfer_s: 6,
              handover_s: 8,
              loaded_speed_factor: 0.92,
            },
            coupling: {
              exclusiveResources: [`AISLE-${aisleId}-L${lvl}`],
              sharesSpaceWith: [`SH-${aisleId}-${s === 1 ? 2 : 1}-L${lvl}`].filter((x) => x !== id),
            },
            energy: { kwh_per_move: 0.008, kwh_per_meter: 0.0016 },
          });
        }
      }
      // 巷道层间转运能力：穿梭车通过巷道提升机换层（SRS §2.4 的"跨层转运"）
      if (p.liftMode === 'shuttle' && aisleLiftIds.length > 0) {
        const liftId = aisleLiftIds[Math.min(aisleLiftIds.length - 1, Math.floor((a - 1) / aislesPerBlock))];
        for (let s = 1; s <= p.shuttlesPerAisle; s += 1) {
          const shuttle = devices.find((d) => d.id === `SH-${aisleId}-${s}-L1`);
          if (shuttle) shuttle.coupling = { ...(shuttle.coupling ?? {}), sharesSpaceWith: [...(shuttle.coupling?.sharesSpaceWith ?? []), liftId] };
        }
      }
    }
  }

  if (manualArea) {
    devices.push({
      id: 'AMR-M01',
      kind: 'transfer-car',
      name: '人工区搬运机器人',
      homeNodeId: 'N-MANUAL-W',
      capability: { areas: [manualArea.id], capacity_loads: 1, capacity_kg: 300 },
      motion: { speed_mps: 1.6, accel_mps2: 1.0, transfer_s: 5, handover_s: 6 },
      energy: { kwh_per_move: 0.006, kwh_per_meter: 0.0012 },
    });
    // 人工区与立库区之间的转运通道
    addLink({
      id: 'K-MANUAL-ASRS',
      from: 'N-MANUAL-E',
      to: 'N-A01-L1-W',
      bidirectional: true,
      mode: 'road',
      capacity: 1,
      allowMeeting: false,
    });
  }

  // 输送机设备（把 conveyor 类通道登记为设备，方便调度侧统计利用率与能耗）
  if (p.conveyorSpeed_mps > 0 && p.aisles > 0) {
    devices.push({
      id: 'CV-01',
      kind: 'conveyor',
      name: '巷道端输送机',
      homeNodeId: 'N-A01-L1-E',
      capability: { areas: [outboundArea.id, inboundArea.id], capacity_loads: 4, capacity_kg: 2000 },
      motion: { speed_mps: p.conveyorSpeed_mps, accel_mps2: 0.4, transfer_s: 2, handover_s: 4 },
      energy: { kwh_per_move: 0.002, kwh_per_meter: 0.0009 },
    });
  }

  const topology: WarehouseTopology = {
    id: `WH-${p.template}-A${p.aisles}-L${p.levels}-B${p.bays}-D${p.depths}`,
    name: `${TOPOLOGY_TEMPLATE_LABEL[p.template]} · ${p.aisles} 巷 × ${p.levels} 层 × ${p.bays} 列 × ${p.depths} 深`,
    template: p.template,
    areas,
    racks,
    aisles,
    nodes,
    links,
    stations,
    buffers,
    devices,
    closedLinks: [],
    frozenLocations: [],
    reservedLocations: [],
    units: { length: 'm', time: 's', mass: 'kg', volume: 'm3' },
  };

  const locations = deriveLocations(topology);
  const asrsRacks = racks.filter((r) => r.kind !== 'shelving');
  const asrsVolume_m3 = asrsRacks.reduce(
    (sum, r) =>
      sum +
      r.bays * r.depths * r.levels.length * r.locationSize.width_m * r.locationSize.depth_m * r.locationSize.height_m,
    0,
  );
  const manualLocations = racks.filter((r) => r.kind === 'shelving').reduce((s, r) => s + r.bays * r.depths * r.levels.length, 0);

  return {
    topology,
    locations,
    stats: {
      locations: locations.length,
      availableLocations: locations.filter((l) => l.availability === 'available').length,
      aisles: p.aisles + (manualArea ? 1 : 0),
      levels: p.levels,
      bays: p.bays,
      depths: p.depths,
      devices: devices.length,
      stations: stations.length,
      footprint_m2: round(areas.reduce((s, a) => s + a.size[0] * a.size[1], 0), 1),
      asrsVolume_m3: round(asrsVolume_m3, 2),
      manualLocations,
    },
  };
}

/** 库位 id：`{rackId}-{level}-{bay}-{depth}`，例如 `A01F-3-12-2`（短、可读、可排序）。 */
export function locationId(rackId: string, level: number, bay: number, depth: number): string {
  return `${rackId}-${level}-${bay}-${depth}`;
}

/**
 * 由拓扑派生库位（唯一来源）。
 *
 * `frozen` / `reserved` / `unavailable` 来自拓扑声明（动态事件在运行期追加），
 * 分区 zone 由区域 + 层推导（用于储存兼容性与温控约束）。
 */
export function deriveLocations(
  topology: WarehouseTopology,
  overrides?: { frozen?: string[]; reserved?: string[]; unavailable?: string[] },
): LocationRecord[] {
  const frozen = new Set(overrides?.frozen ?? topology.frozenLocations ?? []);
  const reserved = new Set(overrides?.reserved ?? topology.reservedLocations ?? []);
  const unavailable = new Set(overrides?.unavailable ?? []);
  const areaZone = new Map<string, string>();
  for (const area of topology.areas) {
    const zone =
      area.kind === 'asrs'
        ? 'ASRS'
        : area.kind === 'picking'
          ? 'PICK'
          : area.kind === 'receiving'
            ? 'RECV'
            : area.kind === 'shipping'
              ? 'SHIP'
              : area.kind.toUpperCase();
    areaZone.set(area.id, zone);
  }
  const out: LocationRecord[] = [];
  for (const rack of topology.racks) {
    for (let levelIdx = 0; levelIdx < rack.levels.length; levelIdx += 1) {
      const level = rack.levels[levelIdx];
      for (let bay = 1; bay <= rack.bays; bay += 1) {
        for (let depth = 1; depth <= rack.depths; depth += 1) {
          const along = (bay - 1) * rack.locationSize.width_m;
          const into = (depth - 1) * rack.locationSize.depth_m;
          const x = rack.origin[0] + rack.bayAxis[0] * along + rack.depthAxis[0] * into;
          const z = rack.origin[2] + rack.bayAxis[1] * along + rack.depthAxis[1] * into;
          const y = level.y_m;
          const id = locationId(rack.id, level.level, bay, depth);
          const baseZone = areaZone.get(rack.areaId) ?? 'ASRS';
          // 高层的温度梯度分区：多层立库的常见表达（高层温度略高，不能放温控货）
          const zone = level.level >= 6 && baseZone === 'ASRS' ? 'ASRS-HIGH' : baseZone;
          out.push({
            id,
            rackId: rack.id,
            areaId: rack.areaId,
            aisleId: rack.aisleId,
            bay,
            level: level.level,
            depth,
            position: [round(x, 4), round(y, 4), round(z, 4)],
            size: { ...rack.locationSize },
            maxWeight_kg: rack.maxWeight_kg,
            maxVolume_m3: rack.maxVolume_m3,
            availability: unavailable.has(id) ? 'unavailable' : frozen.has(id) ? 'frozen' : reserved.has(id) ? 'reserved' : 'available',
            zone,
          });
        }
      }
    }
  }
  return out;
}

/** 有效的库位查询索引（大场景下 O(1) 查库位，避免线性扫描）。 */
export interface LocationIndex {
  locations: LocationRecord[];
  byId: Map<string, LocationRecord>;
  byRack: Map<string, LocationRecord[]>;
  byAisle: Map<string, LocationRecord[]>;
  /** 按 (rackId, level, bay) 排序后的深位列，供多深位遮挡判断。 */
  depthColumns: Map<string, LocationRecord[]>;
}

export function indexLocations(locations: readonly LocationRecord[]): LocationIndex {
  const byId = new Map<string, LocationRecord>();
  const byRack = new Map<string, LocationRecord[]>();
  const byAisle = new Map<string, LocationRecord[]>();
  const depthColumns = new Map<string, LocationRecord[]>();
  for (const loc of locations) {
    byId.set(loc.id, loc);
    const rackList = byRack.get(loc.rackId) ?? [];
    rackList.push(loc);
    byRack.set(loc.rackId, rackList);
    const aisleList = byAisle.get(loc.aisleId) ?? [];
    aisleList.push(loc);
    byAisle.set(loc.aisleId, aisleList);
    const colKey = `${loc.rackId}|${loc.level}|${loc.bay}`;
    const col = depthColumns.get(colKey) ?? [];
    col.push(loc);
    depthColumns.set(colKey, col);
  }
  for (const col of depthColumns.values()) col.sort((a, b) => a.depth - b.depth);
  return { locations: [...locations], byId, byRack, byAisle, depthColumns };
}

/**
 * 拓扑语义校验：拓扑自洽性是"不许生成与结构不一致的数据"的第一道闸门。
 * 返回错误列表（空 = 通过）。求解器在 INVALID_INPUT 前必须调用它。
 */
export function validateTopology(topology: WarehouseTopology): Array<{ path: string; message: string }> {
  const errors: Array<{ path: string; message: string }> = [];
  const nodeIds = new Set(topology.nodes.map((n) => n.id));
  const ids = new Set<string>();
  for (const rack of topology.racks) {
    if (ids.has(rack.id)) errors.push({ path: `racks.${rack.id}`, message: '货架 id 重复' });
    ids.add(rack.id);
    if (!topology.aisles.some((a) => a.id === rack.aisleId)) {
      errors.push({ path: `racks.${rack.id}.aisleId`, message: `巷道不存在：${rack.aisleId}` });
    }
    if (rack.bays < 1 || rack.depths < 1 || rack.levels.length < 1) {
      errors.push({ path: `racks.${rack.id}`, message: 'bay / depth / level 必须 ≥ 1' });
    }
    if (rack.kind !== 'single-deep' && rack.depths < 2) {
      errors.push({ path: `racks.${rack.id}.depths`, message: `${rack.kind} 的深度必须 ≥ 2` });
    }
  }
  for (const aisle of topology.aisles) {
    for (const end of aisle.endNodeIds) {
      if (!nodeIds.has(end)) errors.push({ path: `aisles.${aisle.id}.endNodeIds`, message: `端点节点不存在：${end}` });
    }
    if (aisle.rackIds.length === 0) errors.push({ path: `aisles.${aisle.id}.rackIds`, message: '巷道未挂接任何货架' });
  }
  for (const device of topology.devices) {
    if (!nodeIds.has(device.homeNodeId)) {
      errors.push({ path: `devices.${device.id}.homeNodeId`, message: `初始节点不存在：${device.homeNodeId}` });
    }
    if (device.motion.speed_mps <= 0) errors.push({ path: `devices.${device.id}.motion.speed_mps`, message: '速度必须为正' });
    if (device.capability.capacity_loads < 1) {
      errors.push({ path: `devices.${device.id}.capability.capacity_loads`, message: '载具容量必须 ≥ 1' });
    }
  }
  for (const link of topology.links) {
    if (!nodeIds.has(link.from)) errors.push({ path: `links.${link.id}.from`, message: `节点不存在：${link.from}` });
    if (!nodeIds.has(link.to)) errors.push({ path: `links.${link.id}.to`, message: `节点不存在：${link.to}` });
    if (link.length_m <= 0) errors.push({ path: `links.${link.id}.length_m`, message: '通道长度必须为正（由几何推导）' });
  }
  for (const station of topology.stations) {
    if (!nodeIds.has(station.nodeId)) errors.push({ path: `stations.${station.id}.nodeId`, message: `站点节点不存在：${station.nodeId}` });
    if (station.bufferCapacity < 0) errors.push({ path: `stations.${station.id}.bufferCapacity`, message: '缓存位不能为负' });
  }
  for (const buffer of topology.buffers) {
    if (!nodeIds.has(buffer.nodeId)) errors.push({ path: `buffers.${buffer.id}.nodeId`, message: `缓存节点不存在：${buffer.nodeId}` });
  }
  // 可达性：每个设备至少能到达一条巷道端点（否则该设备无用）
  const adj = new Map<string, string[]>();
  for (const link of topology.links) {
    const a = adj.get(link.from) ?? [];
    a.push(link.to);
    adj.set(link.from, a);
    if (link.bidirectional) {
      const b = adj.get(link.to) ?? [];
      b.push(link.from);
      adj.set(link.to, b);
    }
  }
  const reachableFrom = (start: string): Set<string> => {
    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop() as string;
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return seen;
  };
  for (const device of topology.devices) {
    const seen = reachableFrom(device.homeNodeId);
    const hasWork = [...seen].some((id) => id.startsWith('N-A') || id.startsWith('N-ST'));
    if (!hasWork) {
      errors.push({ path: `devices.${device.id}`, message: '设备从其初始节点无法到达任何巷道 / 站台（不可用配置）' });
    }
  }
  return errors;
}
