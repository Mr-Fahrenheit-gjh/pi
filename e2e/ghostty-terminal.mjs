import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { showSidebarFiles } from "./sidebar.mjs";
import { verifySidebarBrowserWheel } from "./sidebar-browser-wheel.mjs";

const root = process.env.PI_WEB_TERMINAL_ROOT || fileURLToPath(new URL("../", import.meta.url));
const artifacts = process.env.PI_WEB_TERMINAL_ARTIFACTS || mkdtempSync(join(tmpdir(), "pi-web-ghostty-"));
mkdirSync(artifacts, { recursive: true });
console.log(`Artifacts: ${artifacts}`);
const agentDir = join(artifacts, "agent");
const workspace = join(artifacts, "workspace");
mkdirSync(join(agentDir, "sessions", "test"), { recursive: true });
mkdirSync(workspace, { recursive: true });
const timestamp = "2026-10-13T00:00:00.000Z";
const sessionId = "ghostty-terminal-fixture";
writeFileSync(join(agentDir, "sessions", "test", `${sessionId}.jsonl`), [
  { type: "session", version: 3, id: sessionId, timestamp, cwd: workspace },
  { type: "session_info", id: "name", parentId: null, timestamp, name: "Ghostty terminal test" },
  { type: "message", id: "message", parentId: "name", timestamp, message: { role: "user", content: "Ghostty terminal test" } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const log = createWriteStream(join(artifacts, "server.log"));
const server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: root,
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1", HISTFILE: "/dev/null", BASH_SILENCE_DEPRECATION_WARNING: "1", SHELL: "/bin/bash" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.pipe(log, { end: false });
server.stderr.pipe(log, { end: false });
const serverExit = once(server, "exit");
let browser;
const checks = [];
const errors = [];
const result = { passed: false, packageRoot: root, buildId: readFileSync(join(root, ".next/BUILD_ID"), "utf8").trim(), version: JSON.parse(readFileSync(join(root, "package.json"))).version, checks, errors };
try {
  for (let i = 0; ; i++) {
    const response = await fetch(`${base}/api/sessions`).catch(() => null);
    if (response?.ok) break;
    assert.ok(i < 120 && server.exitCode === null, "Server did not become ready");
    await delay(500);
  }
  const wasm = await fetch(`${base}/vendor/ghostty-web/0.4.0/ghostty-vt.wasm`);
  assert.equal(wasm.status, 200);
  assert.match(wasm.headers.get("content-type"), /application\/wasm/);
  const bytes = Buffer.from(await wasm.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [0, 97, 115, 109]);
  result.wasmSha256 = createHash("sha256").update(bytes).digest("hex");
  checks.push("same-origin-versioned-wasm");
  browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 }, locale: "en-US", colorScheme: "light", reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
  page.on("pageerror", (error) => errors.push({ message: error.message, stack: error.stack, after: checks.at(-1) }));
  const created = new Set();
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/terminal" && request.method() === "POST") created.add(request.postDataJSON().id);
  });
  const panel = page.locator(".terminal-panel:visible");
  const input = () => panel.locator("textarea");
  const ready = () => page.locator(".terminal-panel:visible[data-terminal-status=ready]").waitFor();
  const focus = async () => { await panel.locator("canvas").click({ position: { x: 8, y: 8 } }); await input().focus(); };
  const run = async (command) => {
    await focus();
    await page.keyboard.type(command);
    await page.keyboard.press("Enter");
  };
  const screen = async () => {
    await page.evaluate(() => navigator.clipboard.writeText("__pending_screen__"));
    await input().focus();
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Meta+c");
    await page.waitForFunction(async () => (await navigator.clipboard.readText()) !== "__pending_screen__");
    return page.evaluate(() => navigator.clipboard.readText());
  };
  const waitScreen = async (pattern, allowWrap = false) => {
    let content;
    for (let i = 0; i < 50; i++) {
      content = await screen();
      if (pattern.test(content)) return content;
      if (allowWrap && pattern.test(content.replace(/\s+/g, ''))) return content.replace(/\s+/g, '');
      await delay(100);
    }
    throw new Error(`Missing ${pattern}: ${content}`);
  };
  const open = async () => {
    await page.goto(`${base}/?session=${sessionId}`);
    await page.getByText("Ghostty terminal test", { exact: true }).first().waitFor();
    await showSidebarFiles(page);
    await page.getByRole("button", { name: "Open workspace terminal", exact: true }).click();
    await ready();
  };
  await open();
  assert.equal(await panel.getAttribute("data-terminal-engine"), "ghostty");
  assert.equal(await panel.locator("canvas").count(), 1);
  assert.equal(await page.locator(".xterm").count(), 0);
  const preferences = await (await page.request.get(`${base}/api/terminal/preferences`)).json();
  assert.equal(await panel.getAttribute("data-terminal-font-family"), preferences.fontFamily);
  assert.equal(Number(await panel.getAttribute("data-terminal-font-size")), preferences.fontSize);
  assert.equal(await panel.evaluate(el => getComputedStyle(el).backgroundColor), "rgb(255, 255, 255)");
  const corner = await panel.locator("canvas").evaluate(canvas => Array.from(canvas.getContext("2d").getImageData(canvas.width - 2, canvas.height - 2, 1, 1).data));
  assert.deepEqual(corner, [255, 255, 255, 255]);
  checks.push("native-font-preferences-and-white-canvas");
  await run("export GHOSTTY_TOKEN=alive; printf '\\nPID:%s:%s\\n' \"$GHOSTTY_TOKEN\" \"$$\"");
  const first = await waitScreen(/PID:alive:\d+/);
  const pid = first.match(/PID:alive:(\d+)/)[1];
  checks.push("real-pty-keyboard-and-rendered-buffer");
  await verifySidebarBrowserWheel({ context, page, panel, run, waitScreen, checks, created, artifacts });
  await run("printf '\\n\\033[31mRED  \\033[32mGREEN  \\033[34mBLUE\\033[0m THEME_COLORS\\n'");
  await waitScreen(/THEME_COLORS/);
  await page.evaluate(() => { window.__themeCanvas = document.querySelector('.terminal-panel canvas'); });
  const checkThemeCanvas = async (theme) => {
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'));
    await focus();
    const { expected, panelColor } = await panel.evaluate(el => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().slice(1);
      const hex = raw.length === 3 ? raw.split('').map(digit => digit + digit).join('') : raw;
      return {
        expected: hex.match(/../g).map(value => parseInt(value, 16)),
        panelColor: getComputedStyle(el).backgroundColor.match(/\d+/g).slice(0, 3).map(Number),
      };
    });
    assert.deepEqual(panelColor, expected, `${theme}: panel follows web theme`);
    // Verify the actual displayed canvas pixels against the selected web paper.
    const png = await panel.locator('canvas').screenshot();
    const pixel = await page.evaluate(async encoded => {
      const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return Array.from(ctx.getImageData(Math.floor(image.width / 2), image.height - 10, 1, 1).data).slice(0, 3);
    }, png.toString('base64'));
    assert.deepEqual(pixel, expected, `${theme}: terminal pixels match theme background`);
    assert.equal(await page.evaluate(() => document.querySelector('.terminal-panel canvas') === window.__themeCanvas), true);
    assert.equal(created.size, 1, 'Theme changes must not replace the PTY');
    assert.match(await screen(), new RegExp(`PID:alive:${pid}`));
    await focus();
    if (['claude', 'claude-white', 'dark', 'pine'].includes(theme)) await page.screenshot({ path: join(artifacts, `ghostty-${theme}.png`) });
  };
  const selectTheme = async theme => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator(`input[name="theme"][value="${theme}"]`).locator('..').click();
    await page.keyboard.press('Escape');
  };
  for (const theme of ['claude', 'claude-white', 'dark', 'mist', 'rose', 'pine', 'light']) {
    await selectTheme(theme);
    await checkThemeCanvas(theme);
  }
  await selectTheme('auto');
  await page.emulateMedia({ colorScheme: 'dark' });
  await checkThemeCanvas('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await checkThemeCanvas('light');
  await selectTheme('light');
  await page.evaluate(() => { delete window.__themeCanvas; });
  checks.push('all-web-palettes-and-system-following-composited-pixels');
  checks.push('theme-switch-preserves-canvas-history-and-pty');
  await focus();
  await page.evaluate(() => navigator.clipboard.writeText("printf '\\n中文输入与粘贴 ✓\\n'"));
  await Promise.all([
    page.waitForRequest((request) => request.method() === "POST" && request.url().includes("/api/terminal/") && request.postDataJSON()?.data?.includes("中文输入与粘贴")),
    page.keyboard.press("Meta+v"),
  ]);
  await page.keyboard.press("Enter");
  assert.match(await waitScreen(/中文输入与粘贴 ✓/), /中文输入与粘贴 ✓/);
  checks.push("unicode-clipboard-paste-copy");
  await focus();
  await page.keyboard.type("printf '\\n");
  await input().evaluate((el) => {
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "输入法提交" }));
  });
  await page.keyboard.type("\\n'");
  await page.keyboard.press("Enter");
  await waitScreen(/输入法提交/);
  checks.push("composition-event-commit");
  await focus();
  await page.screenshot({ path: join(artifacts, 'ghostty-before-font-refresh.png') });
  let nextPreferences = { fontFamily: '"MesloLGS NF", monospace', fontSize: 16, source: "ghostty" };
  await page.route("**/api/terminal/preferences", route => route.fulfill({ json: nextPreferences }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => document.querySelector('.terminal-panel')?.dataset.terminalFontSize === '16');
  assert.equal(await panel.getAttribute("data-terminal-font-family"), nextPreferences.fontFamily);
  await run("printf '\\nFONT:%s:%s\\n' \"$GHOSTTY_TOKEN\" \"$$\"");
  await waitScreen(new RegExp(`FONT:alive:${pid}`), true); // Native font metrics may wrap the marker.
  checks.push("native-preference-refresh-does-not-restart-pty");
  await page.unroute("**/api/terminal/preferences");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(family => document.querySelector(".terminal-panel")?.dataset.terminalFontFamily === family, preferences.fontFamily);
  await focus();
  await page.keyboard.type("sleep 30");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+c");
  await run("printf '\\nINTERRUPT:%s\\n' \"$GHOSTTY_TOKEN\"");
  await waitScreen(/INTERRUPT:alive/);
  checks.push("ctrl-c-sigint-without-selection");
  await run("printf '\\033[?1049h\\033[2J\\033[H\\033[?25l\\033[1mOpenAI Codex TOP_ROW\\033[0m\\r\\nALT_SCREEN_OK'");
  await waitScreen(/ALT_SCREEN_OK/);
  await focus();
  await panel.locator('.terminal-ghostty-surface').focus();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const topRow = await panel.evaluate(el => {
    const host = el.querySelector('.terminal-ghostty-surface');
    const canvas = el.querySelector('canvas');
    const firstRow = canvas.getContext('2d').getImageData(0, 0, Math.min(80, canvas.width), 1).data;
    return {
      caret: getComputedStyle(host).caretColor,
      safeTop: canvas.getBoundingClientRect().top >= el.getBoundingClientRect().top + 8,
      clearFirstPixelRow: Array.from(firstRow).every((value, index) => value === 255),
    };
  });
  assert.equal(topRow.caret, 'rgba(0, 0, 0, 0)', 'Native contenteditable caret must be hidden');
  assert.ok(topRow.safeTop && topRow.clearFirstPixelRow, JSON.stringify(topRow));
  await page.screenshot({ path: join(artifacts, 'ghostty-top-row.png') });
  checks.push('bold-top-row-unclipped-and-native-caret-hidden');
  await run("printf '\\033[?25h\\033[?1049l'");
  await waitScreen(/INTERRUPT:alive/);
  checks.push("alternate-screen-restored");
  await context.setOffline(true);
  await page.locator('.terminal-panel[data-terminal-status=connecting]').waitFor();
  await context.setOffline(false);
  await ready();
  await run("printf '\\nRECONNECT:%s:%s\\n' \"$GHOSTTY_TOKEN\" \"$$\"");
  await waitScreen(new RegExp(`RECONNECT:alive:${pid}`), true);
  checks.push("offline-reconnect-preserves-shell");
  await page.reload();
  await ready();
  await run("printf '\\nREFRESH:%s:%s\\n' \"$GHOSTTY_TOKEN\" \"$$\"");
  await waitScreen(new RegExp(`REFRESH:alive:${pid}`), true);
  assert.equal(created.size, 1);
  checks.push("refresh-restores-same-pty");
  await page.setViewportSize({ width: 1200, height: 850 });
  await run("printf '\\nSIZE:'; stty size");
  await waitScreen(/SIZE:\d+ \d+/);
  const bounds = await panel.evaluate((el) => {
    const outer = el.getBoundingClientRect();
    const canvas = el.querySelector("canvas").getBoundingClientRect();
    return { fits: canvas.right <= outer.right && canvas.bottom <= outer.bottom, width: canvas.width, height: canvas.height };
  });
  assert.ok(bounds.fits && bounds.width > 100 && bounds.height > 100, JSON.stringify(bounds));
  checks.push("desktop-resize-fits-and-updates-pty");
  await page.setViewportSize({ width: 1512, height: 982 });
  const glyphLine = `Nerd Font: ${String.fromCodePoint(0xf07b)}  ${String.fromCodePoint(0xf121)}  ${String.fromCodePoint(0xe0b0)}  ${String.fromCodePoint(0xf1d3)}   中文字体`;
  await focus();
  await page.evaluate(text => navigator.clipboard.writeText(`printf '\\033[2J\\033[H\\n${text}\\n\\033[31mred  \\033[32mgreen  \\033[34mblue\\033[0m\\n'`), glyphLine);
  await Promise.all([
    page.waitForRequest(request => request.method() === 'POST' && request.url().includes('/api/terminal/') && request.postDataJSON()?.data?.includes(glyphLine)),
    page.keyboard.press('Meta+v'),
  ]);
  await page.keyboard.press('Enter');
  await waitScreen(new RegExp(`Nerd Font: ${String.fromCodePoint(0xf07b)}`));
  checks.push('nerd-font-private-use-glyphs-and-CJK-paste');
  await focus();
  await page.screenshot({ path: join(artifacts, "ghostty-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Terminate terminal workspace", exact: true }).click();
  await page.locator(".terminal-panel").waitFor({ state: "detached" });
  for (const id of created) assert.equal((await page.request.get(`${base}/api/terminal/${id}`)).status(), 404);
  checks.push("close-terminates-pty");
  await context.close();
  const retryContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const retryPage = await retryContext.newPage();
  retryPage.setDefaultTimeout(25_000);
  let retryId;
  let retryCreates = 0;
  retryPage.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/terminal" && request.method() === "POST") { retryCreates++; retryId = request.postDataJSON().id; }
  });
  await retryPage.route("**/ghostty-vt.wasm", (route) => route.abort());
  await retryPage.goto(`${base}/?session=${sessionId}`);
  await showSidebarFiles(retryPage);
  await retryPage.getByRole("button", { name: "Open workspace terminal", exact: true }).click();
  await retryPage.locator(".terminal-panel[data-terminal-status=error]").waitFor();
  assert.equal(retryCreates, 0, "Failed WASM load must not create an orphan shell");
  await retryPage.unroute("**/ghostty-vt.wasm");
  await retryPage.getByRole("button", { name: "Reconnect terminal", exact: true }).click();
  await retryPage.locator(".terminal-panel[data-terminal-status=ready]").waitFor();
  assert.equal(retryCreates, 1);
  checks.push("wasm-failure-retry-without-orphan-shell");
  await retryPage.request.delete(`${base}/api/terminal/${retryId}`);
  await retryPage.reload();
  await retryPage.locator(".terminal-panel[data-terminal-status=error]").waitFor();
  assert.equal(retryCreates, 1, "A restored expired PTY must not silently create a shell");
  await retryPage.getByRole("button", { name: "Terminate terminal workspace", exact: true }).click();
  await retryPage.locator(".terminal-panel").waitFor({ state: "detached" });
  checks.push("expired-restored-pty-does-not-restart");
  await retryContext.close();
  assert.deepEqual(errors, []);
  result.passed = true;
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  result.failure = String(error.stack || error);
  throw error;
} finally {
  writeFileSync(join(artifacts, "result.json"), JSON.stringify(result, null, 2) + "\n");
  await browser?.close();
  server.kill("SIGTERM");
  await serverExit;
  log.end();
}
