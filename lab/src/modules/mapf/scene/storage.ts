/**
 * 本地场景库（M0 §5.4）：localStorage 持久化，键带 schema 版本；上限 10 个。
 * 不上传服务器。Node 测试用注入式 KV（不依赖全局 localStorage）。
 */

import type { SceneDoc } from './SceneDoc';
import { parseScene, serializeScene } from './SceneDoc';

const KEY_PREFIX = 'mapf-scenes:v1:';
const LIST_KEY = `${KEY_PREFIX}index`;
export const MAX_LOCAL_SCENES = 10;

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function browserKV(): KV | null {
  try {
    if (typeof globalThis.localStorage !== 'undefined') return globalThis.localStorage;
  } catch {
    /* 隐私模式等 */
  }
  return null;
}

class MemoryKV implements KV {
  private m = new Map<string, string>();
  getItem(key: string): string | null {
    return this.m.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.m.set(key, value);
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
}

/** 测试注入。 */
export function memoryKV(): KV {
  return new MemoryKV();
}

export interface LocalScene {
  id: string;
  name: string;
  savedAt: number;
}

function readIndex(kv: KV): LocalScene[] {
  try {
    const raw = kv.getItem(LIST_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as LocalScene[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeIndex(kv: KV, list: LocalScene[]): void {
  kv.setItem(LIST_KEY, JSON.stringify(list));
}

export function listLocalScenes(kv: KV = browserKV() ?? memoryKV()): LocalScene[] {
  return readIndex(kv).sort((a, b) => b.savedAt - a.savedAt);
}

export function saveLocalScene(doc: SceneDoc, kv: KV = browserKV() ?? memoryKV()): { ok: boolean; error?: string } {
  const list = readIndex(kv);
  if (!list.some((s) => s.id === doc.id) && list.length >= MAX_LOCAL_SCENES) {
    return { ok: false, error: `本地场景已达上限 ${MAX_LOCAL_SCENES} 个：请导出后删除旧场景` };
  }
  kv.setItem(`${KEY_PREFIX}${doc.id}`, serializeScene(doc));
  const next = list.filter((s) => s.id !== doc.id);
  next.push({ id: doc.id, name: doc.tags?.name || doc.id, savedAt: Date.now() });
  writeIndex(kv, next);
  return { ok: true };
}

export function loadLocalScene(id: string, kv: KV = browserKV() ?? memoryKV()): SceneDoc | null {
  const raw = kv.getItem(`${KEY_PREFIX}${id}`);
  if (!raw) return null;
  try {
    return parseScene(raw);
  } catch {
    return null;
  }
}

export function deleteLocalScene(id: string, kv: KV = browserKV() ?? memoryKV()): void {
  kv.removeItem(`${KEY_PREFIX}${id}`);
  writeIndex(kv, readIndex(kv).filter((s) => s.id !== id));
}
