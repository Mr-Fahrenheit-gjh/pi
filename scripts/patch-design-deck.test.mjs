import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import ts from "typescript";
import { patchDeckFile, patchDesignDeck } from "./patch-design-deck.mjs";

const packageDir = process.env.PI_DESIGN_DECK_PACKAGE || join(homedir(), ".pi/agent/npm/node_modules/pi-design-deck");
const source = await readFile(join(packageDir, "index.ts"), "utf8");
const form = await readFile(join(packageDir, "form/js/deck-session.js"), "utf8");
const require = createRequire(import.meta.url);

// Execute the actual patched tool with no sockets, filesystem writes, model calls or OS launchers.
function toolHost(claim = true) {
  const bus = new EventEmitter(), hooks = new Map(), tools = new Map(), launched = [];
  let callbacks, handle, claimed, closeCount = 0;
  const updates = [];
  const pi = {
    events: { emit: (...args) => bus.emit(...args), on: (...args) => bus.on(...args) },
    on: (name, fn) => hooks.set(name, fn), registerTool: tool => tools.set(tool.name, tool),
    getThinkingLevel: () => "medium", setThinkingLevel() {},
    exec: async (...args) => { launched.push(args); return { code: 0 }; },
  };
  if (claim) bus.on("design-deck:present", request => { claimed = request; request.handled = true; });
  bus.on("design-deck:closed", () => closeCount++);
  const mocks = {
    "@earendil-works/pi-ai": { StringEnum: value => value },
    typebox: { Type: new Proxy({}, { get: () => value => value }) },
    "@earendil-works/pi-tui": { Text: class {} },
    "./settings.ts": { loadSettings: () => ({ autoSaveOnSubmit: false }) },
    "./deck-schema.ts": { validateDeckConfig: value => value, isDeckOption: value => !!value.label },
    "./generate-prompts.ts": { buildGenerateMoreResult: () => "more", buildRegenerateResult: () => "replace" },
    "./model-runner.ts": {}, "./export-html.ts": {},
    "./deck-server.ts": {
      getDefaultSnapshotDir: () => "/tmp/design-deck-test-unused",
      startDeckServer: async (options, handlers) => {
        callbacks = handlers;
        handle = { url: "http://localhost:42001/?session=fixture", port: 42001, close() {},
          pushOption: (id, option) => options.config.slides.find(s => s.id === id).options.push(option),
          cancelGenerate() {}, replaceSlideOptions() {} };
        return handle;
      },
    },
    "node:os": { ...require("node:os"), platform: () => "linux" },
    "node:child_process": { execFile: (...args) => args.at(-1)(null, ""), execFileSync: () => { throw new Error("Unexpected process launch"); } },
  };
  const sandboxModule = { exports: {} };
  runInNewContext(ts.transpileModule(patchDeckFile("index.ts", source).replaceAll("import.meta.url", JSON.stringify(import.meta.url)), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports: sandboxModule.exports, module: sandboxModule, require: name => name in mocks ? mocks[name] : require(name),
    process: { env: {} }, console, setTimeout, clearTimeout,
  });
  sandboxModule.exports.default(pi);
  const invoke = (params, signal) => tools.get("design_deck").execute("test-call", params, signal, value => updates.push(value), {
    cwd: "/tmp", hasUI: true, modelRegistry: { getAvailable: () => [] },
  });
  return { invoke, updates, launched, hooks, get callbacks() { return callbacks; }, get closeCount() { return closeCount; }, get claimed() { return claimed; } };
}
const slides = JSON.stringify({ title: "Test deck", slides: [{ id: "layout", title: "Choose", options: [{ label: "A", previewHtml: "<b>A</b>" }, { label: "B", previewHtml: "<b>B</b>" }] }] });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test("adapter validates before writing, is idempotent, and leaves installed files untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-design-deck-patch-"));
  try {
    await mkdir(join(dir, "form/js"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "pi-design-deck", version: "0.5.1" }));
    await writeFile(join(dir, "index.ts"), source);
    await writeFile(join(dir, "form/js/deck-session.js"), form);
    assert.ok((await patchDesignDeck(dir)).every(item => ["ready", "already-patched"].includes(item.status)));
    assert.equal(await readFile(join(dir, "index.ts"), "utf8"), source);
    await patchDesignDeck(dir, true);
    assert.ok((await patchDesignDeck(dir, true)).every(item => item.status === "already-patched"));
    await writeFile(join(dir, "index.ts"), source);
    await writeFile(join(dir, "form/js/deck-session.js"), "unknown upstream source");
    await assert.rejects(patchDesignDeck(dir, true), /Unsupported/);
    assert.equal(await readFile(join(dir, "index.ts"), "utf8"), source);
    assert.equal(await readFile(join(packageDir, "index.ts"), "utf8"), source);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("hosted tool skips OS launchers and retains the generate-more/add-options/submit protocol", async () => {
  const host = toolHost();
  const first = host.invoke({ slides });
  await nextTurn();
  assert.equal(host.claimed.handled, true);
  assert.deepEqual(host.launched, []);
  host.callbacks.onGenerateMore("layout", "different", undefined, undefined, 1);
  assert.equal((await first).details.status, "generate-more");
  assert.equal(host.closeCount, 0);
  const second = host.invoke({ action: "add-options", slideId: "layout", options: JSON.stringify([{ label: "C", previewHtml: "<b>C</b>" }]) });
  await nextTurn();
  host.callbacks.onSubmit({ layout: "C" }, { layout: "Use this" });
  const result = await second;
  assert.equal(result.details.status, "completed");
  assert.equal(result.details.selections.layout, "C");
  assert.equal(result.details.notes.layout, "Use this");
  assert.equal(host.closeCount, 1);
  assert.deepEqual(host.launched, []);
});

for (const mode of ["cancel", "abort", "shutdown"]) test(`hosted ${mode} resolves the waiting tool and releases the presentation`, async () => {
  const host = toolHost(), controller = new AbortController();
  const pending = host.invoke({ slides }, controller.signal);
  await nextTurn();
  if (mode === "cancel") host.callbacks.onCancel("user");
  else if (mode === "abort") controller.abort();
  else host.hooks.get("session_shutdown")();
  assert.equal((await pending).details.status, mode === "abort" ? "aborted" : "cancelled");
  assert.equal(host.closeCount, 1);
});

test("a CLI host without a presenter claim still opens its ordinary browser", async () => {
  const host = toolHost(false);
  const pending = host.invoke({ slides });
  await nextTurn();
  assert.equal(host.launched.length, 1);
  assert.equal(host.launched[0][0], "xdg-open");
  host.callbacks.onCancel("user");
  await pending;
  assert.equal(host.closeCount, 0);
});

test("only embedded pages omit the unload cancellation handler", () => {
  const patched = patchDeckFile("form/js/deck-session.js", form);
  const guard = patched.match(/if \(new URLSearchParams\(window.location.search\)[\s\S]*?\n\t\}/)[0];
  for (const [search, expected] of [["?embedded=1", 0], ["?session=fixture", 1], ["?embedded=0", 1]]) {
    const listeners = [];
    runInNewContext(guard, { URLSearchParams, window: { location: { search }, addEventListener: name => listeners.push(name) }, sendCancelBeacon() {} });
    assert.equal(listeners.length, expected);
  }
});
