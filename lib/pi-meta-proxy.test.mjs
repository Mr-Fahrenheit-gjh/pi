import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { forwardPiMetaRequest } from "./pi-meta-proxy.mjs";

async function server(t, handler) {
  const root = await mkdtemp(join(tmpdir(), "pi-meta-proxy-"));
  const socket = join(root, "worker.sock");
  const instance = createServer(handler);
  await new Promise((resolve, reject) => instance.listen(socket, resolve).once("error", reject));
  t.after(async () => { await new Promise(resolve => instance.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return socket;
}

test("forwards method, query and body over the private socket and rewrites origin", async (t) => {
  const socket = await server(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.writeHead(201, { "Content-Type": "application/json", "Set-Cookie": ["a=1; Path=/", "b=2; Path=/"] });
    res.end(JSON.stringify({ method: req.method, path: req.url, body, host: req.headers.host, origin: req.headers.origin }));
  });
  const response = await forwardPiMetaRequest(socket, new Request("http://127.0.0.1:30141/api/runtime/meta/agent/new?x=1", {
    method: "POST", headers: { Origin: "http://127.0.0.1:30141", "Content-Type": "application/json" }, body: '{"example":true}',
  }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { method: "POST", path: "/api/agent/new?x=1", body: '{"example":true}', host: "localhost", origin: "http://localhost" });
  assert.equal(response.headers.getSetCookie().length, 2);
});

test("streams an event response and does not expose nested runtime or service routes", async (t) => {
  let calls = 0;
  const socket = await server(t, (_req, res) => {
    calls++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: first\n\n");
    setTimeout(() => res.end("data: second\n\n"), 10);
  });
  const response = await forwardPiMetaRequest(socket, new Request("http://localhost/api/runtime/meta/agent/s/events"));
  assert.equal(await response.text(), "data: first\n\ndata: second\n\n");
  await assert.rejects(forwardPiMetaRequest(socket, new Request("http://localhost/api/runtime/meta/service/restart")), /refused/i);
  await assert.rejects(forwardPiMetaRequest(socket, new Request("http://localhost/api/runtime/meta/runtime/feynman/agent")), /refused/i);
  await assert.rejects(forwardPiMetaRequest(socket, new Request("http://localhost/api/runtime/meta/pi-meta-control")), /refused/i);
  assert.equal(calls, 1);
});
