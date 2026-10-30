import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const { RealtimeDictation, VoiceDraft } = await createJiti(import.meta.url).import('./voice-dictation.ts');
const tick = () => new Promise(setImmediate);
function harness(t, options = {}) {
  const saved = new Map(), sockets = [], tracks = [], contexts = [], nodes = [], requests = [], modes = [];
  const set = (key, value) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value, writable: true }); };
  t.after(() => { for (const [key, desc] of saved) { if (desc) Object.defineProperty(globalThis, key, desc); else delete globalThis[key]; } });
  set('isSecureContext', true);
  set('navigator', { mediaDevices: { getUserMedia: async () => { const track = { stopped: false, stop() { this.stopped = true; } }; tracks.push(track); return { getTracks: () => [track] }; } } });
  set('AudioContext', class { sampleRate = 24000; state = 'running'; destination = {}; audioWorklet = { addModule: async () => {} }; constructor() { contexts.push(this); } createMediaStreamSource() { return { connect() {}, disconnect() {} }; } resume() { return Promise.resolve(); } close() { this.state = 'closed'; return Promise.resolve(); } });
  set('AudioWorkletNode', class { constructor() { nodes.push(this); this.port = { postMessage: () => this.port.onmessage?.({ data: { type: 'flushed' } }), onmessage: null, close() {} }; } connect() {} disconnect() {} });
  set('WebSocket', class { readyState = 0; bufferedAmount = 0; sent = []; constructor(url, protocols) { this.url = url; this.protocols = protocols; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); queueMicrotask(() => this.event({ type: 'session.updated' })); }); } send(text) { this.sent.push(JSON.parse(text)); } event(data) { this.onmessage?.({ data: JSON.stringify(data) }); } close() { this.readyState = 3; this.onclose?.({ wasClean: true }); } });
  set('fetch', async (url, init) => { requests.push({ url, options: init }); if (url.endsWith('dictation-start') && options.start) return options.start(); return Response.json(url.endsWith('dictation-start') ? { secret: 'ek_short', token: 'local-token' } : { ended: true }); });
  const edits = [], draft = new VoiceDraft(); let value = 'existing';
  const client = new RealtimeDictation({ mode: (mode) => modes.push(mode), transcript: (id, text) => { edits.push({ id, text }); value = draft.update(value, id, text); }, capture() {}, error: (e) => { throw e; } });
  t.after(() => client.close());
  return { client, sockets, tracks, contexts, nodes, requests, modes, edits, value: () => value };
}

test('dictation streams text before pause, reconciles final by item without duplicate or Pi execution', async (t) => {
  const h = harness(t); await h.client.start();
  const socket = h.sockets[0]; assert.equal(socket.url, 'wss://api.openai.com/v1/realtime?intent=transcription');
  assert.deepEqual(socket.protocols, ['realtime', 'openai-insecure-api-key.ek_short']);
  assert.equal(socket.sent[0].session.audio.input.transcription.model, 'gpt-live-transcribe');
  socket.event({ type: 'conversation.item.input_audio_transcription.delta', event_id: 'e1', item_id: 'a', content_index: 0, delta: '你好' });
  assert.equal(h.value(), 'existing 你好'); assert.equal(h.tracks[0].stopped, false);
  socket.event({ type: 'conversation.item.input_audio_transcription.delta', event_id: 'e1', item_id: 'a', content_index: 0, delta: '你好' });
  socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', content_index: 0, transcript: '你好。' });
  assert.equal(h.value(), 'existing 你好。');
  assert.ok(h.requests.every((r) => !/handoff|transcribe$|agent/.test(r.url)));
});

test('pause stops the microphone immediately; resume reacquires it and keeps the draft', async (t) => {
  const h = harness(t); await h.client.start();
  h.nodes[0].port.onmessage({ data: { type: 'audio', samples: new Int16Array(2400).buffer } });
  h.client.pause(); assert.equal(h.tracks[0].stopped, true); assert.equal(h.modes.at(-1), 'paused');
  await tick(); assert.equal(h.sockets[0].sent.at(-1).type, 'input_audio_buffer.commit');
  await h.client.start(); assert.equal(h.tracks.length, 2); assert.equal(h.tracks[1].stopped, false); assert.equal(h.sockets.length, 1);
  h.client.close(); assert.equal(h.tracks[1].stopped, true); assert.equal(h.contexts[1].state, 'closed');
  const before = h.value(); h.sockets[0].event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'late', delta: 'stale' }); assert.equal(h.value(), before);
});

test('pause during a slow token request stops capture immediately and discards a late connection', async (t) => {
  const pending = Promise.withResolvers(); const h = harness(t, { start: () => pending.promise });
  const start = h.client.start(); await tick();
  assert.equal(h.tracks[0].stopped, false);
  h.client.pause(); assert.equal(h.tracks[0].stopped, true);
  pending.resolve(Response.json({ secret: 'ek_late', token: 'late-token' })); await start;
  assert.equal(h.sockets.length, 0); assert.equal(h.modes.at(-1), 'paused');
  assert.ok(h.requests.some((r) => r.url.endsWith('dictation-end') && JSON.parse(r.options.body).token === 'late-token'));
});

test('PCM worklet downmixes and resamples to signed little-endian 24kHz without feedback', () => {
  const source = readFileSync(new URL('../public/voice-pcm-worklet.js', import.meta.url), 'utf8');
  for (const rate of [24000, 48000, 44100]) {
    const messages = []; let Processor;
    vm.runInNewContext(source, {
      sampleRate: rate,
      AudioWorkletProcessor: class { port = { postMessage: (value) => messages.push(value) }; },
      registerProcessor: (_name, ctor) => { Processor = ctor; },
    });
    const processor = new Processor();
    const input = new Float32Array(rate / 10).fill(0.5), output = new Float32Array(128);
    processor.process([[input, input]], [[output]]); processor.port.onmessage({ data: { type: 'flush' } });
    const audio = messages.filter((m) => m.type === 'audio');
    assert.equal(audio.reduce((n, m) => n + m.samples.byteLength / 2, 0), 2400);
    assert.equal(new DataView(audio[0].samples).getInt16(0, true), 16384);
    assert.ok(output.every((n) => n === 0)); assert.equal(messages.at(-1).type, 'flushed');
  }
});

test('reversed final transcripts retain separators between initially empty reserved items', () => {
  for (const existing of ['', 'draft ']) {
    const draft = new VoiceDraft(); let value = draft.update(existing, 'a', '');
    value = draft.update(value, 'b', ''); value = draft.update(value, 'b', 'second');
    value = draft.update(value, 'a', 'first'); assert.equal(value, existing + 'first second');
  }
});

test('owned draft ranges correct earlier phrases without overwriting later words or user edits', () => {
  const d = new VoiceDraft(); let value = d.update('draft', 'a', 'one'); value = d.update(value, 'b', 'two');
  value = d.update(value, 'a', 'ONE!'); assert.equal(value, 'draft ONE! two');
  value = d.update(value, 'b', 'TWO'); assert.equal(value, 'draft ONE! TWO');
  value = value.replace('ONE!', 'user'); assert.equal(d.update(value, 'a', 'overwrite'), value);
});
