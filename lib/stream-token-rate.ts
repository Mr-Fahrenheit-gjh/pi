/**
 * Where a streaming reply's tokens-per-second measurement starts: when its first
 * tokens showed, and how many there were. Kept per reply outside the message
 * view, because switching sessions remounts the chat, and a measurement started
 * over would divide every token streamed so far by the time since the remount.
 */
export interface StreamRateStart {
  at: number;
  tokens: number;
}

// A reply that finishes while its chat is not shown is never looked up again;
// only the newest few are kept.
const MAX_TRACKED_REPLIES = 32;
const starts = new Map<string, StreamRateStart>();

/** A streaming reply's identity: pi stamps its message when the request starts. */
export function streamRateKey(message: { provider?: string; model?: string; timestamp?: number }, projection = "all"): string | null {
  if (typeof message.timestamp !== "number") return null;
  return `${message.provider ?? ""}/${message.model ?? ""}@${message.timestamp}:${projection}`;
}

export function streamRateStart(key: string | null, tokens: number, now: number): StreamRateStart {
  const known = key === null ? undefined : starts.get(key);
  if (known) return known;
  // Joining a reply already under way with no record (a page reload): the
  // tokens already there took an unknown time, so only later ones count.
  const start = { at: now, tokens };
  if (key !== null) {
    starts.set(key, start);
    if (starts.size > MAX_TRACKED_REPLIES) starts.delete(starts.keys().next().value!);
  }
  return start;
}

interface RateSample {
  at: number;
  tokens: number;
  lastGrowthAt: number;
  lastTokens: number;
  rate: number | null;
}
const samples = new WeakMap<StreamRateStart, RateSample>();
const RATE_STALE_MS = 2000;

/** Average output rate over the SDK-recorded request duration, not a guessed decode rate. */
export function recordedOutputTokensPerSecond(output: unknown, durationMs: unknown): number | null {
  if (typeof output !== "number" || !Number.isFinite(output) || output <= 0
    || typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  const rate = output * 1000 / durationMs;
  return Number.isFinite(rate) && rate >= 0.05 ? rate : null;
}

/** Count growth, not interval ticks. Waiting is never displayed as zero speed. */
export function streamTokensPerSecond(start: StreamRateStart, tokens: number, now: number): number | null {
  if (!Number.isFinite(tokens) || !Number.isFinite(now)) return null;
  const sample = samples.get(start) ?? {
    at: start.at, tokens: start.tokens, lastGrowthAt: start.at, lastTokens: start.tokens, rate: null,
  };
  samples.set(start, sample);
  const gap = now - sample.lastGrowthAt;
  if (gap < 0 || tokens < sample.lastTokens || (gap > RATE_STALE_MS && tokens > sample.lastTokens)) {
    // A long pause/rejoin or replacement snapshot has no measured generation interval.
    Object.assign(sample, { at: now, tokens, lastGrowthAt: now, lastTokens: tokens, rate: null });
    return null;
  }
  if (gap > RATE_STALE_MS) return null;
  if (tokens > sample.lastTokens) {
    sample.lastGrowthAt = now;
    sample.lastTokens = tokens;
    const elapsedSeconds = (now - sample.at) / 1000;
    const rate = elapsedSeconds > 0.5 ? (tokens - sample.tokens) / elapsedSeconds : null;
    sample.rate = rate !== null && Number.isFinite(rate) && rate >= 0.05 ? rate : null;
  }
  return sample.rate;
}
