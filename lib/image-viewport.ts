export interface ImageTransform {
  scale: number;
  x: number;
  y: number;
}

export interface ImageViewport {
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
}

export const IMAGE_MIN_SCALE = 1;
export const IMAGE_MAX_SCALE = 8;
export const IMAGE_DRAG_THRESHOLD = 4;

export function clampImageTransform(transform: ImageTransform, viewport: ImageViewport): ImageTransform {
  const scale = Math.max(IMAGE_MIN_SCALE, Math.min(IMAGE_MAX_SCALE, transform.scale));
  const limitX = Math.max(0, (viewport.imageWidth * scale - viewport.width) / 2);
  const limitY = Math.max(0, (viewport.imageHeight * scale - viewport.height) / 2);
  return {
    scale,
    x: Math.max(-limitX, Math.min(limitX, transform.x)),
    y: Math.max(-limitY, Math.min(limitY, transform.y)),
  };
}

// The point under the cursor stays put: p = offset + imagePoint * scale.
// Coordinates are relative to the centre of the viewport.
export function zoomImageAt(
  transform: ImageTransform,
  nextScale: number,
  point: { x: number; y: number },
  viewport: ImageViewport,
): ImageTransform {
  const scale = Math.max(IMAGE_MIN_SCALE, Math.min(IMAGE_MAX_SCALE, nextScale));
  const ratio = scale / transform.scale;
  return clampImageTransform({
    scale,
    x: point.x - (point.x - transform.x) * ratio,
    y: point.y - (point.y - transform.y) * ratio,
  }, viewport);
}
