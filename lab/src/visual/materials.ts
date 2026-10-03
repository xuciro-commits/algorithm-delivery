/**
 * 统一工业材质预设（需求 §三、§七）。
 *
 * 设计要点：
 *   1. **角色化**：材质由“部件角色 + 当前模式 + 质量档”决定，而不是每台设备一份手写材质；
 *   2. **可复用**：同角色 / 同模式 / 同色相提示 → 同一个材质实例（缓存），
 *      保证 74 个模型铺满车间时也不会产生上千个材质；
 *   3. **不破坏原件**：只读原始材质名与颜色作为“色相提示”，原始材质对象从不被修改；
 *   4. **透明策略**：优先 MeshPhysicalMaterial 物理透射（transmission）——
 *      它走不透明队列 + 透射采样，天然规避 Three.js 透明排序/深度写入导致的
 *      “互相穿透的视觉噪声”；仅在轻量档退化为 alpha 混合 + 关闭深度写入；
 *   5. **渐变与轮廓**：外壳/玻璃材质注入菲涅尔补丁（冰蓝 → 青 → 银白边缘渐变 +
 *      柔和边缘描边），这是“C4D 质感”的关键，而不是把透明度统一拉到 0.5。
 */

import {
  AdditiveBlending,
  Color,
  DoubleSide,
  FrontSide,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Material,
} from 'three';
import type { PartRole } from './roles';
import { SHELLABLE_ROLES } from './roles';
import type { QualityConfig, ShellConfig, VisualModeConfig } from './modes';
import { VP } from './palette';

export interface MaterialContext {
  mode: VisualModeConfig;
  quality: QualityConfig;
  /** 用户在“视觉工作室”里的透明强度倍率（0 = 关闭透射，1 = 模式默认）。 */
  shellScale: number;
}

/** 触发重新编译所需的补丁参数（也用于 cache key）。 */
interface ShellPatchSpec {
  tintA: string;
  tintB: string;
  rim: string;
  rimStrength: number;
  rimAlpha: number;
  gradient: number;
}

const ROLE_BASE: Record<PartRole, { color: string; roughness: number; metalness: number; env: number }> = {
  shell: { color: VP.silverWhite, roughness: 0.24, metalness: 0.06, env: 1.15 },
  glass: { color: VP.iceGlass, roughness: 0.08, metalness: 0.02, env: 1.3 },
  structure: { color: VP.steelDark, roughness: 0.44, metalness: 0.82, env: 0.95 },
  building: { color: VP.steel, roughness: 0.5, metalness: 0.6, env: 0.9 },
  metal: { color: VP.brushed, roughness: 0.27, metalness: 0.94, env: 1.3 },
  darkmetal: { color: VP.graphite, roughness: 0.54, metalness: 0.72, env: 0.85 },
  mechanism: { color: VP.steel, roughness: 0.3, metalness: 0.9, env: 1.2 },
  rubber: { color: '#22262b', roughness: 0.86, metalness: 0.04, env: 0.5 },
  accent: { color: VP.amber, roughness: 0.38, metalness: 0.28, env: 0.9 },
  emissive: { color: '#0d1218', roughness: 0.32, metalness: 0.1, env: 0.7 },
  floor: { color: VP.base, roughness: 0.4, metalness: 0.5, env: 0.8 },
  detail: { color: VP.steelDark, roughness: 0.42, metalness: 0.72, env: 0.95 },
};

/** 原始材质名 → 自发光色（真实灯具/屏幕用冷色，状态灯语义在模块层覆盖）。 */
const EMISSIVE_HINT: Array<{ match: string; color: string }> = [
  { match: 'glow', color: VP.ice },
  { match: 'light', color: '#fff2d8' },
  { match: 'lamp', color: '#fff2d8' },
  { match: 'screen', color: VP.cyan },
  { match: 'display', color: VP.cyan },
];

function emissiveColor(name: string, original: Color | null): string {
  const lower = name.toLowerCase();
  const hit = EMISSIVE_HINT.find((entry) => lower.includes(entry.match));
  if (hit) return hit.color;
  if (original && original.getHex() > 0x111111) return `#${original.getHexString()}`;
  return VP.cyan;
}

/** 用“色相提示”把原色向目标基色靠拢，制造冷暖统一的层次（保留设备间差异）。 */
function tunedColor(target: string, hint: Color | null, amount: number): Color {
  const color = new Color(target);
  if (!hint) return color;
  // 原始色过暗/过亮时不做提示，避免把金属压成黑色
  const luma = hint.r * 0.2126 + hint.g * 0.7152 + hint.b * 0.0722;
  if (luma < 0.06 || luma > 0.96) return color;
  return color.lerp(hint, amount);
}

