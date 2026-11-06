"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type PointerEvent,
} from "react";
import { clampPanelWidth } from "@/lib/panel-layout";

interface DragState {
  pointerId: number;
  startPosition: number;
  startWidth: number;
  target: HTMLDivElement;
  previousCursor: string;
  previousUserSelect: string;
  moved: boolean;
  shield: HTMLDivElement | null;
}

interface UseResizablePanelOptions {
  ariaLabel: string;
  axis?: "horizontal" | "vertical";
  cssVariable: `--${string}`;
  defaultWidth: number;
  getDefaultWidth?: () => number;
  getMaxWidth: () => number;
  growthDirection: "left" | "right" | "up" | "down";
  maxWidth: number;
  minWidth: number;
  /**
   * False keeps the size the user chose (the stored one, or the last a drag, a
   * key or a reset committed) apart from the one shown: a window too small for
   * it shows less without saving that, and the panel grows back with the window.
   */
  persistClamp?: boolean;
  storageKey: string;
  widthRef: MutableRefObject<number>;
}

interface CommitOptions {
  forcePersist?: boolean;
  persist?: boolean;
}

function readStoredWidth(storageKey: string): number | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return null;
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(storageKey: string, width: number): void {
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // Resizing remains available when storage is unavailable.
  }
}

export function useResizablePanel(options: UseResizablePanelOptions) {
  const {
    ariaLabel,
    axis = "horizontal",
    cssVariable,
    defaultWidth,
    getDefaultWidth,
    getMaxWidth,
    growthDirection,
    maxWidth,
    minWidth,
    persistClamp = true,
    storageKey,
    widthRef,
  } = options;
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const restoredRef = useRef(false);
  // With persistClamp off: the user's size, which only their own commits change.
  const preferredRef = useRef(defaultWidth);
  const [width, setWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const effectiveMaxWidth = useCallback(
    () => Math.min(maxWidth, Math.max(minWidth, getMaxWidth())),
    [getMaxWidth, maxWidth, minWidth],
  );

  const clampWidth = useCallback(
    (candidate: number) => clampPanelWidth(candidate, minWidth, effectiveMaxWidth()),
    [effectiveMaxWidth, minWidth],
  );

  const applyLiveWidth = useCallback((nextWidth: number) => {
    widthRef.current = nextWidth;
    panelRef.current?.style.setProperty(cssVariable, `${nextWidth}px`);
  }, [cssVariable, widthRef]);

  const commitWidth = useCallback((candidate: number, commitOptions: CommitOptions = {}) => {
    const { forcePersist = false, persist = true } = commitOptions;
    const nextWidth = clampWidth(candidate);
    const changed = nextWidth !== widthRef.current;
    applyLiveWidth(nextWidth);
    setWidth(nextWidth);
    if (!persistClamp) {
      // Only a drag, a key or a reset forces a write: the user's own choice,
      // kept within the panel's fixed limits rather than this window's.
      if (forcePersist) {
        preferredRef.current = clampPanelWidth(candidate, minWidth, maxWidth);
        writeStoredWidth(storageKey, preferredRef.current);
      }
    } else if (persist && (changed || forcePersist)) {
      writeStoredWidth(storageKey, nextWidth);
    }
    return nextWidth;
  }, [applyLiveWidth, clampWidth, maxWidth, minWidth, persistClamp, storageKey, widthRef]);

  // Fits the panel to the window again: as it is now, or the user's size
  // (a drag under way keeps the size under the pointer).
  const fitWidth = useCallback(() => {
    commitWidth(persistClamp || dragRef.current ? widthRef.current : preferredRef.current, {
      persist: !dragRef.current,
    });
  }, [commitWidth, persistClamp, widthRef]);

  const restoreBodyState = useCallback((drag: DragState) => {
    document.body.style.cursor = drag.previousCursor;
    document.body.style.userSelect = drag.previousUserSelect;
    drag.shield?.remove();
  }, []);

  const finishResize = useCallback((pointerId: number, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    dragRef.current = null;
    restoreBodyState(drag);
    setIsResizing(false);
    // A click, cancelled pointer or Escape never overwrites the saved choice.
    const nextWidth = commitWidth(cancelled ? drag.startWidth : widthRef.current, {
      persist: !cancelled && drag.moved,
      forcePersist: !cancelled && drag.moved,
    });
    drag.target.setAttribute("aria-valuenow", String(nextWidth));
    drag.target.setAttribute("aria-valuetext", `${nextWidth} px`);

    try {
      if (drag.target.hasPointerCapture(pointerId)) {
        drag.target.releasePointerCapture(pointerId);
      }
    } catch {
      // The browser may have already released capture after pointer cancellation.
    }
  }, [commitWidth, restoreBodyState, widthRef]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const activeDrag = dragRef.current;
    if (activeDrag) finishResize(activeDrag.pointerId);

    const target = event.currentTarget;
    target.focus({ preventScroll: true });
    // Capture is an optimization, not the owner of the drag. Some browser /
    // embedded-preview transitions can release it while the button stays down.
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Window pointer listeners below still track the active pointer.
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startPosition: axis === "vertical" ? event.clientY : event.clientX,
      startWidth: widthRef.current,
      target,
      previousCursor: document.body.style.cursor,
      previousUserSelect: document.body.style.userSelect,
      moved: false,
      shield: null,
    };
    document.body.style.cursor = axis === "vertical" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    setIsResizing(true);
  }, [axis, finishResize, widthRef]);

  const onPointerMove = useCallback((event: Pick<globalThis.PointerEvent,
    "pointerId" | "pointerType" | "buttons" | "clientX" | "clientY" | "preventDefault"
  >) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) {
      finishResize(event.pointerId);
      return;
    }
    event.preventDefault();

    const direction = growthDirection === "right" || growthDirection === "down" ? 1 : -1;
    const position = axis === "vertical" ? event.clientY : event.clientX;
    const delta = position - drag.startPosition;
    if (!drag.moved) {
      if (Math.abs(delta) < 4) return;
      drag.moved = true;
      // A real hit-test shield, not a pointer-events:none overlay: keep embedded
      // previews from swallowing the pointer when crossing their frame boundary.
      const shield = document.createElement("div");
      shield.setAttribute("data-panel-drag-shield", "");
      shield.setAttribute("aria-hidden", "true");
      Object.assign(shield.style, {
        position: "fixed", inset: "0", zIndex: "2147483647",
        cursor: document.body.style.cursor, touchAction: "none", userSelect: "none",
      });
      document.body.appendChild(shield);
      drag.shield = shield;
    }
    const nextWidth = clampWidth(drag.startWidth + (delta * direction));
    applyLiveWidth(nextWidth);
    drag.target.setAttribute("aria-valuenow", String(nextWidth));
    drag.target.setAttribute("aria-valuetext", `${nextWidth} px`);
  }, [applyLiveWidth, axis, clampWidth, finishResize, growthDirection]);

  const onPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId);
  }, [finishResize]);

  const onPointerCancel = useCallback((event: PointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId, true);
  }, [finishResize]);

  const onLostPointerCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    // Losing capture is not a cancellation: keep following window events while
    // held, including events on the iframe shield. A released pointer commits.
    if (event.buttons === 0) finishResize(event.pointerId);
  }, [finishResize]);

  const resetWidth = useCallback(() => {
    const nextDefault = getDefaultWidth?.() ?? defaultWidth;
    commitWidth(nextDefault, { forcePersist: true });
  }, [commitWidth, defaultWidth, getDefaultWidth]);

  const reclampWidth = fitWidth;

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 12;
    const positiveDirection = growthDirection === "right" || growthDirection === "down";
    const positiveKey = axis === "vertical" ? "ArrowDown" : "ArrowRight";
    const negativeKey = axis === "vertical" ? "ArrowUp" : "ArrowLeft";
    const growKey = positiveDirection ? positiveKey : negativeKey;
    const shrinkKey = positiveDirection ? negativeKey : positiveKey;
    // Growing never lowers the user's size: while the window caps the panel
    // below it, grow and End start from that size, not the one shown.
    const growFrom = persistClamp ? widthRef.current : Math.max(widthRef.current, preferredRef.current);

    if (event.key === growKey) {
      event.preventDefault();
      commitWidth(growFrom + step, { forcePersist: true });
    } else if (event.key === shrinkKey) {
      event.preventDefault();
      commitWidth(widthRef.current - step, { forcePersist: true });
    } else if (event.key === "Home") {
      event.preventDefault();
      commitWidth(minWidth, { forcePersist: true });
    } else if (event.key === "End") {
      event.preventDefault();
      commitWidth(Math.max(growFrom, effectiveMaxWidth()), { forcePersist: true });
    } else if (event.key === "Enter") {
      event.preventDefault();
      resetWidth();
    }
  }, [axis, commitWidth, effectiveMaxWidth, growthDirection, minWidth, persistClamp, resetWidth, widthRef]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    const storedWidth = readStoredWidth(storageKey);
    const candidate = storedWidth ?? getDefaultWidth?.() ?? defaultWidth;
    if (!persistClamp) {
      preferredRef.current = clampPanelWidth(candidate, minWidth, maxWidth);
      commitWidth(preferredRef.current, { persist: false });
      return;
    }
    const restoredWidth = commitWidth(candidate, { persist: false });
    if (storedWidth !== null && storedWidth !== restoredWidth) {
      writeStoredWidth(storageKey, restoredWidth);
    }
  }, [commitWidth, defaultWidth, getDefaultWidth, maxWidth, minWidth, persistClamp, storageKey]);

  useEffect(() => {
    if (!restoredRef.current) return;
    fitWidth();

    const onResize = () => {
      fitWidth();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fitWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const cancelResize = () => {
      const drag = dragRef.current;
      if (drag) finishResize(drag.pointerId, true);
    };
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !dragRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancelResize();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") cancelResize();
    };
    const onWindowPointerUp = (event: globalThis.PointerEvent) => finishResize(event.pointerId);
    const onWindowPointerCancel = (event: globalThis.PointerEvent) => finishResize(event.pointerId, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onWindowPointerUp, true);
    window.addEventListener("pointercancel", onWindowPointerCancel, true);
    window.addEventListener("blur", cancelResize);
    window.addEventListener("keydown", onEscape, true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onWindowPointerUp, true);
      window.removeEventListener("pointercancel", onWindowPointerCancel, true);
      window.removeEventListener("blur", cancelResize);
      window.removeEventListener("keydown", onEscape, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [finishResize, isResizing, onPointerMove]);

  useEffect(() => {
    return () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      restoreBodyState(drag);
    };
  }, [restoreBodyState]);

  return {
    isResizing,
    panelRef,
    reclampWidth,
    resetWidth,
    separatorProps: {
      "aria-label": ariaLabel,
      "aria-orientation": axis === "vertical" ? "horizontal" as const : "vertical" as const,
      "aria-valuemax": mounted ? effectiveMaxWidth() : maxWidth,
      "aria-valuemin": minWidth,
      "aria-valuenow": width,
      "aria-valuetext": `${width} px`,
      onDoubleClick: resetWidth,
      onKeyDown,
      onLostPointerCapture,
      onPointerCancel,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      role: "separator" as const,
      tabIndex: 0,
    },
    width,
  };
}
