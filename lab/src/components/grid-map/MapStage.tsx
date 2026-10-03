/**
 * MapStage：4 层 canvas 容器 + ResizeObserver + 交互挂载（M0 §4.1/§4.2/§4.5）。
 *
 * React 只做容器与回调接线；绘制由 MapRenderer（非 React）驱动，交互状态
 * （视口）存 ref + 按需 setState（缩放/平移期间**零 React 重渲**，只有显式
 * onViewportChange 才通知语义层）。视口锚定缩放、空格/中键平移、触摸双指。
 */

import { useEffect, useRef } from 'react';
import { MapRenderer } from './MapRenderer';
import type { Cell, GridDims, PixelSize, Viewport } from './types';
import { fitViewport, inBounds, pxToCell, zoomAt } from './viewport';

export interface MapStageProps {
  dims: GridDims;
  /** 外部控制的视口变化序号（场景切换后 fit 一次）：变化即重新 fit。 */
  fitNonce: number;
  /** 语义层收到视口/尺寸变化（用于 React 侧联动读数）。 */
  onViewport?: (vp: Viewport) => void;
  /** 格点击（已在界内）。 */
  onCellClick?: (cell: Cell, ev: { shift: boolean; meta: boolean }) => void;
  /** 格按下后拖动（画刷）；与 click 互斥（移动超阈值才视为拖刷）。 */
  onCellDrag?: (cell: Cell) => void;
  /** 一笔开始（pointerdown 在格上）：编辑器用来开启「笔画级撤销」。 */
  onCellDown?: (cell: Cell) => void;
  /** 一笔结束（pointerup）：编辑器用来结算撤销步。 */
  onCellUp?: (cell: Cell) => void;
  /** 悬停格（节流至 rAF；离开地图为 null）。 */
  onHover?: (cell: Cell | null) => void;
  /** 中键/空格平移期间的光标样式切换。 */
  className?: string;
  children?: (renderer: MapRenderer) => void;
}

