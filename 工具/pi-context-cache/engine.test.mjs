import test from 'node:test';
import assert from 'node:assert/strict';
import { slimContext } from './engine.mjs';
const text = 'START\n' + 'x'.repeat(8000) + '\nIMPORTANT_OLD_VALUE_731\n' + 'y'.repeat(8000) + '\nEND';
function fixture() {
  const m = [{ role: 'user', content: 'Keep this requirement exactly.' }];
  for (let i = 0; i < 16; i++) {
    m.push({ role: 'assistant', content: [{ type: 'text', text: 'decision-' + i }, { type: 'toolCall', id: 't' + i, name: 'bash', arguments: { command: text, timeout: 5 } }] });
    m.push({ role: 'toolResult', toolName: 'bash', toolCallId: 't' + i, content: [{ type: 'text', text }], isError: false });
  }
  m.push({ role: 'user', content: 'New task.' });
  return m;
}
const opts = { triggerChars: 1, keepAssistantTurns: 2 };

test('old blocks shrink, exact archive available, no mutation or message removal', () => {
  const original = fixture(); const snapshot = structuredClone(original); const files = new Map();
  const r = slimContext(original, s => { const p = '/private/cache/' + files.size; files.set(p, s); return p; }, opts);
  assert.deepEqual(original, snapshot);
  assert.equal(r.messages.length, original.length);
  assert.ok(r.stats.afterChars < r.stats.beforeChars / 4);
  assert.ok([...files.values()].every(s => s === text));
  for (let i = 0; i < original.length; i++) {
    assert.equal(r.messages[i].role, original[i].role);
    if (original[i].role === 'user') assert.deepEqual(r.messages[i], original[i]);
    if (original[i].role === 'assistant') {
      assert.deepEqual(r.messages[i].content[0], original[i].content[0]);
      assert.equal(r.messages[i].content[1].id, original[i].content[1].id);
    }
  }
  assert.deepEqual(r.messages.slice(-5), original.slice(-5));
});

test('current user task is retained even when it is large', () => {
  const m = fixture(); const tail = fixture().slice(1, -1); m.push(...tail);
  const r = slimContext(m, () => '/cache', opts);
  assert.deepEqual(r.messages.slice(-tail.length), tail);
});

test('errors, credentials, unfinished calls, images and short results are retained', () => {
  const m = fixture();
  m[1].content[1].id = 'unfinished';
  m[2].isError = true;
  m[4].toolName = 'credential_browser';
  m[6].content = [{ type: 'image', data: 'original', mimeType: 'image/png' }];
  m[8].content = [{ type: 'text', text: 'ok' }];
  const r = slimContext(m, () => '/cache', opts);
  assert.deepEqual(r.messages[1], m[1]);
  for (const i of [2, 4, 6, 8]) assert.deepEqual(r.messages[i], m[i]);
});

test('below threshold makes no archives', () => {
  const m = [{ role: 'user', content: 'small' }];
  assert.equal(slimContext(m, () => { throw Error('must not archive'); }).messages, m);
});

test('no user boundary means no pruning', () => {
  const m = fixture().filter(m => m.role !== 'user');
  assert.equal(slimContext(m, () => { throw Error('must not archive'); }, opts).messages, m);
});

test('archive failure throws without mutating original', () => {
  const m = fixture(), snapshot = structuredClone(m);
  assert.throws(() => slimContext(m, () => { throw Error('disk full'); }, opts));
  assert.deepEqual(m, snapshot);
});
