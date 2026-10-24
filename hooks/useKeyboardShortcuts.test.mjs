import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";
import { handleGlobalEscape, registerAbortHandler, isQuickActionsShortcut, quickActionsShortcutMode } from "./useKeyboardShortcuts.ts";

function keydown(key, { tagName = "BUTTON", defaultPrevented = false } = {}) {
  return {
    key,
    target: { tagName },
    defaultPrevented,
    preventDefault() { this.defaultPrevented = true; },
  };
}

test("Escape stops a running agent when nothing else took the key", (t) => {
  let stopped = 0;
  registerAbortHandler(() => { stopped += 1; });
  t.after(() => registerAbortHandler(null));

  const event = keydown("Escape");
  assert.equal(handleGlobalEscape(event), true);
  assert.equal(stopped, 1);
  assert.equal(event.defaultPrevented, true);
  // Focus on the page itself, as after a click on nothing in particular.
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "BODY" })), true);
  assert.equal(stopped, 2);
  assert.equal(handleGlobalEscape(keydown("Enter")), false);
  assert.equal(stopped, 2);
});

test("an Escape something nearer already handled does not stop the agent too", (t) => {
  let stopped = 0;
  registerAbortHandler(() => { stopped += 1; });
  t.after(() => registerAbortHandler(null));

  // Settings, the Mermaid viewer or a menu closed on it and marked it handled.
  assert.equal(handleGlobalEscape(keydown("Escape", { defaultPrevented: true })), false);
  // ChatInput and other fields keep their own Escape.
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "TEXTAREA" })), false);
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "INPUT" })), false);
  assert.equal(stopped, 0);
});

test("with no run to stop, Escape is left alone", () => {
  registerAbortHandler(null);
  const event = keydown("Escape");
  assert.equal(handleGlobalEscape(event), false);
  assert.equal(event.defaultPrevented, false);
});

test("Escape cancelling an IME composition does not stop the agent", (t) => {
  let stopped = 0;
  registerAbortHandler(() => { stopped++; });
  t.after(() => registerAbortHandler(null));
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    assert.equal(handleGlobalEscape({ ...keydown("Escape"), ...composition }), false);
  }
  assert.equal(stopped, 0);
});

test("global shortcut preserves its mode before preventing the native browser key", () => {
  let handler;
  const exports = {};
  const source = readFileSync(new URL('./useKeyboardShortcuts.ts', import.meta.url), 'utf8');
  new Script(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText).runInNewContext({
    exports, require: () => ({ useEffect: fn => fn() }),
    window: { addEventListener: (_name, fn) => { handler = fn; }, removeEventListener() {} },
  });
  const modes = [];
  exports.useGlobalKeyboardShortcuts({ onQuickActions: mode => modes.push(mode) });
  for (const key of ['k', 'j']) {
    const event = { key, metaKey: true, target: { closest: () => null }, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; } };
    handler(event);
    assert.equal(event.defaultPrevented, true);
  }
  assert.deepEqual(modes, ['command', 'chat']);
});

test("quick actions respect IME, terminal, dialog and already handled keys", () => {
  const event = { key: "k", metaKey: true, target: { closest: () => null } };
  assert.equal(isQuickActionsShortcut(event), true);
  assert.equal(quickActionsShortcutMode(event), "command");
  assert.equal(quickActionsShortcutMode({ ...event, key: "j" }), "chat");
  assert.equal(isQuickActionsShortcut({ ...event, key: "j" }), true);
  assert.equal(quickActionsShortcutMode({ ...event, key: "x" }), null);
  assert.equal(isQuickActionsShortcut({ ...event, metaKey: false, ctrlKey: true }), true);
  for (const guard of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { repeat: true }, { altKey: true }, { shiftKey: true }, { metaKey: false }, { target: { closest: () => ({}) } }]) {
    assert.equal(isQuickActionsShortcut({ ...event, ...guard }), false);
    assert.equal(isQuickActionsShortcut({ ...event, key: "j", ...guard }), false);
  }
});
