/**
 * glTF / GLB 结构读取与语义判定的共享实现（纯 Node，无第三方依赖）。
 *
 * 两个脚本共用同一份实现，避免“离线审查结论”与“同步进实验室的元数据”漂移：
 *   - lab/scripts/model-structure-audit.mjs  全量结构审查（MODEL-STRUCTURE-AUDIT.*）
 *   - lab/scripts/sync-assets.mjs            把选中的模型同步进 lab/public/models + 清单
 *
 * 关键：这些资产使用 KHR_mesh_quantization（POSITION 是 normalized 整数），
 * 必须先把 accessor 的 min/max 归一化，再乘节点世界矩阵，才能得到真实米制尺寸。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

export const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function readGlb(file) {
  const buf = readFileSync(file);
  if (buf.length < 20 || buf.readUInt32LE(0) !== GLB_MAGIC) return null;
  const total = buf.readUInt32LE(8);
  let offset = 12;
  let json = null;
  let binBytes = 0;
  while (offset + 8 <= Math.min(total, buf.length)) {
    const len = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === CHUNK_JSON) json = JSON.parse(buf.slice(start, start + len).toString('utf8'));
    else if (type === CHUNK_BIN) binBytes = len;
    offset = start + len + ((4 - (len % 4)) % 4);
  }
  if (!json) return null;
  return { json, binBytes, bytes: buf.length };
}

/**
 * 规则匹配：末段优先 + 长命中保护。
 *
 * 这些资产的节点名常带 pack 前缀（machine-shop-and-factory-hall-hall-window-bay_0）：
 *   - 按规则表顺序做包含匹配时，开头的 machine 会盖过真正有意义的 window；
 *   - 只按最长命中时，skylight 又会被其中的 light 抢走。
 * 因此：先剔除被更长命中完全包住的候选（light ⊂ skylight），再取最靠后的命中。
 */
export function matchRule(text, list) {
  const lower = String(text ?? '').toLowerCase();
  if (!lower) return null;
  let best = null;
  let bestIdx = -1;
  let bestLen = -1;
  for (const rule of list) {
    if (lower === rule.match) return rule;
    const idx = lower.lastIndexOf(rule.match);
    if (idx < 0) continue;
    const end = idx + rule.match.length;
    let shadowed = false;
    for (const other of list) {
      if (other === rule) continue;
      const oIdx = lower.lastIndexOf(other.match);
      if (oIdx < 0) continue;
      if (other.match.length > rule.match.length && oIdx <= idx && oIdx + other.match.length >= end) {
        shadowed = true;
        break;
      }
    }
    if (shadowed) continue;
    if (idx > bestIdx || (idx === bestIdx && rule.match.length > bestLen)) {
      best = rule;
      bestIdx = idx;
      bestLen = rule.match.length;
    }
  }
  return best;
}

function roleOfMaterial(name, rules) {
  const rule = matchRule(name, rules.materialRules);
  return rule ? rule.role : null; // null = 未命中（工作流里必须显式补规则）
}

export function groupOfName(name, rules) {
  const rule = matchRule(name, rules.partGroupRules);
  return rule ? rule.group : 'other';
}

/** glTF 里 POSITION accessor 自带 min/max（局部空间；这些资产用 KHR_mesh_quantization，必须是量纲整数）。 */
export const COMPONENT_NORMALIZER = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

export function accessorBounds(gltf, index) {
  const acc = gltf.accessors?.[index];
  if (!acc || !acc.min || !acc.max) return null;
  // 这些资产使用 KHR_mesh_quantization：POSITION 是 normalized 整数，
  // 必须先按分量类型还原为 [-1,1]，再由节点变换缩放到米。
  const scale = acc.normalized ? 1 / (COMPONENT_NORMALIZER[acc.componentType] ?? 1) : 1;
  return { min: acc.min.slice(0, 3).map((v) => v * scale), max: acc.max.slice(0, 3).map((v) => v * scale) };
}

// ---- 4x4 矩阵（列主序，与 glTF 一致）----
export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

export function fromTrs(node) {
  if (node.matrix && node.matrix.length === 16) return node.matrix.slice();
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  const [x, y, z, w] = r;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

export function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** 节点世界矩阵（严格按 scenes[0] 层级；量化位置靠节点 scale 还原为米）。 */
function worldMatrices(gltf) {
  const nodes = gltf.nodes ?? [];
  const parentOf = new Map();
  nodes.forEach((node, i) => {
    for (const child of node.children ?? []) parentOf.set(child, i);
  });
  const cache = new Map();
  const local = new Map();
  const resolveMatrix = (i) => {
    if (cache.has(i)) return cache.get(i);
    const m = local.get(i) ?? fromTrs(nodes[i] ?? {});
    local.set(i, m);
    const parent = parentOf.get(i);
    const world = parent == null ? m : multiply(resolveMatrix(parent), m);
    cache.set(i, world);
    return world;
  };
  nodes.forEach((_, i) => resolveMatrix(i));
  return { world: cache, parentOf, nodes };
}

function boundsOfTransformed(localBounds, matrix) {
  if (!localBounds) return null;
  const { min, max } = localBounds;
  const corners = [
    [min[0], min[1], min[2]], [max[0], min[1], min[2]], [min[0], max[1], min[2]], [max[0], max[1], min[2]],
    [min[0], min[1], max[2]], [max[0], min[1], max[2]], [min[0], max[1], max[2]], [max[0], max[1], max[2]],
  ];
  const out = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const corner of corners) {
    const p = transformPoint(matrix, corner);
    for (let i = 0; i < 3; i += 1) {
      out.min[i] = Math.min(out.min[i], p[i]);
      out.max[i] = Math.max(out.max[i], p[i]);
    }
  }
  return out;
}

