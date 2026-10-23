// Isolated dev preview via playwright-mcp. Synthetic SSE; no model or real-session writes.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareWorkspaceFixture } from "./workspace-design.mjs";

const diagram = {
  version: 1, title: "抛物线与切线", x: [-3, 3], y: [-1, 5],
  parameters: [{ name: "a", min: -2, max: 2, value: 1, step: 0.01 }],
  curves: [{ expr: "x^2", label: "y = x²" }, { expr: "2*a*x-a^2", label: "切线", color: "orange" }],
  shapes: [{ type: "point", at: ["a", "a^2"], drag: "a", label: "P" }],
  readouts: [{ label: "斜率", expr: "2*a" }],
};
const fence = value => "```pi-visual\n" + JSON.stringify(value) + "\n```";

export function prepareInlineVisualFixture(agentDir) {
  const fixture = prepareWorkspaceFixture(agentDir);
  const path = join(agentDir, "sessions/design/workspace-design-fixture.jsonl");
  const entries = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  entries.find(entry => entry.id === "answer").message.content = [{ type: "text", text: `HISTORY_TEXT_A\n\n${fence(diagram)}\n\nHISTORY_TEXT_B` }];
  entries.find(entry => entry.id === "user").message.content = `用户提供的图解数据仍作为代码：\n\n${fence(diagram)}`;
  writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  return fixture;
}

