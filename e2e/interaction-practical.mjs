// Run through playwright-mcp's browser_run_code_unsafe with its isolated page.
// This module never launches a browser, invokes a model or touches user sessions.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "test", usage, stopReason: "stop", timestamp: 1792000000000 });
const paragraphs = count => Array.from({ length: count }, (_, i) => `交互测试段落 ${i + 1}：阅读历史消息时，新内容不应该抢走视口。`).join("\n\n");
const imageURL = "https://interaction-fixture.invalid/diagram.svg";

export function prepareInteractionFixture(agentDir) {
  assert.ok(resolve(agentDir).startsWith("/tmp/") || resolve(agentDir).startsWith("/private/tmp/"), "Use an isolated temporary agent directory");
  const project = join(agentDir, "project");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(agentDir, "sessions/test"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [] }));
  const timestamp = new Date().toISOString();
  const entries = [
    { type: "session", version: 3, id: "interaction-practical", timestamp, cwd: project },
    { type: "session_info", id: "title", timestamp, name: "交互实用组隔离验收" },
    { type: "message", id: "user", parentId: "title", timestamp, message: { role: "user", content: "交互验收，不调用模型。", timestamp: Date.now() } },
    { type: "message", id: "answer", parentId: "user", timestamp, message: assistant(`${paragraphs(35)}\n\n![交互测试图](${imageURL})`) },
  ];
  writeFileSync(join(agentDir, "sessions/test/interaction-practical.jsonl"), entries.map(e => JSON.stringify(e)).join("\n") + "\n");
}

