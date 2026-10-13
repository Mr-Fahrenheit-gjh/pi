import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { normalizePreviewUrl, previewUrlsFromOutput } = await jiti.import("./browser-preview.ts");
const { wheelLines, mouseWheelSequence } = await jiti.import("./terminal-wheel.ts");

test("preview addresses accept HTTP(S) and local development ports", () => {
  assert.equal(normalizePreviewUrl("https://example.com/demo"), "https://example.com/demo");
  assert.equal(normalizePreviewUrl("localhost:5173"), "http://localhost:5173/");
  assert.equal(normalizePreviewUrl("127.0.0.1:3000"), "http://127.0.0.1:3000/");
});
test("browser actions reject scripts, file paths, credentials and controls", () => {
  for (const value of ["javascript:alert(1)", "data:text/html,abc", "file:///etc/passwd", "https://u:p@example.com", "https://example.com/\npath", "", "x".repeat(5000)]) assert.equal(normalizePreviewUrl(value), null, value.slice(0, 50));
});
test("URL suggestions are bounded, ANSI-free and deduplicated", () => {
  assert.deepEqual(previewUrlsFromOutput("\x1b[32mhttp://localhost:5173/\x1b[0m\nhttp://localhost:5173/ https://example.com/demo)"), ["https://example.com/demo", "http://localhost:5173/"]);
  assert.equal(previewUrlsFromOutput(Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`).join(" ")).length, 8);
});
test("trackpad pixels accumulate instead of turning every fractional delta into a key", () => {
  const event = { deltaY: -5, deltaMode: 0, ctrlKey: false, altKey: false, shiftKey: false };
  const first = wheelLines(event, 20, 30);
  assert.equal(first.lines, 0);
  assert.equal(wheelLines({ ...event, deltaY: -15 }, 20, 30, first.remainder).lines, -1);
});
test("wheel line/page units, burst limit and pinch handling", () => {
  const event = { deltaY: 3, deltaMode: 1, ctrlKey: false, altKey: false, shiftKey: false };
  assert.equal(wheelLines(event, 20, 30).lines, 3);
  assert.equal(wheelLines({ ...event, deltaMode: 2 }, 20, 30).lines, 12);
  assert.equal(wheelLines({ ...event, ctrlKey: true }, 20, 30).lines, 0);
});
test("fullscreen scrolling uses mouse wheel reports, never input-history arrow keys", () => {
  const modifiers = { ctrlKey: false, altKey: false, shiftKey: false };
  assert.equal(mouseWheelSequence(-1, 4, 5, true, modifiers), "\x1b[<64;4;5M");
  assert.equal(mouseWheelSequence(1, 4, 5, true, modifiers), "\x1b[<65;4;5M");
  assert.equal(mouseWheelSequence(-1, 4, 5, false, modifiers), "\x1b[M`$%");
});
