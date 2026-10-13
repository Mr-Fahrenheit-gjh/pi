import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import { Ghostty, SelectionManager } from "ghostty-web";
const { clampTerminalFontSize, terminalKeyAction, TERMINAL_THEME } = await createJiti(import.meta.url).import("./ghostty-terminal.ts");
const key = (key, overrides = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides });
test("Ctrl+C without selection interrupts rather than copying", () => {
  assert.equal(terminalKeyAction(key("c", { ctrlKey: true }), false), null);
  assert.equal(terminalKeyAction(key("c", { ctrlKey: true }), true), "copy");
  assert.equal(terminalKeyAction(key("c", { metaKey: true }), true), "copy");
});
test("native paste and shell navigation are not intercepted", () => {
  for (const event of [key("v", { metaKey: true }), key("v", { ctrlKey: true }), key("a", { ctrlKey: true }), key("l", { ctrlKey: true }), key("ArrowUp"), key("中")]) assert.equal(terminalKeyAction(event, false), null);
  assert.equal(terminalKeyAction(key("k", { metaKey: true }), false), "clear");
  assert.equal(terminalKeyAction(key("a", { metaKey: true }), false), "selectAll");
});
test("readable bounded font sizes", () => {
  assert.equal(clampTerminalFontSize(4), 8);
  assert.equal(clampTerminalFontSize(14), 14);
  assert.equal(clampTerminalFontSize(32), 32);
  assert.equal(clampTerminalFontSize(100), 72);
  assert.equal(TERMINAL_THEME.background, "#fffffe"); // immutable base, mapped to the selected paper at paint time
});
test("CJK selection skips wide continuation cells but preserves real spaces", async () => {
  const bytes = readFileSync(new URL("../node_modules/ghostty-web/ghostty-vt.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const wasmTerm = new Ghostty(instance).createTerminal(80, 24);
  try {
    wasmTerm.write("中文 A B 输入法");
    const selected = SelectionManager.prototype.getSelection.call({
      selectionStart: { col: 0, absoluteRow: 0 }, selectionEnd: { col: 79, absoluteRow: 0 }, wasmTerm,
    });
    assert.equal(selected, "中文 A B 输入法");
  } finally { wasmTerm.free(); }
});
test("versioned same-origin WASM exactly matches the pinned dependency", () => {
  const bytes = readFileSync(new URL("../public/vendor/ghostty-web/0.4.0/ghostty-vt.wasm", import.meta.url));
  const dependency = readFileSync(new URL("../node_modules/ghostty-web/ghostty-vt.wasm", import.meta.url));
  assert.deepEqual([...bytes.subarray(0, 4)], [0, 97, 115, 109]);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(dependency).digest("hex"));
});
