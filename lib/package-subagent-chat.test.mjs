import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readPackageChat, transcriptSessionPath } from './package-subagent-chat.ts';
import { normalizeToolCalls } from './normalize.ts';

test('only package-generated header paths, not user transcript text, are used', () => {
  assert.equal(transcriptSessionPath('Run: abc\nArtifacts:\n  Session: /trusted/session.jsonl\n\nTranscript:\nSession: /etc/passwd'), '/trusted/session.jsonl');
  assert.equal(transcriptSessionPath('Run: abc\n\nTranscript:\nSession: /etc/passwd'), undefined);
});

test('a linked project authorizes only its verified parent child tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-linked-chat-'));
  try {
    const root = join(dir, 'sessions'); mkdirSync(root);
    const storage = join(dir, 'actual-project'); mkdirSync(storage);
    symlinkSync(storage, join(root, 'project'));
    const parent = join(root, 'project', 'parent.jsonl'); writeFileSync(parent, '{}');
    mkdirSync(join(storage, 'parent', 'run-0'), { recursive: true });
    const child = join(root, 'project', 'parent', 'run-0', 'session.jsonl');
    writeFileSync(child, JSON.stringify({ type: 'message', message: { role: 'user', content: 'owned' } }));
    assert.throws(() => readPackageChat(child, root), /允许/);
    assert.equal(readPackageChat(child, root, parent).messages[0].content, 'owned');
    const sibling = join(storage, 'foreign.jsonl'); writeFileSync(sibling, '{}');
    assert.throws(() => readPackageChat(sibling, root, parent), /允许/);
    symlinkSync(sibling, join(storage, 'parent', 'escape.jsonl'));
    assert.throws(() => readPackageChat(join(storage, 'parent', 'escape.jsonl'), root, parent), /允许/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('read-only bounded transcript uses native normalization and ignores torn/system entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-child-chat-'));
  try {
    const root = join(dir, 'sessions'); mkdirSync(root);
    const file = join(root, 'child.jsonl');
    writeFileSync(file, [
      { type: 'session', id: 'child' },
      { type: 'message', message: { role: 'system', content: 'private prompt' } },
      { type: 'message', message: { role: 'user', content: 'task' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'x' } }] } },
    ].map(JSON.stringify).join('\n') + '\n{"type":');
    const before = readPackageChat(file, root);
    before.messages = before.messages.map(normalizeToolCalls);
    assert.equal(before.messages.length, 2);
    assert.equal(before.messages[1].content[0].toolName, 'read');
    assert.equal(before.messages[1].content[0].toolCallId, 'call');
    const outside = join(dir, 'outside.jsonl'); writeFileSync(outside, '{}');
    assert.throws(() => readPackageChat(outside, root), /允许/);
    writeFileSync(file, Array.from({ length: 150 }, (_, i) => JSON.stringify({ type: 'message', message: { role: 'user', content: String(i) } })).join('\n'));
    const tail = readPackageChat(file, root);
    assert.equal(tail.messages.length, 100);
    assert.equal(tail.messages[0].content, '50');
    assert.equal(tail.truncated, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
