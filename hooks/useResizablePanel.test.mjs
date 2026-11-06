import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// The hook runs here against a stand-in for React's hooks (one component,
// effects after each render), a window whose size is a variable and a Map for
// localStorage, so what each path shows and saves can be played out.
const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(shimPath);
const { useResizablePanel } = await jiti.import("./useResizablePanel.ts");

function emitter(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    emit(type, event = {}) { for (const fn of [...(listeners.get(type) ?? [])]) fn(event); },
  };
}

const KEY = "test-panel-height";
const stored = new Map();
globalThis.window = emitter({
  localStorage: {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  },
});
const shields = new Set();
globalThis.document = emitter({
  body: {
    style: { cursor: "", userSelect: "" },
    appendChild(node) { shields.add(node); },
  },
  createElement() {
    return { style: {}, setAttribute() {}, remove() { shields.delete(this); } };
  },
});

// One panel at a time: the previous test's stops listening to the window.
let mounted = null;

function mount({ storedHeight, persistClamp, room, axis = "vertical", growthDirection = "down" }) {
  mounted?.unmount();
  stored.clear();
  if (storedHeight !== undefined) stored.set(KEY, String(storedHeight));
  assert.equal(shields.size, 0, "the previous panel removed its drag shield");
  const space = { room };
  const widthRef = { current: 0 };
  const view = renderHook(() => useResizablePanel({
    ariaLabel: "Resize",
    axis,
    cssVariable: "--test-height",
    defaultWidth: 240,
    getMaxWidth: () => space.room,
    growthDirection,
    maxWidth: 800,
    minWidth: 120,
    persistClamp,
    storageKey: KEY,
    widthRef,
  }));
  mounted = view;
  const resize = (nextRoom) => {
    space.room = nextRoom;
    window.emit("resize");
    view.flush();
  };
  const key = (name, shiftKey = false) => {
    view.result.separatorProps.onKeyDown({ key: name, shiftKey, preventDefault() {} });
    view.flush();
  };
  return { view, resize, key, shown: () => view.result.width, saved: () => stored.get(KEY) };
}

test("by default a window too short for the stored size saves the smaller one (both AppShell panels)", () => {
  const panel = mount({ storedHeight: 400, room: 300 });
  assert.equal(panel.shown(), 300);
  assert.equal(panel.saved(), "300");
  panel.resize(250);
  assert.equal(panel.saved(), "250");
  panel.resize(600);
  assert.equal(panel.shown(), 250, "the stored size was lost");
});

test("without persistClamp a short window shows less, saves nothing and grows back", () => {
  const panel = mount({ storedHeight: 400, persistClamp: false, room: 300 });
  assert.equal(panel.shown(), 300);
  assert.equal(panel.saved(), "400");
  panel.resize(250);
  assert.equal(panel.shown(), 250);
  panel.view.result.reclampWidth();
  panel.view.flush();
  assert.equal(panel.saved(), "400");
  panel.resize(600);
  assert.equal(panel.shown(), 400, "back to the user's size");
  panel.resize(1000);
  assert.equal(panel.shown(), 400, "never past it");
  assert.equal(panel.saved(), "400");
});

test("without persistClamp keys and a reset are the user's choice and are saved", () => {
  const panel = mount({ storedHeight: 400, persistClamp: false, room: 300 });
  panel.key("ArrowUp");
  assert.equal(panel.shown(), 288, "shrinks from the size shown");
  assert.equal(panel.saved(), "288");
  panel.resize(600);
  assert.equal(panel.shown(), 288, "the new choice replaced the old one");
  panel.key("End");
  assert.equal(panel.saved(), "600");
  panel.resize(300);
  panel.key("ArrowDown", true);
  assert.equal(panel.shown(), 300, "the window still caps what shows");
  assert.equal(panel.saved(), "632", "a grow starts from the user's size, not the capped one");
  panel.key("End");
  assert.equal(panel.saved(), "632", "End never lowers it either");
  assert.equal(panel.shown(), 300);
  panel.key("Home");
  assert.equal(panel.saved(), "120");
  panel.key("Enter");
  assert.equal(panel.shown(), 240);
  assert.equal(panel.saved(), "240");
});

const separatorTarget = {
  focus() {},
  setPointerCapture() {},
  hasPointerCapture: () => false,
  releasePointerCapture() {},
  setAttribute() {},
};
const pointer = (clientY, extra = {}) => ({
  pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientY, clientX: 0,
  currentTarget: separatorTarget, preventDefault() {}, stopPropagation() {}, ...extra,
});

test("without persistClamp a drag saves where it ends, and a resize during it leaves it alone", () => {
  const panel = mount({ persistClamp: false, room: 500 });
  assert.equal(panel.shown(), 240);
  assert.equal(panel.saved(), undefined, "the default is not written on mount");
  const props = () => panel.view.result.separatorProps;
  props().onPointerDown(pointer(100));
  panel.view.flush();
  props().onPointerMove(pointer(160));
  panel.resize(500);
  assert.equal(panel.shown(), 300, "the size under the pointer, not the saved one");
  props().onPointerMove(pointer(180));
  props().onPointerUp(pointer(180));
  panel.view.flush();
  assert.equal(panel.shown(), 320);
  assert.equal(panel.saved(), "320");
  assert.equal(document.body.style.cursor, "");
});

