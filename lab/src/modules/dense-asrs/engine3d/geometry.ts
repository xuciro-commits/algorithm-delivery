import { RackSpec, TopologySpec, Vec3, InventorySpec, SkuSpec } from './types';

/* ============================================================
 * 2.2 库位世界坐标公式（唯一实现，场景内严禁出现硬编码坐标）
 *  X = origin.x + (bay-0.5)·w·bayAxis.x + (depth-0.5)·d·depthAxis.x
 *  Y = levels[level].y_m
 *  Z = origin.z + (bay-0.5)·w·bayAxis.y + (depth-0.5)·d·depthAxis.y
 * ============================================================ */
export function locationCoord(rack: RackSpec, bay: number, level: number, depth: number): Vec3 {
  const lv = rack.levels.find((l) => l.level === level) ?? rack.levels[level - 1];
  const w = rack.locationSize.width_m;
  const d = rack.locationSize.depth_m;
  return {
    x: rack.origin[0] + (bay - 0.5) * w * rack.bayAxis[0] + (depth - 0.5) * d * rack.depthAxis[0],
    y: lv ? lv.y_m : rack.origin[1],
    z: rack.origin[2] + (bay - 0.5) * w * rack.bayAxis[1] + (depth - 0.5) * d * rack.depthAxis[1],
  };
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');

/** 库位唯一定位 Key：{rackId}-{bay}-{level}-{depth}（如 R01-012-003-02） */
export const locationKey = (rackId: string, bay: number, level: number, depth: number) =>
  `${rackId}-${pad(bay, 3)}-${pad(level, 3)}-${pad(depth, 2)}`;

export interface ParsedKey {
  rackId: string;
  bay: number;
  level: number;
  depth: number;
}

export function parseLocationKey(key: string): ParsedKey | null {
  const parts = key.split('-');
  if (parts.length < 4) return null;
  const depth = Number(parts[parts.length - 1]);
  const level = Number(parts[parts.length - 2]);
  const bay = Number(parts[parts.length - 3]);
  const rackId = parts.slice(0, parts.length - 3).join('-');
  if (![depth, level, bay].every((n) => Number.isFinite(n) && n > 0)) return null;
  return { rackId, bay, level, depth };
}

export function coordOfKey(topology: TopologySpec, key: string): Vec3 | null {
  const p = parseLocationKey(key);
  if (!p) return null;
  const rack = topology.racks.find((r) => r.id === p.rackId);
  if (!rack) return null;
  if (p.bay > rack.bays || p.depth > rack.depths) return null;
  return locationCoord(rack, p.bay, p.level, p.depth);
}

/* ============================================================
 * 2.1 场景边界与中心点动态推导
 *  span = max(ΔX, ΔZ)；center = [(minX+maxX)/2, 0, (minZ+maxZ)/2]
 *  底板尺寸 = ΔX + 8 / ΔZ + 8，相机旋转中心绑定 center
 * ============================================================ */
export interface Bounds {
  minX: number; maxX: number; minZ: number; maxZ: number;
  deltaX: number; deltaZ: number; span: number;
  center: [number, number, number];
  floorW: number; floorD: number;
  maxY: number;
  locationCount: number;
}

export function computeBounds(topology: TopologySpec): Bounds {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = 0;
  const push = (x: number, z: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  };

  let locationCount = 0;
  for (const rack of topology.racks) {
    locationCount += rack.bays * rack.depths * rack.levels.length;
    const top = rack.levels[rack.levels.length - 1];
    maxY = Math.max(maxY, (top?.y_m ?? 0) + (rack.locationSize.height_m || 1.5));
    const hw = rack.locationSize.width_m / 2;
    const hd = rack.locationSize.depth_m / 2;
    for (const bay of [1, rack.bays]) {
      for (const depth of [1, rack.depths]) {
        const c = locationCoord(rack, bay, 1, depth);
        const ex = Math.abs(rack.bayAxis[0]) * hw + Math.abs(rack.depthAxis[0]) * hd;
        const ez = Math.abs(rack.bayAxis[1]) * hw + Math.abs(rack.depthAxis[1]) * hd;
        push(c.x - ex, c.z - ez);
        push(c.x + ex, c.z + ez);
      }
    }
  }

  for (const n of topology.nodes ?? []) {
    push(n.position[0], n.position[2]);
    maxY = Math.max(maxY, n.position[1]);
  }

  for (const a of topology.aisles) {
    if (a.center) {
      const h = a.length_m / 2;
      push(a.center[0] - h * a.axis[0], a.center[2] - h * a.axis[1]);
      push(a.center[0] + h * a.axis[0], a.center[2] + h * a.axis[1]);
    }
  }

  for (const s of topology.stations) {
    const len = s.conveyor?.length_m ?? 2;
    const ax = s.conveyor?.axis ?? [1, 0];
    push(s.position[0] - (len / 2) * ax[0] - 1.2, s.position[2] - (len / 2) * ax[1] - 1.2);
    push(s.position[0] + (len / 2) * ax[0] + 1.2, s.position[2] + (len / 2) * ax[1] + 1.2);
  }

  for (const d of topology.devices) {
    if (d.basePosition) {
      push(d.basePosition[0] - 1, d.basePosition[2] - 1);
      push(d.basePosition[0] + 1, d.basePosition[2] + 1);
      maxY = Math.max(maxY, d.dimensions?.height_m ?? 0);
    }
  }

  if (!Number.isFinite(minX)) { minX = -5; maxX = 5; minZ = -5; maxZ = 5; }

  const deltaX = maxX - minX;
  const deltaZ = maxZ - minZ;
  return {
    minX, maxX, minZ, maxZ, deltaX, deltaZ,
    span: Math.max(deltaX, deltaZ),
    center: [(minX + maxX) / 2, 0, (minZ + maxZ) / 2],
    floorW: deltaX + 8,
    floorD: deltaZ + 8,
    maxY: Math.max(maxY, 2),
    locationCount,
  };
}

/* ============================================================
 * 4. 热力图色标：冷色冰蓝 #2b7fa8 → 热色珊瑚红 #ff6f6f
 *    ratio = (turnover - min) / (max - min)
 * ============================================================ */
const COLD = [0x2b / 255, 0x7f / 255, 0xa8 / 255];
const HOT = [0xff / 255, 0x6f / 255, 0x6f / 255];

export function heatRGB(ratio: number): [number, number, number] {
  const r = Math.min(1, Math.max(0, ratio));
  return [
    COLD[0] + (HOT[0] - COLD[0]) * r,
    COLD[1] + (HOT[1] - COLD[1]) * r,
    COLD[2] + (HOT[2] - COLD[2]) * r,
  ];
}

export function turnoverRange(skus: SkuSpec[]): { min: number; max: number } {
  if (!skus.length) return { min: 0, max: 1 };
  const vals = skus.map((s) => s.turnoverPerDay);
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

/* ============================================================
 * 库存声明式展开（密集库规则：同巷道单 SKU、自深位向外回填 FILO）
 * 使用确定性 PRNG，保证同一 seed 的场景完全可复现。
 * ============================================================ */
export interface SlotOccupancy {
  loadUnitId: string;
  skuId: string;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function expandInventory(topology: TopologySpec, spec?: InventorySpec): Map<string, SlotOccupancy> {
  const map = new Map<string, SlotOccupancy>();
  if (!spec || spec.mode === 'none') return map;

  const rnd = mulberry32(spec.seed || 1);
  const overrides = new Map<string, { fillCount: number; skuId?: string }>();
  for (const o of spec.laneOverrides ?? []) {
    overrides.set(`${o.rackId}|${o.bay}|${o.level}`, { fillCount: o.fillCount, skuId: o.skuId });
  }

  let serial = 1;
  for (const rack of topology.racks) {
    for (let bay = 1; bay <= rack.bays; bay++) {
      for (const lv of rack.levels) {
        const ov = overrides.get(`${rack.id}|${bay}|${lv.level}`);
        const roll = rnd();
        const skuPick = spec.skuPool.length
          ? spec.skuPool[Math.floor(rnd() * spec.skuPool.length)]
          : 'SKU-UNKNOWN';
        const laneSku = ov?.skuId ?? skuPick;

        let count: number;
        if (ov) count = Math.max(0, Math.min(rack.depths, ov.fillCount));
        else if (roll < spec.defaultFill.emptyLaneRatio) count = 0;
        else if (roll > 1 - spec.defaultFill.fullLaneRatio) count = rack.depths;
        else count = 1 + Math.floor(rnd() * (rack.depths - 1));

        // 自最深位向巷道口回填（密集库 FILO 实际形态）
        for (let i = 0; i < count; i++) {
          const depth = rack.depths - i;
          map.set(locationKey(rack.id, bay, lv.level, depth), {
            loadUnitId: `LU-${pad(serial++, 5)}`,
            skuId: laneSku,
          });
        }
      }
    }
  }

  for (const e of spec.explicit ?? []) {
    map.set(e.locationId, { loadUnitId: e.loadUnitId, skuId: e.skuId });
  }
  return map;
}
