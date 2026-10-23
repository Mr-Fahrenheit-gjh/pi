// Focused, isolated dev check. Never installs packages or touches the production service.
// node e2e/design-deck.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { patchDesignDeck } from "../scripts/patch-design-deck.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
assert.ok(!existsSync(join(root, ".next/dev/lock")), "Source checkout already has a dev server; do not start a second one");
const fixture = await mkdtemp(join(tmpdir(), "pi-design-deck-e2e-"));
const agentDir = join(fixture, "agent"), project = join(fixture, "project");
const resultFile = join(fixture, "result.json"), launchFile = join(fixture, "unexpected-launch");
const artifacts = join(root, "test-results/design-deck");
const packageDir = process.env.PI_DESIGN_DECK_PACKAGE || join(homedir(), ".pi/agent/npm/node_modules/pi-design-deck");
const deckCopy = join(fixture, "deck-package");
const SESSION = "design-deck-e2e", SIBLING = "design-deck-other";
const checks = [];
let server, serverExited, browser, page;
const installedIndex = await readFile(join(packageDir, "index.ts"), "utf8");
await mkdir(artifacts, { recursive: true });
const log = createWriteStream(join(artifacts, "server.log"));

try {
  await Promise.all([mkdir(join(agentDir, "extensions"), { recursive: true }), mkdir(join(agentDir, "sessions/fixture"), { recursive: true }), mkdir(project)]);
  await cp(packageDir, deckCopy, { recursive: true });
  await symlink(dirname(packageDir), join(deckCopy, "node_modules"));
  await patchDesignDeck(deckCopy, true);
  // The copied fixture must not consult or alter real settings/snapshots.
  await writeFile(join(deckCopy, "settings.ts"), `export const loadSettings = () => ({ port: 0, autoSaveOnSubmit: false, snapshotDir: ${JSON.stringify(join(fixture, "snapshots"))} }); export const saveGenerateModel = () => {};`);
  const slides = { title: "Sidebar Design Deck", slides: [{ id: "layout", title: "Choose a layout", options: [
    { label: "Editorial", previewHtml: "<div style='padding:20px;background:#faf7f2;color:#27231e'>Editorial preview</div>" },
    { label: "Compact", previewHtml: "<div style='padding:20px;background:#1a1814;color:#e8e4dd'>Compact preview</div>" },
  ] }] };
  await writeFile(join(agentDir, "extensions/deck-fixture.ts"), `
import install from ${JSON.stringify(join(deckCopy, "index.ts"))};
import { writeFileSync } from "node:fs";
export default function(pi) {
  let deck;
  install(new Proxy(pi, { get(target, key) {
    if (key === "registerTool") return tool => { if (tool.name === "design_deck") deck = tool; target.registerTool(tool); };
    if (key === "exec") return async () => { writeFileSync(${JSON.stringify(launchFile)}, "attempted"); throw new Error("External launch forbidden in fixture"); };
    return target[key];
  } }));
  pi.registerCommand("e2e-deck", { handler: async (_args, ctx) => {
    let result = await deck.execute("fixture-deck", { slides: ${JSON.stringify(JSON.stringify(slides))} }, undefined, undefined, ctx);
    if (result.details.status === "generate-more") result = await deck.execute("fixture-more", { action: "add-options", slideId: "layout", options: JSON.stringify([{ label: "Generated", previewHtml: "<p>Generated third option</p>" }]) }, undefined, undefined, ctx);
    writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result.details));
  } });
}`);
  const timestamp = "2026-10-23T00:00:00.000Z";
  for (const id of [SESSION, SIBLING]) await writeFile(join(agentDir, `sessions/fixture/${id}.jsonl`), [
    { type: "session", version: 3, id, cwd: project, timestamp },
    { type: "session_info", id: "name", parentId: null, timestamp, name: id },
    { type: "message", id: "msg", parentId: "name", timestamp, message: { role: "user", content: "Synthetic Design Deck integration fixture" } },
  ].map(item => JSON.stringify(item)).join("\n") + "\n");

  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port;
  assert.notEqual(port, 30141);
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, NODE_ENV: "development", PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1", SSH_CONNECTION: "isolated-e2e" };
  delete env.__NEXT_PRIVATE_ORIGIN;
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], env,
  });
  serverExited = once(server, "exit");
  server.stdout.pipe(log, { end: false }); server.stderr.pipe(log, { end: false });
  const until = Date.now() + 120_000;
  while (!(await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5000) }).catch(() => null))?.ok) {
    assert.equal(server.exitCode, null); assert.ok(Date.now() < until, "Dev server readiness timeout"); await delay(250);
  }
  browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage(); page.setDefaultTimeout(30_000);
  await page.goto(`${base}/?session=${SESSION}`, { waitUntil: "domcontentloaded" });
  const input = page.locator("textarea").last();
  await input.fill("/e2e-deck"); await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("tab", { name: "Design Deck", exact: true }).waitFor();
  const panel = page.locator("#file-panel");
  const surface = panel.locator(".browser-remote-surface:visible");
  await panel.locator(".browser-remote-image:visible").waitFor();
  const browserId = await panel.locator(".terminal-browser-preview:visible").getAttribute("data-browser-id");
  assert.equal(await panel.locator(".terminal-browser-addressbar:visible").count(), 0);
  assert.equal(context.pages().length, 1);
  assert.equal(existsSync(launchFile), false);
  checks.push("actual package claimed by Web; automatic right tab; no external page/OS launcher");
  await page.screenshot({ path: join(artifacts, "sidebar.png") });

  const live = await (await fetch(`${base}/api/agent/running`)).json();
  const presentation = live.designDecks.find(deck => deck.sessionId === SESSION);
  assert.ok(presentation);
  const deckUrl = new URL(presentation.url);
  const response = await fetch(new URL("/generate-more", deckUrl), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: deckUrl.searchParams.get("session"), slideId: "layout", count: 1 }) });
  assert.equal(response.status, 200);
  // Real HTTP/SSE payload; don't read or print capability URLs in artifacts.
  const updated = Date.now() + 10_000;
  while (!(await (await fetch(deckUrl)).text()).includes("Generated third option")) {
    assert.ok(Date.now() < updated, "Added option did not reach server"); await delay(100);
  }
  checks.push("generate-more returns to tool and add-options updates the same live deck");

  // NativeBrowser forwards the package's real number/Enter shortcuts to host Chrome.
  await surface.click({ position: { x: 12, y: 12 } });
  // React queues input over HTTP; Playwright's press() only waits for local events.
  // Wait for the host's key-up acknowledgement before reload can cancel the queue.
  const selected = page.waitForResponse(response => {
    if (response.url() !== `${base}/api/browser/${browserId}` || response.request().method() !== "POST") return false;
    const command = response.request().postDataJSON();
    return command.type === "key" && command.key === "3" && command.event === "keyUp";
  });
  await panel.locator(".browser-input-capture:visible").press("3");
  assert.equal((await selected).status(), 200);
  for (let reload = 0; reload < 9; reload++) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await panel.locator(".browser-remote-image:visible").waitFor();
    assert.equal(await panel.locator(".terminal-browser-preview:visible").getAttribute("data-browser-id"), browserId);
  }
  checks.push("nine reloads reconnect to one page without exhausting the eight-page limit");
  const secondWindow = await context.newPage();
  await secondWindow.goto(`${base}/?session=${SESSION}`, { waitUntil: "domcontentloaded" });
  await secondWindow.locator("#file-panel .browser-remote-image:visible").waitFor();
  assert.equal(await secondWindow.locator("#file-panel .terminal-browser-preview:visible").getAttribute("data-browser-id"), browserId);
  await secondWindow.close();
  await page.bringToFront();
  assert.equal((await fetch(`${base}/api/browser/${browserId}`)).status, 200);
  checks.push("closing another Web window does not delete the shared presentation page");
  await page.getByRole("tab", { name: "Tasks", exact: true }).click();
  await page.getByRole("tab", { name: "Design Deck", exact: true }).click();
  assert.equal(await panel.locator(".terminal-browser-preview:visible").getAttribute("data-browser-id"), browserId);
  await page.locator("[data-right-panel-toggle]").click();
  await page.mouse.move(700, 900);
  if (!await page.locator("#session-sidebar.sidebar-open").count()) await page.locator("[data-sidebar-toggle]").click();
  for (const id of [SIBLING, SESSION]) {
    await page.locator(`[data-row-key="session:group:${id}"] a.session-tree-main`).click();
    await page.waitForFunction(id => new URL(location.href).searchParams.get("session") === id, id);
  }
  assert.equal(await panel.evaluate(element => element.classList.contains("right-panel-open")), false);
  checks.push("returning to a seen deck does not reopen the collapsed panel");
  await page.locator("[data-right-panel-toggle]").click();
  await page.getByRole("tab", { name: "Design Deck", exact: true }).click();
  assert.equal(await panel.locator(".terminal-browser-preview:visible").getAttribute("data-browser-id"), browserId);
  checks.push("workspace tab switch and panel collapse retain the managed browser and selections");
  await surface.click({ position: { x: 12, y: 12 } });
  await panel.locator(".browser-input-capture:visible").press("Enter");
  await panel.locator(".browser-input-capture:visible").press("Enter");
  const completion = Date.now() + 15_000;
  while (!existsSync(resultFile)) { assert.ok(Date.now() < completion, "Keyboard submit did not finish the tool"); await delay(100); }
  const result = JSON.parse(await readFile(resultFile, "utf8"));
  assert.equal(result.status, "completed"); assert.deepEqual(result.selections, { layout: "Generated" });
  await page.getByRole("tab", { name: "Design Deck", exact: true }).waitFor({ state: "detached" });
  assert.equal(existsSync(launchFile), false);
  checks.push("keyboard selection and submit resolve original tool; completion removes the tab");
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: "passed", stage: "isolated-dev", checks }, null, 2));
  console.log(JSON.stringify({ status: "passed", checks, artifacts }));
} catch (error) {
  await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await Promise.race([serverExited, delay(5000).then(() => server.exitCode === null && server.kill("SIGKILL"))]); }
  log.end();
  assert.equal(await readFile(join(packageDir, "index.ts"), "utf8"), installedIndex, "Installed extension was modified");
  await rm(fixture, { recursive: true, force: true });
}
