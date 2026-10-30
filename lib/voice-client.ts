import { commentaryChunks, record, VoiceTranscript, VOICE_CALL_MS } from "./voice-protocol";
import { RealtimeDictation } from "./voice-dictation";

export interface VoiceView {
  mode: "idle" | "permission" | "recording" | "paused" | "transcribing" | "connecting" | "live" | "delegating" | "ending" | "error";
  notice: string; muted: boolean; audioBlocked: boolean; seconds: number; usage?: number; finalUsage: boolean;
  user: string; assistant: string; levels: number[]; task?: { id: string; text: string }; operation?: string;
}
const initial = (): VoiceView => ({ mode: "idle", notice: "", muted: false, audioBlocked: false, seconds: 0, finalUsage: false, user: "", assistant: "", levels: [] });
interface Call {
  peer: RTCPeerConnection; channel: RTCDataChannel; audio: HTMLAudioElement; stream: MediaStream;
  started: boolean; closing: boolean; sessionId: string; token?: string; liveId?: string; leafId?: string;
  transcript: VoiceTranscript; delegations: Set<string>; completed: Set<string>; offset: number;
  timers: Set<ReturnType<typeof setTimeout>>; abort: AbortController; polling: boolean;
  pendingMute?: string; operationId?: string; startedAt: number;
}

/** Safari 16.2 has AbortController, but not AbortSignal.any/timeout. Dispose listeners and timers. */
async function voiceJson(url: string, init: RequestInit, owner: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (owner.aborted) abort(); else owner.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 65_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, data: record(await response.json()) };
  } finally { clearTimeout(timer); owner.removeEventListener("abort", abort); }
}

