import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const { collectTaskOutputs, taskOutputPath, outputPathForCwd, MAX_TASK_OUTPUTS } = await createJiti(import.meta.url).import('./task-outputs.ts');
const assistant = content => ({ type: 'message', message: { role: 'assistant', content } });
const call = (id, name, path) => assistant([{ type: 'toolCall', id, name, arguments: { path } }]);
const result = (id, name, isError = false, extra = {}) => ({ type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: name, isError, ...extra } });
const paths = entries => collectTaskOutputs(entries, '/project').paths;

test('automatically lists successful writes and edits, newest first, without requiring an open tab', () => {
  assert.deepEqual(paths([
    call('a', 'write', 'report.md'), result('a', 'write'),
    call('b', 'edit', 'report.md'), result('b', 'edit'),
    call('c', 'write', '/project/reports/报告.pdf'), result('c', 'write'),
    call('bad', 'write', 'failed.md'), result('bad', 'write', true), call('pending', 'write', 'pending.md'),
  ]), ['/project/reports/报告.pdf', '/project/report.md']);
});

test('normalizes UI and persisted calls but never treats reads, unknown tools or unpaired results as writes', () => {
  assert.deepEqual(paths([
    assistant([{ type: 'toolCall', toolCallId: 'a', toolName: 'write', input: { path: 'a.md' } }]), result('a', 'write'),
    call('r', 'read', 'read.md'), result('r', 'read'),
    call('m', 'mcp__server__write', 'remote.md'), result('m', 'mcp__server__write'),
    result('unknown', 'write', false, { content: [{ type: 'text', text: 'Wrote /project/fake.md' }] }),
  ]), ['/project/a.md']);
});

test('literal file paths preserve punctuation and allow already-authorized files outside cwd', () => {
  assert.equal(taskOutputPath('reports/中文 #100%?.pdf', '/project'), '/project/reports/中文 #100%?.pdf');
  assert.equal(taskOutputPath('/tmp/报告.pdf', '/project'), '/tmp/报告.pdf');
  assert.equal(taskOutputPath('C:\\reports\\a.pdf', '/project'), 'C:/reports/a.pdf');
  assert.equal(taskOutputPath('README', '/project'), '/project/README');
  for (const value of ['../secret', '/project/link/../secret', 'https://example.com/a', 'file:///secret', 'a/\u0000b', 'folder/', null]) {
    assert.equal(taskOutputPath(value, '/project'), null, String(value));
  }
});

test('SDK nested write results use their own outcome even if their parent script failed', () => {
  assert.deepEqual(paths([result('outer', 'codemode', true, { nestedCalls: { complete: false, calls: [
    { name: 'write', status: 'ok', arguments: { path: 'nested.md' } },
    { name: 'edit', status: 'ok', arguments: { path: 'edited.md' } },
    { name: 'write', status: 'error', arguments: { path: 'error.md' } },
    { name: 'write', status: 'unfinished', arguments: { path: 'pending.md' } },
    { name: 'write', status: 'ok', argumentsBytes: 100000 },
    { name: 'mcp__remote__write', status: 'ok', arguments: { path: 'remote.md' } },
  ] } })]), ['/project/edited.md', '/project/nested.md']);
});

test('legacy codemode display args must be complete JSON with explicit success', () => {
  assert.deepEqual(paths([result('a', 'codemode', false, { details: { calls: [
    { name: 'write', status: 'ok', args: '{"path":"legacy.md","content":"ok"}' },
    { name: 'write', status: 'ok', args: '{"path":"truncated.md","content":"...' },
    { name: 'write', status: 'cancelled', args: '{"path":"cancelled.md"}' },
    { name: 'write', args: '{"path":"unknown.md"}' },
  ] } })]), ['/project/legacy.md']);
  assert.deepEqual(paths([result('a', 'mcp', false, { details: { calls: [{ name: 'write', status: 'ok', args: '{"path":"remote.md"}' }] } })]), []);
});

test('assistant delivery links include shell-produced documents, images, spaces and parentheses', () => {
  const content = '[PDF](reports/a%20b.pdf#page=2) ![图](<reports/图 表.png>) [Sheet](reports/a(1).xlsx) [Text](README.md "Read me")';
  assert.deepEqual(paths([assistant([{ type: 'text', text: content }])]), ['/project/README.md', '/project/reports/a(1).xlsx', '/project/reports/图 表.png', '/project/reports/a b.pdf']);
  assert.deepEqual(paths([assistant('[PDF](file:///tmp/ready.pdf)')]), ['/tmp/ready.pdf']);
});

test('does not infer artifacts from user mentions, shell text, tool logs, code examples or remote links', () => {
  assert.deepEqual(paths([
    { type: 'message', message: { role: 'user', content: '[Existing](existing.md)' } },
    result('x', 'bash', false, { content: [{ type: 'text', text: 'printf /project/not-created.pdf' }], details: { fullOutputPath: '/tmp/log.txt' } }),
    { type: 'custom', customType: 'codemode-store', data: { path: '/project/fake.pdf' } },
    { type: 'context_edit', replacement: { content: '[Fake](fake.md)' } },
    assistant([{ type: 'text', text: '```md\n[Example](example.md)\n```\n`[Example](inline.md)` [Web](https://example.com/a.pdf) [Escape](%2e%2e/secret) [API](/api/files/private)' }]),
  ]), []);
});

test('pre-compaction entries are retained and repeated references are de-duplicated', () => {
  assert.deepEqual(paths([
    call('old', 'write', 'before.md'), result('old', 'write'),
    { type: 'compaction', summary: 'Old work', firstKeptEntryId: 'later' },
    call('new', 'write', 'after.md'), result('new', 'write'),
    assistant([{ type: 'text', text: '[Before](before.md)' }]),
  ]), ['/project/before.md', '/project/after.md']);
});

test('response bounds retain the newest files and disclose truncation, not the old 32-pin cap', () => {
  const entries = Array.from({ length: MAX_TASK_OUTPUTS + 3 }, (_, i) => [call(String(i), 'write', `${i}.md`), result(String(i), 'write')]).flat();
  const output = collectTaskOutputs(entries, '/project');
  assert.equal(output.paths.length, MAX_TASK_OUTPUTS); assert.equal(output.truncated, true);
  assert.equal(output.paths[0], `/project/${MAX_TASK_OUTPUTS + 2}.md`);
  assert.equal(paths(entries.slice(0, 100)).length, 50);
});

test('file-index paths remain project-contained and cannot broaden file access', () => {
  for (const path of ['../secret', '/home/other/file', '/project-evil/a', 'file:///secret', 'C:/secret', 'a\\b', 'a/../b', '\u0000secret', '', null]) assert.equal(outputPathForCwd(path, '/project'), null, String(path));
  assert.equal(outputPathForCwd('/project/reports/a b.pdf', '/project'), 'reports/a b.pdf');
});
