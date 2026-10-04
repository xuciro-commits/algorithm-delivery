import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/* ---------------- 通用几何工具 ---------------- */

/** 带倒角的盒体（比裸 BoxGeometry 更接近真实钣金件） */
export function roundedBox(w: number, h: number, d: number, r = 0.03): THREE.BufferGeometry {
  const rr = Math.min(r, w / 2 - 0.001, d / 2 - 0.001);
  const s = new THREE.Shape();
  const x = -w / 2, z = -d / 2;
  s.moveTo(x + rr, z);
  s.lineTo(x + w - rr, z);
  s.quadraticCurveTo(x + w, z, x + w, z + rr);
  s.lineTo(x + w, z + d - rr);
  s.quadraticCurveTo(x + w, z + d, x + w - rr, z + d);
  s.lineTo(x + rr, z + d);
  s.quadraticCurveTo(x, z + d, x, z + d - rr);
  s.lineTo(x, z + rr);
  s.quadraticCurveTo(x, z, x + rr, z);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: h, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 1, curveSegments: 2,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -h / 2, 0); // 与 BoxGeometry 一致：几何中心落在原点
  g.computeVertexNormals();
  return g;
}

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) =>
  new THREE.BoxGeometry(w, h, d).translate(x, y, z);

export function hazardTexture(bg = '#f5b301', fg = '#15181d'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg; ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = fg;
  ctx.lineWidth = 0;
  for (let i = -64; i < 64; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 64); ctx.lineTo(i + 16, 64); ctx.lineTo(i + 48, 0); ctx.lineTo(i + 32, 0);
    ctx.closePath(); ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function labelSprite(text: string, color = '#e2e8f0', scale = 1): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(8,13,24,0.78)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  (ctx as any).roundRect?.(4, 8, 248, 48, 10);
  if (!(ctx as any).roundRect) ctx.rect(4, 8, 248, 48);
  ctx.fill(); ctx.stroke();
  ctx.font = 'bold 30px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(1.9 * scale, 0.48 * scale, 1);
  sp.renderOrder = 20;
  return sp;
}

/**
 * 全场统一的托盘支承高度（相对层基准面）：
 * 货位支承翼顶面 / 穿梭车顶升板顶面 / 提升机链条面 / 输送机辊面 全部对齐该高度，
 * 从而保证空载穿梭车（整车高 0.285m）可从已存托盘下方穿行——密集库的核心物理前提。
 */
export const PALLET_REST = 0.3;

/* ---------------- 共享材质 ---------------- */
export const MATS = {
  steelBlue: new THREE.MeshStandardMaterial({ color: 0x2b4a7d, metalness: 0.55, roughness: 0.45 }),
  steelDark: new THREE.MeshStandardMaterial({ color: 0x18202e, metalness: 0.6, roughness: 0.5 }),
  rail: new THREE.MeshStandardMaterial({ color: 0x9aa7b8, metalness: 0.85, roughness: 0.28 }),
  railClosed: new THREE.MeshStandardMaterial({ color: 0xff6f6f, emissive: 0x5c1111, metalness: 0.5, roughness: 0.4 }),
  beam: new THREE.MeshStandardMaterial({ color: 0xe08a1e, metalness: 0.35, roughness: 0.55 }),
  liftRed: new THREE.MeshStandardMaterial({ color: 0xb5362f, metalness: 0.5, roughness: 0.45 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x14171d, metalness: 0.1, roughness: 0.9 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xc9d2de, metalness: 0.9, roughness: 0.18 }),
  wood: new THREE.MeshStandardMaterial({ color: 0xb07d45, roughness: 0.92, metalness: 0.02 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x1a2130, roughness: 0.98, metalness: 0.0 }),
  glassGreen: new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x16a34a, emissiveIntensity: 0.8, roughness: 0.3 }),
};