/** Owns every media resource. One instance per composer identity, never a global microphone. */
export class VoiceClient {
  view = initial();
  private generation = 0;
  private busy = false;
  private stream?: MediaStream;
  private dictation?: RealtimeDictation;
  private call?: Call;
  private meter?: { context: AudioContext; source: MediaStreamAudioSourceNode; analyser: AnalyserNode; frame: number };
  constructor(private changed: (view: VoiceView) => void, private updateDraft: (id: string, text: string) => void) {}
  private update(patch: Partial<VoiceView>) { this.view = { ...this.view, ...patch }; this.changed(this.view); }
  private fail(error: unknown) {
    this.update({ mode: "error", notice: error instanceof DOMException && error.name === "NotAllowedError" ? "permissionDenied" : error instanceof Error && error.message === "unsupported" ? "unsupported" : "failed" });
  }
  private supported(rtc: boolean) {
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia || (rtc ? typeof RTCPeerConnection === "undefined" : typeof MediaRecorder === "undefined")) throw new Error("unsupported");
  }
  private startMeter(stream: MediaStream) {
    // Optional, local-only analysis of the already-owned microphone. No destination
    // connection (feedback), extra capture, synthetic movement or audio upload.
    const AudioContextClass = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass || typeof requestAnimationFrame !== "function") return;
    let context: AudioContext | undefined, source: MediaStreamAudioSourceNode | undefined, analyser: AnalyserNode | undefined;
    try {
      context = new AudioContextClass(); source = context.createMediaStreamSource(stream); analyser = context.createAnalyser();
      analyser.fftSize = 512; source.connect(analyser);
      const meter = this.meter = { context, source, analyser, frame: 0 };
      const data = new Uint8Array(analyser.fftSize); let sampledAt = -Infinity;
      const sample = (now: number) => {
        if (this.meter !== meter) return;
        if (now - sampledAt >= 70) {
          sampledAt = now;
          meter.analyser.getByteTimeDomainData(data);
          const audible = stream.getAudioTracks().some((track) => track.enabled && !track.muted);
          const levels = Array.from({ length: 24 }, (_, index) => {
            let sum = 0;
            const start = Math.floor(index * data.length / 24), end = Math.floor((index + 1) * data.length / 24);
            for (let i = start; i < end; i++) sum += ((data[i] - 128) / 128) ** 2;
            return audible ? Math.min(1, Math.sqrt(sum / (end - start)) * 4) : 0;
          });
          this.update({ levels });
        }
        meter.frame = requestAnimationFrame(sample);
      };
      if (context.state === "suspended") void context.resume().catch(() => {});
      meter.frame = requestAnimationFrame(sample);
    } catch {
      source?.disconnect(); analyser?.disconnect();
      if (context) void context.close().catch(() => {});
      this.meter = undefined; // Meter failure must not fail recording or a call.
    }
  }
  private stopMeter() {
    const meter = this.meter; this.meter = undefined;
    if (!meter) return;
    cancelAnimationFrame(meter.frame); meter.source.disconnect(); meter.analyser.disconnect();
    void meter.context.close().catch(() => {});
    this.update({ levels: [] });
  }
  private stopTracks() { this.stream?.getTracks().forEach((t) => t.stop()); this.stream = undefined; }
  private clearRecording() {
    this.dictation?.close(); this.dictation = undefined;
    this.stopMeter(); this.stopTracks();
  }
  cancel() {
    ++this.generation; this.clearRecording();
    if (this.call) { this.hangup(); return; }
    this.busy = false; this.update({ mode: "idle", notice: "" });
  }
  async dictate() {
    if (this.dictation && this.view.mode === "paused") { await this.dictation.start(); return; }
    if (this.busy) return;
    this.busy = true; ++this.generation;
    this.update({ ...initial(), mode: "permission" });
    const owned = new RealtimeDictation({
      mode: (mode) => { if (this.dictation === owned) this.update({ mode }); },
      transcript: (id, text) => { if (this.dictation === owned) this.updateDraft(id, text); },
      capture: (stream) => { this.stopMeter(); if (stream) this.startMeter(stream); },
      error: (error) => { if (this.dictation === owned) { this.dictation = undefined; this.busy = false; this.fail(error); } },
    });
    this.dictation = owned;
    await owned.start();
  }
  stopDictation() { this.dictation?.pause(); }
  private timer(call: Call, fn: () => void, ms: number) {
    const id = setTimeout(() => { call.timers.delete(id); fn(); }, ms); call.timers.add(id); return id;
  }
  private send(call: Call, message: Record<string, unknown>): boolean {
    if (!call.started || call.channel.readyState !== "open") return false;
    try { call.channel.send(JSON.stringify({ event_id: crypto.randomUUID(), ...message })); return true; } catch { return false; }
  }
  private async api(action: string, call: Call, body: Record<string, unknown> = {}, signal = call.abort.signal) {
    const { response, data } = await voiceJson(`/api/voice/${action}`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: call.token, liveId: call.liveId, sessionId: call.sessionId, ...body }),
      keepalive: action === "end" || action === "revoke" }, signal);
    if (!response.ok) throw Object.assign(new Error(typeof data.error === "string" ? data.error : "voice-failed"), { refused: response.status >= 400 && response.status < 500 });
    return data;
  }
  async startCall(sessionId: string, leafId?: string | null) {
    if (this.busy || !sessionId) return;
    this.busy = true; const generation = ++this.generation;
    this.update({ ...initial(), mode: "connecting" });
    let call: Call | undefined;
    try {
      this.supported(true);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== this.generation) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.stream = stream;
      const peer = new RTCPeerConnection(); const audio = new Audio(); audio.autoplay = true;
      const channel = peer.createDataChannel("oai-events");
      call = { peer, channel, audio, stream, started: false, closing: false, sessionId, transcript: new VoiceTranscript(),
        delegations: new Set(), completed: new Set(), offset: -1, timers: new Set(), abort: new AbortController(), polling: false, startedAt: Date.now() };
      this.call = call; this.stream = undefined;
      this.startMeter(stream);
      const owned = call;
      // Include ICE and the upstream start request in the connection deadline.
      this.timer(call, () => { if (!owned.started) this.hangup("connectTimeout"); }, 20_000);
      this.timer(call, () => this.hangup("limit"), VOICE_CALL_MS);
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio.play().catch(() => { if (this.call === owned && !owned.closing) this.update({ audioBlocked: true }); });
      };
      channel.onmessage = (event) => {
        if (typeof event.data !== "string" || event.data.length > 80_000 || this.call !== owned) return;
        try { this.event(owned, record(JSON.parse(event.data))); } catch { this.hangup("failed"); }
      };
      channel.onclose = () => { if (this.call === owned) this.releaseCall(owned, false, "disconnected"); };
      peer.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(peer.connectionState) && this.call === owned) this.hangup("disconnected");
      };
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      await peer.setLocalDescription(await peer.createOffer());
      if (this.call !== call || call.closing) return;
      await this.waitIce(call);
      if (this.call !== call || call.closing) return;
      const data = await this.api("start", call, { sdp: peer.localDescription?.sdp, leafId });
      if (typeof data.token !== "string" || typeof data.liveId !== "string" || typeof data.sdp !== "string" || typeof data.leafId !== "string") throw new Error("invalid-answer");
      call.token = data.token; call.liveId = data.liveId; call.leafId = data.leafId;
      if (this.call !== call || call.closing) { void this.api("end", call, { confirmed: false }, new AbortController().signal).catch(() => {}); return; }
      await peer.setRemoteDescription({ type: "answer", sdp: data.sdp });
      void this.poll(call);
    } catch (error) {
      if (call && this.call === call) this.releaseCall(call, false, "unknownUsage");
      else if (generation === this.generation) { this.clearRecording(); this.busy = false; this.fail(error); }
    }
  }
  private waitIce(call: Call): Promise<void> {
    if (call.peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer); call.timers.delete(timer); call.peer.removeEventListener("icegatheringstatechange", change);
        call.abort.signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      };
      const change = () => { if (call.peer.iceGatheringState === "complete") done(); };
      const abort = () => done(new Error("cancelled"));
      const timer = this.timer(call, () => done(new Error("ice-timeout")), 10_000);
      call.peer.addEventListener("icegatheringstatechange", change);
      call.abort.signal.addEventListener("abort", abort, { once: true });
      change();
    });
  }
  private event(call: Call, event: Record<string, unknown>) {
    if (event.type === "session.closed") {
      const seconds = record(event.usage).seconds;
      const valid = typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0;
      this.update({ usage: valid ? seconds : undefined });
      this.releaseCall(call, true, valid ? "ended" : "unknownUsage"); return;
    }
    if (event.type === "session.started") {
      if (call.started) return;
      call.started = true; call.startedAt = Date.now();
      if (call.closing) { this.send(call, { type: "session.close" }); return; }
      this.update({ mode: "live" });
      const tick = () => { if (this.call !== call || call.closing) return; this.update({ seconds: Math.floor((Date.now() - call.startedAt) / 1000) }); this.timer(call, tick, 1000); };
      tick(); return;
    }
    if (call.closing || !call.started) return;
    if (event.type === "session.usage.updated") {
      const seconds = record(event.usage).seconds;
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) this.update({ usage: seconds });
    } else if (event.type === "session.input_transcript.delta" || event.type === "session.output_transcript.delta") {
      call.transcript.add(event);
      this.update({ user: call.transcript.text("user"), assistant: call.transcript.text("assistant") });
    } else if (event.type === "session.delegation.created") {
      const delegation = record(event.delegation);
      if (typeof delegation.id !== "string" || delegation.id.length > 200 || delegation.target !== "client" || call.delegations.has(delegation.id)) return;
      if (call.delegations.size >= 40) { this.hangup("limit"); return; }
      call.delegations.add(delegation.id);
      if (this.view.task || this.view.mode === "delegating" || typeof event.offset_ms !== "number" || !Number.isFinite(event.offset_ms)) {
        this.send(call, { type: "session.commentary.append", delegation_id: delegation.id, content: "Pi handoff deferred: another handoff is pending. No new work was submitted." }); return;
      }
      const task = call.transcript.task(call.offset, event.offset_ms);
      call.offset = Math.max(call.offset, event.offset_ms);
      // Even an empty/late transcript requires the user to fill and confirm, never executes automatically.
      this.update({ task: { id: delegation.id, text: task }, notice: "review" });
    } else if (event.type === "session.input_audio.muted" || event.type === "session.input_audio.unmuted") {
      if (event.client_event_id === call.pendingMute) { call.pendingMute = undefined; this.update({ notice: "" }); }
    } else if (event.type === "error" || event.type === "session.error") {
      this.update({ notice: "protocolError" });
    }
  }
  dismissNotice() { this.update({ notice: "" }); }
  editTask(text: string) { if (this.view.task) this.update({ task: { ...this.view.task, text: text.slice(0, 4000) } }); }
  dismissTask() {
    if (this.call && this.view.task) this.send(this.call, { type: "session.commentary.append", delegation_id: this.view.task.id, content: "The user declined this handoff. No Pi work was submitted." });
    this.update({ task: undefined, notice: "" });
  }
  async handoff() {
    const call = this.call, task = this.view.task;
    if (!call || call.closing || !call.started || !task?.text.trim() || this.view.mode === "delegating") return;
    call.operationId = task.id;
    this.update({ mode: "delegating", task: undefined, operation: "admitting", notice: "" });
    try {
      const data = await this.api("handoff", call, { delegationId: task.id, text: task.text, leafId: call.leafId });
      if (this.call === call && !call.closing) this.operation(call, record(data.operation));
    } catch (error) {
      if (this.call === call && !call.closing) {
        if (record(error).refused === true) {
          call.completed.add(task.id);
          this.send(call, { type: "session.commentary.append", delegation_id: task.id, content: "Pi is busy or this request is stale. No new work was accepted; do not retry automatically." });
          this.update({ mode: "live", notice: "handoffRefused", operation: "rejected" });
        } else this.update({ notice: "handoffUnknown", operation: "unknown" });
      }
      // Keep polling the exact operation; never resend an ambiguous admission.
    }
  }
  private operation(call: Call, operation: Record<string, unknown>) {
    if (typeof operation.id !== "string" || operation.id !== call.operationId || !call.delegations.has(operation.id)) return;
    const status = String(operation.status);
    this.update({ operation: status });
    if (["completed", "unavailable", "rejected"].includes(status)) {
      if (call.completed.has(operation.id)) return;
      call.completed.add(operation.id);
      if (typeof operation.leafId === "string") call.leafId = operation.leafId;
      const text = status === "completed" && typeof operation.text === "string" ? operation.text : "Pi did not return a safely matched final answer. Check the Pi conversation; do not repeat the operation automatically.";
      for (const content of commentaryChunks(text)) this.send(call, { type: "session.commentary.append", delegation_id: operation.id, content });
      this.update({ mode: "live", notice: status === "completed" ? "completed" : "handoffRefused" });
    }
  }
  private async poll(call: Call) {
    if (this.call !== call || call.closing || call.polling) return;
    call.polling = true;
    try {
      const data = await this.api("poll", call);
      if (this.call === call && !call.closing && data.operation) this.operation(call, record(data.operation));
    } catch { if (this.call === call && !call.closing) this.hangup("disconnected"); }
    finally { call.polling = false; if (this.call === call && !call.closing) this.timer(call, () => { void this.poll(call); }, 2500); }
  }
  mute() {
    const call = this.call; if (!call?.started || call.closing) return;
    const muted = !this.view.muted;
    call.stream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    const id = crypto.randomUUID(); call.pendingMute = id;
    this.send(call, { type: muted ? "session.input_audio.mute" : "session.input_audio.unmute", event_id: id });
    this.update({ muted, notice: "mutePending" });
  }
  async playAudio() {
    try { await this.call?.audio.play(); this.update({ audioBlocked: false }); }
    catch { this.update({ audioBlocked: true }); }
  }
  hangup(notice = "") {
    const call = this.call;
    if (!call) { this.cancel(); return; }
    if (call.closing) return;
    this.stopMeter();
    call.closing = true; call.stream.getTracks().forEach((track) => { track.enabled = false; track.stop(); });
    call.audio.muted = true;
    // Admission revocation must not wait for the remote close/usage drain.
    if (call.token) void this.api("revoke", call, {}, new AbortController().signal).catch(() => {});
    this.update({ mode: "ending", task: undefined, notice });
    this.send(call, { type: "session.close" });
    if (!call.started) call.abort.abort();
    this.timer(call, () => this.releaseCall(call, false, notice || "unknownUsage"), 15_000);
  }
  private releaseCall(call: Call, confirmed: boolean, notice: string) {
    if (this.call !== call) return;
    this.stopMeter();
    this.call = undefined; call.closing = true; call.abort.abort();
    call.timers.forEach(clearTimeout); call.timers.clear();
    call.stream.getTracks().forEach((track) => track.stop());
    call.channel.onmessage = null; call.channel.onclose = null; call.peer.ontrack = null; call.peer.onconnectionstatechange = null;
    call.channel.close(); call.peer.close(); call.audio.pause(); call.audio.srcObject = null;
    if (call.token) void this.api("end", call, { confirmed }, new AbortController().signal).catch(() => {});
    this.busy = false;
    this.update({ mode: confirmed ? "idle" : "error", finalUsage: confirmed && this.view.usage !== undefined, task: undefined,
      notice: confirmed ? notice : "unknownUsage" });
  }
}
