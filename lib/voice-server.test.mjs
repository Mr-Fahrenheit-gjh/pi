import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const protocol = await jiti.import("./voice-protocol.ts");
const work = await jiti.import("./voice-work.ts");
const security = await jiti.import("./request-security.ts");
const source = await readFile(new URL("./voice-server.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness(t) {
  globalThis.__piVoiceCalls = new Map(); globalThis.__piVoiceStarts = []; globalThis.__piVoiceStartingSessions = new Set(); globalThis.__piVoiceWork = new Map();
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; globalThis.__piVoiceCalls.clear(); globalThis.__piVoiceWork.clear(); });
  let leaf = "leaf", busy = false, draining = false, result;
  const requests = [], prompts = [];
  const wrapper = {
    inner: { sessionManager: { getLeafId: () => leaf, getBranch: () => [{ message: { role: "user", content: "visible task" } }] } },
    isAlive: () => true, isRunning: () => busy,
    send: async (command, voice) => { prompts.push(command); result = voice; },
  };
  const mocks = {
    "node:crypto": { randomUUID }, "./voice-protocol": protocol, "./voice-work": work, "./request-security": security,
    "./model-runtime": { getModelRuntimeWithExtensions: async () => ({ getModel: (provider, id) => { assert.equal(provider, "openai"); return { id, baseUrl: "https://api.openai.com/v1" }; }, getAuth: async () => ({ auth: { apiKey: "private-key", headers: { "OpenAI-Project": "configured-project" } } }) }) },
    "./http-dispatcher": { configureHttpDispatcher() {} },
    "./service-restart-state": { assertServiceNotRestarting() { if (draining) throw new Error("private internal restart diagnostic"); } },
    "./rpc-manager": { getRpcSession: () => wrapper, startRpcSession: async () => ({ session: wrapper }) },
    "./session-reader": { resolveSessionPath: async () => "/tmp/fake-session.jsonl" },
    "./session-liveness": { registerSessionLivenessProvider: () => () => {} },
  };
  const exports = {}; new Function("require", "exports", compiled)((key) => { assert.ok(key in mocks, key); return mocks[key]; }, exports);
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return Response.json(String(url).endsWith("transcriptions") ? { text: "typed words" } : { session: { id: "live_id" }, transport: { sdp: "v=0\r\nanswer" } });
  };
  const req = (action, body, options = {}) => exports.voiceRequest(new Request(`http://localhost:30150/api/voice/${action}`, {
    method: "POST", headers: { host: "localhost:30150", origin: "http://localhost:30150", "content-type": "application/json", ...options.headers },
    body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body), signal: options.signal,
  }), action);
  const start = async () => { const res = await req("start", { sessionId: "pi-session", leafId: leaf, sdp: "v=0\r\noffer", model: "attacker", apiKey: "bad", baseUrl: "https://attacker.invalid" }); assert.equal(res.status, 200); return { ...await res.json(), sessionId: "pi-session" }; };
  return { req, start, requests, prompts, result: () => result, setLeaf: (v) => { leaf = v; }, busy: () => { busy = true; }, drain: () => { draining = true; }, exports, mocks };
}

test("fixed official endpoint/model, server-only credential and filtered public context", async (t) => {
  const h = harness(t); const call = await h.start();
  assert.equal(h.requests[0].url, "https://api.openai.com/v1/live/sessions");
  const options = h.requests[0].options, body = JSON.parse(options.body);
  assert.equal(options.headers.get("authorization"), "Bearer private-key");
  assert.equal(options.headers.get("accept"), "application/json");
  assert.equal(options.headers.get("accept-encoding"), "identity");
  assert.equal(options.redirect, "error");
  assert.equal(body.session.model, "gpt-live-1"); assert.equal(body.session.store, false);
  assert.deepEqual(body.session.delegation, { type: "client" });
  assert.match(body.session.instructions, /visible task/);
  assert.doesNotMatch(JSON.stringify(call), /private-key|configured-project/);
  assert.equal(work.activeVoiceWork(), 1);
  assert.equal((await h.req("end", { ...call, confirmed: true })).headers.get("cache-control"), "no-store");
  assert.equal(work.activeVoiceWork(), 0);
});

