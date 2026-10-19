// Candidate-only: isolated history, intercepted agent commands, no model calls.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function prepareSidebarForkFixture(agentDir) {
  assert.match(resolve(agentDir), /^\/(?:private\/)?tmp\//);
  const project = join(agentDir, "分支会话演示");
  const sessions = join(agentDir, "sessions", "fork-tree");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [] }));
  const entries = [
    ["root", "调研顶会 Benchmark 设计", null, 0],
    ["fork", "分支：比较研究方法", "root", 4],
    ["nested", "分支：补充实验方案", "fork", 5],
    ["sibling", "分支：核对评价指标", "root", 3],
    ["other", "继续推进当前调研工作", null, 2],
  ];
  const base = Date.parse("2026-10-16T06:00:00Z");
  for (const [suffix, name, parent, order] of entries) {
    const id = `fork-tree-${suffix}`;
    const timestamp = new Date(base + order * 1000).toISOString();
    const header = { type: "session", version: 3, id, timestamp, cwd: project,
      ...(parent ? { parentSession: join(sessions, `fork-tree-${parent}.jsonl`) } : {}) };
    const rows = [header,
      { type: "session_info", id: "title", timestamp, name },
      { type: "message", id: "user", parentId: "title", timestamp,
        message: { role: "user", content: name, timestamp: base } },
      { type: "message", id: "answer", parentId: "user", timestamp,
        message: { role: "assistant", content: [{ type: "text", text: `这是 ${name} 的独立会话。` }],
          api: "openai-completions", provider: "openai", model: "fork-fixture", stopReason: "stop", timestamp: base,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
    ];
    writeFileSync(join(sessions, `${id}.jsonl`), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  }
  return { project };
}

export async function runSidebarForkChecks(page, { baseURL, project, outputDir }) {
  assert.match(baseURL, /^http:\/\/127\.0\.0\.1:301[5-9]\d$/);
  assert.match(project, /^\/(?:private\/)?tmp\//);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("pi-locale", "zh-CN");
    localStorage.setItem("pi-ui-language-version", "english-interface-v1"); // Explicit test locale after migration.
    localStorage.setItem("pi-theme", "claude-white");
    localStorage.setItem("pi-sidebar-open", "true");
    window.EventSource = class extends EventTarget {
      readyState = 1;
      close() { this.readyState = 2; }
    };
  });
  const state = { model: { provider: "openai", id: "fork-fixture" }, thinkingLevel: "medium",
    isStreaming: false, isPromptRunning: false, messages: [], extensionStatuses: [], extensionWidgets: [] };
  await page.route("**/api/agent/*/subagents**", (route) => route.fulfill({ json: { available: false } }));
  await page.route("**/api/agent/running", (route) => route.fulfill({ json: { running: [], awaitingInput: [] } }));
  await page.route("**/api/sessions/*/state", (route) => route.fulfill({ json: { running: false, state } }));
  await page.route("**/api/agent/fork-tree-*", (route) => {
    const command = route.request().method() === "POST" ? route.request().postDataJSON() : {};
    assert.ok(!command.type || ["get_state", "get_tools", "get_commands"].includes(command.type), `Unexpected agent command: ${command.type}`);
    return route.fulfill({ json: command.type === "get_state" ? { success: true, data: state }
      : command.type === "get_tools" ? { success: true, data: [] }
        : command.type === "get_commands" ? { success: true, data: { commands: [] } }
          : { running: false, state } });
  });
  await page.route("**/api/models?**", (route) => route.fulfill({ json: {
    models: { "openai/fork-fixture": "Fixture" }, modelList: [{ provider: "openai", id: "fork-fixture", name: "Fixture" }],
    defaultModel: { provider: "openai", modelId: "fork-fixture" }, defaultThinkingLevel: "medium",
  } }));
  const row = (suffix, context = "group") => page.locator(`[data-row-key="session:${context}:fork-tree-${suffix}"]`);
  await page.goto(`${baseURL}/?session=fork-tree-root`, { waitUntil: "networkidle" });
  await row("nested").waitFor({ state: "visible" });
  for (const [suffix, depth] of [["root", 0], ["fork", 1], ["nested", 2], ["sibling", 1], ["other", 0]]) {
    assert.equal(await row(suffix).getAttribute("data-branch-depth"), String(depth));
  }
  const geometry = await Promise.all(["root", "fork", "nested", "sibling", "other"].map(async (suffix) => {
    const title = await row(suffix).locator(".session-tree-title").boundingBox();
    return { suffix, x: title.x, y: title.y };
  }));
  assert.ok(geometry[0].y < geometry[1].y && geometry[1].y < geometry[2].y && geometry[0].y < geometry[3].y, "parents must precede their descendants");
  assert.equal(geometry[1].x - geometry[0].x, 16);
  assert.equal(geometry[2].x - geometry[1].x, 16);
  const rootLink = row("root").locator(".session-tree-main");
  await rootLink.click();
  await page.waitForFunction(() => document.querySelector('[data-row-key="session:group:fork-tree-root"] .session-tree-main')?.getAttribute("aria-current") === "true");
  await row("fork").locator(".session-tree-branch-toggle").click();
  await row("nested").waitFor({ state: "detached" });
  assert.equal(await rootLink.getAttribute("aria-current"), "true", "folding must not select a session");
  await row("fork").locator(".session-tree-branch-toggle").click();
  await row("nested").waitFor({ state: "visible" });
  await row("nested").locator(".session-tree-main").click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("session") === "fork-tree-nested");
  await row("root").locator(".session-tree-branch-toggle").click();
  await row("fork").waitFor({ state: "detached" });
  // A catalogue refresh must not override the user's explicit fold.
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/sessions");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await refreshed;
  assert.equal(await row("root").locator(".session-tree-branch-toggle").getAttribute("aria-expanded"), "false");
  await row("other").locator(".session-tree-main").click();
  await page.goto(`${baseURL}/?session=fork-tree-nested`, { waitUntil: "networkidle" });
  await row("nested").waitFor({ state: "visible" });
  await row("fork").hover();
  await row("fork").locator(".session-tree-pin-action").click();
  await row("fork", "pinned").waitFor({ state: "visible" });
  assert.equal(await row("fork", "pinned").getAttribute("data-branch-depth"), "0");
  assert.equal(await row("nested").getAttribute("data-branch-depth"), "0", "a parent in another section must not hide its child");
  await row("fork", "pinned").hover();
  await row("fork", "pinned").locator(".session-tree-pin-action").click();
  await row("fork").waitFor({ state: "visible" });
  assert.equal(await row("nested").getAttribute("data-branch-depth"), "2");
  await page.mouse.move(700, 600);
  await page.screenshot({ path: `${outputDir}/sidebar-fork-tree-desktop.png` });
  await row("root").locator(".session-tree-branch-toggle").click();
  await page.screenshot({ path: `${outputDir}/sidebar-fork-tree-collapsed.png` });
  await row("root").locator(".session-tree-branch-toggle").click();
  await page.setViewportSize({ width: 820, height: 950 });
  await row("nested").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${outputDir}/sidebar-fork-tree-compact.png` });
  assert.deepEqual(errors, []);
  return { passed: true, checks: ["three-level order and 16px indentation", "independent fold without selection", "nested session navigation", "explicit fold survives catalogue refresh", "selected deep link is visible", "independent pinning and cross-section fallback", "desktop and compact layout"], geometry };
}
