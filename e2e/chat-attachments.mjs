// Focused browser integration: node e2e/chat-attachments.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

export async function runChatAttachmentChecks(page, { baseURL, project }) {
  if (!/^http:\/\/127\.0\.0\.1:301[5-9]\d$/.test(baseURL) || !/^\/(?:private\/)?tmp\//.test(project)) throw new Error("Isolated candidate and project required");
  const listUrl = `${baseURL}/api/files/${project.split("/").filter(Boolean).map(encodeURIComponent).join("/")}?type=list`;
  const before = await (await page.request.get(listUrl)).json();
  const uploads = [];
  const record = (request) => { if (request.method() === "POST" && request.url().includes("type=upload")) uploads.push(request.url()); };
  page.on("request", record);
  try {
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.goto(`${baseURL}/?session=workspace-design-fixture`, { waitUntil: "domcontentloaded" });
    const input = page.locator('.chat-input-shell input[type="file"]').first();
    const textarea = page.locator(".chat-input-textarea").first();
    await textarea.waitFor({ state: "visible" });
    await textarea.fill("");
    const response = page.waitForResponse((response) => response.url().endsWith("/api/chat-attachments") && response.request().method() === "POST");
    await input.setInputFiles({ name: "attachment check.md", mimeType: "text/markdown", buffer: Buffer.from("# Referenced attachment\n") });
    const first = await (await response).json();
    if (!first.attachments?.[0]?.path?.includes("/chat-attachments/")) throw new Error("Chat attachment was not stored outside the project");
    const card = page.locator(".chat-input-shell .attachment-card");
    await card.waitFor();
    assert.equal(await textarea.inputValue(), "", "file labels must not appear in editable prose");
    assert.equal(await textarea.getAttribute("placeholder"), "", "attachments must not leave redundant text below the card");
    assert.doesNotMatch(await page.locator(".chat-input-shell").innerText(), /\[file\.\d+\]|chat-attachments/);
    const bounds = await card.boundingBox();
    assert.ok(bounds && bounds.width <= 184 && bounds.height <= 56, "attachment card stays compact");
    const path = first.attachments[0].path;
    await card.getByRole("button", { name: "attachment check.md", exact: true }).click();
    const dialog = page.locator(".attachment-preview-dialog");
    await dialog.waitFor({ state: "visible" });
    await dialog.getByText("Referenced attachment", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    const repeated = page.waitForResponse((response) => response.url().endsWith("/api/chat-attachments") && response.request().method() === "POST");
    await input.setInputFiles({ name: "attachment check.md", mimeType: "text/markdown", buffer: Buffer.from("# Referenced attachment\n") });
    const second = await (await repeated).json();
    if (second.attachments[0].path !== path) throw new Error("Identical attachment was not deduplicated");
    assert.equal(await card.count(), 1);
    await textarea.pressSequentially("Read this");
    await textarea.press("ControlOrMeta+z");
    assert.equal(await card.count(), 1, "native text undo must not discard files");
    await textarea.fill("");
    await page.locator(".sidebar-quick-new:visible, .sidebar-new-button:visible").first().click();
    await page.waitForFunction(() => !document.querySelector(".chat-input-shell .attachment-card"));
    await page.locator('[data-row-key$=":workspace-design-fixture"] a.session-tree-main').first().click();
    await card.waitFor();
    assert.equal(await textarea.inputValue(), "", "switching drafts restores files without editor labels");
    const after = await (await page.request.get(listUrl)).json();
    assert.deepEqual(after, before);
    assert.equal(uploads.length, 0);
    const read = await page.request.get(`${baseURL}/api/files/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}?type=read`);
    assert.equal(read.status(), 200);

    // A rejected submission must restore a compact draft, not lose the file or
    // leak a UI token into the agent request. No model request is made.
    let submitted;
    const rejectSend = async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const command = route.request().postDataJSON();
      if (command.type !== "prompt") return route.continue();
      submitted = command;
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Attachment recovery fixture", code: "prompt_rejected", accepted: false }) });
    };
    await page.route("**/api/agent/**", rejectSend);
    const rejection = page.waitForResponse((response) => response.request().method() === "POST" && response.request().postDataJSON()?.type === "prompt");
    await textarea.press("Enter");
    await rejection;
    await card.waitFor();
    assert.equal(await textarea.inputValue(), "", "rejection restores the attachment, not a duplicate label");
    assert.ok(submitted, "send was intercepted");
    assert.ok(JSON.stringify(submitted).includes(path), "agent receives the original path");
    assert.doesNotMatch(JSON.stringify(submitted), /\[file\.\d+\]/);
    await page.unroute("**/api/agent/**", rejectSend);
    await card.locator(".attachment-card-remove").click();
    assert.equal(await card.count(), 0);
    assert.doesNotMatch(await textarea.inputValue(), /\[file\./);
    return { passed: true, projectUnchanged: true, deduplicated: true, preview: true, canonicalSubmission: true, rejectedDraftRestored: true, noDuplicateEditorText: true, compactCards: true, nativeUndoKeepsFiles: true, draftSwitchKeepsFiles: true };
  } finally { page.off("request", record); }
}

function fixturePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 18 Tf 20 150 Td (Attachment preview) Tj ET\n";
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(pdf + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

async function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const mode = process.env.E2E_SERVER_MODE || "dev";
  assert.ok(mode === "dev" || mode === "start", "E2E_SERVER_MODE must be dev or start");
  assert.ok(mode !== "dev" || !existsSync(join(root, ".next/dev/lock")), "An active source dev server must not be replaced");
  const agentDir = mkdtempSync("/tmp/pi-chat-attachment-e2e-");
  const project = join(agentDir, "project"), sessions = join(agentDir, "sessions", "attachments");
  mkdirSync(project); mkdirSync(sessions, { recursive: true });
  const timestamp = new Date().toISOString();
  const entries = [
    { type: "session", version: 3, id: "workspace-design-fixture", timestamp, cwd: project },
    { type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: "Attachment appearance fixture" } },
    { type: "message", id: "a1", parentId: "u1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Ready for attachments." }] } },
  ];
  writeFileSync(join(sessions, `${timestamp.replaceAll(":", "-")}_workspace-design-fixture.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const artifacts = join(root, "test-results", "chat-attachments");
  mkdirSync(artifacts, { recursive: true });
  const log = createWriteStream(join(artifacts, "server.log"));
  const server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), mode, "-H", "127.0.0.1", "-p", "30157"], {
    cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.pipe(log); server.stderr.pipe(log);
  const exited = once(server, "exit");
  let browser;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 180; attempt++) {
      if (server.exitCode !== null) throw new Error("Dev server exited; see " + artifacts);
      try { ready = (await fetch("http://127.0.0.1:30157/api/home")).ok; } catch {}
      if (ready) break;
      await delay(500);
    }
    assert.ok(ready, "Dev server started");
    browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL || "chrome" });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const result = await runChatAttachmentChecks(page, { baseURL: "http://127.0.0.1:30157", project });
    const input = page.locator('.chat-input-shell input[type="file"]').first();
    const picture = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 200;
      const context = canvas.getContext("2d");
      context.fillStyle = "#e4e9df"; context.fillRect(0, 0, 320, 200);
      context.fillStyle = "#74836c"; context.beginPath(); context.arc(160, 90, 46, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#4c5947"; context.font = "18px sans-serif"; context.fillText("Attachment", 112, 166);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await input.setInputFiles([
      { name: "2统计语言模型2026.pdf", mimeType: "application/pdf", buffer: fixturePdf() },
      { name: "sample.png", mimeType: "image/png", buffer: Buffer.from(picture, "base64") },
    ]);
    await page.locator(".chat-input-shell .attachment-card-open").filter({ hasText: "2统计语言模型2026.pdf" }).waitFor();
    await page.locator(".composer-attachment-image").waitFor();
    await page.screenshot({ path: join(artifacts, "composer.png"), fullPage: true });
    await page.locator(".attachment-card-open").filter({ hasText: "2统计语言模型2026.pdf" }).click();
    const frame = page.locator(".attachment-preview-dialog iframe");
    await frame.waitFor();
    const pdfUrl = await frame.getAttribute("src");
    assert.match(pdfUrl, /type=read/);
    const pdfResponse = await page.request.get(`http://127.0.0.1:30157${pdfUrl}`);
    assert.equal(pdfResponse.status(), 200);
    assert.match(pdfResponse.headers()["content-type"], /application\/pdf/);
    // Chromium's built-in PDF viewer paints asynchronously after the response.
    await delay(3000);
    await page.screenshot({ path: join(artifacts, "pdf-preview.png"), fullPage: true });
    const bounds = await page.locator(".attachment-preview-dialog").boundingBox();
    assert.ok(bounds && bounds.x > 0 && bounds.y > 0, "preview is centered, not pinned to a corner");
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
    writeFileSync(join(artifacts, "result.json"), JSON.stringify({ ...result, imageThumbnail: true, pdfPreviewFrame: true, pageErrors: errors }, null, 2));
    console.log(JSON.stringify({ ...result, imageThumbnail: true, pdfPreviewFrame: true, artifacts }, null, 2));
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await exited;
    log.end();
    rmSync(agentDir, { recursive: true, force: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
