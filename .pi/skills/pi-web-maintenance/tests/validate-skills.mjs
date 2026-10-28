// Pure filesystem skill discovery/contract checks; no session, provider or service.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import test from 'node:test';
import { loadSkills, loadSkillsFromDir } from '/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const skill = join(root, '.pi/skills/pi-web-maintenance');
const sources = join(root, '工具/pi-web维护/skill-sources');

test('main and both compatibility entries load with the installed Pi skill loader', () => {
  for (const [name, directory] of [['pi-web-maintenance', skill], ...['pi-upgrade-check', 'pi-web-candidate'].map(name => [name, join(sources, name)])]) {
    const result = loadSkillsFromDir({ dir: directory, source: 'flow-validation' });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, name);
  }
  const discovered = loadSkills({ cwd: root, agentDir: join(homedir(), '.pi/agent'), skillPaths: [], includeDefaults: true });
  for (const name of ['pi-web-maintenance', 'pi-upgrade-check', 'pi-web-candidate']) {
    assert.equal(discovered.skills.filter(skill => skill.name === name).length, 1, `Unique default entry: ${name}`);
  }
});

test('runtime compatibility skills exactly match their version sources and do not offer old Web overwrite paths', () => {
  for (const name of ['pi-upgrade-check', 'pi-web-candidate']) {
    const source = readFileSync(join(sources, name, 'SKILL.md'), 'utf8');
    const runtime = readFileSync(join(homedir(), '.pi/agent/skills', name, 'SKILL.md'), 'utf8');
    assert.equal(runtime, source);
    assert.match(source, /pi-web-maintenance\/SKILL\.md/);
    assert.doesNotMatch(source, /npm install -g @agegr\/pi-web|ln -s .*node_modules|pi-web-source-0\.12`（当前/);
  }
});

test('skill references and preparation tools exist without adding another deploy entry', () => {
  const files = [join(skill, 'SKILL.md'), ...readdirSync(join(skill, 'references')).filter(name => name.endsWith('.md')).map(name => join(skill, 'references', name))];
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(https?:|#)/.test(match[1])) continue;
      const target = match[1].split('#')[0];
      assert.ok(existsSync(resolve(dirname(file), target)), `${file}: ${target}`);
    }
  }
  for (const name of ['flow.py', 'preflight.py', 'history_fixture.py', 'upgrade_when_idle.py']) {
    assert.ok(existsSync(join(root, '工具/pi-web维护/native-agent-switcher', name)));
  }
  const text = readFileSync(join(skill, 'SKILL.md'), 'utf8');
  assert.match(text, /flow\.py --features/);
  assert.match(text, /flow\.py --evidence/);
  assert.match(text, /upgrade_when_idle\.py/);
  assert.match(text, /30141/);
  assert.match(text, /其他会话与 PTY 保护/);
});