test("realtime dictation mints only a short-lived transcription secret, then releases its bounded hold", async (t) => {
  const h = harness(t);
  globalThis.fetch = async (url, options) => {
    h.requests.push({ url, options });
    return Response.json({ value: "ek_temporary", expires_at: Math.floor(Date.now() / 1000) + 60 });
  };
  const res = await h.req("dictation-start", { model: "attacker", baseUrl: "https://evil.invalid" });
  assert.equal(res.status, 200);
  const data = await res.json(); assert.equal(data.secret, "ek_temporary"); assert.equal(typeof data.token, "string");
  assert.equal(h.requests[0].url, "https://api.openai.com/v1/realtime/client_secrets");
  const body = JSON.parse(h.requests[0].options.body);
  assert.deepEqual(body.expires_after, { anchor: "created_at", seconds: 60 });
  assert.equal(body.session.type, "transcription");
  assert.equal(body.session.audio.input.transcription.model, "gpt-live-transcribe");
  assert.equal(body.session.audio.input.turn_detection, null);
  assert.doesNotMatch(JSON.stringify(data), /private-key|configured-project/);
  assert.equal(h.prompts.length, 0); assert.equal(work.activeVoiceWork(), 1);
  assert.equal((await h.req("dictation-end", { token: data.token, confirmed: true })).status, 200);
  assert.equal(work.activeVoiceWork(), 0);
});

