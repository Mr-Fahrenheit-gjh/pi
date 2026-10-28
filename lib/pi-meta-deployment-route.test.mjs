import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../app/api/service/meta-deployment/route.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
const { signalFromNodeResponse } = createRequire(import.meta.url)("next/dist/server/web/spec-extension/adapters/next-request.js");
const LEASE = "11111111-1111-4111-8111-111111111111";
function harness(overrides = {}) {
  let held = false, committed = false, releases = 0, calls = 0;
  const context = vm.createContext({
    Request, Response, URL, TextEncoder, ReadableStream,
    NextResponse: { json: (value, options) => Response.json(value, options) },
    noStore: { "Cache-Control": "no-store" },
    isLocalServiceRequest: () => true,
    ownsMetaDeploymentLease: id => held && id === LEASE,
    commitMetaDeploymentLease: id => { if (!held || id !== LEASE) return false; committed = true; return true; },
    cancelMetaDeploymentLease: id => { if (!held || id !== LEASE) return false; held = false; committed = false; return true; },
    acquireMetaDeploymentLease: async () => {
      calls++;
      held = true;
      return { ok: true, leaseId: LEASE, release() { if (!committed) { held = false; releases++; } } };
    },
    ...overrides,
  });
  for (const name of ["GET", "POST"]) {
    const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    const js = ts.transpileModule(declaration.getText(file).replace(/^export /, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInContext(js, context);
  }
  return { context, get held() { return held; }, get releases() { return releases; }, get calls() { return calls; } };
}

const post = (signal, body = { confirmed: true }) => new Request("http://localhost:30141/api/service/meta-deployment", {
  method: "POST", headers: { origin: "http://localhost:30141", "content-type": "application/json" }, body: JSON.stringify(body), signal,
});

test("deployment lease is local and explicitly confirmed", async () => {
  const denied = harness({ isLocalServiceRequest: () => false });
  assert.equal((await denied.context.POST(post())).status, 403);
  assert.equal(denied.calls, 0);
  const h = harness();
  assert.equal((await h.context.POST(post(undefined, {}))).status, 400);
  assert.equal(h.calls, 0);
});

test("the streaming connection holds the lease and abort releases it once", async () => {
  const h = harness();
  const abort = new AbortController();
  const response = await h.context.POST(post(abort.signal));
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.deepEqual(JSON.parse(new TextDecoder().decode(first.value)), { ok: true, leaseId: LEASE });
  assert.equal(h.held, true);
  const status = await h.context.GET(new Request(`http://localhost:30141/api/service/meta-deployment?leaseId=${LEASE}`));
  assert.deepEqual(await status.json(), { owns: true });
  abort.abort();
  assert.equal((await reader.read()).done, true);
  assert.equal(h.held, false);
  assert.equal(h.releases, 1);
});

test("closing the response body also releases the lease", async () => {
  const h = harness();
  const response = await h.context.POST(post());
  await response.body.cancel();
  assert.equal(h.held, false);
  assert.equal(h.releases, 1);
});

test("a real HTTP disconnect aborts the Next response signal and releases the lease", async (t) => {
  const h = harness();
  let closed;
  const responseClosed = new Promise(resolve => { closed = resolve; });
  const server = createServer(async (incoming, outgoing) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    const request = new Request("http://localhost:30141/api/service/meta-deployment", {
      method: "POST", headers: { "content-type": "application/json" }, body,
      signal: signalFromNodeResponse(outgoing),
    });
    const response = await h.context.POST(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    const reader = response.body.getReader();
    const first = await reader.read();
    outgoing.write(first.value);
    outgoing.once("close", () => { void reader.cancel().finally(closed); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = httpRequest({ host: "127.0.0.1", port: server.address().port, path: "/api/service/meta-deployment", method: "POST" });
  const responsePromise = once(client, "response");
  client.end(JSON.stringify({ confirmed: true }));
  const [response] = await responsePromise;
  const [chunk] = await once(response, "data");
  assert.equal(JSON.parse(chunk.toString()).leaseId, LEASE);
  assert.equal(h.held, true);
  response.destroy();
  await responseClosed;
  assert.equal(h.held, false);
  assert.equal(h.releases, 1);
});

test("disconnect after ownership check prevents committing the stop", async () => {
  const h = harness();
  const abort = new AbortController();
  const response = await h.context.POST(post(abort.signal));
  const reader = response.body.getReader();
  await reader.read();
  const status = await h.context.GET(new Request(`http://localhost:30141/api/service/meta-deployment?leaseId=${LEASE}`));
  assert.deepEqual(await status.json(), { owns: true });
  abort.abort();
  assert.equal((await reader.read()).done, true);
  const commit = await h.context.POST(post(undefined, { confirmed: true, action: "commit", leaseId: LEASE }));
  assert.equal(commit.status, 409);
  assert.equal(h.held, false);
});

test("a committed stop keeps admission closed after disconnect until explicitly cancelled", async () => {
  const h = harness();
  const abort = new AbortController();
  const response = await h.context.POST(post(abort.signal));
  const reader = response.body.getReader();
  await reader.read();
  assert.equal((await h.context.POST(post(undefined, { confirmed: true, action: "commit", leaseId: LEASE }))).status, 200);
  abort.abort();
  assert.equal((await reader.read()).done, true);
  assert.equal(h.held, true);
  assert.equal((await h.context.POST(post(undefined, { confirmed: true, action: "cancel", leaseId: LEASE }))).status, 200);
  assert.equal(h.held, false);
});

test("a disconnect while a worker is draining releases the acquired lease", async () => {
  let finish, released = 0;
  const h = harness({ acquireMetaDeploymentLease: () => new Promise(resolve => { finish = resolve; }) });
  const abort = new AbortController();
  const request = h.context.POST(post(abort.signal));
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  finish({ ok: true, leaseId: "late", release() { released++; } });
  assert.equal((await request).status, 409);
  assert.equal(released, 1);
});