function quantizedHint(hint: Color | null): string {
  if (!hint) return 'none';
  const q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 7);
  return `${q(hint.r)}${q(hint.g)}${q(hint.b)}`;
}

/**
 * 菲涅尔外壳补丁：边缘处向冰蓝/青渐变并加亮，形成高级玻璃的“边缘光”，
 * 同时不影响内部机构的不透明度。
 */
function applyShellPatch(material: MeshPhysicalMaterial | MeshStandardMaterial, spec: ShellPatchSpec): void {
  const uniforms = {
    uShellA: { value: new Color(spec.tintA) },
    uShellB: { value: new Color(spec.tintB) },
    uShellRim: { value: new Color(spec.rim) },
    uShellRimStrength: { value: spec.rimStrength },
    uShellRimAlpha: { value: spec.rimAlpha },
    uShellGradient: { value: spec.gradient },
  };
  material.userData.shellUniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uShellA;
uniform vec3 uShellB;
uniform vec3 uShellRim;
uniform float uShellRimStrength;
uniform float uShellRimAlpha;
uniform float uShellGradient;`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
{
  vec3 vpView = normalize(vViewPosition);
  float vpFres = pow(1.0 - clamp(dot(normalize(normal), vpView), 0.0, 1.0), 2.2);
  vec3 vpTint = mix(uShellA, uShellB, clamp(vpFres * uShellGradient, 0.0, 1.0));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vpTint, vpFres * uShellRimStrength);
  gl_FragColor.rgb += uShellRim * vpFres * uShellRimStrength * 0.35;
  gl_FragColor.a = clamp(gl_FragColor.a + vpFres * uShellRimAlpha, 0.0, 1.0);
}`,
      );
  };
  material.customProgramCacheKey = () =>
    `vp-shell:${spec.tintA}:${spec.tintB}:${spec.rim}:${spec.rimStrength}:${spec.rimAlpha}:${spec.gradient}`;
}

export function shellSpec(base: ShellConfig, role: PartRole): ShellPatchSpec {
  return {
    tintA: base.tint,
    tintB: role === 'building' ? VP.iceGlass : VP.cyanGlass,
    rim: base.rimTint,
    rimStrength: base.rimStrength,
    rimAlpha: base.rimAlpha,
    gradient: 1,
  };
}

/** 透明外壳：物理透射（优先）或 alpha 混合（轻量档兜底）。 */
function createShellMaterial(
  role: PartRole,
  base: { color: string; roughness: number; metalness: number; env: number },
  shell: ShellConfig,
  ctx: MaterialContext,
  hint: Color | null,
): MeshPhysicalMaterial {
  const useTransmission = ctx.quality.useTransmission && shell.transmission > 0;
  const material = new MeshPhysicalMaterial({
    color: tunedColor(base.color, hint, role === 'building' ? 0.1 : 0.16),
    roughness: shell.roughness,
    metalness: 0.04,
    envMapIntensity: ctx.mode.artisticMaterials ? 1.25 : 0.9,
    clearcoat: 0.65,
    clearcoatRoughness: 0.22,
    specularIntensity: 1,
  });
  if (useTransmission) {
    // 物理透射：磨砂玻璃 / 冰蓝透明树脂 / 半透明工业亚克力
    material.transmission = Math.min(1, shell.transmission);
    material.thickness = shell.thickness;
    material.ior = 1.46;
    material.attenuationColor = new Color(shell.tint);
    material.attenuationDistance = 0.9;
    material.transparent = false;
    material.side = FrontSide;
  } else {
    material.transparent = true;
    material.opacity = Math.max(0.06, shell.opacity);
    material.depthWrite = false;
    material.side = FrontSide;
  }
  applyShellPatch(material, shellSpec(shell, role));
  return material;
}