/* ---------------- 托盘 + 货物（实例化用几何） ---------------- */
export function palletGeometries() {
  const parts: THREE.BufferGeometry[] = [];
  // 下层三条底板
  for (const z of [-0.44, 0, 0.44]) parts.push(box(1.2, 0.022, 0.11, 0, 0.011, z));
  // 九个支墩
  for (const x of [-0.545, 0, 0.545]) for (const z of [-0.44, 0, 0.44]) parts.push(box(0.1, 0.072, 0.1, x, 0.058, z));
  // 上层面板（5 短板 + 2 边板）
  for (const z of [-0.44, -0.22, 0, 0.22, 0.44]) parts.push(box(1.2, 0.024, 0.12, 0, 0.106, z));
  parts.push(box(1.2, 0.024, 0.06, 0, 0.106, -0.5), box(1.2, 0.024, 0.06, 0, 0.106, 0.5));
  const wood = mergeGeometries(parts, false)!;
  // 货物底面贴合托盘面板顶（0.13m），故中心抬升 0.13 + 0.86/2
  const goods = roundedBox(1.08, 0.86, 0.9, 0.04);
  goods.translate(0, 0.548, 0);
  return { wood, goods };
}

let sharedPallet: { wood: THREE.BufferGeometry; goods: THREE.BufferGeometry } | null = null;
export function palletGroup(color: THREE.ColorRepresentation): THREE.Group {
  if (!sharedPallet) sharedPallet = palletGeometries();
  const g = new THREE.Group();
  const w = new THREE.Mesh(sharedPallet.wood, MATS.wood);
  const k = new THREE.Mesh(
    sharedPallet.goods,
    new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05 }),
  );
  w.castShadow = k.castShadow = true;
  g.add(w, k);
  return g;
}

/* ---------------- 四向穿梭车 ---------------- */
export interface ShuttleRig {
  root: THREE.Group;
  lifter: THREE.Group;      // 顶升平台
  wheelsX: THREE.Group;     // 主巷道行走轮（X 向）
  wheelsZ: THREE.Group;     // 子巷道行走轮（Z 向）
  beacon: THREE.Mesh;
  cargoAnchor: THREE.Group; // 载货挂点
  deckY: number;
}

export function createShuttle(color: THREE.ColorRepresentation, L = 1.25, W = 1.2): ShuttleRig {
  const root = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.45, roughness: 0.38 });

  // 底盘
  const chassis = new THREE.Mesh(roundedBox(L, 0.13, W, 0.05), MATS.steelDark);
  chassis.position.y = 0.07;
  root.add(chassis);

  // 车体外壳
  const shell = new THREE.Mesh(roundedBox(L - 0.08, 0.1, W - 0.1, 0.05), bodyMat);
  shell.position.y = 0.2;
  root.add(shell);

  // 警示裙边
  const stripeMat = new THREE.MeshStandardMaterial({ map: hazardTexture(), roughness: 0.7 });
  (stripeMat.map as THREE.Texture).repeat.set(5, 1);
  for (const sx of [-1, 1]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.07, W - 0.16), stripeMat);
    skirt.position.set((sx * L) / 2, 0.165, 0);
    root.add(skirt);
  }

  // 顶升平台（含四根导向柱）
  const lifter = new THREE.Group();
  const plate = new THREE.Mesh(roundedBox(L - 0.3, 0.05, W - 0.26, 0.04), MATS.chrome);
  plate.position.y = 0.26;
  lifter.add(plate);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.07, 8), MATS.steelDark);
    pin.position.set(sx * (L / 2 - 0.2), 0.3, sz * (W / 2 - 0.18));
    lifter.add(pin);
  }
  for (const z of [-0.26, 0, 0.26]) {
    const grip = new THREE.Mesh(new THREE.BoxGeometry(L - 0.34, 0.012, 0.035), MATS.rubber);
    grip.position.set(0, 0.289, z);
    lifter.add(grip);
  }
  root.add(lifter);

  // 行走轮组
  const wheelGeo = new THREE.CylinderGeometry(0.078, 0.078, 0.055, 18);
  const hubGeo = new THREE.CylinderGeometry(0.032, 0.032, 0.058, 12);
  const wheelsX = new THREE.Group();
  const wheelsZ = new THREE.Group();
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const wx = new THREE.Group();
    const t1 = new THREE.Mesh(wheelGeo, MATS.rubber);
    const h1 = new THREE.Mesh(hubGeo, MATS.chrome);
    t1.rotation.x = h1.rotation.x = Math.PI / 2;
    wx.add(t1, h1);
    wx.position.set(sx * (L / 2 - 0.22), 0.078, sz * (W / 2 - 0.045));
    wheelsX.add(wx);

    const wz = new THREE.Group();
    const t2 = new THREE.Mesh(wheelGeo, MATS.rubber);
    const h2 = new THREE.Mesh(hubGeo, MATS.chrome);
    t2.rotation.z = h2.rotation.z = Math.PI / 2;
    wz.add(t2, h2);
    wz.position.set(sx * (L / 2 - 0.045), 0.078, sz * (W / 2 - 0.22));
    wheelsZ.add(wz);
  }
  root.add(wheelsX, wheelsZ);

  // 四角激光测距 + 防撞角
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const sensor = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 10), MATS.steelDark);
    sensor.position.set(sx * (L / 2 - 0.08), 0.27, sz * (W / 2 - 0.08));
    const lens = new THREE.Mesh(
      new THREE.SphereGeometry(0.018, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x38bdf8, emissiveIntensity: 1.6 }),
    );
    lens.position.set(sx * (L / 2 - 0.08), 0.3, sz * (W / 2 - 0.08));
    root.add(sensor, lens);
  }

  // 状态警示灯
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.042, 0.05, 0.075, 12),
    new THREE.MeshStandardMaterial({ color: 0xffc53d, emissive: 0xffa600, emissiveIntensity: 1.2, transparent: true, opacity: 0.92 }),
  );
  beacon.position.set(-(L / 2 - 0.16), 0.3, -(W / 2 - 0.2));
  root.add(beacon);

  const cargoAnchor = new THREE.Group();
  cargoAnchor.position.y = 0.3;
  lifter.add(cargoAnchor);

  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { root, lifter, wheelsX, wheelsZ, beacon, cargoAnchor, deckY: 0.3 };
}

