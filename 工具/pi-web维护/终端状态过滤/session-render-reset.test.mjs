import test from "node:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { withSessionRenderReset } from "./session-render-reset.ts";

const cli = await realpath(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const { TuiAltScreen, TuiMainScreen } = await import(new URL("../../node_modules/@earendil-works/pi-tui/dist/index.js", pathToFileURL(cli)));

for (const Renderer of [TuiAltScreen, TuiMainScreen]) {
  test(`${Renderer.name}: direct clears lose unchanged content; session reset repaints it ten times`, async () => {
    let output = "";
    const terminal = {
      columns: 80, rows: 24,
      write(text) { output += text; },
      hideCursor() {}, showCursor() {}, start() {}, stop() {},
    };
    const tui = new Renderer(terminal);
    const component = { render: () => ["WELCOME", "EDITOR", "FOOTER"], invalidate() {} };
    tui.addChild(component);
    tui.start();
    tui.renderNow();
    assert.match(output, /EDITOR/);
    output = "\x1b[2J\x1b[H"; // The installed Beautiful TUI's session_start clear.
    tui.renderNow();
    assert.doesNotMatch(output, /EDITOR/, "baseline must reproduce the screen-cache mismatch");

    let start;
    const pi = { on(_event, handler) { start = handler; } };
    const ctx = { hasUI: true, mode: "tui", ui: { setHeader(factory) { factory?.(tui); } } };
    let installed = false;
    withSessionRenderReset(pi).on("session_start", async (_event, view) => {
      output = "\x1b[2J\x1b[H";
      if (!installed) {
        view.ui.setHeader(() => component);
        installed = true;
      }
      await Promise.resolve();
    });
    try {
      for (let i = 0; i < 10; i++) {
        await start({ reason: "new" }, ctx);
        tui.renderNow();
        for (const text of ["WELCOME", "EDITOR", "FOOTER"]) assert.ok(output.includes(text), `${text} missing after session ${i + 1}`);
      }
    } finally {
      tui.stop();
    }
  });
}

test("passes non-TUI contexts through and does not redraw on ordinary events", async () => {
  const handlers = new Map();
  const calls = [];
  const renderer = { requestRender(force) { calls.push(force); } };
  const wrapped = withSessionRenderReset({ on(event, fn) { handlers.set(event, fn); } });
  wrapped.on("session_start", (_event, ctx) => ctx.ui.setHeader(() => ({})));
  wrapped.on("message_end", () => {});
  const ui = { setHeader(factory) { factory?.(renderer); } };
  await handlers.get("session_start")({}, { hasUI: true, mode: "tui", ui });
  assert.deepEqual(calls, [true]);
  await handlers.get("message_end")({}, { hasUI: true, mode: "tui", ui });
  assert.deepEqual(calls, [true]);
  for (const ctx of [{ hasUI: false, ui }, { hasUI: true, mode: "rpc", ui }]) {
    wrapped.on("session_start", (_event, actual) => assert.equal(actual, ctx));
    await handlers.get("session_start")({}, ctx);
  }
  assert.deepEqual(calls, [true]);
});

test("keeps initialization failures visible and stops tracking removed headers", async () => {
  const handlers = new Map();
  const calls = [];
  const renderer = { requestRender(force) { calls.push(force); } };
  const ctx = { hasUI: true, mode: "tui", ui: { setHeader(factory) { factory?.(renderer); } } };
  const wrapped = withSessionRenderReset({ on(event, fn) { handlers.set(event, fn); } });
  wrapped.on("session_start", (_event, view) => {
    view.ui.setHeader(() => ({}));
    throw new Error("editor failed");
  });
  await assert.rejects(handlers.get("session_start")({}, ctx), /editor failed/);
  assert.deepEqual(calls, [true]);
  wrapped.on("session_shutdown", (_event, view) => view.ui.setHeader(undefined));
  await handlers.get("session_shutdown")({}, ctx);
  wrapped.on("session_start", () => {});
  await handlers.get("session_start")({}, ctx);
  assert.deepEqual(calls, [true]);
});
