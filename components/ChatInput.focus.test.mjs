import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findEffect(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect"
    && node.arguments[0]?.name?.text === "restoreComposerFocus") return node;
  return ts.forEachChild(node, findEffect);
}
const effect = findEffect(source);
assert.ok(effect, "test the actual composer focus effect");
const script = new Script(ts.transpileModule(`(${effect.arguments[0].getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText);

function harness() {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const frames = new Map();
  let nextFrame = 0;
  const isComposingRef = { current: false };
  const state = { mobile: false, focused: true, selected: false, hidden: false, inert: false, overlays: [], focusCalls: [], blurCalls: 0 };
  const document = {
    body: { matches: () => false }, documentElement: { matches: () => false }, activeElement: null, visibilityState: "visible",
    hasFocus: () => state.focused,
    querySelectorAll: () => state.overlays,
    addEventListener: (type, fn) => documentListeners.set(type, fn),
    removeEventListener: (type, fn) => { if (documentListeners.get(type) === fn) documentListeners.delete(type); },
  };
  const textarea = {
    isConnected: true,
    getClientRects: () => state.hidden ? [] : [{}],
    closest: () => state.inert ? {} : null,
    blur() { state.blurCalls++; document.activeElement = document.body; },
    focus(options) { state.focusCalls.push({ ...options }); document.activeElement = textarea; },
  };
  const window = {
    matchMedia: () => ({ matches: state.mobile }),
    getSelection: () => ({ isCollapsed: !state.selected }),
    addEventListener: (type, fn) => windowListeners.set(type, fn),
    removeEventListener: (type, fn) => { if (windowListeners.get(type) === fn) windowListeners.delete(type); },
  };
  document.activeElement = document.body;
  return {
    state, document, textarea, windowListeners, documentListeners, frames, isComposingRef,
    mount(compact = false) {
      return script.runInNewContext({
        compact, textareaRef: { current: textarea }, isComposingRef, document, window,
        requestAnimationFrame: (fn) => { const id = ++nextFrame; frames.set(id, fn); return id; },
        cancelAnimationFrame: (id) => frames.delete(id),
      })();
    },
    flush() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(); },
    leaveWindow() { windowListeners.get("blur")?.(); },
    hidePage() { document.visibilityState = "hidden"; documentListeners.get("visibilitychange")?.(); },
    returnToWindow() { windowListeners.get("focus")?.(); },
    showPage() { document.visibilityState = "visible"; documentListeners.get("visibilitychange")?.(); },
  };
}

const control = (navigation = false, keyboard = false) => ({
  matches: (selector) => selector === ":focus-visible" ? keyboard : navigation,
});

test("entering a conversation focuses the composer once without scrolling", () => {
  const h = harness();
  h.mount();
  assert.equal(h.state.focusCalls.length, 0, "wait until the mounted draft is ready");
  h.flush();
  assert.deepEqual(h.state.focusCalls, [{ preventScroll: true }]);
  h.returnToWindow();
  h.showPage();
  h.flush();
  assert.equal(h.state.focusCalls.length, 1, "leave an existing caret/selection alone");
  assert.equal(effect.arguments[1].getText(source), "[compact, draftKey]", "session changes, not streamed replies, trigger entry focus");
});

test("returning to the window or tab restores an idle composer", () => {
  const h = harness();
  h.mount();
  h.flush();
  h.document.activeElement = h.document.body;
  h.returnToWindow();
  h.flush();
  h.document.activeElement = h.document.documentElement;
  h.showPage();
  h.flush();
  assert.equal(h.state.focusCalls.length, 3);
});

test("tab/window return reconnects native input even when the textarea stayed active", () => {
  for (const leave of ["leaveWindow", "hidePage"]) {
    const h = harness();
    h.mount(); h.flush();
    h.isComposingRef.current = true; // The browser may omit compositionend on departure.
    h[leave]();
    assert.equal(h.isComposingRef.current, false, "abandoned composition cannot block future keys");
    h.returnToWindow(); h.showPage();
    assert.equal(h.state.blurCalls, 0, "wait for browser activation to settle");
    h.flush();
    assert.equal(h.state.blurCalls, 1);
    assert.equal(h.state.focusCalls.length, 2, "focus + visibility return coalesce into one reconnect");
    assert.equal(h.document.activeElement, h.textarea);
    h.returnToWindow(); h.flush();
    assert.equal(h.state.blurCalls, 1, "ordinary focus events must not keep resetting the IME");
  }
});

test("deferred return rechecks ownership, overlays and a newly started composition", () => {
  for (const change of [
    h => { h.document.activeElement = control(); },
    h => { h.state.overlays = [{ getClientRects: () => [{}] }]; },
    h => { h.isComposingRef.current = true; },
    h => { h.state.selected = true; },
    h => { h.state.focused = false; },
  ]) {
    const h = harness();
    h.mount(); h.flush(); h.leaveWindow(); h.returnToWindow();
    change(h); h.flush();
    assert.equal(h.state.blurCalls, 0);
    assert.equal(h.state.focusCalls.length, 1);
  }
});

test("return while still hidden waits for visibility and unmount cancels pending reconnect", () => {
  const h = harness();
  const cleanup = h.mount(); h.flush();
  h.hidePage(); h.returnToWindow(); h.flush();
  assert.equal(h.state.blurCalls, 0);
  h.showPage(); h.flush();
  assert.equal(h.state.blurCalls, 1);
  h.leaveWindow(); h.returnToWindow(); cleanup(); h.flush();
  assert.equal(h.state.blurCalls, 1);
  assert.equal(h.windowListeners.size + h.documentListeners.size, 0);
});

test("mouse session/New navigation hands off focus, keyboard navigation keeps it", () => {
  for (const keyboard of [false, true]) {
    const h = harness();
    h.document.activeElement = control(true, keyboard);
    h.mount();
    h.flush();
    assert.equal(h.state.focusCalls.length, keyboard ? 0 : 1);
    h.document.activeElement = control(true, false);
    h.returnToWindow();
    assert.equal(h.state.focusCalls.length, keyboard ? 0 : 1, "window return does not steal navigation focus");
  }
});

for (const [name, prepare] of [
  ["mobile/touch keyboard", (h) => { h.state.mobile = true; }],
  ["background tab", (h) => { h.document.visibilityState = "hidden"; }],
  ["inactive window", (h) => { h.state.focused = false; }],
  ["hidden composer", (h) => { h.state.hidden = true; }],
  ["detached composer", (h) => { h.textarea.isConnected = false; }],
  ["inert/aria-hidden conversation", (h) => { h.state.inert = true; }],
  ["open dialog/menu", (h) => { h.state.overlays = [{ getClientRects: () => [{}] }]; }],
  ["selected message text", (h) => { h.state.selected = true; }],
  ["another field, terminal, iframe or control", (h) => { h.document.activeElement = control(); }],
]) {
  test(`automatic focus preserves ${name}`, () => {
    const h = harness();
    prepare(h);
    h.mount();
    h.flush();
    h.returnToWindow();
    h.documentListeners.get("visibilitychange")?.();
    h.flush();
    assert.equal(h.state.focusCalls.length, 0);
  });
}

test("deferred entry focus rechecks the user's current target", () => {
  const h = harness();
  h.mount();
  h.document.activeElement = control();
  h.flush();
  assert.equal(h.state.focusCalls.length, 0);
});

test("hidden overlays do not block entry focus", () => {
  const h = harness();
  h.state.overlays = [{ getClientRects: () => [] }];
  h.mount();
  h.flush();
  assert.equal(h.state.focusCalls.length, 1);
});

test("compact quote composer opts out, unmount removes callbacks", () => {
  const compact = harness();
  assert.equal(compact.mount(true), undefined);
  assert.equal(compact.frames.size + compact.windowListeners.size + compact.documentListeners.size, 0);
  const h = harness();
  const cleanup = h.mount();
  cleanup();
  assert.equal(h.frames.size + h.windowListeners.size + h.documentListeners.size, 0);
  h.flush();
  h.returnToWindow();
  h.showPage();
  assert.equal(h.state.focusCalls.length, 0);
});
