import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url);
const { chatAttachmentMentionText, splitDroppedItems } = await jiti.import("../lib/file-upload-client.ts");
const sourceText = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("ChatWindow.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name, context) {
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) return node.initializer.arguments[0];
    return ts.forEachChild(node, find);
  }
  return new Script(ts.transpileModule(find(source).getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText).runInNewContext(context);
}
const photo = new File(["x"], "photo.png", { type: "image/png" });
const report = new File(["x"], "report.pdf", { type: "application/pdf" });
const log = new File(["x"], "server.log");
async function attach(files, response = { status: 200, data: { attachments: [{ name: "report.pdf", path: "/agent/chat-attachments/hash/report.pdf" }] } }) {
  const calls = { images: [], uploads: [], mentions: [], notices: [] };
  const scope = {
    chatInputRef: { current: { addImages: (images) => calls.images.push(...images), insertText: (text) => calls.mentions.push(text) } },
    addNotice: (notice) => calls.notices.push([notice.type, notice.message]),
    t: (key, vars) => vars ? `${key} ${JSON.stringify(vars)}` : key,
    splitDroppedItems, chatAttachmentMentionText,
    uploadChatAttachments: async (uploads) => { calls.uploads.push(uploads.map((file) => file.name)); return response; },
  };
  scope.uploadDroppedFiles = callback("uploadDroppedFiles", scope);
  scope.onDrop = callback("onDrop", scope);
  callback("onAttachFiles", scope)(files);
  await new Promise((resolve) => setImmediate(resolve));
  return calls;
}

test("picked files and drops become private absolute references, never project uploads", async () => {
  const mixed = await attach([photo, report, log], { status: 200, data: { attachments: [
    { name: "report.pdf", path: "/agent/chat-attachments/a/report.pdf" },
    { name: "server.log", path: "/agent/chat-attachments/b/server.log" },
  ] } });
  assert.deepEqual(mixed.images, [photo]);
  assert.deepEqual(mixed.uploads, [["report.pdf", "server.log"]]);
  assert.deepEqual(mixed.mentions, ["@/agent/chat-attachments/a/report.pdf @/agent/chat-attachments/b/server.log "]);
  assert.deepEqual(mixed.notices, [["success", 'chat.dropUploaded {"count":2}']]);
  assert.doesNotMatch(sourceText, /uploadFiles\(cwd|uploadFiles\(.*"skip"/);
});

test("image-only attachments keep their existing prompt path", async () => {
  const result = await attach([photo]);
  assert.deepEqual(result.images, [photo]);
  assert.deepEqual(result.uploads, []);
  assert.deepEqual(result.notices, []);
});

test("a failed attachment never inserts an invalid @path", async () => {
  const result = await attach([report], { status: 500, data: { error: "disk error" } });
  assert.deepEqual(result.mentions, []);
  assert.equal(result.notices[0][0], "error");
});