export async function runInlineVisualChecks(page, { baseURL, outputDir }) {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  check(/^http:\/\/127\.0\.0\.1:301[5-9]\d$/.test(baseURL), "Use an isolated preview port");
  const checks = [], errors = [], commands = [], unexpectedRequests = [];
  const onError = error => errors.push(error.message);
  page.on("pageerror", onError);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem("pi-locale", "zh-CN");
    localStorage.setItem("pi-ui-language-version", "english-interface-v1");
    localStorage.setItem("pi-theme", "claude-white");
    window.__sources = [];
    window.EventSource = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      readyState = 1; onmessage = null; onerror = null;
      constructor(url) { super(); this.url = url; window.__sources.push(this); setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }), 0); }
      close() { this.readyState = 2; }
    };
    window.__feed = event => window.__sources.filter(source => source.readyState === 1).forEach(source => source.onmessage?.({ data: JSON.stringify(event) }));
  });
  let running = false;
  const state = () => ({ model: { provider: "openai", id: "design-fixture" }, thinkingLevel: "medium", isStreaming: running, isPromptRunning: running, isCompacting: false, messages: [], extensionStatuses: [], extensionWidgets: [] });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== baseURL || (route.request().method() === "POST" && /\/api\/(?:agent|models|sessions\/.+\/auto-name)/.test(url.pathname))) {
      unexpectedRequests.push(url.origin + url.pathname);
      return route.abort();
    }
    return route.continue();
  });
  await page.route("**/api/agent/*/subagents**", route => route.fulfill({ json: { available: false } }));
  await page.route("**/api/agent/running", route => route.fulfill({ json: { running: [], awaitingInput: [] } }));
  await page.route("**/api/sessions/*/state", route => route.fulfill({ json: { running, state: state() } }));
  await page.route("**/api/agent/workspace-design-fixture", route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { running, state: state() } });
    const command = route.request().postDataJSON();
    commands.push(command);
    const data = command.type === "get_state" ? state() : command.type === "get_tools" ? [] : command.type === "get_commands" ? { commands: [] } : {};
    return route.fulfill({ json: { success: true, data } });
  });
  await page.route("**/api/models?**", route => route.fulfill({ json: { models: { "openai/design-fixture": "Design fixture" }, modelList: [{ provider: "openai", id: "design-fixture", name: "Design fixture" }], defaultModel: { provider: "openai", modelId: "design-fixture" }, defaultThinkingLevel: "medium" } }));
  const feed = event => page.evaluate(event => window.__feed(event), event);
  const ordered = async (body, expected) => {
    const actual = await body.evaluate(node => [...node.children].map(child => child.dataset.visualState ? `visual:${child.dataset.visualState}` : child.textContent.trim()).filter(Boolean));
    check(JSON.stringify(actual) === JSON.stringify(expected), `Message order: ${JSON.stringify(actual)}`);
  };
  try {
    await page.goto(`${baseURL}/?session=workspace-design-fixture`, { waitUntil: "networkidle" });
    const history = page.locator(".markdown-assistant-message").filter({ hasText: "HISTORY_TEXT_A" });
    await history.locator('[data-visual-state="ready"]').waitFor();
    await ordered(history, ["HISTORY_TEXT_A", "visual:ready", "HISTORY_TEXT_B"]);
    check(await page.locator('.message-user [data-visual-state]').count() === 0, "User data is not a rendered diagram");
    check(await page.locator('[data-visual-state="ready"]').count() === 1, "Only the assistant diagram renders");
    checks.push("history and assistant-only rendering; exact prose/diagram/prose order");

    running = true;
    const thinking = { type: "thinking", thinking: "Fixture reasoning stays separate from the answer." };
    const message = { role: "assistant", content: [thinking, { type: "text", text: "STREAM_TEXT_A\n\n" }], api: "openai-completions", provider: "openai", model: "design-fixture", timestamp: Date.now() };
    let fullText = message.content[1].text;
    await feed({ type: "agent_start" });
    await feed({ type: "message_start", message });
    const stream = page.locator(".markdown-assistant-message").filter({ hasText: "STREAM_TEXT_A" });
    await stream.getByText("STREAM_TEXT_A", { exact: true }).waitFor();
    check(await stream.locator("[data-visual-state]").count() === 0, "Prose arrives before any diagram data");
    const delta = async text => {
      fullText += text;
      await feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: text } });
    };
    await delta("```pi-visual\n" + JSON.stringify(diagram));
    await stream.locator('[data-visual-state="pending"]').waitFor();
    await ordered(stream, ["STREAM_TEXT_A", "visual:pending"]);
    await delta("\n```\n");
    const visual = stream.locator('[data-visual-state="ready"]');
    await visual.waitFor();
    await ordered(stream, ["STREAM_TEXT_A", "visual:ready"]);
    const point = visual.locator('[data-visual-point="P"]');
    await point.focus();
    await point.press("ArrowRight");
    check(await point.getAttribute("aria-valuenow") === "1.01", "Point supports keyboard adjustments");
    const beforeDrag = await point.boundingBox();
    await page.mouse.move(beforeDrag.x + 16, beforeDrag.y + 16);
    await page.mouse.down();
    await page.mouse.move(beforeDrag.x - 24, beforeDrag.y + 16, { steps: 5 });
    await page.mouse.up();
    const dragged = Number(await point.getAttribute("aria-valuenow"));
    check(dragged < 1, "Dragging changes the parameter locally");
    check(Math.abs(Number(await visual.locator('[data-visual-readout="斜率"]').innerText()) - 2 * dragged) < 0.001, "Readout matches the tangent formula");
    await delta("\nSTREAM_TEXT_B\n\n");
    await stream.getByText("STREAM_TEXT_B", { exact: true }).waitFor();
    await ordered(stream, ["STREAM_TEXT_A", "visual:ready", "STREAM_TEXT_B"]);
    check(Number(await point.getAttribute("aria-valuenow")) === dragged, "Interaction survives subsequent streamed prose");
    checks.push("prose first; pending stays in place; closed fence renders before completion; pointer/keyboard/readout work");

    await delta(fence({ ...diagram, title: "第二张图" }) + "\n\nSTREAM_TEXT_C");
    await stream.getByText("STREAM_TEXT_C", { exact: true }).waitFor();
    await ordered(stream, ["STREAM_TEXT_A", "visual:ready", "STREAM_TEXT_B", "visual:ready", "STREAM_TEXT_C"]);
    await feed({ type: "message_end", message: { ...message, content: [thinking, { type: "text", text: fullText }], stopReason: "stop" } });
    await stream.getByText("STREAM_TEXT_C", { exact: true }).waitFor();
    check(Number(await stream.locator('[data-visual-point="P"]').first().getAttribute("aria-valuenow")) === dragged, "Interaction survives message_end");
    running = false;
    await feed({ type: "agent_end", messages: [] });
    await ordered(stream, ["STREAM_TEXT_A", "visual:ready", "STREAM_TEXT_B", "visual:ready", "STREAM_TEXT_C"]);
    check(Number(await stream.locator('[data-visual-point="P"]').first().getAttribute("aria-valuenow")) === dragged, "Interaction survives agent_end");
    checks.push("two diagrams never move or reorder; values survive message/agent completion");
    await stream.locator('[data-visual-state="ready"]').first().screenshot({ path: `${outputDir}/inline-tangent.png` });

    // The dev-only Next.js badge overlaps this footer button; use its keyboard action.
    await page.getByRole("button", { name: "设置", exact: true }).focus();
    await page.getByRole("button", { name: "设置", exact: true }).press("Enter");
    await page.locator(".settings-section-tabs").getByRole("button", { name: "常规", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "按需交互图解", exact: true });
    check(await toggle.getAttribute("aria-checked") === "true", "Setting defaults to enabled");
    await toggle.click();
    check(await page.locator('[data-visual-state="ready"]').count() === 0, "Disable hides existing diagrams immediately");
    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "networkidle" });
    await history.locator('[data-visual-state="disabled"]').waitFor();
    await ordered(history, ["HISTORY_TEXT_A", "visual:disabled", "HISTORY_TEXT_B"]);
    checks.push("default-on settings; immediate disable; persistent after reload without reordered text");
    check(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
    check(unexpectedRequests.length === 0, `Unexpected unmocked requests: ${unexpectedRequests.join("; ")}`);
    check(!commands.some(command => ["prompt", "steer", "follow_up"].includes(command.type)), "No model submissions during local interaction");
    return { passed: true, checks, modelRequests: 0, errors, mocked: true, browserBackend: "playwright-mcp" };
  } catch (error) {
    await page.screenshot({ path: `${outputDir}/failure.png` });
    throw new Error(`${error.message}\nCompleted: ${checks.join("; ")}\nErrors: ${errors.join("; ")}`);
  } finally {
    page.off("pageerror", onError);
  }
}