test("without persistClamp a click on the separator saves nothing", () => {
  const panel = mount({ storedHeight: 400, persistClamp: false, room: 300 });
  const props = () => panel.view.result.separatorProps;
  props().onPointerDown(pointer(100));
  panel.view.flush();
  props().onPointerUp(pointer(100));
  panel.view.flush();
  assert.equal(panel.shown(), 300);
  assert.equal(panel.saved(), "400", "not the short window's clamp");
  panel.resize(1000);
  assert.equal(panel.shown(), 400, "back to the user's size");
});

test("a sub-4px move is a click, not a saved drag", () => {
  const panel = mount({ persistClamp: false, room: 500 });
  const props = () => panel.view.result.separatorProps;
  props().onPointerDown(pointer(100));
  panel.view.flush();
  props().onPointerMove(pointer(103));
  assert.equal(shields.size, 0);
  props().onPointerUp(pointer(103));
  panel.view.flush();
  assert.equal(panel.shown(), 240);
  assert.equal(panel.saved(), undefined);
});

test("Escape rolls a live drag back without saving, even after window resizing", () => {
  const panel = mount({ storedHeight: 400, room: 600 });
  const props = () => panel.view.result.separatorProps;
  props().onPointerDown(pointer(100));
  panel.view.flush();
  props().onPointerMove(pointer(180));
  assert.equal(shields.size, 1);
  panel.resize(650);
  assert.equal(panel.shown(), 480);
  assert.equal(panel.saved(), "400", "live widths are not persisted");
  let stopped = false;
  window.emit("keydown", { key: "Escape", preventDefault() {}, stopPropagation() { stopped = true; } });
  panel.view.flush();
  assert.equal(stopped, true);
  assert.equal(panel.shown(), 400);
  assert.equal(panel.saved(), "400");
  assert.equal(shields.size, 0);
  assert.equal(panel.view.result.isResizing, false);
  assert.equal(document.body.style.userSelect, "");
});

for (const cancelMethod of ["onPointerCancel"]) {
  test(`${cancelMethod} restores the initial width and removes the iframe shield`, () => {
    const panel = mount({ storedHeight: 300, room: 600 });
    const props = () => panel.view.result.separatorProps;
    props().onPointerDown(pointer(100));
    panel.view.flush();
    props().onPointerMove(pointer(180));
    props()[cancelMethod](pointer(180));
    panel.view.flush();
    assert.equal(panel.shown(), 300);
    assert.equal(panel.saved(), "300");
    assert.equal(shields.size, 0);
  });
}

for (const growthDirection of ["right", "left"]) {
  test(`${growthDirection}-growing panel keeps dragging after capture loss and commits on window pointerup`, () => {
    const panel = mount({ storedHeight: 240, room: 600, axis: "horizontal", growthDirection });
    const props = () => panel.view.result.separatorProps;
    const direction = growthDirection === "right" ? 1 : -1;
    const event = delta => pointer(100, { clientX: 200 + delta * direction });
    props().onPointerDown(event(0));
    panel.view.flush();
    props().onPointerMove(event(40));
    props().onLostPointerCapture(event(40));
    panel.view.flush();
    assert.equal(panel.view.result.isResizing, true, "capture loss is not pointer cancellation");
    assert.equal(shields.size, 1, "keep the iframe shield while the pointer is held");
    window.emit("pointermove", { ...event(80), currentTarget: window });
    window.emit("pointerup", { ...event(80), buttons: 0, currentTarget: window });
    panel.view.flush();
    assert.equal(panel.shown(), 320);
    assert.equal(panel.saved(), "320");
    assert.equal(shields.size, 0);
    assert.equal(panel.view.result.isResizing, false);
    assert.equal(document.body.style.cursor, "");
    window.emit("pointermove", event(120));
    panel.view.flush();
    assert.equal(panel.shown(), 320, "completed drags do not leave window listeners active");
  });
}

test("capture loss before movement still tracks the pointer, ignores other pointers and cancels on blur", () => {
  const panel = mount({ storedHeight: 240, room: 600 });
  const props = () => panel.view.result.separatorProps;
  props().onPointerDown(pointer(100));
  panel.view.flush();
  props().onLostPointerCapture(pointer(100));
  window.emit("pointermove", pointer(180, { pointerId: 2 }));
  window.emit("pointerup", pointer(180, { pointerId: 2, buttons: 0 }));
  assert.equal(shields.size, 0, "an unrelated pointer cannot move or finish this drag");
  window.emit("pointermove", pointer(180));
  assert.equal(shields.size, 1);
  window.emit("blur");
  panel.view.flush();
  assert.equal(panel.shown(), 240);
  assert.equal(panel.saved(), "240");
  assert.equal(shields.size, 0);
  assert.equal(panel.view.result.isResizing, false);
});

test("unmounting during a drag restores body state and removes its shield", () => {
  const panel = mount({ room: 600 });
  panel.view.result.separatorProps.onPointerDown(pointer(100));
  panel.view.flush();
  panel.view.result.separatorProps.onPointerMove(pointer(180));
  assert.equal(shields.size, 1);
  panel.view.unmount();
  mounted = null;
  assert.equal(shields.size, 0);
  assert.equal(document.body.style.cursor, "");
});