/* ---------------- 垂直提升机 ---------------- */
export interface LiftRig {
  root: THREE.Group;
  carriage: THREE.Group;
  ropes: THREE.Mesh[];
  topY: number;
  deckY: number;
}

export function createLift(height: number, accent: THREE.ColorRepresentation): LiftRig {
  const root = new THREE.Group();
  const H = Math.max(3, height);
  const half = 0.9;

  // 四根桁架立柱 + 斜撑
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const mast = new THREE.Mesh(roundedBox(0.13, H, 0.13, 0.03), MATS.liftRed);
    mast.position.set(sx * half, H / 2, sz * half);
    root.add(mast);
  }
  for (const sz of [-1, 1]) {
    for (let y = 0.4; y < H - 0.6; y += 1.1) {
      const brace = new THREE.Mesh(new THREE.BoxGeometry(2 * half, 0.05, 0.05), MATS.liftRed);
      brace.position.set(0, y, sz * half);
      brace.rotation.z = (y / 1.1) % 2 < 1 ? 0.48 : -0.48;
      root.add(brace);
      const flat = new THREE.Mesh(new THREE.BoxGeometry(2 * half, 0.05, 0.05), MATS.liftRed);
      flat.position.set(0, y + 0.55, sz * half);
      root.add(flat);
    }
  }

  // 顶部机房 + 卷筒 + 导轮
  const house = new THREE.Mesh(roundedBox(2.0, 0.42, 2.0, 0.06), MATS.steelDark);
  house.position.y = H;
  root.add(house);
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 1.3, 16), MATS.chrome);
  drum.rotation.z = Math.PI / 2;
  drum.position.y = H + 0.5;
  root.add(drum);
  const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.46, 14), new THREE.MeshStandardMaterial({ color: accent, metalness: 0.6, roughness: 0.35 }));
  motor.rotation.z = Math.PI / 2;
  motor.position.set(0.95, H + 0.5, 0);
  root.add(motor);

  // 载货台（链条输送式）
  const carriage = new THREE.Group();
  const frame = new THREE.Mesh(roundedBox(1.72, 0.1, 1.6, 0.04), MATS.steelDark);
  frame.position.y = 0.19;
  carriage.add(frame);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const stud = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.08), MATS.steelDark);
    stud.position.set(sx * 0.72, 0.1, sz * 0.66);
    carriage.add(stud);
  }
  const chainMat = new THREE.MeshStandardMaterial({ color: 0x6b7686, metalness: 0.85, roughness: 0.3 });
  for (const z of [-0.42, 0.42]) {
    const chain = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.05, 0.14), chainMat);
    chain.position.set(0, 0.275, z);
    carriage.add(chain);
  }
  const stripeMat = new THREE.MeshStandardMaterial({ map: hazardTexture('#f5b301', '#15181d'), roughness: 0.75 });
  (stripeMat.map as THREE.Texture).repeat.set(6, 1);
  for (const sz of [-1, 1]) {
    const guard = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.14, 0.04), stripeMat);
    guard.position.set(0, 0.33, sz * 0.8);
    carriage.add(guard);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.09, 10), MATS.chrome);
    roller.rotation.x = Math.PI / 2;
    roller.position.set(sx * half, 0.1, sz * half);
    carriage.add(roller);
  }
  root.add(carriage);

  // 钢丝绳（随载货台高度动态拉伸）
  const ropes: THREE.Mesh[] = [];
  for (const sz of [-0.5, 0.5]) {
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 1, 6), MATS.chrome);
    rope.position.set(0, 0, sz);
    ropes.push(rope);
    root.add(rope);
  }

  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { root, carriage, ropes, topY: H + 0.3, deckY: PALLET_REST };
}