/** 生成某个角色在当前视觉配置下的材质（未命中缓存时调用）。 */
function buildMaterial(role: PartRole, hint: Color | null, name: string, ctx: MaterialContext): Material {
  const { mode, shellScale } = ctx;
  const base = ROLE_BASE[role];

  // —— 模式 A：忠实还原（使用原始材质，见 applyRoleMaterials 的短路分支）——
  if (!mode.artisticMaterials) {
    return new MeshStandardMaterial({
      color: hint ?? new Color(base.color),
      roughness: base.roughness,
      metalness: base.metalness,
      envMapIntensity: 0.8,
    });
  }

  const scaledShell: ShellConfig = SHELLABLE_ROLES.has(role)
    ? { ...(role === 'building' ? mode.building : mode.shell), opacity: (role === 'building' ? mode.building.opacity : mode.shell.opacity) * (0.4 + 0.6 * shellScale) }
    : mode.shell;

  if (SHELLABLE_ROLES.has(role) && (role === 'building' ? mode.building.treatment === 'glass' : mode.shell.treatment === 'glass') && shellScale > 0.02) {
    return createShellMaterial(role, base, scaledShell, ctx, hint);
  }

  if (role === 'emissive') {
    const material = new MeshStandardMaterial({
      color: new Color(base.color),
      roughness: base.roughness,
      metalness: base.metalness,
      envMapIntensity: base.env,
    });
    material.emissive = new Color(emissiveColor(name, hint));
    material.emissiveIntensity = 1.35 * mode.glow;
    return material;
  }

  if (role === 'accent') {
    // 厂家涂装：保留可辨识色相，但整体降饱和并靠向琥珀/冰蓝体系，避免花哨
    const color = tunedColor(VP.amber, hint, 0.55);
    if (hint) {
      const hsl = { h: 0, s: 0, l: 0 };
      hint.getHSL(hsl);
      color.setHSL(hsl.h, Math.min(0.55, hsl.s * 0.75), Math.min(0.66, Math.max(0.42, hsl.l)));
    }
    return new MeshStandardMaterial({ color, roughness: base.roughness, metalness: base.metalness, envMapIntensity: base.env });
  }

  const material = new MeshPhysicalMaterial({
    color: tunedColor(base.color, hint, role === 'shell' ? 0.14 : 0.1),
    roughness: base.roughness,
    metalness: role === 'rubber' ? base.metalness : Math.min(1, base.metalness * 1.02),
    envMapIntensity: base.env * mode.materialTint,
  });
  if (role === 'metal' || role === 'mechanism') {
    material.clearcoat = 0.35;
    material.clearcoatRoughness = 0.3;
  }
  return material;
}

/** 材质缓存：同角色/模式/质量/色相 → 同一实例（模型与材质实例复用）。 */
const cache = new Map<string, Material>();

export function roleMaterial(role: PartRole, hint: Color | null, originalName: string, ctx: MaterialContext): Material {
  const key = `${role}|${ctx.mode.id}|${ctx.quality.id}|${Math.round(ctx.shellScale * 20)}|${quantizedHint(hint)}|${originalName}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const material = buildMaterial(role, hint, originalName, ctx);
  material.name = `vp-${role}-${originalName}`;
  material.userData.vpRole = role;
  material.userData.vpOriginal = originalName;
  cache.set(key, material);
  return material;
}

/** 模式 C 的“弱化”处理：建筑/次要设备压暗，但不消失（保持空间关系可读）。 */
export function dimmedMaterial(base: Material, dim: number): Material {
  if (dim >= 0.999) return base;
  const key = `dim|${base.uuid}|${dim.toFixed(2)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const material = base.clone();
  const factor = new Color(dim, dim, dim);
  // 只压暗颜色与环境反射，不做整体透明（避免排序噪声）
  const anyMaterial = material as MeshStandardMaterial;
  if (anyMaterial.color) anyMaterial.color.multiply(factor);
  anyMaterial.envMapIntensity = (anyMaterial.envMapIntensity ?? 1) * (0.4 + 0.6 * dim);
  if (anyMaterial.emissive) anyMaterial.emissive.multiply(factor);
  cache.set(key, material);
  return material;
}

/** 选中/高亮部件时的强调材质（细轮廓 + 局部高光，不画整个线框）。 */
export function emphasizedMaterial(base: Material, color: string): Material {
  const key = `emph|${base.uuid}|${color}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const material = base.clone();
  const anyMaterial = material as MeshStandardMaterial;
  if (anyMaterial.emissive) {
    anyMaterial.emissive = new Color(color);
    anyMaterial.emissiveIntensity = 0.5;
  }
  anyMaterial.userData = { ...anyMaterial.userData, vpEmphasized: true };
  cache.set(key, material);
  return material;
}

/** 算法可视化用的软性光晕（真实数据驱动的标点，不用于伪装生产运行）。 */
export function haloMaterial(color: string, opacity: number): MeshBasicMaterial {
  const key = `halo|${color}|${opacity.toFixed(2)}`;
  const cached = cache.get(key);
  if (cached) return cached as MeshBasicMaterial;
  const material = new MeshBasicMaterial({
    color: new Color(color),
    transparent: true,
    opacity,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
  });
  cache.set(key, material);
  return material;
}

/** 测试/模式切换时清理缓存（避免长时间会话堆积）。 */
export function clearMaterialCache(): void {
  cache.clear();
}

export function materialCacheSize(): number {
  return cache.size;
}