export function MapStage(props: MapStageProps) {
  const { dims, fitNonce, onViewport, onCellClick, onCellDrag, onCellDown, onCellUp, onHover } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<MapRenderer | null>(null);
  const vpRef = useRef<Viewport | null>(null);
  const sizeRef = useRef<PixelSize>({ w: 0, h: 0 });
  const fitCellRef = useRef<number>(8);
  const spaceRef = useRef(false);
  const panRef = useRef<{ active: boolean; startX: number; startY: number; tx: number; ty: number }>({ active: false, startX: 0, startY: 0, tx: 0, ty: 0 });
  const dragRef = useRef<{ down: boolean; moved: boolean; start: Cell | null; last: Cell | null }>({
    down: false,
    moved: false,
    start: null,
    last: null,
  });
  // The DOM listeners are intentionally installed once. Keep callbacks current so a
  // tool/wizard/scene change never leaves the canvas dispatching a stale closure.
  const callbacksRef = useRef({ onViewport, onCellClick, onCellDrag, onCellDown, onCellUp, onHover });
  callbacksRef.current = { onViewport, onCellClick, onCellDrag, onCellDown, onCellUp, onHover };

  // —— 创建 / 销毁 ——
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const r = new MapRenderer();
    r.attach(host);
    rendererRef.current = r;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const size = { w: Math.max(1, Math.floor(rect.width)), h: Math.max(1, Math.floor(rect.height)) };
      sizeRef.current = size;
      const vp = vpRef.current ?? fitViewport(dims, size);
      vpRef.current = vp;
      fitCellRef.current = vp.cellPx;
      r.setViewport(vp, size);
      callbacksRef.current.onViewport?.(vp);
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      r.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 场景/fit 变化 ——
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || sizeRef.current.w < 2) return;
    const vp = fitViewport(dims, sizeRef.current);
    fitCellRef.current = vp.cellPx;
    vpRef.current = vp;
    r.setViewport(vp, sizeRef.current);
    callbacksRef.current.onViewport?.(vp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims.width, dims.height, fitNonce]);

  // —— 指针交互 ——
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const localPos = (ev: PointerEvent | WheelEvent | MouseEvent) => {
      const rect = host.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };
    const applyVp = (vp: Viewport) => {
      vpRef.current = vp;
      rendererRef.current?.setViewport(vp, sizeRef.current);
      callbacksRef.current.onViewport?.(vp);
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.code === 'Space') spaceRef.current = true;
    };
    const onKeyUp = (ev: KeyboardEvent) => {
      if (ev.code === 'Space') spaceRef.current = false;
    };
    globalThis.addEventListener?.('keydown', onKeyDown);
    globalThis.addEventListener?.('keyup', onKeyUp);

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const vp = vpRef.current;
      if (!vp) return;
      const { x, y } = localPos(ev);
      const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      applyVp(zoomAt(vp, x, y, factor, 0.3, 8, fitCellRef.current));
    };

    const onPointerDown = (ev: PointerEvent) => {
      const vp = vpRef.current;
      if (!vp) return;
      const { x, y } = localPos(ev);
      const pan = ev.button === 1 || spaceRef.current;
      if (pan) {
        panRef.current = { active: true, startX: x, startY: y, tx: vp.tx, ty: vp.ty };
        host.setPointerCapture(ev.pointerId);
        return;
      }
      if (ev.button === 0) {
        const cell = pxToCell(vp, x, y);
        const start = inBounds(dims, cell) ? cell : null;
        dragRef.current = { down: true, moved: false, start, last: start };
        if (start) callbacksRef.current.onCellDown?.(start);
        host.setPointerCapture(ev.pointerId);
      }
    };

    const onPointerMove = (ev: PointerEvent) => {
      const vp = vpRef.current;
      if (!vp) return;
      const { x, y } = localPos(ev);
      if (panRef.current.active) {
        applyVp({ ...vp, tx: panRef.current.tx + (x - panRef.current.startX), ty: panRef.current.ty + (y - panRef.current.startY) });
        return;
      }
      const cell = pxToCell(vp, x, y);
      callbacksRef.current.onHover?.(inBounds(dims, cell) ? cell : null);
      const gesture = dragRef.current;
      if (gesture.down && gesture.start) {
        const crossedCell = cell.x !== gesture.start.x || cell.y !== gesture.start.y;
        if (!gesture.moved && crossedCell) {
          gesture.moved = true;
          // Treat the first movement as a brush stroke beginning at the pressed cell.
          callbacksRef.current.onCellDrag?.(gesture.start);
          gesture.last = gesture.start;
        }
        if (gesture.moved && inBounds(dims, cell) && (cell.x !== gesture.last?.x || cell.y !== gesture.last?.y)) {
          callbacksRef.current.onCellDrag?.(cell);
          gesture.last = cell;
        }
      }
    };

    const resetGesture = () => {
      dragRef.current = { down: false, moved: false, start: null, last: null };
    };

    const onPointerUp = (ev: PointerEvent) => {
      const vp = vpRef.current;
      if (panRef.current.active) {
        panRef.current.active = false;
        host.releasePointerCapture?.(ev.pointerId);
        return;
      }
      const gesture = dragRef.current;
      if (gesture.down) {
        const { x, y } = localPos(ev);
        const cell = vp ? pxToCell(vp, x, y) : null;
        const end = cell && inBounds(dims, cell) ? cell : null;
        const crossed = Boolean(gesture.start && cell && (cell.x !== gesture.start.x || cell.y !== gesture.start.y));
        const dragged = gesture.moved || crossed;
        if (dragged && gesture.start) {
          if (!gesture.moved) callbacksRef.current.onCellDrag?.(gesture.start);
          if (end && (end.x !== gesture.last?.x || end.y !== gesture.last?.y)) callbacksRef.current.onCellDrag?.(end);
        } else if (gesture.start && end && end.x === gesture.start.x && end.y === gesture.start.y) {
          callbacksRef.current.onCellClick?.(end, { shift: ev.shiftKey, meta: ev.metaKey || ev.ctrlKey });
        }
        const finalCell = end ?? gesture.last ?? gesture.start;
        if (finalCell) callbacksRef.current.onCellUp?.(finalCell);
        resetGesture();
        host.releasePointerCapture?.(ev.pointerId);
      }
    };

    const onPointerCancel = () => {
      if (panRef.current.active) panRef.current.active = false;
      const gesture = dragRef.current;
      if (gesture.down) {
        const finalCell = gesture.last ?? gesture.start;
        if (finalCell) callbacksRef.current.onCellUp?.(finalCell);
        resetGesture();
      }
    };

    const onLostPointerCapture = () => {
      onPointerCancel();
    };

    const onLeave = () => callbacksRef.current.onHover?.(null);

    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', onPointerUp);
    host.addEventListener('pointercancel', onPointerCancel);
    host.addEventListener('lostpointercapture', onLostPointerCapture);
    host.addEventListener('pointerleave', onLeave);
    return () => {
      globalThis.removeEventListener?.('keydown', onKeyDown);
      globalThis.removeEventListener?.('keyup', onKeyUp);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('pointercancel', onPointerCancel);
      host.removeEventListener('lostpointercapture', onLostPointerCapture);
      host.removeEventListener('pointerleave', onLeave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims.width, dims.height]);

  // —— 挂载宿主绘制器（children 回调形式）——
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    props.children?.(r);
    r.invalidate();
  });

  return <div ref={hostRef} className={`map-stage ${props.className ?? ''}`} role="application" />;
}
