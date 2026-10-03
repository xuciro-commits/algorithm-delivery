#!/usr/bin/env node
/**
 * GLB structure inspector (offline, no Three.js runtime).
 *
 * Reads the JSON chunk of a binary glTF and reports the pieces the art-direction
 * pass needs: node hierarchy, mesh/primitive names, material list, PBR factors and
 * world-space bounds per node. Used to decide which parts may become shells,
 * glass, internal mechanism or structure — never to modify the model files.
 *
 * Usage: node scripts/inspect-glb.mjs <file.glb> [--json] [--depth N]
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

function readGlb(path) {
  const buffer = readFileSync(path);
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path} is not a GLB (bad magic)`);
  const total = buffer.readUInt32LE(8);
  let offset = 12;
  let json = null;
  const binChunks = [];
  while (offset < total) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const chunk = buffer.subarray(start, start + length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === 0x004e4942) binChunks.push(chunk);
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new Error(`${path} has no JSON chunk`);
  return { json, bin: binChunks[0] ?? null, bytes: buffer.length };
}

const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function readAccessorBounds(json, bin, index) {
  const accessor = json.accessors?.[index];
  if (!accessor) return null;
  if (accessor.min && accessor.max) return { min: accessor.min.slice(0, 3), max: accessor.max.slice(0, 3) };
  if (!bin || accessor.bufferView === undefined) return null;
  const view = json.bufferViews[accessor.bufferView];
  const size = COMPONENT_SIZE[accessor.componentType] ?? 4;
  const count = TYPE_COUNT[accessor.type] ?? 3;
  if (accessor.componentType !== 5126) return null;
  const stride = view.byteStride ?? size * count;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < accessor.count; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      const value = bin.readFloatLE(start + i * stride + c * 4);
      if (value < min[c]) min[c] = value;
      if (value > max[c]) max[c] = value;
    }
  }
  return { min, max };
}

// Minimal column-major 4x4 helpers (glTF matrices are column-major).
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a, b) {
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
function fromTRS(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
function applyPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
function transformBounds(m, bounds) {
  if (!bounds) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i += 1) {
    const corner = [i & 1 ? bounds.max[0] : bounds.min[0], i & 2 ? bounds.max[1] : bounds.min[1], i & 4 ? bounds.max[2] : bounds.min[2]];
    const p = applyPoint(m, corner);
    for (let c = 0; c < 3; c += 1) {
      if (p[c] < min[c]) min[c] = p[c];
      if (p[c] > max[c]) max[c] = p[c];
    }
  }
  return { min, max };
}
function unionBounds(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

function materialSummary(json, index) {
  const material = json.materials?.[index];
  if (!material) return null;
  const pbr = material.pbrMetallicRoughness ?? {};
  return {
    name: material.name ?? `material-${index}`,
    baseColor: pbr.baseColorFactor ? pbr.baseColorFactor.map((v) => Number(v.toFixed(3))) : null,
    metallic: pbr.metallicFactor ?? 1,
    roughness: pbr.roughnessFactor ?? 1,
    alphaMode: material.alphaMode ?? 'OPAQUE',
    doubleSided: Boolean(material.doubleSided),
    emissive: material.emissiveFactor && material.emissiveFactor.some((v) => v > 0) ? material.emissiveFactor : null,
  };
}

function inspect(path, { depth = 4 } = {}) {
  const { json, bin, bytes } = readGlb(path);
  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const triangles = [];
  const materialUse = new Map();
  const report = {
    file: basename(path),
    bytes,
    generator: json.asset?.generator ?? null,
    counts: {
      nodes: nodes.length,
      meshes: meshes.length,
      materials: (json.materials ?? []).length,
      textures: (json.textures ?? []).length,
      images: (json.images ?? []).length,
      animations: (json.animations ?? []).length,
      skins: (json.skins ?? []).length ?? 0,
    },
    scene: [],
    bounds: null,
  };

  const visit = (index, parentMatrix, level, path) => {
    const node = nodes[index];
    if (!node) return;
    const world = multiply(parentMatrix, fromTRS(node));
    let nodeBounds = null;
    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      for (const primitive of mesh.primitives ?? []) {
        const bounds = transformBounds(world, readAccessorBounds(json, bin, primitive.attributes?.POSITION));
        nodeBounds = unionBounds(nodeBounds, bounds);
        const positions = json.accessors?.[primitive.attributes?.POSITION]?.count ?? 0;
        const indices = primitive.indices !== undefined ? json.accessors[primitive.indices]?.count ?? 0 : positions;
        const material = materialSummary(json, primitive.material);
        triangles.push({ node: path, mesh: mesh.name ?? `mesh-${node.mesh}`, positions, indices, material: material?.name ?? null });
        if (material) materialUse.set(material.name, (materialUse.get(material.name) ?? 0) + 1);
      }
    }
    report.bounds = unionBounds(report.bounds, nodeBounds);
    if (level <= depth) {
      report.scene.push({
        path,
        name: node.name ?? `node-${index}`,
        level,
        mesh: node.mesh !== undefined ? meshes[node.mesh]?.name ?? `mesh-${node.mesh}` : null,
        children: node.children?.length ?? 0,
        bounds: nodeBounds
          ? { min: nodeBounds.min.map((v) => Number(v.toFixed(3))), max: nodeBounds.max.map((v) => Number(v.toFixed(3))) }
          : null,
        size: nodeBounds
          ? nodeBounds.min.map((v, i) => Number((nodeBounds.max[i] - v).toFixed(3)))
          : null,
      });
    }
    for (const child of node.children ?? []) visit(child, world, level + 1, `${path}/${nodes[child]?.name ?? child}`);
  };

  for (const root of json.scenes?.[json.scene ?? 0]?.nodes ?? []) visit(root, identity(), 0, nodes[root]?.name ?? String(root));

  report.materials = [...materialUse.entries()].map(([name, uses]) => ({ name, uses }));
  report.triangles = triangles.reduce((sum, entry) => sum + entry.indices / 3, 0);
  report.primitives = triangles.length;
  if (report.bounds) {
    report.bounds = {
      min: report.bounds.min.map((v) => Number(v.toFixed(3))),
      max: report.bounds.max.map((v) => Number(v.toFixed(3))),
      size: report.bounds.min.map((v, i) => Number((report.bounds.max[i] - v).toFixed(3))),
    };
  }
  return report;
}

const [, , target, ...rest] = process.argv;
if (!target) {
  console.error('usage: node scripts/inspect-glb.mjs <file.glb> [--json] [--depth N] [--list]');
  process.exit(2);
}
const asJson = rest.includes('--json');
const listOnly = rest.includes('--list');
const depthIndex = rest.indexOf('--depth');
const depth = depthIndex >= 0 ? Number(rest[depthIndex + 1]) : 4;

const data = inspect(target, { depth });
if (asJson) {
  process.stdout.write(`${JSON.stringify(data.scene, null, 2)}\n`);
} else if (listOnly) {
  for (const node of data.scene) {
    process.stdout.write(`${'  '.repeat(node.level)}${node.name}${node.size ? `  [${node.size.join(' × ')}]` : ''}${node.mesh ? `  mesh=${node.mesh}` : ''}\n`);
  }
} else {
  console.log(`# ${data.file}`);
  console.log(`  ${data.bytes} bytes · generator=${data.generator}`);
  console.log(`  ${JSON.stringify(data.counts)}`);
  console.log(`  primitives=${data.primitives} triangles=${Math.round(data.triangles)}`);
  if (data.bounds) console.log(`  bounds size: ${data.bounds.size.join(' × ')}  min=${data.bounds.min.join(',')}`);
  console.log('  materials:');
  for (const material of data.materials) console.log(`    - ${material.name} (${material.uses} prims)`);
  console.log('  hierarchy:');
  for (const node of data.scene) {
    console.log(`${'  '.repeat(node.level)}${node.name}${node.size ? `  [${node.size.join(' × ')}]` : ''}${node.mesh ? `  mesh=${node.mesh}` : ''}`);
  }
}
