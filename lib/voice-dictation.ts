import { record, VOICE_RECORD_MS } from "./voice-protocol";

/** Only revise text still owned by recognition; explicit user edits always win. */
export class VoiceDraft {
  private ranges = new Map<string, { start: number; text: string; content: string; edited: boolean }>();
  update(value: string, id: string, text: string): string {
    let owned = this.ranges.get(id);
    if (!owned) {
      owned = { start: value.length, text: "", content: "", edited: false };
      this.ranges.set(id, owned);
    }
    owned.content = text;
    // Earlier empty reservations can fill after later turns. Reconcile each still-owned
    // boundary in order, including its separator, instead of only shifting offsets.
    for (const range of this.ranges.values()) {
      if (range.edited || value.slice(range.start, range.start + range.text.length) !== range.text) {
        range.edited = true; continue;
      }
      const prefix = range.start > 0 && !/\s/.test(value[range.start - 1]) && !/^\s/.test(range.content) ? " " : "";
      const next = range.content ? prefix + range.content : "";
      const delta = next.length - range.text.length;
      value = value.slice(0, range.start) + next + value.slice(range.start + range.text.length);
      let later = false;
      for (const other of this.ranges.values()) {
        if (other === range) { later = true; continue; }
        if (other.start > range.start || (later && other.start === range.start)) other.start += delta;
      }
      range.text = next;
    }
    return value;
  }
}

interface Capture { stream: MediaStream; context: AudioContext; source: MediaStreamAudioSourceNode; node: AudioWorkletNode; finish: () => void }
interface Sink {
  mode: (mode: "permission" | "recording" | "paused") => void;
  transcript: (id: string, text: string) => void;
  capture: (stream?: MediaStream) => void;
  error: (error: unknown) => void;
}
const SESSION = { type: "transcription", audio: { input: {
  format: { type: "audio/pcm", rate: 24000 },
  transcription: { model: "gpt-live-transcribe", delay: "low" }, turn_detection: null,
} } };

