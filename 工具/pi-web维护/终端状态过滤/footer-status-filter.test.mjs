import test from "node:test";
import assert from "node:assert/strict";
import { withFilteredFooter } from "./footer-status-filter.ts";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("hides status rows without mutating live statuses or other footer data", () => {
  const handlers = new Map();
  const statuses = new Map([
    ["codex-computer-use", "codex-cua: computer on · browser on · ready"],
    ["lsp", "LSP: 1/8 servers"],
    ["other-extension", "other status"],
    ["codex-speed", "Codex fast"],
  ]);
  const footerData = {
    statuses,
    getExtensionStatuses() { return this.statuses; },
    getGitBranch() { return this.statuses.has("lsp") ? "main" : null; },
  };
  let footer;
  const ui = {
    setFooter(factory) { footer = factory; },
    notify(message) { return message; },
  };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    getThinkingLevel() { return "max"; },
  };
  const wrapped = withFilteredFooter(pi);
  assert.equal(wrapped.getThinkingLevel(), "max");
  wrapped.on("session_start", (_event, ctx) => {
    assert.equal(ctx.ui.notify("ok"), "ok");
    ctx.ui.setFooter((_tui, _theme, data) => data);
  });
  handlers.get("session_start")({}, { ui });
  const view = footer({}, {}, footerData);
  assert.deepEqual([...view.getExtensionStatuses()], []);
  assert.equal(statuses.get("lsp"), "LSP: 1/8 servers");
  assert.equal(view.getGitBranch(), "main");
  assert.equal(statuses.has("codex-computer-use"), true);
  statuses.set("lsp", "LSP: connection failed");
  assert.equal(view.getExtensionStatuses().has("lsp"), false);
  assert.equal(statuses.get("lsp"), "LSP: connection failed");
  statuses.set("codex-speed", "OpenAI fast");
  assert.equal(view.getExtensionStatuses().has("codex-speed"), false);
  view.getExtensionStatuses().clear();
  assert.equal(statuses.get("codex-speed"), "OpenAI fast");
  statuses.delete("codex-speed");
  assert.equal(view.getExtensionStatuses().size, 0);
  assert.equal(statuses.size, 3);
});

test("reload picks up changed filter logic in the real Pi module loader", async () => {
  const cli = await realpath(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
  const { createJiti } = await import(new URL("../core/extensions/jiti-loader.js", pathToFileURL(cli)));
  const dir = await mkdtemp(join(tmpdir(), "pi-footer-reload-"));
  try {
    const source = await readFile(new URL("./footer-status-filter.ts", import.meta.url), "utf8");
    const entry = join(dir, "wrapper.ts");
    const helper = join(dir, "footer-status-filter.ts");
    await writeFile(entry, 'import {withFilteredFooter} from "./footer-status-filter.ts"; export default withFilteredFooter;');
    await writeFile(helper, source.replace('return new Map();', 'return new Map([["legacy", "legacy"]]);'));
    const visibleKeys = async () => {
      const jiti = createJiti(import.meta.url, { moduleCache: false });
      const wrap = await jiti.import(entry, { default: true });
      let handler, footer;
      wrap({ on(_event, fn) { handler = fn; } }).on("session_start", (_event, ctx) => {
        ctx.ui.setFooter((_tui, _theme, data) => data);
      });
      handler({}, { ui: { setFooter(fn) { footer = fn; } } });
      return [...footer({}, {}, { getExtensionStatuses: () => new Map([["lsp", "LSP 0/8"], ["codex-speed", "Codex fast"]]) }).getExtensionStatuses().keys()];
    };
    assert.deepEqual(await visibleKeys(), ["legacy"]);
    await writeFile(helper, source);
    assert.deepEqual(await visibleKeys(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Fast decorates only the footer model label and follows toggles/model switches", () => {
  let handler, factory;
  const statuses = new Map();
  const ctx = {
    model: { id: "gpt-6.1-sol", provider: "openai-codex" },
    ui: { setFooter(fn) { factory = fn; } },
  };
  const model = ctx.model;
  const theme = { fg(color, text) { assert.equal(this, theme); return `${color}:${text}`; } };
  withFilteredFooter({ on(_event, fn) { handler = fn; } }).on("session_start", (_event, view) => {
    view.ui.setFooter((_tui, paint, data) => ({
      render: () => [paint.fg("text", view.model.id), paint.fg("text", "OpenAI Codex"), ...data.getExtensionStatuses().values()],
    }));
  });
  handler({}, ctx);
  const footer = factory({}, theme, { getExtensionStatuses: () => statuses });
  assert.deepEqual(footer.render(), ["text:gpt-6.1-sol", "text:OpenAI Codex"]);
  statuses.set("codex-speed", "Codex fast");
  statuses.set("lsp", "LSP: 0/8 servers");
  assert.deepEqual(footer.render(), ["text:gpt-6.1-sol ⚡", "text:OpenAI Codex"]);
  assert.equal(ctx.model, model);
  assert.equal(model.id, "gpt-6.1-sol");
  ctx.model = { id: "gpt-6-astra", provider: "openai" };
  statuses.set("codex-speed", "OpenAI fast");
  assert.equal(footer.render()[0], "text:gpt-6-astra ⚡");
  statuses.delete("codex-speed");
  assert.equal(footer.render()[0], "text:gpt-6-astra");
});

test("passes footer removal through unchanged", () => {
  let handler;
  let received = "not called";
  const pi = { on(_event, fn) { handler = fn; } };
  withFilteredFooter(pi).on("session_shutdown", (_event, ctx) => ctx.ui.setFooter(undefined));
  handler({}, { ui: { setFooter(value) { received = value; } } });
  assert.equal(received, undefined);
});
