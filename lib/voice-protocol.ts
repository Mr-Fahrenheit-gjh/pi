/** Client/server voice limits; no credentials or SDK objects cross this boundary. */
export const VOICE_AUDIO_BYTES = 12_000_000;
export const VOICE_RECORD_MS = 120_000;
export const VOICE_CALL_MS = 20 * 60_000;
export const VOICE_TEXT_LIMIT = 12_000;
export const audioExtension = (mime: string): string | undefined => ({
  "audio/webm": "webm", "audio/mp4": "mp4", "audio/wav": "wav", "audio/mpeg": "mp3",
}[mime.toLowerCase().split(";")[0].trim()]);

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function publicText(message: unknown): string {
  const m = record(message);
  if (m.role !== "user" && m.role !== "assistant") return "";
  if (typeof m.content === "string") return m.content.slice(0, VOICE_TEXT_LIMIT);
  return Array.isArray(m.content) ? m.content.filter((b) => record(b).type === "text")
    .map((b) => typeof record(b).text === "string" ? record(b).text : "").join("").slice(0, VOICE_TEXT_LIMIT) : "";
}
export function voiceContext(entries: unknown[]): string {
  return entries.map((e) => record(e).message).filter((m) => ["user", "assistant"].includes(String(record(m).role)))
    .slice(-12).map((m) => `${record(m).role}: ${publicText(m)}`).join("\n").slice(-VOICE_TEXT_LIMIT);
}
/** Reject a later keyboard/notification turn; never read thinking, tools or partial/error answers. */
export function voiceFinalAnswer(entries: unknown[], prompt: string): string | null {
  let user = -1;
  entries.forEach((entry, i) => { if (record(record(entry).message).role === "user") user = i; });
  if (user < 0 || publicText(record(entries[user]).message) !== prompt) return null;
  const tail = entries.slice(user + 1).map((e) => record(e).message).filter(Boolean);
  if (tail.some((m) => !["assistant", "toolResult", "system"].includes(String(record(m).role)))) return null;
  const last = record(tail.at(-1));
  if (last.role !== "assistant" || last.stopReason !== "stop") return null;
  return publicText(last).trim() || null;
}

export interface VoiceFragment { id: string; role: "user" | "assistant"; start: number; end: number; text: string }
export class VoiceTranscript {
  fragments: VoiceFragment[] = [];
  private seen = new Set<string>();
  add(event: Record<string, unknown>): void {
    const role = event.type === "session.input_transcript.delta" ? "user" : event.type === "session.output_transcript.delta" ? "assistant" : null;
    if (!role || typeof event.event_id !== "string" || this.seen.has(event.event_id)
      || typeof event.delta !== "string" || typeof event.start_ms !== "number" || typeof event.end_ms !== "number"
      || !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms) || event.start_ms < 0 || event.end_ms < event.start_ms) return;
    // Bound the entire call rather than evict dedupe IDs and replay old speech.
    if (this.seen.size >= 4000) throw new Error("transcript-limit");
    this.seen.add(event.event_id);
    this.fragments.push({ id: event.event_id, role, start: event.start_ms, end: event.end_ms, text: event.delta.slice(0, 2000) });
    this.fragments.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  }
  text(role: VoiceFragment["role"]): string { return this.fragments.filter((f) => f.role === role).map((f) => f.text).join("").slice(-VOICE_TEXT_LIMIT); }
  task(after: number, offset: number): string {
    return this.fragments.filter((f) => f.role === "user" && f.end > after && f.end <= offset)
      .map((f) => f.text).join("").trim().slice(0, 4000);
  }
}
/** UTF-8 bytes upper-bound BPE tokens; each event stays below the documented 500-token limit. */
export function commentaryChunks(text: string): string[] {
  const chunks: string[] = []; let chunk = "", bytes = 0;
  for (const char of text.slice(0, VOICE_TEXT_LIMIT)) {
    const size = new TextEncoder().encode(char).length;
    if (bytes + size > 480) { chunks.push(chunk); chunk = ""; bytes = 0; }
    chunk += char; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export class VoiceOperationLedger<T> {
  private operations = new Map<string, T>();
  get(id: string): T | undefined { return this.operations.get(id); }
  claim(id: string, create: () => T): T {
    const previous = this.operations.get(id);
    if (previous !== undefined) return previous;
    if (this.operations.size >= 40) throw new Error("operation-limit");
    const value = create(); this.operations.set(id, value); return value;
  }
}
