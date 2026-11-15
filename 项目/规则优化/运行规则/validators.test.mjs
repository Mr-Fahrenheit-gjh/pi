import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../../..');
const rulesRelative = '项目/规则优化/运行规则';
const pstackRelative = '.pi/skills/pstack';
const read = file => readFileSync(file, 'utf8');
function fixture(t) {
  const temp = mkdtempSync(path.join(tmpdir(), 'pi-validator-contract-'));
  const workspace = path.join(temp, 'workspace');
  const home = path.join(temp, 'home');
  const rules = path.join(workspace, rulesRelative);
  const pstack = path.join(workspace, pstackRelative);
  for (const relative of ['AGENTS.md', rulesRelative, pstackRelative, '.pi/skills/pi-web-maintenance/SKILL.md']) {
    const target = path.join(workspace, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(root, relative), target, { recursive: true });
  }
  const agent = path.join(home, '.pi/agent');
  for (const [source, destination] of [['APPEND_SYSTEM.md', 'APPEND_SYSTEM.md'], ['references/execution.md', 'rules/execution.md'], ['references/delegation.md', 'rules/delegation.md'], ['browser-harness/SKILL.md', 'skills/browser-harness/SKILL.md']]) {
    const target = path.join(agent, destination);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(rules, source), target);
  }
  mkdirSync(path.join(agent, 'skills/grilling'), { recursive: true });
  writeFileSync(path.join(agent, 'skills/grilling/SKILL.md'), '---\nname: grilling\ndescription: Synthetic manual-only fixture\ndisable-model-invocation: true\n---\nFixture body\n');
  symlinkSync(pstack, path.join(agent, 'skills/pstack'), 'dir');
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const run = (kind = 'rules', source = true) => spawnSync(process.execPath, [path.join(kind === 'rules' ? rules : pstack, 'validate.mjs'), ...(source ? ['--source'] : [])], {
    cwd: workspace, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent }, encoding: 'utf8', timeout: 30000,
  });
  const mutate = (file, transform) => writeFileSync(file, transform(read(file)));
  return { workspace, rules, pstack, agent, run, mutate };
}
function passes(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).passed, true);
}
function rejects(result, reason) {
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout + result.stderr, reason);
}

test('source and runtime rules pass for matching credential-free fixtures, but default rejects pending drift', t => {
  const f = fixture(t);
  passes(f.run());
  passes(f.run('rules', false));
  f.mutate(path.join(f.agent, 'APPEND_SYSTEM.md'), text => text + '\nsynthetic pending drift\n');
  passes(f.run());
  rejects(f.run('rules', false), /pending drift: APPEND_SYSTEM.md/);
});

test('resident budgets reject growth, and required boundaries cannot be deleted for green', t => {
  const f = fixture(t);
  const appendFile = path.join(f.rules, 'APPEND_SYSTEM.md');
  const agentsFile = path.join(f.workspace, 'AGENTS.md');
  const append = read(appendFile), agents = read(agentsFile);
  writeFileSync(appendFile, append + 'x'.repeat(1101 - append.length));
  rejects(f.run(), /global 1101 > 1100/);
  writeFileSync(appendFile, append);
  writeFileSync(agentsFile, agents + 'x'.repeat(1251 - agents.length));
  rejects(f.run(), /workspace 1251 > 1250/);
  writeFileSync(appendFile, append + 'x'.repeat(1100 - append.length));
  writeFileSync(agentsFile, agents + 'x'.repeat(1250 - agents.length));
  passes(f.run()); // exact combined budget 2350 is accepted
  writeFileSync(agentsFile, agents);
  writeFileSync(appendFile, append.replace('不要重发写操作', 'xxxxxxxx'));
  rejects(f.run(), /不要重发写操作/);
  writeFileSync(appendFile, append.replace('不传 `timing`', 'timing: now'));
  rejects(f.run(), /不得恢复旧记忆保存时序/);
});

test('pstack permits the committed baseline or the explicit poteto exception, but no other metadata drift', t => {
  const f = fixture(t);
  const poteto = path.join(f.pstack, 'upstream/skills/poteto-mode/SKILL.md');
  // Do not let copying a dirty worktree hide a dependency on excluded changes.
  f.mutate(poteto, text => text.replace(/^disable-model-invocation: true\r?\n/m, '').replace(/^name: poteto-mode$/m, 'name: poteto-mode\ndisable-model-invocation: true'));
  passes(f.run('pstack'));
  passes(f.run('pstack', false));
  f.mutate(poteto, text => text.replace(/^disable-model-invocation: true\r?\n/m, ''));
  passes(f.run('pstack'));
  passes(f.run('pstack', false));
  const manual = path.join(f.pstack, 'upstream/skills/how/SKILL.md');
  f.mutate(manual, text => text.replace(/^disable-model-invocation: true\r?\n/m, ''));
  rejects(f.run('pstack'), /automaticNames|how|deepEqual/);
  f.mutate(manual, text => text.replace(/^name: how$/m, 'name: how\ndisable-model-invocation: true'));
  for (const [file, name] of [['entry/SKILL.md', 'pstack'], ['upstream/skills/setup-pstack/SKILL.md', 'setup-pstack']]) {
    const skill = path.join(f.pstack, file);
    f.mutate(skill, text => text.replace(`name: ${name}\n`, `name: ${name}\ndisable-model-invocation: true\n`));
    rejects(f.run('pstack'), /Expected values to be strictly deep-equal/);
    f.mutate(skill, text => text.replace(/^disable-model-invocation: true\r?\n/m, ''));
  }
  const wrong = path.join(f.agent, 'skills/pstack');
  unlinkSync(wrong);
  symlinkSync(path.join(f.pstack, 'entry'), wrong, 'dir');
  passes(f.run('pstack'));
  rejects(f.run('pstack', false), /pending drift: 全局pstack链接/);
});

test('maintenance homepage has one current identity entry and dated releases stay historical', () => {
  const home = read(path.join(root, '工具/pi-web维护/README.md'));
  const maintenance = read(path.join(root, '工具/pi-web维护/native-agent-switcher/README.md'));
  const anchor = '#当前身份核对唯一现行入口';
  assert.ok(home.includes(`native-agent-switcher/README.md${anchor}`));
  assert.equal((maintenance.match(/^## 当前身份核对（唯一现行入口）$/gm) || []).length, 1);
  const current = maintenance.slice(0, maintenance.indexOf('## 历史：'));
  for (const required of ['local-update.json', 'upgrade-0.12-state.json', 'live-result.json', '/opt/homebrew/lib/node_modules/@agegr/pi-web/package.json', '.next/BUILD_ID', '30141']) assert.ok(current.includes(required), required);
  assert.doesNotMatch(maintenance, /^## .*（(?:当前正式版|上一正式版|上一正式基线)/m);
  assert.doesNotMatch(home, /最新维护入口|上一正式发布/);
});
