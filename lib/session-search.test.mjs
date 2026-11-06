import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { searchSessionContents, searchSessionContentsPage, SessionSearchCursorError } from "./session-search.ts";

function fixture(t, entries, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-search-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { id: "session", path, cwd: dir, created: "2026-01-01", modified: "2026-01-01", firstMessage: "first", messageCount: entries.length, ...overrides };
}

function message(role, content) {
  return { type: "message", message: { role, content } };
}

test("finds one literal, case-insensitive snippet per session, newest first", async (t) => {
  const older = fixture(t, [{ ...message("user", "before NEEDLE after"), id: "matched-entry" }, message("user", "needle again")], { id: "older" });
  const newer = fixture(t, [message("assistant", [{ type: "text", text: "another needle" }])], { id: "newer", modified: "2026-02-01" });
  const result = await searchSessionContents([older, newer], " needle ");
  assert.deepEqual(result.results.map(({ session }) => session.id), ["newer", "older"]);
  assert.deepEqual(result.results[1], { session: older, entryId: "matched-entry", blockIndex: 0, before: "before ", match: "NEEDLE", after: " after" });
  assert.equal(result.truncated, false);

  const literal = fixture(t, [message("user", "a".repeat(40) + "!"), message("user", "literal (a+)+$ and [test].*")]);
  assert.equal((await searchSessionContents([literal], "(a+)+$")).results[0].match, "(a+)+$");
  assert.equal((await searchSessionContents([literal], "[test].*")).results[0].match, "[test].*");
});

test("identifies the matching text block across thinking, tools and multiple text blocks", async (t) => {
  const session = fixture(t, [message("assistant", [
    { type: "thinking", thinking: "pi-cwd-spark" },
    { type: "text", text: "earlier text" },
    { type: "toolCall", name: "read", arguments: {} },
    { type: "text", text: "正文 pi-cwd-spark" },
    { type: "text", text: "later text" },
  ])]);
  assert.equal((await searchSessionContents([session], "pi-cwd-spark")).results[0].blockIndex, 3);
  assert.equal((await searchSessionContents([session], "earlier text")).results[0].blockIndex, 1);
  assert.equal((await searchSessionContents([session], "later text")).results[0].blockIndex, 4);
  assert.equal((await searchSessionContents([session], "spark\nlater")).results[0].blockIndex, 3);
});

test("searches historical text, excluding tools, thinking, images, summaries and transient sessions", async (t) => {
  const hidden = fixture(t, [
    message("toolResult", "needle"),
    message("assistant", [{ type: "thinking", thinking: "needle" }, { type: "toolCall", arguments: { text: "needle" } }, { type: "image", data: "needle" }]),
    { type: "compaction", summary: "needle" },
    { type: "custom", data: "needle" },
    message("user", null),
    null,
  ]);
  assert.deepEqual((await searchSessionContents([hidden], "needle")).results, []);
  const history = fixture(t, [message("user", "needle before compaction"), { type: "compaction", summary: "summary" }, message("user", "current")]);
  assert.equal((await searchSessionContents([history], "needle")).results.length, 1);
  assert.deepEqual((await searchSessionContents([{ ...history, transient: true }], "needle")).results, []);
});

test("keeps Unicode offsets correct and bounds snippets around the actual match", async (t) => {
  const session = fixture(t, [message("user", `${"x".repeat(200)}\n\u0130 中文 NEEDLE \n${"y".repeat(200)}`)]);
  const result = await searchSessionContents([session], "needle");
  assert.equal(result.results[0].match, "NEEDLE");
  assert.ok(result.results[0].before.startsWith("..."));
  assert.ok(result.results[0].after.endsWith("..."));
  assert.ok(result.results[0].before.length <= 83);
  assert.doesNotMatch(result.results[0].before, /\n/);
  assert.equal((await searchSessionContents([session], "中文")).results[0].match, "中文");
});

