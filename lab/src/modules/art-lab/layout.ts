/**
 * 三维实验室的**空间布局**（单一来源）。
 *
 * 这套坐标同时服务于三件事，因此必须是一份数据：
 *   1. 厂房构件装配（柱距 6 m，上传构件即 6 m 体系）；
 *   2. 产线设备的真实摆放（机加工 → 输送 → 焊接/装配 → 检测 → 入库）；
 *   3. 算法格坐标 → 厂房世界坐标的**确定性映射**（AGV / MAPF 的路径与任务点）。
 *
 * 映射规则（写进面板提示，可追溯）：算法格阵等比缩放到「算法作业区」矩形内并居中，
 * 保持格子的正交性与相对间距（不拉伸、不镜像），因此路径的转弯、绕行与拥挤关系
 * 在厂房里仍然可读。
 */

import type { FloorZone } from '../../art/ArtGroundField';
import type { ArtEquipmentPlacement } from '../../art/ArtStage';
import { GLOW } from '../../art/tokens';

export const HALL = {
  /** 上传构件是 6 m 柱距体系。 */
  bay: 6,
  baysX: 4,
  baysZ: 3,
  /** 屋架下弦高度（钢柱 8 m 等比缩放到此高度）。 */
  height: 6,
} as const;

export const HALL_SIZE = { width: HALL.baysX * HALL.bay, depth: HALL.baysZ * HALL.bay } as const;

/**
 * 算法作业区：AGV / MAPF 的格阵映射到这块真实厂房地面上。
 * 它覆盖存储区（z 1.5–5.5）、产线前通道与主运输通道，与设备摆放不重叠。
 */
export const ALGO_ZONE = { x: 1.6, z: 1.4, width: 20.8, depth: 15.4 } as const;

/** 地坪分区（语义来自产线工艺与物流，不是装饰）。 */
export const FLOOR_ZONES: FloorZone[] = [
  { id: 'line', x: 3.2, z: 5.4, width: 17.6, depth: 5.2, color: GLOW.planned, label: '加工与装配产线' },
  { id: 'aisle', x: 1.6, z: 11.2, width: 20.8, depth: 3.6, color: GLOW.task, label: 'AGV 主运输通道', dashed: true },
  { id: 'storage', x: 1.6, z: 1.4, width: 8.4, depth: 3.4, color: GLOW.done, label: '线边存储 / 立库入口' },
  { id: 'charging', x: 17.2, z: 1.4, width: 5.2, depth: 3.4, color: GLOW.event, label: '充电与整备区' },
  { id: 'algo-zone', x: ALGO_ZONE.x, z: ALGO_ZONE.z, width: ALGO_ZONE.width, depth: ALGO_ZONE.depth, color: '#5f7fa0', label: '算法作业区（格阵映射范围）', dashed: true },
];