export async function runInteractionChecks(page, { baseURL, outputDir }) {
  // Self-contained so the function can also run inside playwright-mcp's VM,
  // where dynamic imports and Node's module globals are intentionally absent.
  const check = (condition, message = "Assertion failed") => { if (!condition) throw new Error(message); };
  const assert = {
    ok: check,
    equal: (actual, expected, message) => check(actual === expected, `${message ?? "Equality"}: ${actual} !== ${expected}`),
    deepEqual: (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message ?? "Deep equality"}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`),
    match: (actual, pattern) => check(pattern.test(actual), "Candidate URL must use loopback port 30150–30199"),
  };
  const join = (directory, name) => `${directory}/${name}`;
  const paragraphs = count => Array.from({ length: count }, (_, i) => `交互测试段落 ${i + 1}：阅读历史消息时，新内容不应该抢走视口。`).join("\n\n");
  const assistant = text => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "test", stopReason: "stop", timestamp: 1792000000000 });
  const imageURL = "https://interaction-fixture.invalid/diagram.svg";
  assert.match(baseURL, /^http:\/\/127\.0\.0\.1:301(?:[5-9]\d)$/);
  const checks = [];
  const errors = [];
  const pageError = error => errors.push(error.message);
  page.on("pageerror", pageError);
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.addInitScript(() => {
    if (location.protocol !== "http:") return;
    localStorage.setItem("pi-locale", "zh-CN");
    localStorage.setItem("pi-sidebar-open", "true");
    window.__sources = [];
    window.EventSource = class {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      readyState = 1; onmessage = null; onerror = null;
      constructor(url) {
        this.url = url;
        window.__sources.push(this);
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }), 0);
      }
      close() { this.readyState = 2; }
    };
    window.__feed = event => window.__sources.filter(s => s.readyState === 1).forEach(s => s.onmessage?.({ data: JSON.stringify(event) }));
  });
  const state = { running: false, state: { isStreaming: false, isPromptRunning: false, messages: [], thinkingLevel: "off", extensionStatuses: [], extensionWidgets: [] } };
  await page.route("**/api/agent/*/subagents**", route => route.fulfill({ json: { available: false } }));
  await page.route("**/api/sessions/*/state", route => route.fulfill({ json: state }));
  await page.route("**/api/agent/interaction-practical", route => route.fulfill({ json: state }));
  await page.route(imageURL, route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#c8d8ea"/><path d="M0 400H1200M600 0V800" stroke="#506070" stroke-width="4"/><text x="100" y="150" font-size="60">Image viewport test</text></svg>' }));
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const readTransform = () => page.locator(".image-preview-image").evaluate(el => {
    const m = new DOMMatrix(getComputedStyle(el).transform);
    return { scale: m.a, x: m.e, y: m.f };
  });
  try {
    await page.goto(`${baseURL}/?session=interaction-practical`, { waitUntil: "networkidle" });
    const trigger = page.getByRole("button", { name: "预览图片: 交互测试图", exact: true });
    await trigger.waitFor();
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    await page.locator(".image-preview-image").waitFor();
    await page.waitForFunction(() => document.querySelector(".image-preview-image")?.complete && document.querySelector(".image-preview-image")?.naturalWidth > 0);
    await frames();
    const viewport = page.locator(".image-preview-viewport");
    const box = await viewport.boundingBox();
    const point = { x: box.x + box.width / 2 + 120, y: box.y + box.height / 2 - 70 };
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, -100);
    await page.waitForFunction(() => new DOMMatrix(getComputedStyle(document.querySelector(".image-preview-image")).transform).a > 1.5);
    const zoomed = await readTransform();
    assert.ok(Math.abs((120 - zoomed.x) / zoomed.scale - 120) < 1, "cursor x anchor");
    assert.ok(Math.abs((-70 - zoomed.y) / zoomed.scale + 70) < 1, "cursor y anchor");
    checks.push("image: wheel zoom retains cursor anchor");

    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + 2, centre.y + 1);
    assert.deepEqual(await readTransform(), zoomed, "micro-movement does not pan");
    await page.mouse.up();
    assert.equal(await page.locator(".image-preview-dialog[open]").count(), 1, "a captured click on the image does not close it");
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + 80, centre.y + 60, { steps: 8 });
    await page.mouse.up();
    const panned = await readTransform();
    assert.ok(Math.abs(panned.x - zoomed.x - 80) < 1);
    assert.ok(Math.abs(panned.y - zoomed.y - 60) < 1);
    checks.push("image: dead zone, captured click and pan");
    await page.screenshot({ path: join(outputDir, "image-zoom-pan.png") });
    await viewport.focus();
    await page.keyboard.press("0");
    assert.deepEqual(await readTransform(), { scale: 1, x: 0, y: 0 });
    await page.keyboard.press("+");
    assert.ok((await readTransform()).scale > 1);
    await page.getByRole("button", { name: "还原视图", exact: true }).click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".image-preview-dialog").count(), 0);
    assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
    await trigger.click();
    assert.deepEqual(await readTransform(), { scale: 1, x: 0, y: 0 });
    await page.keyboard.press("Escape");
    checks.push("image: keyboard, reset, Escape, focus return and reopen");

    const handle = page.locator('[data-resize-handle="sidebar"]');
    await handle.waitFor({ state: "visible" });
    const start = Number(await handle.getAttribute("aria-valuenow"));
    const saved = await page.evaluate(() => localStorage.getItem("pi-sidebar-width"));
    let handleBox = await handle.boundingBox();
    let x = handleBox.x + handleBox.width / 2;
    const y = handleBox.y + Math.min(120, handleBox.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 3, y);
    await page.mouse.up();
    assert.equal(Number(await handle.getAttribute("aria-valuenow")), start);
    assert.equal(await page.evaluate(() => localStorage.getItem("pi-sidebar-width")), saved);
    await page.evaluate(({ x, y }) => {
      const frame = document.createElement("iframe"); frame.id = "interaction-frame";
      frame.srcdoc = "<button>Embedded preview</button>";
      Object.assign(frame.style, { position: "fixed", left: `${x + 20}px`, top: `${y - 40}px`, width: "240px", height: "240px", zIndex: "1000" });
      document.body.append(frame);
    }, { x, y });
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 100, y, { steps: 10 });
    assert.equal(await page.locator("[data-panel-drag-shield]").count(), 1);
    assert.equal(Number(await handle.getAttribute("aria-valuenow")), start + 100);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(Number(await handle.getAttribute("aria-valuenow")), start);
    assert.equal(await page.locator("[data-panel-drag-shield]").count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("pi-sidebar-width")), saved);
    checks.push("split: dead zone, iframe crossing and Escape rollback without persistence");
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y, { steps: 6 });
    await page.mouse.up();
    assert.equal(Number(await handle.getAttribute("aria-valuenow")), start + 60);
    assert.equal(await page.evaluate(() => Number(localStorage.getItem("pi-sidebar-width"))), start + 60);
    await page.evaluate(() => document.getElementById("interaction-frame").remove());
    handleBox = await handle.boundingBox();
    x = handleBox.x + handleBox.width / 2;
    await page.mouse.dblclick(x, y);
    assert.equal(Number(await handle.getAttribute("aria-valuenow")), start);
    checks.push("split: commit, shield cleanup and double-click reset");

    const scroller = page.locator(".chat-content .overflow-y-auto").first();
    // Locate the actual transcript by its scrollable overflow, not an ancestor.
    assert.equal(await scroller.count(), 1);
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event("scroll")); });
    const before = await scroller.evaluate(el => el.scrollTop);
    const message = assistant(paragraphs(20));
    await page.evaluate(message => {
      window.__feed({ type: "agent_start" });
      window.__feed({ type: "message_start", message });
      const container = document.querySelector(".chat-content .overflow-y-auto");
      container.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
    }, message);
    await page.getByText("交互测试段落 20：阅读历史消息时，新内容不应该抢走视口。", { exact: true }).last().waitFor();
    await frames();
    assert.ok(Math.abs(await scroller.evaluate(el => el.scrollTop) - before) < 2, "wheel-up intent cancels the queued stream frame");
    checks.push("scroll: wheel intent beats a queued streaming frame");
    const scrollBox = await scroller.boundingBox();
    await page.mouse.move(scrollBox.x + 100, scrollBox.y + 200);
    await page.mouse.wheel(0, -350);
    await page.waitForFunction(previous => document.querySelector(".chat-content .overflow-y-auto").scrollTop < previous - 100, before);
    const reading = await scroller.evaluate(el => el.scrollTop);
    await page.evaluate(message => window.__feed({ type: "message_start", message }), assistant(paragraphs(28)));
    await frames();
    assert.ok(Math.abs(await scroller.evaluate(el => el.scrollTop) - reading) < 2, "new tokens preserve the reading position");
    await scroller.evaluate(el => {
      const block = document.createElement("div"); block.id = "interaction-growth"; block.style.height = "300px";
      el.firstElementChild.append(block);
    });
    await frames();
    assert.ok(Math.abs(await scroller.evaluate(el => el.scrollTop) - reading) < 2, "late content growth preserves the reading position");
    checks.push("scroll: tokens and late content growth do not steal reading position");
    // Explicit user navigation toward the tail restores follow.
    await scroller.evaluate(el => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true }));
      el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event("scroll"));
    });
    await frames();
    await scroller.evaluate(() => { document.getElementById("interaction-growth").style.height = "600px"; });
    await page.waitForFunction(() => {
      const el = document.querySelector(".chat-content .overflow-y-auto");
      return el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
    });
    checks.push("scroll: returning to the tail resumes ResizeObserver follow");
    await page.screenshot({ path: join(outputDir, "desktop.png") });
    assert.deepEqual(errors, []);
    const result = { passed: true, desktopOnly: true, baseURL, checks, pageErrors: [...errors] };
    return result;
  } catch (error) {
    await page.screenshot({ path: join(outputDir, "failure.png") }).catch(() => {});
    return { passed: false, checks, error: String(error), pageErrors: errors };
  } finally {
    // Stop page pollers before removing fixture routes; otherwise they could
    // reach real endpoints with synthetic session ids after assertions finish.
    await page.goto("about:blank").catch(() => {});
    page.off("pageerror", pageError);
    await page.unrouteAll({ behavior: "wait" });
  }
}
