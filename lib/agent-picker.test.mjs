import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { agentSummary, agentPickerGroups } = await jiti.import('./agent-picker.ts');
const target = (id, label, role = 'reviewer') => ({ id: `package:${id}`, runId: id, label, role, state: 'complete' });
test('repeated role prefixes and whitespace are display-only cleanup', () => {
  assert.equal(agentSummary('reviewer · reviewer:  检查\n界面', 'reviewer', 'id'), '检查 界面');
  assert.equal(agentSummary('Review work', 'reviewer', 'id'), 'Review work');
});
test('revival scaffolding never becomes the task title', () => {
  assert.equal(agentSummary('reviewer: You are reviving a previous subagent conversation. Original task: 检查字体', 'reviewer', 'x'), '检查字体');
  assert.equal(agentSummary('reviewer: You are reviving a previous subagent conversation. Origin...', 'reviewer', 'package:12345678-rest'), '续接记录 · 12345678');
});
test('identical display summaries group without losing exact run and step identities', () => {
  const targets = [target('a:0', 'reviewer: 检查界面'), target('a:1', 'reviewer: 检查界面'), target('b', '检查界面'), target('c', '检查界面', 'worker')];
  const groups = agentPickerGroups([], targets, new Set());
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].items.map(item => item.id), ['package:a:0', 'package:a:1', 'package:b']);
  assert.equal(groups[1].items[0].role, 'worker');
});
test('unknown revival records never imply common lineage', () => {
  const label = 'You are reviving a previous subagent conversation. Origin...';
  assert.equal(agentPickerGroups([], [target('a', label), target('b', label)], new Set()).length, 2);
});
test('a task used as role cannot inflate the role column', () => {
  const groups = agentPickerGroups([], [target('a', '检查文件', 'x'.repeat(120))], new Set());
  assert.equal(groups[0].items[0].role, '子代理');
});
