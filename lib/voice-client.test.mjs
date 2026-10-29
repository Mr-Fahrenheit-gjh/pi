import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { VoiceClient } = await createJiti(import.meta.url).import("./voice-client.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness(t, options = {}) {
  const saved = new Map();
  const set = (key, value) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const tracks = [], requests = [], peers = [], recorders = [], views = [];
  let captures = 0, draft = "existing ", operation = null;
  function stream() { const track = { enabled: true, stopped: false, stop() { this.stopped = true; } }; tracks.push(track); return { getTracks: () => [track], getAudioTracks: () => [track] }; }
  set("isSecureContext", true);
  set("navigator", { mediaDevices: { getUserMedia: () => { captures++; return options.permission?.() ?? Promise.resolve(stream()); } } });
  set("MediaRecorder", class {
    static isTypeSupported(type) { return type === "audio/mp4"; }
    state = "inactive"; mimeType = "audio/mp4";
    constructor() { recorders.push(this); }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(["real bytes"], { type: this.mimeType }) }); this.onstop?.(); }); }
  });
  set("Audio", class { autoplay = false; srcObject = null; play() { return Promise.resolve(); } pause() {} });
  set("RTCPeerConnection", class extends EventTarget {
    iceGatheringState = "complete"; connectionState = "connected"; localDescription = null; closed = false; added = 0;
    constructor() { super(); peers.push(this); }
    createDataChannel(label) { assert.equal(label, "oai-events"); this.channel = { readyState: "open", sent: [], send(text) { this.sent.push(JSON.parse(text)); }, close() { this.readyState = "closed"; } }; return this.channel; }
    addTrack() { this.added++; }
    async createOffer() { assert.ok(this.channel.onmessage); assert.ok(this.ontrack); assert.equal(this.added, 1); return { type: "offer", sdp: "v=0\r\noffer" }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription(description) { assert.equal(description.type, "answer"); }
    close() { this.closed = true; }
  });
  set("fetch", async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("transcribe")) return options.transcribe?.() ?? Response.json({ text: "dictated" });
    if (url.endsWith("start")) return Response.json({ token: "nonce", liveId: "live_123", leafId: "leaf", sdp: "v=0\r\nanswer" });
    if (url.endsWith("handoff")) { const body = JSON.parse(init.body); operation = { id: body.delegationId, status: "running" }; return Response.json({ operation }); }
    if (url.endsWith("poll")) return Response.json({ operation });
    return Response.json({ ended: true });
  });
  const client = new VoiceClient((v) => views.push(v), (text) => { draft += text; });
  const event = (data) => peers[0]?.channel.onmessage?.({ data: JSON.stringify(data) });
  t.after(() => { client.cancel(); event({ type: "session.closed", usage: { seconds: 1 } }); });
  return { client, event, tracks, requests, peers, recorders, views, stream, captures: () => captures, draft: () => draft, edit: (value) => { draft = value; } };
}

test("dictation only appends to the latest draft after the last data event; no Pi prompt", async (t) => {
  const h = harness(t);
  await Promise.all([h.client.dictate(), h.client.dictate()]); assert.equal(h.captures(), 1);
  h.edit("edited while recording "); h.client.stopDictation(); await tick();
  assert.equal(h.draft(), "edited while recording dictated");
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, "/api/voice/transcribe");
  assert.equal(h.requests[0].init.body.type, "audio/mp4");
  assert.ok(h.tracks.every((t) => t.stopped));
});

test("permission arriving after owner navigation immediately stops all tracks", async (t) => {
  const permission = Promise.withResolvers(); const h = harness(t, { permission: () => permission.promise });
  const pending = h.client.dictate(); h.client.cancel(); permission.resolve(h.stream()); await pending;
  assert.ok(h.tracks.every((t) => t.stopped)); assert.equal(h.recorders.length, 0); assert.equal(h.requests.length, 0);
});

test("late transcription after send/navigation cannot touch the replacement draft", async (t) => {
  const transcription = Promise.withResolvers(); const h = harness(t, { transcribe: () => transcription.promise });
  await h.client.dictate(); h.client.stopDictation(); await tick();
  h.client.cancel(); h.edit("new session "); transcription.resolve(Response.json({ text: "stale" })); await tick();
  assert.equal(h.draft(), "new session "); assert.equal(h.client.view.mode, "idle");
});

test("Live registers channel/media before offer and never sends commands before started", async (t) => {
  const h = harness(t); await h.client.startCall("pi-session", "leaf");
  const channel = h.peers[0].channel;
  assert.deepEqual(channel.sent, []); h.client.mute(); assert.deepEqual(channel.sent, []);
  h.event({ type: "session.started" }); h.client.mute();
  assert.equal(channel.sent[0].type, "session.input_audio.mute"); assert.equal(h.tracks[0].enabled, false);
  h.client.hangup(); assert.equal(channel.sent.at(-1).type, "session.close"); assert.equal(h.peers[0].closed, false);
  h.event({ type: "session.closed", usage: { seconds: 12 } });
  assert.equal(h.peers[0].closed, true); assert.equal(h.tracks[0].stopped, true); assert.equal(h.client.view.usage, 12); assert.equal(h.client.view.finalUsage, true);
});

