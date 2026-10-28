import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const agentDir = path.join(os.homedir(), '.pi/agent');
const roles = ['delegate', 'scout', 'worker', 'reviewer', 'researcher', 'evidence-auditor', 'oracle'];
const readRole = name => fs.readFileSync(path.join(agentDir, 'agents', `${name}.md`), 'utf8');

test('maintained worker/reviewer sources match their live runtime files', () => {
  for (const role of ['worker', 'reviewer']) {
    assert.equal(readRole(role), fs.readFileSync(new URL(`./agents/${role}.md`, import.meta.url), 'utf8'));
  }
});

test('all seven local roles retain ambient tools, extensions and skills', () => {
  for (const role of roles) {
    const frontmatter = readRole(role).split('---')[1];
    assert.doesNotMatch(frontmatter, /^(?:tools|extensions|subagentOnlyExtensions):/m, role);
    assert.match(frontmatter, /^inheritSkills: true$/m, role);
  }
  const { subagents = {} } = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
  assert.notDeepEqual(subagents.defaultExtensions, []);
  assert.ok(subagents.defaultSubagentOnlyExtensions.some(p => p.endsWith('/child-shared-tools.ts')));
});

test('role wording permits actual tools without broadening a read-only task', () => {
  assert.doesNotMatch(readRole('worker'), /uses a strict tool allowlist|does not inherit ambient extension tools/);
  const reviewer = readRole('reviewer');
  assert.match(reviewer, /Read-only shell inspection is allowed/);
  assert.match(reviewer, /Do not mutate files or Git state/);
  assert.match(reviewer, /not a prerequisite/);
  assert.doesNotMatch(reviewer, /Do not use shell commands/);
});
