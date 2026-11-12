import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { AttachmentPresentation, presentAttachmentMessage, splitComposerAttachments, serializeComposerAttachments, mergeComposerAttachments } = await createJiti(import.meta.url).import("./attachment-presentation.ts");
const root = "/Users/example/.pi/agent/chat-attachments/" + "a".repeat(64);
const path = `${root}/报告 with spaces.pdf`;
const reference = `@"${path}"`;

test("display tokens round-trip canonical references without exposing private paths", () => {
  const p = new AttachmentPresentation();
  const value = p.compact(`Read ${reference} please`);
  assert.equal(value, "Read [file.1] please");
  assert.equal(p.expand(value), `Read ${reference} please`);
  assert.deepEqual(p.files(value), [{ token: "[file.1]", name: "报告 with spaces.pdf", path }]);
});
test("removal, undo, repeated files and restored drafts retain identity", () => {
  const p = new AttachmentPresentation();
  const value = p.compact(reference);
  assert.deepEqual(p.files(""), []);
  assert.equal(p.expand(value), reference);
  assert.equal(p.compact(reference), value);
  const q = new AttachmentPresentation();
  assert.equal(q.expand(q.compact(p.expand(value))), reference);
  assert.equal(p.expand("[file.999]"), "[file.999]");
});
test("mixed files, normal mentions, URLs and paths are not confused", () => {
  const p = new AttachmentPresentation();
  const raw = `@src/main.ts /tmp/a.pdf https://example.com/a @${root}/plain.txt ${reference}`;
  const compact = p.compact(raw);
  assert.equal(compact, "@src/main.ts /tmp/a.pdf https://example.com/a [file.1] [file.2]");
  assert.equal(p.expand(compact), raw);
});
test("composer drafts keep attachments out of editable text and round-trip whitespace", () => {
  const file = { name: "报告 with spaces.pdf", path };
  for (const text of ["", "Please read", "Please read  \n", "Keep [file.1] as prose"]) {
    const canonical = serializeComposerAttachments(text, [file]);
    assert.deepEqual(splitComposerAttachments(canonical), { text, files: [file] });
    assert.ok(canonical.includes(path));
  }
  assert.deepEqual(splitComposerAttachments("Type normally  "), { text: "Type normally  ", files: [] });
  assert.deepEqual(mergeComposerAttachments([file], [file]), [file]);
});

test("Windows drive and UNC attachments round-trip without changing separators", () => {
  const hash = "b".repeat(64);
  for (const root of [
    "C:\\Users\\Alice\\.pi\\agent\\chat-attachments\\",
    "C:/Users/Alice/.pi/agent/chat-attachments/",
    "\\\\server\\share\\.pi\\agent\\chat-attachments\\",
    "//server/share/.pi/agent/chat-attachments/",
    "/home/alice/.pi/agent/chat-attachments/",
  ]) {
    const separator = root.endsWith("\\") ? "\\" : "/";
    const file = { name: "报告 with spaces.pdf", path: `${root}${hash}${separator}报告 with spaces.pdf` };
    const raw = serializeComposerAttachments("Read this", [file]);
    assert.deepEqual(splitComposerAttachments(raw), { text: "Read this", files: [file] });
    assert.deepEqual(presentAttachmentMessage(raw).files.map(({ name, path }) => ({ name, path })), [file]);
    const presentation = new AttachmentPresentation();
    assert.equal(presentation.expand(presentation.compact(raw)), raw);
  }
});

test("Windows project paths, drive-relative paths and URLs remain ordinary text", () => {
  const hash = "c".repeat(64);
  for (const raw of [
    "@C:\\repo\\report.pdf",
    `@C:chat-attachments\\${hash}\\report.pdf`,
    `@https://example.com/chat-attachments/${hash}/report.pdf`,
    `@chat-attachments/${hash}/report.pdf`,
  ]) assert.deepEqual(splitComposerAttachments(raw), { text: raw, files: [] });
});

test("sent messages show named cards instead of storage references", () => {
  const shown = presentAttachmentMessage(`Please read\n${reference} @${root}/report.txt`);
  assert.equal(shown.text, "Please read");
  assert.deepEqual(shown.files.map((file) => file.name), ["报告 with spaces.pdf", "report.txt"]);
  assert.equal(presentAttachmentMessage("Keep [file.1] as an example").text, "Keep [file.1] as an example");
});
