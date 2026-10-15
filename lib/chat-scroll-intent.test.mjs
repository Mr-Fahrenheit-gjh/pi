import assert from "node:assert/strict";
import test from "node:test";
import { bindChatScrollIntent, scrollKeyDirection } from "./chat-scroll-intent.ts";

class FakeElement {
  constructor(parentElement = null) { this.parentElement = parentElement; }
  closest() { return this.editable ? this : this.parentElement?.closest() ?? null; }
}
class FakeHTMLElement extends FakeElement {
  listeners = new Map();
  scrollHeight = 600;
  clientHeight = 600;
  overflowY = "visible";
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  removeEventListener(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); }
  emit(name, data = {}) { this.listeners.get(name)?.({ target: this, ...data }); }
}
globalThis.Element = FakeElement;
globalThis.HTMLElement = FakeHTMLElement;
globalThis.getComputedStyle = (el) => ({ overflowY: el.overflowY });

const key = (name, extra = {}) => ({ key: name, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });

test("scroll keys distinguish reading history, returning and non-scroll shortcuts", () => {
  for (const name of ["ArrowUp", "PageUp", "Home"]) assert.equal(scrollKeyDirection(key(name)), "away");
  for (const name of ["ArrowDown", "PageDown", "End", " "]) assert.equal(scrollKeyDirection(key(name)), "toward");
  assert.equal(scrollKeyDirection(key(" ", { shiftKey: true })), "away");
  assert.equal(scrollKeyDirection(key("ArrowUp", { metaKey: true })), null);
  assert.equal(scrollKeyDirection(key("Home", { ctrlKey: true })), "away");
  assert.equal(scrollKeyDirection(key("a")), null);
});

test("wheel intent is delivered before any scroll and listeners are removed", () => {
  const container = new FakeHTMLElement();
  const received = [];
  const cleanup = bindChatScrollIntent(container, (direction) => received.push(direction));
  container.emit("wheel", { deltaY: -1 });
  assert.deepEqual(received, ["away"]);
  container.emit("wheel", { deltaY: 3 });
  container.emit("wheel", { deltaY: -3, ctrlKey: true });
  container.emit("wheel", { deltaY: 0 });
  assert.deepEqual(received, ["away", "toward"]);
  cleanup();
  assert.equal(container.listeners.size, 0);
});

test("nested scroll surfaces and editor/control keys do not detach the transcript", () => {
  const container = new FakeHTMLElement();
  const code = new FakeHTMLElement(container);
  code.overflowY = "auto";
  code.scrollHeight = 1200;
  const editor = new FakeElement(container);
  editor.editable = true;
  const received = [];
  bindChatScrollIntent(container, (direction) => received.push(direction));
  container.emit("wheel", { target: code, deltaY: -100 });
  container.emit("keydown", { target: editor, ...key("Home") });
  container.emit("keydown", { ...key("ArrowUp"), defaultPrevented: true });
  assert.deepEqual(received, []);
  container.emit("keydown", key("PageUp"));
  assert.deepEqual(received, ["away"]);
  container.emit("wheel", { target: editor, deltaY: -10 });
  assert.deepEqual(received, ["away", "away"], "wheel over a control still scrolls the transcript");
});

test("single-finger movement signals direction, multi-touch and cancelled gestures do not", () => {
  const container = new FakeHTMLElement();
  const received = [];
  bindChatScrollIntent(container, (direction) => received.push(direction));
  container.emit("touchstart", { touches: [{ clientY: 100 }] });
  container.emit("touchmove", { touches: [{ clientY: 101 }] });
  container.emit("touchmove", { touches: [{ clientY: 120 }] });
  container.emit("touchmove", { touches: [{ clientY: 90 }] });
  container.emit("touchcancel");
  container.emit("touchmove", { touches: [{ clientY: 140 }] });
  container.emit("touchstart", { touches: [{ clientY: 100 }] });
  container.emit("touchmove", { touches: [{ clientY: 120 }, { clientY: 140 }] });
  container.emit("touchmove", { touches: [{ clientY: 150 }] });
  container.emit("touchstart", { touches: [{ clientY: 100 }, { clientY: 120 }] });
  container.emit("touchmove", { touches: [{ clientY: 150 }] });
  assert.deepEqual(received, ["away", "toward"]);
});