test("skips malformed lines and reports unreadable or oversized content as incomplete", async (t) => {
  const session = fixture(t, [message("user", "x".repeat(1024 * 1024 + 1)), message("user", "needle")]);
  const missing = { ...session, id: "missing", path: join(session.cwd, "missing.jsonl") };
  const result = await searchSessionContents([missing, session], "needle");
  assert.equal(result.results.length, 1);
  assert.equal(result.truncated, true);
  writeFileSync(session.path, `invalid\n${JSON.stringify(message("user", "needle"))}\n{"type":`);
  assert.equal((await searchSessionContents([session], "needle")).results.length, 1);
});

test("handles empty, oversized and cancelled queries without reading a session", async (t) => {
  const session = fixture(t, [message("user", "needle")]);
  assert.deepEqual(await searchSessionContents([session], "  "), { results: [], truncated: false });
  await assert.rejects(searchSessionContents([session], "x".repeat(201)), RangeError);
  assert.deepEqual(await searchSessionContents([session], "needle", AbortSignal.abort()), { results: [], truncated: true });
});

test("bounds bytes read from a single file and reports the unsearched remainder", async (t) => {
  const session = fixture(t, []);
  writeFileSync(session.path, " ".repeat(16 * 1024 * 1024) + "\n" + JSON.stringify(message("user", "needle")));
  assert.deepEqual(await searchSessionContents([session], "needle"), { results: [], truncated: true });
});

test("checks the deadline inside the final file, before the matching line", async (t) => {
  const session = fixture(t, [message("user", "no match"), message("user", "needle")]);
  let ticks = 0;
  t.mock.method(Date, "now", () => ++ticks <= 3 ? 0 : 4000);
  assert.deepEqual(await searchSessionContents([session], "needle"), { results: [], truncated: true });
});

test("reports file and result caps even when no conversations match", async (t) => {
  const session = fixture(t, [message("user", "needle")]);
  const sessions = Array.from({ length: 501 }, (_, index) => ({ ...session, id: String(index) }));
  const noMatches = await searchSessionContents(sessions, "absent");
  assert.deepEqual(noMatches, { results: [], truncated: true });
  const capped = await searchSessionContents(sessions, "needle");
  assert.equal(capped.results.length, 30);
  assert.equal(capped.truncated, true);
  assert.equal((await searchSessionContents(sessions.slice(0, 30), "needle")).truncated, false);
});

async function allPages(sessions, query) {
  const results = [], cursors = new Set();
  let cursor;
  do {
    const page = await searchSessionContentsPage(sessions, query, undefined, cursor);
    results.push(...page.results);
    cursor = page.nextCursor;
    if (cursor) {
      assert.equal(cursors.has(cursor), false, "each batch must advance even without hits");
      cursors.add(cursor);
    }
    assert.ok(cursors.size < 100, "bounded test traversal");
  } while (cursor);
  return results;
}

test("paged search reaches conversations beyond 500 files and ignores sidebar/project visibility", async (t) => {
  const empty = fixture(t, [message("user", "ordinary history")]);
  const old = fixture(t, [message("assistant", "old archived needle")], { id: "0000", cwd: "/another-project" });
  const sessions = [old, ...Array.from({ length: 500 }, (_, i) => ({ ...empty, id: String(i + 1).padStart(4, "0") }))];
  const first = await searchSessionContentsPage(sessions, "needle");
  assert.deepEqual(first.results, []);
  assert.ok(first.nextCursor);
  assert.equal(first.incomplete, false);
  const rest = await searchSessionContentsPage(sessions.reverse(), "needle", undefined, first.nextCursor);
  assert.deepEqual(rest.results.map(r => r.session.id), ["0000"]);
  assert.equal(rest.nextCursor, null);
  assert.equal(rest.truncated, false);
});

