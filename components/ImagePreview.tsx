"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  clampImageTransform,
  IMAGE_DRAG_THRESHOLD,
  IMAGE_MAX_SCALE,
  IMAGE_MIN_SCALE,
  zoomImageAt,
  type ImageTransform,
} from "@/lib/image-viewport";

interface ImagePreviewProps {
  src: string;
  alt?: string;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

function ImageViewport({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const transformRef = useRef<ImageTransform>({ scale: 1, x: 0, y: 0 });
  const [transform, setTransform] = useState(transformRef.current);
  const dragRef = useRef<{
    pointerId: number; startX: number; startY: number;
    transform: ImageTransform; moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const backdropPointerRef = useRef(false);

  const geometry = useCallback(() => {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    return {
      width: viewport?.clientWidth ?? 0,
      height: viewport?.clientHeight ?? 0,
      imageWidth: image?.offsetWidth ?? 0,
      imageHeight: image?.offsetHeight ?? 0,
    };
  }, []);
  const apply = useCallback((next: ImageTransform) => {
    const clamped = clampImageTransform(next, geometry());
    transformRef.current = clamped;
    setTransform(clamped);
  }, [geometry]);
  const zoom = useCallback((scale: number, clientPoint?: { x: number; y: number }) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const point = clientPoint
      ? { x: clientPoint.x - rect.left - rect.width / 2, y: clientPoint.y - rect.top - rect.height / 2 }
      : { x: 0, y: 0 };
    apply(zoomImageAt(transformRef.current, scale, point, geometry()));
  }, [apply, geometry]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      const delta = Math.max(-100, Math.min(100, event.deltaY * unit));
      zoom(transformRef.current.scale * Math.exp(-delta * 0.005), { x: event.clientX, y: event.clientY });
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      apply(transformRef.current);
    });
    observer?.observe(viewport);
    if (imageRef.current) observer?.observe(imageRef.current);
    return () => {
      viewport.removeEventListener("wheel", wheel);
      observer?.disconnect();
    };
  }, [apply, zoom]);

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    suppressClickRef.current = drag.moved;
    if (cancelled) apply(drag.transform);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <>
      <div className="image-preview-toolbar" role="toolbar" aria-label={t("chat.previewImage")}>
        <button type="button" onClick={() => zoom(transformRef.current.scale / 1.25)} disabled={transform.scale <= IMAGE_MIN_SCALE} aria-label={t("i18n.zoomOut")} title={t("i18n.zoomOut")}>−</button>
        <output className="image-preview-scale" aria-live="off">{Math.round(transform.scale * 100)}%</output>
        <button type="button" onClick={() => zoom(transformRef.current.scale * 1.25)} disabled={transform.scale >= IMAGE_MAX_SCALE} aria-label={t("i18n.zoomIn")} title={t("i18n.zoomIn")}>+</button>
        <button type="button" onClick={() => apply({ scale: 1, x: 0, y: 0 })} aria-label={t("i18n.resetView")} title={t("i18n.resetView")}>↺</button>
      </div>
      <div
        ref={viewportRef}
        className="image-preview-viewport"
        tabIndex={0}
        role="region"
        aria-label={t("chat.imageNavigationHint")}
        title={t("chat.imageNavigationHint")}
        data-zoomed={transform.scale > 1 || undefined}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          const step = event.shiftKey ? 80 : 32;
          if (event.key === "+" || event.key === "=") zoom(transformRef.current.scale * 1.25);
          else if (event.key === "-") zoom(transformRef.current.scale / 1.25);
          else if (event.key === "0") apply({ scale: 1, x: 0, y: 0 });
          else if (event.key === "ArrowLeft") apply({ ...transformRef.current, x: transformRef.current.x + step });
          else if (event.key === "ArrowRight") apply({ ...transformRef.current, x: transformRef.current.x - step });
          else if (event.key === "ArrowUp") apply({ ...transformRef.current, y: transformRef.current.y + step });
          else if (event.key === "ArrowDown") apply({ ...transformRef.current, y: transformRef.current.y - step });
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          zoom(transformRef.current.scale > 1 ? 1 : 2, { x: event.clientX, y: event.clientY });
        }}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          suppressClickRef.current = false;
          backdropPointerRef.current = event.target === event.currentTarget;
          if (transformRef.current.scale <= 1) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
            transform: { ...transformRef.current }, moved: false,
          };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const dx = event.clientX - drag.startX;
          const dy = event.clientY - drag.startY;
          if (!drag.moved && Math.hypot(dx, dy) < IMAGE_DRAG_THRESHOLD) return;
          drag.moved = true;
          apply({ ...drag.transform, x: drag.transform.x + dx, y: drag.transform.y + dy });
        }}
        onPointerUp={(event) => finishDrag(event)}
        onPointerCancel={(event) => finishDrag(event, true)}
        onLostPointerCapture={(event) => finishDrag(event, true)}
        onClick={(event) => {
          // Do not interpret the click generated at the end of a pan as a
          // backdrop click, even when pointer capture retargets it here.
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            event.stopPropagation();
          } else if (event.target === event.currentTarget && backdropPointerRef.current) {
            onClose();
          }
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imageRef}
          className="image-preview-image"
          src={src}
          alt={alt}
          draggable={false}
          onLoad={() => apply(transformRef.current)}
          style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
        />
      </div>
    </>
  );
}

export function ImagePreview({ src, alt = "", children, className, style }: ImagePreviewProps) {
  const { t } = useI18n();
  const previewLabel = t("chat.previewImage");
  const triggerLabel = alt.trim() ? `${previewLabel}: ${alt}` : previewLabel;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [open]);

  const closePreview = () => {
    if (dialogRef.current?.open) dialogRef.current.close();
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className}
        style={{ display: "block", padding: 0, border: "none", background: "none", color: "inherit", cursor: "zoom-in", ...style }}
        onClick={() => setOpen(true)}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={previewLabel}
      >
        {children}
      </button>
      {open && (
        <dialog
          ref={dialogRef}
          className="image-preview-dialog"
          aria-label={previewLabel}
          onCancel={(event) => { event.preventDefault(); event.stopPropagation(); closePreview(); }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault(); event.stopPropagation(); closePreview();
          }}
          onClick={(event) => { if (event.target === event.currentTarget) closePreview(); }}
        >
          <ImageViewport key={src} src={src} alt={alt} onClose={closePreview} />
          <button ref={closeButtonRef} type="button" className="image-preview-close" onClick={closePreview} aria-label={t("chat.close")} title={t("chat.close")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </dialog>
      )}
    </>
  );
}
