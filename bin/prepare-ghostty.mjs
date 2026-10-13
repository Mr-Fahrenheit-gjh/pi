import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = "0.4.0";
const dependency = join(root, "node_modules/ghostty-web");
const pkg = JSON.parse(readFileSync(join(dependency, "package.json"), "utf8"));
if (pkg.version !== version) throw new Error(`Expected ghostty-web ${version}, got ${pkg.version}`);
// 0.4.0 copies the continuation cell of a wide glyph as a literal space.
// Keep a narrow, idempotent patch until upstream fixes CJK selection copying.
const esm = join(dependency, "dist/ghostty-web.js");
const original = "const a = i[M];\n        if (a && a.codepoint !== 0) {";
const patched = "const a = i[M];\n        if (M > 0 && i[M - 1]?.width === 2) continue; // pi-web: skip wide continuation\n        if (a && a.codepoint !== 0) {";
function patch(before, after, label) {
  const source = readFileSync(esm, "utf8");
  if (source.includes(after)) return;
  if (source.split(before).length !== 2) throw new Error(`Ghostty ${label} patch no longer matches; review upstream before upgrading`);
  writeFileSync(esm, source.replace(before, after));
}
patch(original, patched, "CJK selection");
// The WASM bridge exports resolved RGB, not color indices. Retain its immutable
// base palette and remap only exact palette values at paint time. Never rebuild
// the emulator, replay shell output, invert the canvas, or discard scrollback.
patch('  rgbToCSS(A, B, g) {\n    return `rgb(${A}, ${B}, ${g})`;',
  '  rgbToCSS(A, B, g) {\n    return this.piThemeColors?.get((A << 16) | (B << 8) | g) ?? `rgb(${A}, ${B}, ${g})`;', 'palette paint');
patch('  setTheme(A) {\n    this.theme = { ...f, ...A }, this.palette = [',
  `  setTheme(A) {
    this.piBaseTheme ??= this.theme;
    const next = { ...f, ...A };
    this.piThemeColors = new Map();
    for (const key of ["foreground", "background", "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"]) {
      const from = this.piBaseTheme[key];
      if (/^#[0-9a-f]{6}$/i.test(from)) this.piThemeColors.set(parseInt(from.slice(1), 16), next[key]);
    }
    this.theme = next, this.palette = [`, 'live palette');
patch('this.renderer && console.warn("ghostty-web: theme changes after open() are not yet fully supported");',
  `if (this.renderer && this.wasmTerm) {
            this.renderer.setTheme(this.options.theme);
            this.renderer.render(this.wasmTerm, true, this.viewportY, this);
          }`, 'live theme option');
patch('    const A = this.options.theme, B = this.options.scrollback;',
  '    this.piWasmTheme ??= this.options.theme;\n    const A = this.piWasmTheme, B = this.options.scrollback;', 'stable reset palette');
// reset() replaces WASM, but upstream leaves selection bound to the freed
// instance. Rebind it or copied rows use obsolete dimensions after resizing.
patch('this.wasmTerm = this.ghostty.createTerminal(this.cols, this.rows, A), this.renderer.clear(), this.currentTitle = "";',
  `this.wasmTerm = this.ghostty.createTerminal(this.cols, this.rows, A), this.renderer.clear(), this.currentTitle = "";
    if (this.selectionManager) {
      this.selectionManager.wasmTerm = this.wasmTerm;
      this.selectionManager.clearSelection();
    }
    this.linkDetector?.invalidateCache();
    this.viewportY = 0;`, 'reset selection binding');
// selectAll used a viewport-relative number as an absolute buffer row,
// omitting bottom rows as soon as scrollback existed. Select the whole buffer.
patch('const A = this.wasmTerm.getDimensions(), B = this.getViewportY();\n    this.selectionStart = { col: 0, absoluteRow: B }, this.selectionEnd = { col: A.cols - 1, absoluteRow: B + A.rows - 1 }',
  'const A = this.wasmTerm.getDimensions(), B = this.wasmTerm.getScrollbackLength();\n    this.selectionStart = { col: 0, absoluteRow: 0 }, this.selectionEnd = { col: A.cols - 1, absoluteRow: B + A.rows - 1 }', 'complete buffer selection');
// Measuring only "M" omits full ascent/descent. A bold first row can draw above
// y=0 and be clipped (not a toolbar overlap). Use full font metrics and padding.
patch('C = g.actualBoundingBoxAscent || this.fontSize * 0.8, I = g.actualBoundingBoxDescent || this.fontSize * 0.2',
  'C = Math.max(g.fontBoundingBoxAscent || this.fontSize, g.actualBoundingBoxAscent || 0), I = Math.max(g.fontBoundingBoxDescent || this.fontSize * 0.25, g.actualBoundingBoxDescent || 0)', 'font bounds');
const target = join(root, "public/vendor/ghostty-web", version);
mkdirSync(target, { recursive: true });
for (const name of ["ghostty-vt.wasm", "LICENSE"]) copyFileSync(join(dependency, name), join(target, name));
const hash = createHash("sha256").update(readFileSync(join(target, "ghostty-vt.wasm"))).digest("hex");
console.log(`ghostty-web ${version} WASM sha256 ${hash}`);
