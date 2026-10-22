import test from 'node:test';
import assert from 'node:assert/strict';
import { outputPathForCwd, parseTaskOutputs, taskOutputKey, MAX_TASK_OUTPUTS } from './task-outputs.ts';

test('only workspace-relative or contained absolute files can be pinned', () => {
  for (const path of ['../secret', '/home/other/file', '/project-evil/a', 'file:///secret', 'C:/secret', 'a\\b', 'a/../b', '\u0000secret', '', null]) assert.equal(outputPathForCwd(path, '/project'), null, String(path));
  assert.equal(outputPathForCwd('/project/reports/a b.pdf', '/project'), 'reports/a b.pdf');
  assert.equal(outputPathForCwd('./reports//a.md', '/project'), 'reports/a.md');
  assert.equal(outputPathForCwd('报告.md', '/project'), '报告.md');
});

test('stored references are bounded, de-duplicated and revalidated', () => {
  assert.deepEqual(parseTaskOutputs('{broken', '/project'), []);
  assert.deepEqual(parseTaskOutputs('{}', '/project'), []);
  assert.deepEqual(parseTaskOutputs(JSON.stringify(['a.md', 'a.md', '/project/b.pdf', '../secret', 4]), '/project'), ['a.md', 'b.pdf']);
  assert.equal(parseTaskOutputs(JSON.stringify(Array.from({length:100}, (_,i)=>`${i}.md`)), '/project').length, MAX_TASK_OUTPUTS);
  assert.deepEqual(parseTaskOutputs('x'.repeat(100001), '/project'), []);
});

test('session and workspace both participate in the storage identity', () => {
  assert.notEqual(taskOutputKey('a', '/project'), taskOutputKey('b', '/project'));
  assert.notEqual(taskOutputKey('a', '/project'), taskOutputKey('a', '/other'));
  assert.notEqual(taskOutputKey('a:b', '/c'), taskOutputKey('a', 'b:/c'));
});