export function primitiveTriangles(gltf, prim) {
  const mode = prim.mode ?? 4;
  if (mode !== 4) return 0;
  const count = prim.indices != null ? gltf.accessors?.[prim.indices]?.count : gltf.accessors?.[prim.attributes?.POSITION]?.count;
  return typeof count === 'number' ? count / 3 : 0;
}

export function meshTriangles(gltf, mesh) {
  let tris = 0;
  for (const prim of mesh.primitives ?? []) tris += primitiveTriangles(gltf, prim);
  return Math.round(tris);
}

export function meshLocalBounds(gltf, mesh) {
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const prim of mesh.primitives ?? []) {
    const b = accessorBounds(gltf, prim.attributes?.POSITION);
    if (!b) continue;
    for (let i = 0; i < 3; i += 1) {
      box.min[i] = Math.min(box.min[i], b.min[i]);
      box.max[i] = Math.max(box.max[i], b.max[i]);
    }
  }
  if (!Number.isFinite(box.min[0])) return null;
  return box;
}

export function unionBounds(target, add) {
  if (!add) return target;
  for (let i = 0; i < 3; i += 1) {
    target.min[i] = Math.min(target.min[i], add.min[i]);
    target.max[i] = Math.max(target.max[i], add.max[i]);
  }
  return target;
}


export function collectNodes(gltf) {
  const nodes = gltf.nodes ?? [];
  const parentOf = new Map();
  nodes.forEach((node, i) => {
    for (const child of node.children ?? []) parentOf.set(child, i);
  });
  return { nodes, parentOf };
}

export function rootNameOf(gltf, index) {
  const { nodes, parentOf } = collectNodes(gltf);
  let cursor = index;
  let guard = 0;
  while (parentOf.has(cursor) && guard < 64) {
    cursor = parentOf.get(cursor);
    guard += 1;
  }
  return String(nodes[cursor]?.name ?? '').replace(/\/\d+$/, '');
}

const TRANSPARENT_GROUPS = new Set(['roof', 'structure']);
const STRUCTURE_GROUPS = new Set(['roof', 'structure', 'floor']);


export function analyzeAsset(file, category, rules, repoRoot) {
  const glb = readGlb(file);
  if (!glb) return { error: 'not-a-glb' };
  const { json: gltf, bytes, binBytes } = glb;
  const { world, nodes } = worldMatrices(gltf);
  const meshes = gltf.meshes ?? [];
  const materials = gltf.materials ?? [];

  const materialNames = materials.map((m, i) => (m.name ? String(m.name).toLowerCase() : `material-${i}`));
  const roleOf = new Map();
  const unknownMaterials = [];
  for (const name of materialNames) {
    const role = roleOfMaterial(name, rules);
    roleOf.set(name, role ?? 'unknown');
    if (!role) unknownMaterials.push(name);
  }

  let transformsInNodes = 0;
  for (const node of nodes) {
    if (node.matrix || node.translation || node.rotation || node.scale) transformsInNodes += 1;
  }

  const boxes = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const roleTris = new Map();
  const uniqueMeshes = new Set();
  let glassTris = 0;
  let triangles = 0;

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node.mesh == null) continue;
    const mesh = meshes[node.mesh];
    if (!mesh) continue;
    uniqueMeshes.add(node.mesh);
    unionBounds(boxes, boundsOfTransformed(meshLocalBounds(gltf, mesh), world.get(i) ?? IDENTITY));
    for (const prim of mesh.primitives ?? []) {
      const tris = primitiveTriangles(gltf, prim);
      triangles += tris;
      const matName = prim.material != null ? materialNames[prim.material] : 'unassigned';
      const role = roleOf.get(matName) ?? 'unknown';
      roleTris.set(role, (roleTris.get(role) ?? 0) + tris);
      if (role === 'glazing') glassTris += tris;
    }
  }

  const asset = {
    slug: basename(file, '.glb'),
    category,
    file: relative(repoRoot, file),
    bytes,
    binBytes,
    generator: gltf.asset?.generator ?? '',
    extensions: gltf.extensionsUsed ?? [],
    nodeCount: nodes.length,
    meshCount: meshes.length,
    instanceCount: nodes.filter((n) => n.mesh != null).length,
    materialCount: materialNames.length,
    materials: materialNames,
    triangles: Math.round(triangles),
    uniqueTriangles: [...uniqueMeshes].reduce((sum, idx) => sum + meshTriangles(gltf, meshes[idx]), 0),
    transformsInNodes,
  };

  asset.sizeMeters = Number.isFinite(boxes.min[0])
    ? [round(boxes.max[0] - boxes.min[0]), round(boxes.max[1] - boxes.min[1]), round(boxes.max[2] - boxes.min[2])]
    : null;
  asset.boundsMin = Number.isFinite(boxes.min[0]) ? boxes.min.map((v) => round(v, 2)) : null;
  asset.boundsMax = Number.isFinite(boxes.max[0]) ? boxes.max.map((v) => round(v, 2)) : null;
  asset.roles = Object.fromEntries([...roleTris.entries()].map(([k, v]) => [k, Math.round(v)]));
  asset.glassShare = asset.triangles > 0 ? round(glassTris / asset.triangles, 3) : 0;
  asset.unknownMaterials = unknownMaterials;

  const groupCounts = new Map();
  for (const node of nodes) {
    const name = String(node.name ?? '').replace(/\/\d+$/, '');
    if (!name) continue;
    const group = groupOfName(name, rules);
    groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
  }
  asset.groups = Object.fromEntries([...groupCounts.entries()].sort((a, b) => b[1] - a[1]));
  const equipmentGroups = ['machine', 'drive', 'robot', 'conveyor', 'racking', 'vessel', 'workstation', 'vehicle'];
  const structureGroups = ['structure', 'roof', 'aperture', 'floor'];
  const equipmentCount = equipmentGroups.reduce((sum, g) => sum + (groupCounts.get(g) ?? 0), 0);
  const structureCount = structureGroups.reduce((sum, g) => sum + (groupCounts.get(g) ?? 0), 0);
  asset.equipmentShare = round(equipmentCount / Math.max(1, equipmentCount + structureCount), 3);
  asset.hasTransparencyShell = [...groupCounts.keys()].some((g) => TRANSPARENT_GROUPS.has(g)) || asset.glassShare > 0.02;
  asset.hasInternalMechanism = ['drive', 'machine', 'robot'].some((g) => (groupCounts.get(g) ?? 0) > 0);
  asset.heroScore = heroScore(asset);

  // 逐部件明细：只在需要时输出（英雄候选 / --detail 指定），避免报告体积失控。
  asset.partDetail = null;
  return asset;
}