/* ---------------- 辊筒输送机 / 站台 ---------------- */
export function createConveyor(length: number, deckY: number, accent: THREE.ColorRepresentation): THREE.Group {
  const g = new THREE.Group();
  const L = Math.max(1, length);

  for (const sz of [-1, 1]) {
    const side = new THREE.Mesh(roundedBox(L, 0.16, 0.08, 0.02), MATS.steelDark);
    side.position.set(0, deckY - 0.02, sz * 0.62);
    g.add(side);
  }

  const count = Math.max(2, Math.floor(L / 0.17));
  const rollerGeo = new THREE.CylinderGeometry(0.045, 0.045, 1.18, 10).rotateX(Math.PI / 2);
  const rollers = new THREE.InstancedMesh(rollerGeo, MATS.chrome, count);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    m.makeTranslation(-L / 2 + 0.09 + i * (L - 0.18) / (count - 1 || 1), deckY, 0);
    rollers.setMatrixAt(i, m);
  }
  rollers.castShadow = true;
  g.add(rollers);

  for (let x = -L / 2 + 0.35; x <= L / 2; x += 1.6) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, deckY - 0.08, 0.07), MATS.steelBlue);
      leg.position.set(x, (deckY - 0.08) / 2, sz * 0.6);
      g.add(leg);
    }
  }

  // 控制柜 + 指示灯
  const cab = new THREE.Mesh(roundedBox(0.42, 0.95, 0.34, 0.04), MATS.steelBlue);
  cab.position.set(-L / 2 + 0.3, 0.48, 1.0);
  g.add(cab);
  const lamp = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 0.16, 10),
    new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 1.4 }),
  );
  lamp.position.set(-L / 2 + 0.3, 1.04, 1.0);
  g.add(lamp);

  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/** 站台缓冲水位指示柱：返回可按占用数更新的灯珠数组 */
export function createBufferTower(capacity: number, accent: THREE.ColorRepresentation) {
  const g = new THREE.Group();
  const mast = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3 + capacity * 0.16, 0.08), MATS.steelDark);
  mast.position.y = (0.3 + capacity * 0.16) / 2;
  g.add(mast);
  const lamps: THREE.Mesh[] = [];
  for (let i = 0; i < capacity; i++) {
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.1, 0.06),
      new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0, transparent: true, opacity: 0.35 }),
    );
    lamp.position.set(0.13, 0.25 + i * 0.16, 0);
    lamps.push(lamp);
    g.add(lamp);
  }
  return { group: g, lamps };
}
