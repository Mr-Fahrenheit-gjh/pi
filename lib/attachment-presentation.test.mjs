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

test("sent messages show named cards instead of storage references", () => {
  const shown = presentAttachmentMessage(`Please read\n${reference} @${root}/report.txt`);
  assert.equal(shown.text, "Please read");
  assert.deepEqual(shown.files.map((file) => file.name), ["报告 with spaces.pdf", "report.txt"]);
  assert.equal(presentAttachmentMessage("Keep [file.1] as an example").text, "Keep [file.1] as an example");
});