export function partsOfAsset(file, rules) {
  const glb = readGlb(file);
  if (!glb) return [];
  const { json: gltf } = glb;
  const { world, nodes } = worldMatrices(gltf);
  const meshes = gltf.meshes ?? [];
  const materials = (gltf.materials ?? []).map((m, i) => (m.name ? String(m.name).toLowerCase() : `material-${i}`));
  const parts = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node.mesh == null) continue;
    const mesh = meshes[node.mesh];
    if (!mesh) continue;
    const name = String(node.name ?? mesh.name ?? `mesh-${node.mesh}`);
    const box = boundsOfTransformed(meshLocalBounds(gltf, mesh), world.get(i) ?? IDENTITY);
    const primRoles = (mesh.primitives ?? []).map((prim) =>
      prim.material != null ? roleOfMaterial(materials[prim.material], rules) ?? 'unknown' : 'unknown',
    );
    parts.push({
      name,
      root: rootNameOf(gltf, i),
      group: groupOfName(name, rules),
      roles: [...new Set(primRoles)],
      triangles: meshTriangles(gltf, mesh),
      size: box ? [round(box.max[0] - box.min[0], 2), round(box.max[1] - box.min[1], 2), round(box.max[2] - box.min[2], 2)] : null,
    });
  }
  return parts.sort((a, b) => b.triangles - a.triangles);
}


/**
 * 英雄设备评分（阶段一实验对象）：结构复杂 + 机械细节丰富 + 具备可单独控制的部件。
 * 关键：**抑制“房间式小场景”**（结构/门窗/地面占绝大多数）——它们网格很多但不是一台设备。
 */
export function heroScore(asset) {
  const tris = Math.min(asset.triangles / 9000, 1.0) * 30;
  const meshPart = Math.min(asset.meshCount / 22, 1.0) * 18;
  const materialPart = Math.min(asset.materialCount / 9, 1.0) * 12;
  const glassPart = asset.glassShare > 0.005 ? 8 : 0;
  const groups = asset.groups ?? {};
  const doorPart = (groups.aperture ?? 0) > 0 ? 6 : 0;
  const mechanismPart = asset.hasInternalMechanism ? 6 : 0;
  const drivePart = (groups.drive ?? 0) > 0 ? 6 : 0;
  const base = tris + meshPart + materialPart + glassPart + doorPart + mechanismPart + drivePart;
  // 设备占比：0.15（几乎全是房间结构）→ 0.5 系数；1.0（纯设备）→ 1.0 系数
  const equipmentFactor = 0.5 + 0.5 * Math.min(1, Math.max(0, (asset.equipmentShare - 0.15) / 0.85));
  return Math.round(base * equipmentFactor);
}


export function round(n, digits = 3) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}



/** 列出目录下全部 GLB（按类别子目录递归）。 */
export function listGlbFiles(assetsDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (entry.endsWith('.glb')) out.push(p);
    }
  };
  walk(assetsDir);
  return out;
}

export { readFileSync };
