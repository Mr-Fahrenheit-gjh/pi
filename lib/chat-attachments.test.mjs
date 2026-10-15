import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { saveChatAttachments, chatAttachmentRoot, existingChatAttachmentRoot } = await jiti.import("./chat-attachments.ts");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chat-attachments-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("uploads are private, deduplicated and never copied into a project", async (t) => {
  const root = fixture(t);
  const agent = path.join(root, "agent"); const project = path.join(root, "project");
  fs.mkdirSync(project); fs.writeFileSync(path.join(project, "keep.txt"), "original");
  const file = new File(["document"], "report with spaces.pdf");
  const [first] = await saveChatAttachments([file], agent);
  const before = fs.statSync(first.path);
  const [again] = await saveChatAttachments([file], agent);
  assert.equal(first.path, again.path);
  assert.equal(fs.statSync(first.path).ino, before.ino);
  assert.equal(fs.statSync(first.path).mtimeMs, before.mtimeMs);
  assert.equal(fs.readFileSync(first.path, "utf8"), "document");
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(project), ["keep.txt"]);
  assert.equal(first.path.startsWith(chatAttachmentRoot(agent) + path.sep), true);
});

test("a failed batch cannot delete a concurrent successful reuse", async (t) => {
  const root = fixture(t);
  let entered; let resume;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  const report = new File(["report"], "report.txt");
  const broken = { name: "x".repeat(300), size: 1, async arrayBuffer() { entered(); await gate; return new Uint8Array([1]).buffer; } };
  const failed = saveChatAttachments([report, broken], root);
  await waiting;
  const concurrent = saveChatAttachments([report], root);
  resume();
  await assert.rejects(failed);
  const [success] = await concurrent;
  assert.equal(fs.readFileSync(success.path, "utf8"), "report");
  assert.equal(fs.existsSync(path.join(chatAttachmentRoot(root), ".upload.lock")), false);
});

test("dead upload owners can be recovered without replacing live locks", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(chatAttachmentRoot(root), { recursive: true });
  fs.writeFileSync(path.join(chatAttachmentRoot(root), ".upload.lock"), JSON.stringify({ pid: 999999999, token: "dead-test" }));
  const [stored] = await saveChatAttachments([new File(["safe"], "safe.txt")], root);
  assert.equal(fs.readFileSync(stored.path, "utf8"), "safe");
});

test("same names with different contents cannot overwrite earlier references", async (t) => {
  const root = fixture(t);
  const [one] = await saveChatAttachments([new File(["one"], "report.txt")], root);
  const [two] = await saveChatAttachments([new File(["two"], "report.txt")], root);
  assert.notEqual(one.path, two.path);
  assert.equal(fs.readFileSync(one.path, "utf8"), "one");
});

test("path traversal, duplicate names and oversized files are rejected before writing", async (t) => {
  const root = fixture(t);
  await assert.rejects(saveChatAttachments([new File(["bad"], "../outside")], root), /path/);
  await assert.rejects(saveChatAttachments([new File(["x"], "a"), new File(["y"], "a")], root), /Duplicate/);
  await assert.rejects(saveChatAttachments([{ name: "big", size: 26 * 1024 * 1024 }], root), /size/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("attachments reject symbolic-link roots and destinations", async (t) => {
  const root = fixture(t); const outside = path.join(root, "outside"); fs.mkdirSync(outside);
  const agent = path.join(root, "agent"); fs.mkdirSync(agent);
  fs.symlinkSync(outside, chatAttachmentRoot(agent));
  assert.equal(existingChatAttachmentRoot(agent), null);
  await assert.rejects(saveChatAttachments([new File(["x"], "file")], agent), /symbolic link/);
  assert.deepEqual(fs.readdirSync(outside), []);
  const clean = path.join(root, "clean"); const hash = createHash("sha256").update("content").digest("hex");
  const dir = path.join(chatAttachmentRoot(clean), hash); fs.mkdirSync(dir, { recursive: true });
  const original = path.join(outside, "original"); fs.writeFileSync(original, "content");
  fs.symlinkSync(original, path.join(dir, "file"));
  await assert.rejects(saveChatAttachments([new File(["content"], "file")], clean), /regular file/);
  assert.equal(fs.readFileSync(original, "utf8"), "content");
});