test("delegation subtitles require confirmation, repeated event/click cannot double execute", async (t) => {
  const h = harness(t); await h.client.startCall("pi-session"); h.event({ type: "session.started" });
  h.event({ type: "session.input_transcript.delta", event_id: "u1", delta: "inspect files", start_ms: 1, end_ms: 10 });
  const delegation = { type: "session.delegation.created", offset_ms: 12, delegation: { id: "d1", target: "client" } };
  h.event(delegation); h.event(delegation);
  assert.equal(h.client.view.task.text, "inspect files"); assert.equal(h.requests.filter((r) => r.url.endsWith("handoff")).length, 0);
  h.client.editTask("inspect without changes"); await Promise.all([h.client.handoff(), h.client.handoff()]);
  assert.equal(h.requests.filter((r) => r.url.endsWith("handoff")).length, 1);
  assert.equal(h.client.view.mode, "delegating");
  // Exercise the same matched polling reducer without waiting for its wall-clock poll timer.
  const call = h.client.call;
  h.client.operation(call, { id: "other", status: "completed", text: "wrong answer" });
  h.client.operation(call, { id: "d1", status: "completed", text: "Owned final answer", leafId: "new-leaf" });
  h.client.operation(call, { id: "d1", status: "completed", text: "Owned final answer" });
  const results = h.peers[0].channel.sent.filter((e) => e.type === "session.commentary.append");
  assert.equal(results.length, 1); assert.equal(results[0].delegation_id, "d1"); assert.equal(results[0].content, "Owned final answer");
  assert.equal(h.client.view.mode, "live");
  h.client.hangup(); h.event({ ...delegation, delegation: { id: "late", target: "client" } }); assert.equal(h.client.view.task, undefined);
});

test("hangup revokes pending admission before draining media; accepted Pi work is untouched", async (t) => {
  const h = harness(t); await h.client.startCall("pi-session"); h.event({ type: "session.started" });
  h.client.cancel();
  assert.equal(h.requests.filter((r) => r.url.endsWith("revoke")).length, 1);
  assert.equal(h.requests.filter((r) => r.url.endsWith("end")).length, 0);
  assert.equal(h.peers[0].closed, false); assert.equal(h.tracks[0].enabled, false);
  assert.equal(h.client.call.audio.muted, true);
  assert.ok(h.requests.every((r) => r.url.startsWith("/api/voice/")));
  h.event({ type: "session.closed", usage: { seconds: 1 } }); await tick();
  assert.equal(h.requests.filter((r) => r.url.endsWith("end")).length, 1);
});

test("dictation and Live work without AbortSignal.any or AbortSignal.timeout", async (t) => {
  for (const key of ["any", "timeout"]) {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, key);
    Object.defineProperty(AbortSignal, key, { configurable: true, value: undefined });
    t.after(() => Object.defineProperty(AbortSignal, key, descriptor));
  }
  const h = harness(t);
  await h.client.dictate(); h.client.stopDictation(); await tick();
  assert.equal(h.draft(), "existing dictated");
  await h.client.startCall("pi-session"); h.event({ type: "session.started" });
  assert.equal(h.client.view.mode, "live");
  h.client.cancel(); h.event({ type: "session.closed", usage: { seconds: 1 } });
  assert.ok(h.tracks.every((track) => track.stopped));
});

test("pending Live permission arriving after ownership loss is stopped without starting a call", async (t) => {
  const permission = Promise.withResolvers(); const h = harness(t, { permission: () => permission.promise });
  const pending = h.client.startCall("pi-session"); h.client.cancel(); permission.resolve(h.stream()); await pending;
  assert.ok(h.tracks.every((track) => track.stopped)); assert.equal(h.peers.length, 0); assert.equal(h.requests.length, 0);
});

test("recording ownership loss stops media without starting transcription", async (t) => {
  const h = harness(t); await h.client.dictate(); h.client.cancel(); await tick();
  assert.ok(h.tracks.every((track) => track.stopped)); assert.equal(h.requests.length, 0);
});

test("missing final usage never promotes an earlier usage snapshot to a final bill", async (t) => {
  const h = harness(t); await h.client.startCall("pi-session"); h.event({ type: "session.started" });
  h.event({ type: "session.usage.updated", usage: { seconds: 12 } }); h.event({ type: "session.usage.updated", usage: { seconds: 15 } });
  assert.equal(h.client.view.usage, 15);
  h.event({ type: "session.closed" }); assert.equal(h.client.view.finalUsage, false); assert.equal(h.client.view.notice, "unknownUsage");
});

test("disconnect releases media and reports unknown final usage, without retrying start", async (t) => {
  const h = harness(t); await h.client.startCall("pi-session"); h.event({ type: "session.started" });
  h.peers[0].channel.onclose(); await tick();
  assert.equal(h.client.view.notice, "unknownUsage"); assert.ok(h.tracks[0].stopped);
  assert.equal(h.requests.filter((r) => r.url.endsWith("start")).length, 1);
});
