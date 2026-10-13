import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { CanvasRenderer, Terminal } from 'ghostty-web';
const jiti = createJiti(import.meta.url);
const { TERMINAL_THEME } = await jiti.import('./ghostty-terminal.ts');
const { terminalThemeForPalette, readTerminalTheme } = await jiti.import('./terminal-theme.ts');
const keys = ['foreground', 'background', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
const rgb = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16));
const palette = (background, foreground, dark) => terminalThemeForPalette({ background, foreground, accent: dark ? '#afbece' : '#526171', selection: dark ? '#38414b' : '#dddeda' }, dark);

test('web shorthand colors are expanded rather than replaced by fallback colors', t => {
  const original = globalThis.getComputedStyle;
  t.after(() => { if (original === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = original; });
  const tokens = { '--bg': '#fff', '--text': '#222', '--accent': '#abc', '--bg-selected': '#eee' };
  globalThis.getComputedStyle = () => ({ getPropertyValue: key => tokens[key] });
  const theme = readTerminalTheme({ classList: { contains: () => false } });
  assert.equal(theme.background, '#ffffff');
  assert.equal(theme.foreground, '#222222');
  assert.equal(theme.cursor, '#aabbcc');
  assert.equal(theme.selectionBackground, '#eeeeee');
});

test('base colors are distinct; explicit RGB white is not a background alias', () => {
  assert.equal(new Set(keys.map(key => TERMINAL_THEME[key])).size, keys.length);
  assert.ok(!keys.some(key => TERMINAL_THEME[key] === '#ffffff'));
});

test('repeated theme changes recolor the same semantic palette, not arbitrary true color', () => {
  const renderer = Object.create(CanvasRenderer.prototype);
  renderer.theme = { ...TERMINAL_THEME };
  for (const next of [palette('#faf9f5', '#292722', false), palette('#1a1a1a', '#e8e8e8', true), palette('#fafaf9', '#292925', false)]) {
    renderer.setTheme(next);
    for (const key of keys) assert.equal(renderer.rgbToCSS(...rgb(TERMINAL_THEME[key])), next[key], key);
    assert.equal(renderer.rgbToCSS(1, 2, 3), 'rgb(1, 2, 3)');
    assert.equal(renderer.rgbToCSS(255, 255, 255), 'rgb(255, 255, 255)');
    assert.equal(renderer.rgbToCSS(0, 0, 0), 'rgb(0, 0, 0)');
  }
});

test('theme option redraws without resetting the emulator or scroll position', () => {
  const calls = [], wasmTerm = {}, theme = palette('#1a1a1a', '#e8e8e8', true);
  const terminal = { options: { theme }, wasmTerm, viewportY: 7, renderer: {
    setTheme(value) { calls.push(value); },
    render(...args) { calls.push(args); },
  } };
  Terminal.prototype.handleOptionChange.call(terminal, 'theme', theme, TERMINAL_THEME);
  assert.equal(calls[0], theme);
  assert.deepEqual(calls[1], [wasmTerm, true, 7, terminal]);
  assert.equal(terminal.wasmTerm, wasmTerm);
});

test('SSE reset still uses the original WASM palette after a theme change', () => {
  const terminal = { options: { theme: TERMINAL_THEME, scrollback: 10000 }, parseColorToHex: Terminal.prototype.parseColorToHex };
  const before = Terminal.prototype.buildWasmConfig.call(terminal);
  terminal.options.theme = palette('#1a1a1a', '#e8e8e8', true);
  assert.deepEqual(Terminal.prototype.buildWasmConfig.call(terminal), before);
});

test('reset rebinds selection to the new buffer rather than the freed instance', () => {
  const oldBuffer = { free() {} }, newBuffer = {}, calls = [];
  const terminal = { assertOpen() {}, wasmTerm: oldBuffer, buildWasmConfig: () => ({}),
    ghostty: { createTerminal: () => newBuffer }, cols: 60, rows: 35,
    renderer: { clear() {} }, viewportY: 5,
    selectionManager: { wasmTerm: oldBuffer, clearSelection() { calls.push('clear'); } },
    linkDetector: { invalidateCache() { calls.push('links'); } },
  };
  Terminal.prototype.reset.call(terminal);
  assert.equal(terminal.wasmTerm, newBuffer);
  assert.equal(terminal.selectionManager.wasmTerm, newBuffer);
  assert.equal(terminal.viewportY, 0);
  assert.deepEqual(calls, ['clear', 'links']);
});

test('select all includes scrollback and the last visible row', async () => {
  const { readFileSync } = await import('node:fs');
  const { Ghostty, SelectionManager } = await import('ghostty-web');
  const { instance } = await WebAssembly.instantiate(readFileSync(new URL('../node_modules/ghostty-web/ghostty-vt.wasm', import.meta.url)), { env: { log() {} } });
  const wasmTerm = new Ghostty(instance).createTerminal(12, 3);
  try {
    wasmTerm.write('one\r\ntwo\r\nthree\r\nfour');
    const selection = { wasmTerm, requestRender() {}, selectionChangedEmitter: { fire() {} } };
    SelectionManager.prototype.selectAll.call(selection);
    const text = SelectionManager.prototype.getSelection.call(selection);
    assert.match(text, /^one\n/);
    assert.match(text, /four$/);
    assert.equal(selection.selectionEnd.absoluteRow, wasmTerm.getScrollbackLength() + 2);
  } finally { wasmTerm.free(); }
});

test('font box, rather than capital M ink, leaves the first line unclipped', t => {
  const original = globalThis.document;
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
  globalThis.document = { createElement: () => ({ getContext: () => ({ measureText: () => ({ width: 8.4, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 0, fontBoundingBoxAscent: 15, fontBoundingBoxDescent: 4 }) }) }) };
  const metrics = CanvasRenderer.prototype.measureFont.call({ fontSize: 14, fontFamily: 'JetBrainsMono Nerd Font' });
  assert.equal(metrics.width, 9);
  assert.equal(metrics.baseline, 16);
  assert.equal(metrics.height, 21);
  assert.ok(metrics.baseline - 15 >= 1);
  assert.ok(metrics.height - metrics.baseline - 4 >= 1);
});
