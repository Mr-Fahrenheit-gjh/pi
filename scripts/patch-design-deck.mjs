// Compatibility adapter for pi-design-deck 0.5.1. Nothing is installed by importing this file.
// Check first; applying to the installed extension belongs to the authorized release.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const replacements = {
  "index.ts": [
    [
      'let restoreDeckThinking: (() => void) | null = null;',
      'let restoreDeckThinking: (() => void) | null = null;\nlet closeHostPresentation: (() => void) | null = null;',
    ],
    [
      'function cleanupActiveDeck(reason?: string): void {\n\tclearDeckIdleTimer();',
      'function cleanupActiveDeck(reason?: string): void {\n\tclearDeckIdleTimer();\n\tconst closePresentation = closeHostPresentation;\n\tcloseHostPresentation = null;\n\tclosePresentation?.();',
    ],
    [
      '\tpi.on("session_shutdown", () => {\n\t\tpendingDeckResult = null;',
      '\tpi.on("session_shutdown", () => {\n\t\tif (closeHostPresentation && activeDeckServer) {\n\t\t\tcleanupActiveDeckAndStoreResult({\n\t\t\t\tcontent: [{ type: "text", text: "Design deck session closed." }],\n\t\t\t\tdetails: { status: "cancelled", url: activeDeckServer.handle.url, reason: "session-shutdown" },\n\t\t\t});\n\t\t}\n\t\tpendingDeckResult = null;',
    ],
    [
      '"On macOS, opens in a native window (Glimpse); falls back to a browser tab elsewhere. "',
      '"In Pi Web, opens in the right sidebar; other hosts use a native window or browser tab. "',
    ],
    [
      '\t\t\tconst remoteLikely = isRemoteSession() || await hasActiveRemoteLogin();',
      '\t\t\t// pi-web-design-deck-presenter-v1: a host may claim presentation without changing the tool protocol.\n\t\t\tconst presentation = { url: serverHandle.url, title: config.title || "Design Deck", handled: false };\n\t\t\tpi.events.emit("design-deck:present", presentation);\n\t\t\tif (presentation.handled) {\n\t\t\t\tcloseHostPresentation = () => pi.events.emit("design-deck:closed", { url: serverHandle.url });\n\t\t\t\treturn blockOnDeck();\n\t\t\t}\n\n\t\t\tconst remoteLikely = isRemoteSession() || await hasActiveRemoteLogin();',
    ],
  ],
  "form/js/deck-session.js": [[
    '\twindow.addEventListener("beforeunload", sendCancelBeacon);',
    '\t// Embedded pages may be recreated when the host UI reloads; explicit Cancel still works.\n\tif (new URLSearchParams(window.location.search).get("embedded") !== "1") {\n\t\twindow.addEventListener("beforeunload", sendCancelBeacon);\n\t}',
  ]],
};

export function patchDeckFile(path, source) {
  for (const [before, after] of replacements[path] ?? []) {
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2) throw new Error(`Unsupported design-deck source: ${path}`);
    source = source.replace(before, after);
  }
  return source;
}

export async function patchDesignDeck(packageDir, apply = false) {
  const metadata = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  if (metadata.name !== "pi-design-deck" || metadata.version !== "0.5.1") {
    throw new Error("This adapter requires pi-design-deck 0.5.1; review it before changing versions.");
  }
  // Validate both files before writing either; drift fails closed.
  const files = await Promise.all(Object.keys(replacements).map(async path => {
    const source = await readFile(join(packageDir, path), "utf8");
    return { path, source, patched: patchDeckFile(path, source) };
  }));
  for (const file of files) {
    if (apply && file.source !== file.patched) await writeFile(join(packageDir, file.path), file.patched);
  }
  return files.map(file => ({ path: file.path, status: file.source === file.patched ? "already-patched" : apply ? "patched" : "ready" }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, packageDir] = process.argv.slice(2);
  if (!["--check", "--apply"].includes(mode) || !packageDir || process.argv.length !== 4) {
    console.error("Usage: node scripts/patch-design-deck.mjs --check|--apply /path/to/pi-design-deck");
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(await patchDesignDeck(resolve(packageDir), mode === "--apply")));
  }
}
