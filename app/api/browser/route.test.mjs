import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const protocol = await jiti.import("../../../lib/browser-protocol.ts");
const preview = await jiti.import("../../../lib/browser-preview.ts");
const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const deck = { id: "00112233-4455-6677-8899-aabbccddeeff", url: "http://127.0.0.1:42001/?session=fixture&embedded=1" };
const body = { id: deck.id.replaceAll("-", ""), url: deck.url, designDeckId: deck.id };
function fixture({ live = deck, finishDuringCreate = false } = {}) {
  const calls = [], sandboxModule = { exports: {} };
  const mocks = {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/browser-protocol": protocol, "@/lib/browser-preview": preview,
    "@/lib/design-deck-bridge": { getDesignDeck: id => live?.id === id ? live : undefined },
    "@/lib/browser-manager": { getBrowserManager: () => ({
      create: async id => { calls.push(["create", id]); if (finishDuringCreate) live = undefined; return { id }; },
      close: async id => calls.push(["close", id]),
    }) },
  };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports: sandboxModule.exports, require: name => mocks[name] });
  return { calls, post: data => sandboxModule.exports.POST(new Request("http://localhost/api/browser", { method: "POST", body: JSON.stringify(data) })) };
}

test("only the live presentation's exact page ID and URL may be reconnected", async () => {
  const f = fixture();
  assert.equal((await f.post(body)).status, 200);
  for (const changed of [{ designDeckId: "gone" }, { url: "http://127.0.0.1:42001/admin" }, { id: "a".repeat(32) }, { designDeckId: null }]) {
    assert.equal((await f.post({ ...body, ...changed })).status, 410);
  }
  assert.equal(f.calls.length, 1);
});

test("completion during browser startup closes the late page rather than leaking it", async () => {
  const f = fixture({ finishDuringCreate: true });
  assert.equal((await f.post(body)).status, 410);
  assert.deepEqual(f.calls, [["create", body.id], ["close", body.id]]);
});

test("ordinary terminal browser creation is unchanged", async () => {
  const f = fixture({ live: null });
  const ordinary = { id: body.id, url: body.url };
  assert.equal((await f.post(ordinary)).status, 200);
  assert.deepEqual(f.calls, [["create", body.id]]);
});
