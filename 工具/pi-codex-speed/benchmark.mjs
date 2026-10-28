// Uses Pi's normal ModelRuntime credential handling; never reads/prints secrets.
import { ModelRuntime } from '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

const dir = process.argv[2];
const phase = process.argv[3];
if (!dir || !['preflight', 'measure'].includes(phase)) throw new Error('Usage: node benchmark.mjs RESULT_DIR preflight|measure');
mkdirSync(dir, { recursive: true });
const configPath = join(dir, 'config.json');
const resultPath = join(dir, 'trials.jsonl');
const tiers = { standard: 'default', fast: 'priority', ultrafast: 'ultrafast' };
const sentence = 'Calm rivers flow past green fields beneath a clear blue sky.';
const prompt = `Output exactly 40 lines and nothing else. Each line must contain its two-digit line number from 01 to 40, then " | ", then this exact sentence: ${sentence} Do not add a heading, explanation, or code fence.`;
const orders = [
  ['fast','standard','ultrafast'], ['ultrafast','fast','standard'],
  ['standard','ultrafast','fast'], ['fast','ultrafast','standard'],
  ['standard','fast','ultrafast'], ['ultrafast','standard','fast'],
  ['standard','ultrafast','fast'], ['fast','standard','ultrafast'],
];
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {
  created: new Date().toISOString(), provider: 'openai-codex', model: process.env.PI_MODEL || 'gpt-6-astra',
  reasoning: 'medium', transport: process.env.CODEX_BENCH_TRANSPORT || 'websocket', sessionId: randomUUID(),
  timeoutMs: 90000, prompt, orders, trialsPerMode: 8,
  notes: 'Independent short prompts; same persistent connection/session per phase; no tools/history; no automatic retries. Preflight excluded. Fast wire priority, ultrafast wire ultrafast. Output-tokens/sec over full response is end-to-end throughput, not pure decode speed.',
};
if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify(config, null, 2));
const previous = () => existsSync(resultPath) ? readFileSync(resultPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const model = runtime.getModel(config.provider, config.model);
if (!model || model.api !== 'openai-codex-responses') throw new Error('Expected installed Codex model');
if (!runtime.hasConfiguredAuth(config.provider)) throw new Error('No configured Pi authentication');

function errorClass(message = '') {
  if (/ultrafast|service.tier|priority/i.test(message) && /not.support|invalid|not.allowed|not.available|unsupported/i.test(message)) return 'tier_rejected';
  if (/usage.limit|quota|rate.limit|too.many|429/i.test(message)) return 'quota_or_rate_limit';
  if (/unauthorized|authentication|401|token.expired/i.test(message)) return 'authentication_error';
  if (/forbidden|permission|403/i.test(message)) return 'permission_error';
  if (/timeout|timed.out|aborted/i.test(message)) return 'timeout_or_abort';
  if (/websocket|network|connect|fetch/i.test(message)) return 'transport_error';
  return 'provider_error';
}
async function trial(mode, round) {
  const start = performance.now();
  let firstText, lastText, firstEvent, text = '', reportedTier = null, responseModel = null;
  let responseStatus = null, sentTier = null, sentReasoning = null, errorCode = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const row = { phase, round, mode, requestedTier: tiers[mode], started: new Date().toISOString() };
  try {
    const stream = runtime.streamSimple(model, {
      messages: [{ role: 'user', content: config.prompt, timestamp: 0 }],
    }, {
      reasoning: config.reasoning, transport: config.transport,
      sessionId: config.sessionId, timeoutMs: config.timeoutMs, websocketConnectTimeoutMs: 15000,
      maxRetries: 0, signal: controller.signal,
      onPayload: payload => {
        sentTier = tiers[mode]; sentReasoning = payload.reasoning?.effort ?? null;
        return { ...payload, service_tier: sentTier };
      },
      onResponse: response => { responseStatus = response.status; },
      onProviderStreamEvent: data => {
        firstEvent ??= performance.now() - start;
        if (data?.response?.service_tier) reportedTier = data.response.service_tier;
        if (data?.response?.model) responseModel = data.response.model;
        const code = data?.error?.code ?? data?.response?.error?.code;
        if (typeof code === 'string' && /^[\w.-]{1,100}$/.test(code)) errorCode = code;
      },
    });
    for await (const event of stream) {
      if (event.type === 'text_delta' && event.delta) {
        firstText ??= performance.now() - start;
        lastText = performance.now() - start;
        text += event.delta;
        if (text.length > 12000) controller.abort();
      }
    }
    const result = await stream.result();
    const durationMs = performance.now() - start;
    const lines = text.trim().split('\n');
    const exact = lines.length === 40 && lines.every((line, i) => line === `${String(i + 1).padStart(2, '0')} | ${sentence}`);
    Object.assign(row, {
      success: result.stopReason !== 'error' && result.stopReason !== 'aborted', stopReason: result.stopReason,
      errorClass: result.errorMessage ? errorClass(result.errorMessage) : null,
      durationMs, firstTextMs: firstText ?? null, lastTextMs: lastText ?? null,
      firstEventMs: firstEvent ?? null, chars: text.length, lines: lines.length, exactOutput: exact,
      usage: { input: result.usage.input, output: result.usage.output, reasoning: result.usage.reasoning ?? null, cacheRead: result.usage.cacheRead, cacheWrite: result.usage.cacheWrite, total: result.usage.totalTokens },
      endToEndTokensPerSecond: result.usage.output / (durationMs / 1000),
      textCharsPerSecond: firstText !== undefined && lastText > firstText ? text.length / ((lastText - firstText) / 1000) : null,
    });
  } catch (error) {
    Object.assign(row, { success: false, errorClass: errorClass(error.message), durationMs: performance.now() - start });
  } finally { clearTimeout(timer); }
  Object.assign(row, { sentTier, sentReasoning, reportedTier, responseModel, responseStatus, errorCode });
  appendFileSync(resultPath, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
  await new Promise(resolve => setTimeout(resolve, 1000));
  return row;
}
if (phase === 'preflight') {
  for (const mode of ['standard', 'fast', 'ultrafast']) {
    if (previous().some(r => r.phase === phase && r.mode === mode)) continue;
    const row = await trial(mode, 0);
    if (!row.success && ['authentication_error', 'quota_or_rate_limit', 'transport_error'].includes(row.errorClass)) break;
  }
} else {
  const eligible = new Set(previous().filter(r => r.phase === 'preflight' && r.success && r.exactOutput).map(r => r.mode));
  for (let i = 0; i < config.orders.length; i++) {
    for (const mode of config.orders[i]) {
      if (!eligible.has(mode) || previous().some(r => r.phase === phase && r.round === i + 1 && r.mode === mode)) continue;
      const row = await trial(mode, i + 1);
      if (!row.success) {
        eligible.delete(mode);
        if (['authentication_error','quota_or_rate_limit'].includes(row.errorClass)) eligible.clear();
      }
    }
  }
}
process.exit(0);