/** Transcription only: no assistant, response.create, Pi prompt or execution path. */
export class RealtimeDictation {
  private generation = 0;
  private closed = false;
  private starting = false;
  private paused = true;
  private socket?: WebSocket;
  private token?: string;
  private capture?: Capture;
  private pendingStream?: MediaStream;
  private pendingContext?: AudioContext;
  private abort?: AbortController;
  private ready?: Promise<void>;
  private stopping: Promise<void> = Promise.resolve();
  private connectionTimer?: ReturnType<typeof setTimeout>;
  private limitTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private items = new Map<string, { text: string; done: boolean }>();
  private events = new Set<string>();
  private samples = 0;
  private prefix = crypto.randomUUID();
  constructor(private sink: Sink) {}
  async start() {
    if (this.closed || this.starting || !this.paused) return;
    const generation = ++this.generation; this.starting = true; this.paused = false;
    clearTimeout(this.idleTimer); this.sink.mode("permission");
    let stream: MediaStream | undefined, context: AudioContext | undefined;
    try {
      if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined" || typeof WebSocket === "undefined") throw new Error("unsupported");
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (generation !== this.generation || this.closed) return;
      this.pendingStream = stream;
      await this.stopping;
      if (generation !== this.generation || this.closed) return;
      if (!this.socket) this.ready = this.connect();
      await this.ready;
      if (generation !== this.generation || this.closed) return;
      const Context = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) throw new Error("unsupported");
      context = this.pendingContext = new Context({ sampleRate: 24000 });
      await context.audioWorklet.addModule("/voice-pcm-worklet.js");
      if (generation !== this.generation || this.closed) return;
      await context.resume();
      if (generation !== this.generation || this.closed) return;
      const node = new AudioWorkletNode(context, "pi-voice-pcm");
      const source = context.createMediaStreamSource(stream);
      const owned: Capture = { stream, context, source, node, finish: () => {} };
      this.capture = owned;
      node.port.onmessage = ({ data }) => {
        if (this.closed || this.capture !== owned) return;
        if (data.type === "flushed") { owned.finish(); return; }
        if (data.type !== "audio" || !(data.samples instanceof ArrayBuffer)) return;
        if (!this.socket || this.socket.readyState !== 1 || this.socket.bufferedAmount > 256_000) { this.fail(new Error("disconnected")); return; }
        const bytes = new Uint8Array(data.samples);
        if (!bytes.length || bytes.length > 12_000 || bytes.length % 2) return;
        let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
        this.send({ type: "input_audio_buffer.append", audio: btoa(binary) });
        this.samples += bytes.length / 2;
        if (this.samples >= 24000 * 15) this.commit();
      };
      source.connect(node); node.connect(context.destination); // Worklet emits silence, never microphone feedback.
      this.sink.capture(stream); this.sink.mode("recording");
      this.pendingStream = undefined; this.pendingContext = undefined;
      stream = undefined; context = undefined; // Ownership transferred to capture.
    } catch (error) { if (generation === this.generation && !this.closed) this.fail(error); }
    finally {
      stream?.getTracks().forEach((track) => track.stop());
      if (this.pendingStream === stream) this.pendingStream = undefined;
      if (context && context.state !== "closed") void context.close().catch(() => {});
      if (this.pendingContext === context) this.pendingContext = undefined;
      if (generation === this.generation) this.starting = false;
    }
  }
  private async connect() {
    this.abort = new AbortController();
    const abort = this.abort;
    this.connectionTimer = setTimeout(() => this.fail(new Error("connectTimeout")), 20_000);
    const response = await fetch("/api/voice/dictation-start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: abort.signal });
    const data = record(await response.json());
    // Even a late token must be released; never leak the main provider credential to this path.
    if (typeof data.token === "string" && abort.signal.aborted) { this.end(data.token); throw new Error("cancelled"); }
    if (!response.ok || typeof data.secret !== "string" || !data.secret.startsWith("ek_") || typeof data.token !== "string") throw new Error("not-configured");
    this.token = data.token;
    return new Promise<void>((resolve, reject) => {
      const socket = this.socket = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", ["realtime", "openai-insecure-api-key." + data.secret]);
      const cancel = () => reject(new Error("cancelled"));
      abort.signal.addEventListener("abort", cancel, { once: true });
      socket.onopen = () => { if (!this.closed) this.send({ type: "session.update", session: SESSION }); };
      socket.onmessage = ({ data }) => {
        if (this.closed || this.socket !== socket || typeof data !== "string" || data.length > 80_000) return;
        try {
          const event = record(JSON.parse(data));
          if (event.type === "session.updated") {
            clearTimeout(this.connectionTimer); abort.signal.removeEventListener("abort", cancel); resolve();
            this.limitTimer ??= setTimeout(() => this.fail(new Error("limit")), VOICE_RECORD_MS);
          } else if (event.type === "error" || event.type === "conversation.item.input_audio_transcription.failed") {
            reject(new Error("transcribe-failed")); this.fail(new Error("transcribe-failed"));
          } else this.transcript(event);
        } catch { reject(new Error("transcribe-failed")); this.fail(new Error("transcribe-failed")); }
      };
      socket.onerror = () => { reject(new Error("disconnected")); this.fail(new Error("disconnected")); };
      socket.onclose = () => {
        reject(new Error("disconnected"));
        if (this.closed || this.socket !== socket) return;
        this.fail(new Error("disconnected"));
      };
    });
  }
  private transcript(event: Record<string, unknown>) {
    const committed = event.type === "input_audio_buffer.committed";
    const delta = event.type === "conversation.item.input_audio_transcription.delta";
    const completed = event.type === "conversation.item.input_audio_transcription.completed";
    if (!committed && !delta && !completed) return;
    if (typeof event.item_id !== "string" || event.item_id.length > 200 || (event.content_index != null && event.content_index !== 0)) return;
    if (typeof event.event_id === "string") {
      if (this.events.has(event.event_id)) return;
      if (this.events.size >= 10_000) throw new Error("limit");
      this.events.add(event.event_id);
    }
    let item = this.items.get(event.item_id);
    if (!item) {
      if (this.items.size >= 128) throw new Error("limit");
      item = { text: "", done: false }; this.items.set(event.item_id, item);
    }
    if (item.done) return;
    if (delta && typeof event.delta === "string") item.text += event.delta;
    if (completed && typeof event.transcript === "string") { item.text = event.transcript; item.done = true; }
    if ([...this.items.values()].reduce((n, item) => n + item.text.length, 0) > 12_000) throw new Error("limit");
    this.sink.transcript(`${this.prefix}:${event.item_id}`, item.text);
  }
  private send(event: object) { if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(event)); }
  private commit() {
    if (!this.samples) return;
    // The API requires at least 100ms. Pad only a very short, explicitly paused tail.
    if (this.samples < 2400) this.send({ type: "input_audio_buffer.append", audio: btoa("\0".repeat((2400 - this.samples) * 2)) });
    this.send({ type: "input_audio_buffer.commit" }); this.samples = 0;
  }
  pause() {
    if (this.closed || this.paused) return;
    this.paused = true; this.starting = false; ++this.generation;
    this.pendingStream?.getTracks().forEach((track) => track.stop());
    if (this.pendingContext && this.pendingContext.state !== "closed") void this.pendingContext.close().catch(() => {});
    this.sink.capture(); this.sink.mode("paused");
    const capture = this.capture;
    if (capture) {
      capture.stream.getTracks().forEach((track) => track.stop()); capture.source.disconnect();
      this.stopping = new Promise<void>((resolve) => {
        const timer = setTimeout(() => capture.finish(), 200);
        capture.finish = () => {
          if (this.capture !== capture) return;
          clearTimeout(timer); if (!this.closed) this.commit(); this.capture = undefined;
          capture.node.port.onmessage = null; capture.node.port.close(); capture.node.disconnect();
          void capture.context.close().catch(() => {}); resolve();
        };
        capture.node.port.postMessage({ type: "flush" });
      });
    } else {
      this.abort?.abort(); this.closeSocket();
    }
    // Do not retain a remote idle session indefinitely. Resume opens a fresh one after this.
    this.idleTimer = setTimeout(() => { this.closeSocket(); }, 30_000);
  }
  private end(token: string, confirmed = true) {
    void fetch("/api/voice/dictation-end", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, confirmed }), keepalive: true }).catch(() => {});
  }
  private closeSocket() {
    const socket = this.socket, token = this.token; this.socket = undefined; this.token = undefined; this.ready = undefined;
    if (socket) {
      socket.onopen = null; socket.onmessage = null; socket.onerror = null;
      socket.onclose = (event) => { if (token) this.end(token, event.wasClean === true); };
      if (socket.readyState === 3) { socket.onclose = null; if (token) this.end(token, false); }
      else socket.close();
    } else if (token) this.end(token);
    clearTimeout(this.connectionTimer); clearTimeout(this.limitTimer); this.limitTimer = undefined;
    this.samples = 0;
  }
  close() {
    if (this.closed) return;
    this.closed = true; ++this.generation; this.abort?.abort();
    clearTimeout(this.idleTimer);
    this.pendingStream?.getTracks().forEach((track) => track.stop());
    if (this.pendingContext && this.pendingContext.state !== "closed") void this.pendingContext.close().catch(() => {});
    const capture = this.capture;
    if (capture) {
      capture.stream.getTracks().forEach((track) => track.stop()); capture.source.disconnect();
      capture.finish();
      capture.node.port.onmessage = null; capture.node.port.close(); capture.node.disconnect();
      void capture.context.close().catch(() => {}); this.capture = undefined;
    }
    this.sink.capture(); this.closeSocket();
  }
  private fail(error: unknown) { if (!this.closed) { this.close(); this.sink.error(error); } }
}
