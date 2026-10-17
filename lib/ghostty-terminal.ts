import { runtimeFetch as fetch } from "./runtime-client.mjs";
import type { Ghostty } from "ghostty-web";
import { DEFAULT_GHOSTTY_FONT, type GhosttyFontPreferences } from "./ghostty-font-config";

export async function loadGhosttyFontPreferences(signal?: AbortSignal): Promise<GhosttyFontPreferences> {
  try {
    const response = await fetch("/api/terminal/preferences", { signal, cache: "no-store" });
    if (!response.ok) return DEFAULT_GHOSTTY_FONT;
    const value = await response.json() as GhosttyFontPreferences;
    if (typeof value.fontFamily !== "string" || value.fontFamily.length > 1600 || !Number.isFinite(value.fontSize)) return DEFAULT_GHOSTTY_FONT;
    return { fontFamily: value.fontFamily, fontSize: clampTerminalFontSize(value.fontSize), source: value.source === "ghostty" ? "ghostty" : "default" };
  } catch { return DEFAULT_GHOSTTY_FONT; }
}

// Use an explicit, versioned same-origin asset, not the package's URL guessing.
let runtime: Promise<{ module: typeof import("ghostty-web"); ghostty: Ghostty }> | undefined;
export function loadGhosttyTerminal() {
  runtime ??= import("ghostty-web").then(async (module) => ({
    module,
    ghostty: await module.Ghostty.load("/vendor/ghostty-web/0.4.0/ghostty-vt.wasm"),
  })).catch((error) => {
    runtime = undefined;
    throw error;
  });
  return runtime;
}

// Immutable WASM palette. Its 18 distinct RGB values identify semantic colors
// for the version-pinned renderer's live mapping. Near-white avoids confusing
// the default background with explicit #ffffff / ANSI-256 white output.
export const TERMINAL_THEME = {
  background: "#fffffe", foreground: "#30343b", cursor: "#5c6570",
  cursorAccent: "#ffffff", selectionBackground: "#dde1df", selectionForeground: "#20252b",
  black: "#2f343b", red: "#a84343", green: "#40734f", yellow: "#896521",
  blue: "#396ba0", magenta: "#7d5790", cyan: "#347b80", white: "#d8dce2",
  brightBlack: "#69717b", brightRed: "#b44a4a", brightGreen: "#467a54",
  brightYellow: "#916a26", brightBlue: "#4074ad", brightMagenta: "#875e9a",
  brightCyan: "#39848a", brightWhite: "#f2f3f5",
};

export function clampTerminalFontSize(size: number) {
  return Math.min(72, Math.max(8, size));
}

export function terminalKeyAction(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, selected: boolean) {
  const key = event.key.toLowerCase();
  if (event.altKey) return null;
  if ((event.metaKey || event.ctrlKey) && key === "c" && selected) return "copy";
  if (event.metaKey && key === "k") return "clear";
  if (event.metaKey && key === "a") return "selectAll";
  // Ctrl+C without a selection remains SIGINT. Ctrl+L stays a shell command.
  return null;
}
