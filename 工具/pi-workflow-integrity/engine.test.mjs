import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createJiti } from '/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/jiti/lib/jiti.mjs';
import { compact, prepareCompaction } from '/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js';
import { abbreviateToolResult, OUTPUT_LIMIT, unifySplitPreparation } from './engine.mjs';

const message = text => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 });
function preparation() {
  return { messagesToSummarize: [message('Original goal: inspect plugins.')], turnPrefixMessages: [message('User authorized implementation. Deployment failed; do not ask again.')], isSplitTurn: true, firstKeptEntryId: 'retained-id', tokensBefore: 200000, previousSummary: 'Previously waiting for authorization', settings: { enabled: true, keepRecentTokens: 20000, reserveTokens: 72000 }, fileOps: { read: new Set(['source.ts']), written: new Set(['deployment-state.json']), edited: new Set() } };
}
const result = extras => ({ toolName: 'bash', toolCallId: 'outer', content: [{ type: 'text', text: 'a'.repeat(17000) + 'FINAL ERROR DETAIL' }], isError: true, ...extras });

test('split spans share a single chronology; retained boundary/settings/file tracking stay unchanged', () => {
  const p = preparation(), settings = p.settings, ops = p.fileOps;
  assert.equal(unifySplitPreparation(p), true);
  assert.equal(p.messagesToSummarize.length, 2); assert.equal(p.turnPrefixMessages.length, 0); assert.equal(p.isSplitTurn, false);
  assert.equal(p.settings, settings); assert.equal(p.fileOps, ops); assert.equal(p.firstKeptEntryId, 'retained-id'); assert.equal(p.tokensBefore, 200000);
  assert.equal(p.previousSummary, 'Previously waiting for authorization');
  assert.equal(unifySplitPreparation(p), false);
});
test('ordinary native preparation is untouched', () => {
  const p = { ...preparation(), isSplitTurn: false }; const copy = JSON.stringify(p);
  assert.equal(unifySplitPreparation(p), false); assert.equal(JSON.stringify(p), copy);
});
test('large top-level text is archived with explicit truncation and error tail', () => {
  let saved; const event = result(); const transformed = abbreviateToolResult(event, text => { saved = text; return '/private/output.txt'; });
  assert.equal(saved, event.content[0].text); assert.ok(transformed.content[0].text.length < OUTPUT_LIMIT);
  assert.ok(transformed.content[0].text.includes('/private/output.txt')); assert.ok(transformed.content[0].text.endsWith('FINAL ERROR DETAIL'));
  assert.ok(transformed.content[0].text.includes('不是完整 JSON')); assert.equal(event.isError, true); assert.equal(event.content[0].text, saved);
});
test('nested results, structured results, file reads and small outputs stay intact', () => {
  for (const event of [result({ parentToolCallId: 'parent' }), result({ structuredContent: { data: 'full' } }), result({ toolName: 'read' }), result({ content: [{ type: 'text', text: 'short' }] })]) {
    assert.equal(abbreviateToolResult(event, () => { throw new Error('must not archive'); }), undefined);
  }
});
test('images remain attached and multi-block text is bounded', () => {
  const image = { type: 'image', data: 'fixture', mimeType: 'image/png' };
  const event = result({ content: [{ type: 'text', text: 'a'.repeat(9000) }, image, { type: 'text', text: 'b'.repeat(9000) }] });
  const transformed = abbreviateToolResult(event, () => '/private/output.txt');
  assert.equal(transformed.content[1], image); assert.equal(transformed.content.length, 2);
});
test('archive failure never produces a truncated result', () => {
  const event = result(); assert.throws(() => abbreviateToolResult(event, () => { throw new Error('disk error'); }), /disk error/);
  assert.ok(event.content[0].text.length > OUTPUT_LIMIT);
});
test('native compact uses one call, keeps usage/files/boundary and honors abort signal', async () => {
  const p = preparation(); unifySplitPreparation(p); const captured = [];
  const signal = new AbortController().signal;
  const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const response = { role: 'assistant', content: [{ type: 'text', text: '## Progress\nDeployment failed, implementation authorized.' }], api: 'openai-responses', provider: 'openai', model: 'fixture', stopReason: 'stop', usage, timestamp: 1 };
  const stream = (model, context, options) => {
    captured.push(context); assert.equal(options.signal, signal);
    return { result: async () => response, async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'stop', message: response }; } };
  };
  const model = { id: 'fixture', name: 'fixture', provider: 'openai', api: 'openai-responses', baseUrl: 'https://unused.invalid', reasoning: false, input: ['text'], cost: usage.cost, contextWindow: 272000, maxTokens: 128000 };
  const summary = await compact(p, model, 'fixture', undefined, undefined, signal, undefined, stream);
  assert.equal(captured.length, 1); const prompt = JSON.stringify(captured[0]);
  assert.ok(prompt.includes('Original goal')); assert.ok(prompt.includes('User authorized implementation')); assert.ok(prompt.includes('Previously waiting'));
  assert.equal(summary.firstKeptEntryId, 'retained-id'); assert.equal(summary.usage.totalTokens, 120);
  assert.ok(summary.summary.includes('deployment-state.json')); assert.ok(summary.summary.includes('source.ts'));
});
test('historical failing case keeps the exact native cut point after merging', () => {
  const file = '../../系统数据/Pi会话/2026-10-12T11-17-45-616Z_01a12fd5-3a10-73ff-aa26-a6ef009984dd.jsonl';
  const entries = readFileSync(new URL(file, import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const at = entries.findIndex(entry => entry.type === 'compaction');
  assert.ok(at > 0); const p = prepareCompaction(entries.slice(0, at), { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
  assert.ok(p); const before = p.firstKeptEntryId; const count = p.messagesToSummarize.length + p.turnPrefixMessages.length;
  unifySplitPreparation(p); assert.equal(p.firstKeptEntryId, before); assert.equal(p.messagesToSummarize.length + p.turnPrefixMessages.length, count);
  assert.ok(entries.slice(0, at).some(entry => entry.id === before));
});
test('real Pi extension loader registers only the two intended hooks', async () => {
  const load = createJiti(import.meta.url); const { default: extension } = await load.import('./index.ts');
  const hooks = new Map(); extension({ on: (name, handler) => hooks.set(name, handler), appendEntry() {}, getAllTools: () => [] });
  assert.deepEqual([...hooks.keys()], ['session_before_compact', 'tool_result']);
  const p = preparation(); hooks.get('session_before_compact')({ preparation: p }); assert.equal(p.isSplitTurn, false);
});
