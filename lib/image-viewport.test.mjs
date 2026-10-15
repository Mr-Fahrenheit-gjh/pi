import assert from "node:assert/strict";
import test from "node:test";
import { clampImageTransform, zoomImageAt } from "./image-viewport.ts";

const viewport = { width: 800, height: 600, imageWidth: 800, imageHeight: 600 };

test("zoom preserves the image point under the cursor", () => {
  const start = { scale: 1, x: 0, y: 0 };
  const point = { x: 150, y: -80 };
  const next = zoomImageAt(start, 2, point, viewport);
  assert.deepEqual(next, { scale: 2, x: -150, y: 80 });
  assert.equal((point.x - next.x) / next.scale, (point.x - start.x) / start.scale);
  assert.equal((point.y - next.y) / next.scale, (point.y - start.y) / start.scale);
  assert.deepEqual(zoomImageAt(next, 1, point, viewport), start);
});

test("zoom and pan are clamped without letting the image disappear", () => {
  assert.deepEqual(clampImageTransform({ scale: 2, x: 10000, y: -10000 }, viewport), { scale: 2, x: 400, y: -300 });
  assert.deepEqual(clampImageTransform({ scale: 0.2, x: 100, y: 100 }, viewport), { scale: 1, x: 0, y: 0 });
  assert.equal(zoomImageAt({ scale: 7, x: 0, y: 0 }, 20, { x: 0, y: 0 }, viewport).scale, 8);
});

test("small images stay centred on axes that do not overflow", () => {
  const small = { ...viewport, imageWidth: 200, imageHeight: 500 };
  assert.deepEqual(clampImageTransform({ scale: 2, x: 50, y: 300 }, small), { scale: 2, x: 0, y: 200 });
});

test("a resized viewport reclamps the old offset", () => {
  assert.deepEqual(clampImageTransform({ scale: 2, x: 300, y: 200 }, { ...viewport, width: 1400, height: 1100 }), { scale: 2, x: 100, y: 50 });
});