/** 产线设备布置：全部使用上传模型的真实尺寸，间距按安全作业面（≥0.8 m）留出。 */
export const LINE_EQUIPMENT: ArtEquipmentPlacement[] = [
  // —— 北侧机床列（z ≈ 6.6）——
  { key: 'cnc-a', model: 'cncCentre', position: [4.6, 0, 7.6], rotationY: Math.PI },
  { key: 'lathe-a', model: 'engineLathe', position: [8.4, 0, 7.6], rotationY: Math.PI },
  { key: 'mill-a', model: 'verticalMill', position: [12.0, 0, 7.6], rotationY: Math.PI },
  { key: 'press-a', model: 'hydraulicPress', position: [15.0, 0, 7.6], rotationY: Math.PI },
  { key: 'robot-weld', model: 'weldingRobot', position: [18.4, 0, 7.4], rotationY: -Math.PI / 2 },
  { key: 'fence-w', model: 'robotFence', position: [18.4, 0, 5.6], rotationY: 0 },
  { key: 'fence-e', model: 'robotFence', position: [18.4, 0, 9.2], rotationY: 0 },
  { key: 'robot-paint', model: 'paintRobot', position: [21.4, 0, 8.6], rotationY: -Math.PI / 2 },
  { key: 'robot-glass', model: 'glassRobot', position: [21.4, 0, 6.0], rotationY: -Math.PI / 2 },

  // —— 输送线（沿 X 方向贯穿）——
  { key: 'conv-1', model: 'conveyorStraight', position: [5.2, 0, 10.4], rotationY: Math.PI / 2 },
  { key: 'conv-2', model: 'conveyorStraight', position: [9.2, 0, 10.4], rotationY: Math.PI / 2 },
  { key: 'conv-3', model: 'conveyorStraight', position: [13.2, 0, 10.4], rotationY: Math.PI / 2 },
  { key: 'conv-4', model: 'conveyorStraight', position: [17.2, 0, 10.4], rotationY: Math.PI / 2 },
  { key: 'conv-curve', model: 'conveyorCurve', position: [21.2, 0, 10.4], rotationY: 0 },
  { key: 'scanner', model: 'scannerArch', position: [11.2, 0, 10.4], rotationY: Math.PI / 2 },
  { key: 'conv-leg', model: 'conveyorLeg', position: [15.2, 0, 10.4] },

  // —— 南侧工位与料架（z ≈ 12.6 之外，不与算法通道冲突）——
  { key: 'bench-1', model: 'workbench', position: [4.6, 0, 13.0], rotationY: 0 },
  { key: 'bench-2', model: 'assemblyBench', position: [7.0, 0, 13.0], rotationY: 0 },
  { key: 'cabinet', model: 'toolCabinet', position: [9.0, 0, 13.0], rotationY: 0 },
  { key: 'line-rack', model: 'lineSideRack', position: [16.6, 0, 13.2], rotationY: 0 },
  { key: 'stillage', model: 'stillage', position: [19.0, 0, 13.2], rotationY: 0.3 },
  { key: 'mesh-stillage', model: 'meshStillage', position: [20.6, 0, 13.2], rotationY: -0.2 },
  { key: 'pallet', model: 'cartonPallet', position: [13.6, 0, 13.4], rotationY: 0.15 },

  // —— 存储区（西）+ 充电整备区（东）——
  { key: 'rack-1', model: 'rackingBay', position: [3.4, 0, 3.0], rotationY: 0 },
  { key: 'rack-2', model: 'rackingBay', position: [6.6, 0, 3.0], rotationY: 0 },
  { key: 'charge-1', model: 'chargingPoint', position: [18.6, 0, 3.0], rotationY: Math.PI },
  { key: 'forklift', model: 'forklift', position: [21.0, 0, 4.6], rotationY: 0.6 },

  // —— 上方构件（吊装与标识）——
  { key: 'hoist', model: 'hoistGantry', position: [12.0, 0, 4.4], rotationY: Math.PI / 2 },
  { key: 'area-panel', model: 'areaPanel', position: [11.0, 3.3, 12.6], rotationY: Math.PI },
  { key: 'crane', model: 'gantryCraneBridge', position: [12.0, HALL.height * 0.74 - 0.6, HALL_SIZE.depth / 2], rotationY: 0 },
];

/** 产线工位（APS 机器 → 工位映射用的真实泊位；含第二排，最多 10 台）。 */
export interface StationPad {
  id: string;
  x: number;
  z: number;
  label: string;
  /** 该泊位对应的产线设备 key（`LINE_EQUIPMENT`）——用于把算法使用的设备强调出来。 */
  equipment?: string;
}