test("all keyword hits are reachable beyond 30, with replayable query-bound cursors", async (t) => {
  const original = fixture(t, [message("user", "needle")]);
  const sessions = Array.from({ length: 75 }, (_, i) => ({ ...original, id: String(i).padStart(4, "0") }));
  const first = await searchSessionContentsPage(sessions, "needle");
  assert.equal(first.results.length, 30);
  const next = await searchSessionContentsPage(sessions, "needle", undefined, first.nextCursor);
  assert.deepEqual(await searchSessionContentsPage([...sessions].reverse(), "needle", undefined, first.nextCursor), next);
  assert.equal((await allPages(sessions, "needle")).length, 75);
  await assert.rejects(searchSessionContentsPage(sessions, "different", undefined, first.nextCursor), error => error instanceof SessionSearchCursorError && error.status === 400);
  await assert.rejects(searchSessionContentsPage(sessions, "needle", undefined, "not-a-cursor"), SessionSearchCursorError);
});

test("paged title/first-message matches include other projects without requiring readable body files", async (t) => {
  const original = fixture(t, []);
  const named = { ...original, id: "named", path: join(original.cwd, "missing"), name: "Archived report", cwd: "/archived-project" };
  const first = { ...original, id: "first", firstMessage: "report in another project", cwd: "/another-project" };
  const page = await searchSessionContentsPage([named, first], "REPORT");
  assert.deepEqual(page.results.map(r => r.session.id), ["named", "first"]);
  assert.ok(page.results.every(r => !r.entryId));
  assert.equal(page.incomplete, false);
});

test("paged search continues after 16MiB and preserves UTF-8 message/block positions", async (t) => {
  const session = fixture(t, []);
  const filler = JSON.stringify(message("assistant", "无关内容".repeat(800))) + "\n";
  const tail = { ...message("assistant", [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "中文 needle 尾部" }]), id: "tail-entry" };
  writeFileSync(session.path, filler.repeat(Math.ceil(17 * 1024 * 1024 / Buffer.byteLength(filler))) + JSON.stringify(tail) + "\n");
  const first = await searchSessionContentsPage([session], "needle");
  assert.equal(first.results.length, 0);
  assert.ok(first.nextCursor);
  const rest = await searchSessionContentsPage([session], "needle", undefined, first.nextCursor);
  assert.equal(rest.results[0].entryId, "tail-entry");
  assert.equal(rest.results[0].blockIndex, 1);
  assert.equal(rest.results[0].before, "中文 ");
  assert.equal(rest.nextCursor, null);
});

test("a timed batch resumes at the exact committed line, not the stream read-ahead position", async (t) => {
  const session = fixture(t, [message("user", "中文 earlier"), { ...message("user", "中文 needle"), id: "later" }]);
  let ticks = 0;
  t.mock.method(Date, "now", () => ++ticks === 1 ? 0 : 4000);
  const first = await searchSessionContentsPage([session], "needle");
  t.mock.restoreAll();
  assert.ok(first.nextCursor);
  assert.equal(first.results.length, 0);
  const rest = await searchSessionContentsPage([session], "needle", undefined, first.nextCursor);
  assert.equal(rest.results[0].entryId, "later");
});

test("continuation refuses a changed file and cancellation never returns successful partial data", async (t) => {
  const session = fixture(t, [message("user", "earlier"), message("user", "needle")]);
  let ticks = 0;
  t.mock.method(Date, "now", () => ++ticks === 1 ? 0 : 4000);
  const first = await searchSessionContentsPage([session], "needle");
  t.mock.restoreAll();
  writeFileSync(session.path, JSON.stringify(message("user", "replacement needle")) + "\n");
  await assert.rejects(searchSessionContentsPage([session], "needle", undefined, first.nextCursor), error => error instanceof SessionSearchCursorError && error.status === 409);
  await assert.rejects(searchSessionContentsPage([session], "needle", AbortSignal.abort()), /abort/i);
});

test("oversized/unreadable lines stay explicitly incomplete without hiding later conversations", async (t) => {
  const session = fixture(t, [message("assistant", "x".repeat(1024 * 1024 + 1)), message("user", "literal [needle].*")]);
  const page = await searchSessionContentsPage([session], "[needle].*");
  assert.equal(page.results[0].match, "[needle].*");
  assert.equal(page.incomplete, true);
  assert.equal(page.nextCursor, null);
  assert.equal(page.truncated, true);
});
