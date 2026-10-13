import { normalizePreviewUrl } from "./browser-preview";
import type { BrowserCommand } from "./browser-types";
export const isBrowserId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const integer = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const number = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
export function parseBrowserCommand(input: unknown): BrowserCommand | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const b = input as Record<string, unknown>;
  if (b.type === "navigate" && typeof b.url === "string") {
    const url = normalizePreviewUrl(b.url); return url ? { type: "navigate", url } : null;
  }
  if (b.type === "reload" || b.type === "back" || b.type === "forward" || b.type === "copy") return { type: b.type };
  if (b.type === "resize" && integer(b.width, 200, 2400) && integer(b.height, 150, 1600)) return { type: "resize", width: b.width, height: b.height };
  if (b.type === "text" && typeof b.text === "string" && b.text.length <= 65536) return { type: "text", text: b.text };
  if (b.type === "dialog" && typeof b.accept === "boolean" && (b.promptText === undefined || typeof b.promptText === "string" && b.promptText.length <= 4096)) return { type: "dialog", accept: b.accept, promptText: b.promptText as string | undefined };
  if (b.type === "key" && ["keyDown", "keyUp"].includes(String(b.event)) && typeof b.key === "string" && b.key.length <= 80 && typeof b.code === "string" && b.code.length <= 80 && integer(b.keyCode, 0, 65535) && integer(b.modifiers, 0, 15) && (b.text === undefined || typeof b.text === "string" && b.text.length <= 16)) {
    return { type: "key", event: b.event as "keyDown" | "keyUp", key: b.key, code: b.code, keyCode: b.keyCode, modifiers: b.modifiers, text: b.text as string | undefined };
  }
  if (b.type === "mouse" && ["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].includes(String(b.event)) && number(b.x, 0, 2400) && number(b.y, 0, 1600) && ["left", "middle", "right", "none"].includes(String(b.button)) && integer(b.buttons, 0, 7) && integer(b.clickCount, 0, 3) && integer(b.modifiers, 0, 15) && (b.deltaX === undefined || number(b.deltaX, -5000, 5000)) && (b.deltaY === undefined || number(b.deltaY, -5000, 5000))) {
    return { type: "mouse", event: b.event as "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel", x: b.x, y: b.y, button: b.button as "left" | "middle" | "right" | "none", buttons: b.buttons, clickCount: b.clickCount, modifiers: b.modifiers, deltaX: b.deltaX as number | undefined, deltaY: b.deltaY as number | undefined };
  }
  return null;
}