test("dictation sends actual MIME filename and never prompts Pi", async (t) => {
  const h = harness(t);
  const res = await h.req("transcribe", new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mp4" } });
  assert.deepEqual(await res.json(), { text: "typed words" });
  assert.equal(h.requests[0].options.body.get("file").name, "dictation.mp4");
  assert.equal(h.requests[0].options.body.get("file").type, "audio/mp4");
  assert.equal(h.requests[0].options.body.get("model"), "gpt-transcribe");
  assert.equal(h.requests[0].options.headers.get("accept"), "application/json");
  assert.equal(h.requests[0].options.headers.get("accept-encoding"), "identity");
  assert.equal(h.prompts.length, 0);
  assert.equal((await h.req("transcribe", "audio", { headers: { "content-type": "audio/ogg" } })).status, 400);
});

test("same-origin, bounded payload, blank transcript and secret upstream errors fail safely", async (t) => {
  const h = harness(t);
  assert.equal((await h.req("start", {}, { headers: { origin: "https://evil.invalid" } })).status, 403);
  assert.equal((await h.req("start", "x".repeat(80_001))).status, 413);
  globalThis.fetch = async () => new Response("private-key secret upstream", { status: 401 });
  let res = await h.req("transcribe", "a", { headers: { "content-type": "audio/webm" } });
  assert.equal(res.status, 502); assert.doesNotMatch(await res.text(), /private-key|secret upstream/);
  globalThis.fetch = async () => Response.json({ text: "  " });
  res = await h.req("transcribe", "a", { headers: { "content-type": "audio/webm" } });
  assert.equal(res.status, 502);
});

test("browser Host survives internal Next URL rewriting without admitting cross-site origins", async (t) => {
  const h = harness(t);
  for (const headers of [
    { origin: "" },
    { origin: "null" },
    { origin: "https://evil.invalid" },
    { origin: "http://127.0.0.1:30151", host: "127.0.0.1:30150" },
    { "sec-fetch-site": "cross-site" },
    { origin: "https://evil.invalid", host: "evil.invalid" },
  ]) assert.equal((await h.req("start", {}, { headers })).status, 403);
  assert.equal(h.requests.length, 0);
  const response = await h.req("transcribe", new Uint8Array([1]), {
    headers: { host: "127.0.0.1:30150", origin: "http://127.0.0.1:30150", "content-type": "audio/wav", "sec-fetch-site": "same-origin" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "typed words" });
});

test("delegation is idempotent; POST admission is not completion; matched final answer only", async (t) => {
  const h = harness(t); const call = await h.start();
  const handoff = { ...call, delegationId: "d1", text: "inspect only", leafId: "leaf" };
  await Promise.all([h.req("handoff", handoff), h.req("handoff", handoff)]); await tick();
  assert.equal(h.prompts.length, 1);
  let data = await (await h.req("poll", call)).json(); assert.equal(data.operation.status, "running"); assert.equal(data.operation.text, undefined);
  h.result().onComplete([{ message: { role: "user", content: h.prompts[0].message } }, { message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Checked" }] } }]);
  data = await (await h.req("poll", call)).json(); assert.equal(data.operation.text, "Checked");
  await h.req("handoff", handoff); assert.equal(h.prompts.length, 1);
  await h.req("end", { ...call, confirmed: true });
  assert.equal((await h.req("handoff", { ...handoff, delegationId: "d2" })).status, 409);
});

test("busy, branch changes, duplicate call starts and restart draining fail closed", async (t) => {
  const h = harness(t); const call = await h.start();
  assert.equal((await h.req("start", { sessionId: "pi-session", sdp: "v=0", leafId: "leaf" })).status, 409);
  h.setLeaf("new-leaf");
  assert.equal((await h.req("handoff", { ...call, delegationId: "d1", text: "do it", leafId: "leaf" })).status, 409);
  h.busy(); assert.equal((await h.req("handoff", { ...call, delegationId: "d2", text: "do it", leafId: "new-leaf" })).status, 409);
  h.drain(); assert.equal((await h.req("transcribe", "a", { headers: { "content-type": "audio/webm" } })).status, 502);
  assert.equal(h.prompts.length, 0);
});

test("start rate is bounded and unknown close conservatively blocks restart", async (t) => {
  const h = harness(t); const call = await h.start();
  await h.req("end", { ...call, confirmed: false }); assert.equal(work.activeVoiceWork(), 1);
  globalThis.__piVoiceStarts = Array(6).fill(Date.now());
  assert.equal((await h.req("transcribe", "a", { headers: { "content-type": "audio/webm" } })).status, 429);
});

test("revoking admission is immediate and independent of remote closure accounting", async (t) => {
  const h = harness(t), call = await h.start();
  await h.req("handoff", { ...call, delegationId: "d1", text: "inspect", leafId: "leaf" });
  assert.equal(h.result().isCurrent(), true);
  assert.equal((await h.req("revoke", call)).status, 200);
  assert.equal(h.result().isCurrent(), false);
  assert.equal(h.prompts.length, 1, "Already accepted work is not aborted or replayed");
  assert.equal((await h.req("handoff", { ...call, delegationId: "d2", text: "new", leafId: "leaf" })).status, 409);
  assert.equal(work.activeVoiceWork(), 1, "Remote close has not been confirmed");
  await h.req("end", { ...call, confirmed: true });
  assert.equal(work.activeVoiceWork(), 0);
});

test("admission expiry keeps restart protection through the remote drain interval", async (t) => {
  const now = Date.now; let clock = now(); Date.now = () => clock; t.after(() => { Date.now = now; });
  const h = harness(t), call = await h.start();
  clock += protocol.VOICE_CALL_MS;
  assert.equal((await h.req("poll", call)).status, 409);
  assert.equal(work.activeVoiceWork(), 1);
  clock += 16_000;
  assert.equal(work.activeVoiceWork(), 1, "The later browser deadline/drain must still be protected");
  assert.equal((await h.req("end", { ...call, confirmed: true })).status, 200);
  assert.equal(work.activeVoiceWork(), 0);
});

test("an unknown expired close stays protected only until its conservative retention deadline", async (t) => {
  const now = Date.now; let clock = now(); Date.now = () => clock; t.after(() => { Date.now = now; });
  const h = harness(t), call = await h.start();
  clock += protocol.VOICE_CALL_MS;
  await h.req("poll", call);
  clock += 16_000; assert.equal(work.activeVoiceWork(), 1);
  clock += 90_000; assert.equal(work.activeVoiceWork(), 0);
});

for (const stage of ["runtime", "auth", "path", "wrapper"]) test(`aborted ${stage} initialization settles the route but retains unresolved work`, { timeout: 1000 }, async (t) => {
  const h = harness(t), gate = Promise.withResolvers(), controller = new AbortController();
  let value;
  if (stage === "runtime") {
    value = await h.mocks["./model-runtime"].getModelRuntimeWithExtensions();
    h.mocks["./model-runtime"].getModelRuntimeWithExtensions = () => gate.promise;
  } else if (stage === "auth") {
    const runtime = await h.mocks["./model-runtime"].getModelRuntimeWithExtensions(); value = await runtime.getAuth();
    runtime.getAuth = () => gate.promise;
    h.mocks["./model-runtime"].getModelRuntimeWithExtensions = async () => runtime;
  } else if (stage === "path") {
    value = "/tmp/fake-session.jsonl"; h.mocks["./session-reader"].resolveSessionPath = () => gate.promise;
  } else {
    value = await h.mocks["./rpc-manager"].startRpcSession();
    h.mocks["./rpc-manager"].getRpcSession = () => undefined;
    h.mocks["./rpc-manager"].startRpcSession = () => gate.promise;
  }
  t.after(() => gate.resolve(value));
  const pending = h.req("start", { sessionId: "pi-session", sdp: "v=0", leafId: "leaf" }, { signal: controller.signal });
  await tick(); controller.abort();
  assert.equal((await pending).status, 502);
  assert.equal(work.activeVoiceWork(), 1, "Cancellation does not prove underlying initialization stopped");
  assert.equal(h.requests.length, 0);
  gate.resolve(value); await tick();
  assert.equal(work.activeVoiceWork(), 0); assert.equal(h.requests.length, 0, "A late initialization must not make a paid request");
});

test("invalid start does not leak a work hold", async (t) => {
  const h = harness(t);
  assert.equal((await h.req("start", {})).status, 400); assert.equal(work.activeVoiceWork(), 0);
});

test("aborted streamed body releases its reader without consuming further data", async (t) => {
  const h = harness(t), controller = new AbortController(); let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const pending = h.exports.boundedVoiceBody(body, 10, controller.signal);
  controller.abort(); await assert.rejects(pending); assert.equal(cancelled, true);
});
