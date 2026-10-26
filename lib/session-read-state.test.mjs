import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { readSessionReadState, updateSessionReadState, recordSessionReadLifecycle, forgetSessionReadState } = await jiti.import("./session-read-state.ts");
const { parseSessionReadRequest } = await jiti.import("./session-read-state-shared.ts");
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-read-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "state.json");
}
test("completion tokens survive stale reads, zero reads and repeated explicit unread", async t => {
  const path = fixture(t);
  const first = await recordSessionReadLifecycle("s1", "complete", path);
  const next = await recordSessionReadLifecycle("s1", "complete", path);
  assert.ok(next.unread.s1 > first.unread.s1);
  for (const token of [0, first.unread.s1]) {
    assert.deepEqual(await updateSessionReadState({ action: "read", entries: [{ id: "s1", token }] }, path), next);
  }
  assert.deepEqual(await updateSessionReadState({ action: "unread", ids: ["s1"] }, path), next);
  const read = await updateSessionReadState({ action: "read", entries: [{ id: "s1", token: next.unread.s1 }] }, path);
  assert.deepEqual(read.unread, {});
  assert.deepEqual(readSessionReadState(path), read);
  assert.deepEqual(await updateSessionReadState({ action: "import", ids: ["s1"] }, path), read);
});
test("start/end writes and concurrent requests serialize, imports cannot resurrect tombstones", async t => {
  const path = fixture(t);
  const operations = [recordSessionReadLifecycle("s1", "start", path), recordSessionReadLifecycle("s1", "complete", path), recordSessionReadLifecycle("s1", "start", path)];
  await Promise.all(operations);
  assert.deepEqual(readSessionReadState(path).unread, {});
  await Promise.all(Array.from({ length: 25 }, (_, i) => updateSessionReadState({ action: "unread", ids: [`s${i + 2}`] }, path)));
  assert.equal(Object.keys(readSessionReadState(path).unread).length, 25);
  await updateSessionReadState({ action: "read", entries: [{ id: "new", token: 0 }] }, path);
  const imported = await updateSessionReadState({ action: "import", ids: ["s1", "new", "legacy"] }, path);
  assert.equal(imported.unread.s1, undefined);
  assert.equal(imported.unread.new, undefined);
  assert.ok(imported.unread.legacy);
  await forgetSessionReadState(["legacy"], path);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).entries.legacy, undefined);
});
test("corrupt, non-regular and regressed storage fails closed without rewriting", async t => {
  const path = fixture(t);
  const good = await recordSessionReadLifecycle("s1", "complete", path);
  writeFileSync(path, "{bad");
  assert.throws(() => readSessionReadState(path));
  await assert.rejects(updateSessionReadState({ action: "unread", ids: ["s2"] }, path));
  assert.equal(readFileSync(path, "utf8"), "{bad");
  writeFileSync(path, JSON.stringify({ version: 1, revision: 0, entries: {} }));
  assert.throws(() => readSessionReadState(path));
  rmSync(path); mkdirSync(path);
  assert.throws(() => readSessionReadState(path));
  assert.equal(good.revision, 1);
});
test("independent processes lock the same store and restart preserves revision/tokens", async t => {
  const path = fixture(t);
  const moduleUrl = new URL("./session-read-state.ts", import.meta.url).href;
  const script = `import { createJiti } from 'jiti'; const m = await createJiti(import.meta.url).import(${JSON.stringify(moduleUrl)}); const path = process.argv[1]; const id = process.argv[2]; if (id) await m.updateSessionReadState({ action: 'unread', ids: [id] }, path); console.log(JSON.stringify(m.readSessionReadState(path)));`;
  await Promise.all(Array.from({ length: 4 }, (_, i) => exec(process.execPath, ["--input-type=module", "-e", script, path, `process${i}`])));
  const expected = readSessionReadState(path);
  assert.equal(expected.revision, 4);
  assert.equal(Object.keys(expected.unread).length, 4);
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script, path]);
  assert.deepEqual(JSON.parse(stdout), expected);
});

test("strict bounded request schema", () => {
  for (const body of [null, [], { action: "read", entries: [{ id: "a", token: -1 }] }, { action: "read", entries: [{ id: "a", token: 1, extra: true }] }, { action: "unread", ids: ["../x"] }, { action: "import", ids: ["a".repeat(201)] }, { action: "unread", ids: ["s"], extra: true }, { action: "unread", ids: Array.from({ length: 501 }, (_, i) => `s${i}`) }]) assert.equal(parseSessionReadRequest(body), null);
  assert.deepEqual(parseSessionReadRequest({ action: "unread", ids: ["s", "s"] }), { action: "unread", ids: ["s"] });
});