export const STATION_PADS: StationPad[] = [
  { id: 'pad-1', x: 4.6, z: 9.0, label: '工位 1 · 加工中心', equipment: 'cnc-a' },
  { id: 'pad-2', x: 8.4, z: 9.0, label: '工位 2 · 车削', equipment: 'lathe-a' },
  { id: 'pad-3', x: 12.0, z: 9.0, label: '工位 3 · 铣削', equipment: 'mill-a' },
  { id: 'pad-4', x: 15.0, z: 9.0, label: '工位 4 · 压装', equipment: 'press-a' },
  { id: 'pad-5', x: 18.4, z: 9.6, label: '工位 5 · 焊接', equipment: 'robot-weld' },
  { id: 'pad-6', x: 21.4, z: 7.2, label: '工位 6 · 喷涂/装配', equipment: 'robot-paint' },
  // 备料泊位没有固定设备：AGV/机器人在此取放料（真实语义，不硬凑一个设备上去）。
  { id: 'pad-7', x: 4.6, z: 4.6, label: '备料泊位 7' },
  { id: 'pad-8', x: 8.4, z: 4.6, label: '备料泊位 8' },
  { id: 'pad-9', x: 12.0, z: 4.6, label: '备料泊位 9' },
  { id: 'pad-10', x: 15.0, z: 4.6, label: '备料泊位 10' },
];

/** APS 机器下标 → 泊位（确定性；超出泊位数时如实报告，不做重叠摆放）。 */
export function stationForMachine(index: number): StationPad | null {
  return STATION_PADS[index] ?? null;
}

/**
 * 本次排程里被使用的设备 key（用于在沙盘上强调这些设备）。
 * 只做"机器 → 泊位 → 设备"的确定性映射；没有映射的机器不会让任何设备亮起。
 */
export function equipmentKeysForMachines(machines: readonly string[]): string[] {
  const keys = new Set<string>();
  machines.forEach((_, index) => {
    const pad = stationForMachine(index);
    if (pad?.equipment) keys.add(pad.equipment);
  });
  return [...keys];
}

/**
 * 格阵 → 世界坐标的映射参数：等比缩放并居中（保持正交与相对间距）。
 * 返回的函数是纯函数，可在渲染、测试与面板提示中复用同一份换算。
 */
export interface GridMapping {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetZ: number;
  /** 世界坐标反解（用于拾取）。 */
  toCell: (x: number, z: number) => { x: number; y: number; inside: boolean };
}

export function createGridMapping(gridWidth: number, gridHeight: number): GridMapping {
  const width = Math.max(1, gridWidth);
  const height = Math.max(1, gridHeight);
  const scale = Math.min(ALGO_ZONE.width / width, ALGO_ZONE.depth / height);
  const offsetX = ALGO_ZONE.x + (ALGO_ZONE.width - width * scale) / 2;
  const offsetZ = ALGO_ZONE.z + (ALGO_ZONE.depth - height * scale) / 2;
  return {
    width,
    height,
    scale,
    offsetX,
    offsetZ,
    toCell: (x: number, z: number) => {
      const cx = (x - offsetX) / scale - 0.5;
      const cy = (z - offsetZ) / scale - 0.5;
      const ix = Math.round(cx);
      const iy = Math.round(cy);
      const inside = ix >= 0 && iy >= 0 && ix < width && iy < height;
      return { x: ix, y: iy, inside };
    },
  };
}

/** 单个格 → 世界坐标（格心）。 */
export function cellToWorld(mapping: GridMapping, cell: [number, number], y = 0): [number, number, number] {
  return [mapping.offsetX + (cell[0] + 0.5) * mapping.scale, y, mapping.offsetZ + (cell[1] + 0.5) * mapping.scale];
}

/** 地图字符串（'.' 空地 / '#' 障碍）→ 世界坐标，供建筑轮廓与通道叠加使用。 */
export function mapStringsToCells(cells: string[]): { width: number; height: number; blocked: Array<[number, number]> } {
  const height = cells.length;
  const width = cells.reduce((max, row) => Math.max(max, row.length), 0);
  const blocked: Array<[number, number]> = [];
  cells.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) if (row[x] !== '.' && row[x] !== ' ') blocked.push([x, y]);
  });
  return { width, height, blocked };
}
