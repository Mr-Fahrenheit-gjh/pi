import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
assert.ok(process.argv.slice(2).every(arg => arg === '--source'), '只支持显式 --source；默认校验实际全局链接与发现');
const sourceOnly = process.argv.includes('--source');
const automaticNames = ['pstack', 'setup-pstack'];
const optionalAutomaticNames = ['poteto-mode'];
const sdkRoot = process.env.PI_SDK_ROOT || '/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent';
const { loadSkills, loadSkillsFromDir, formatSkillsForPrompt } = await import(pathToFileURL(join(sdkRoot, 'dist/core/skills.js')));
const source = loadSkillsFromDir({ dir: root, source: 'path' });
assert.equal(source.skills.length, 55);
assert.deepEqual(source.diagnostics, []);
const names = new Set(source.skills.map(s => s.name));
assert.equal(names.size, 55);
for (const name of ['pstack', 'poteto-mode', 'how', 'why', 'blast-radius', 'tdd', 'architect', 'interrogate']) {
  assert(names.has(name), `missing ${name}`);
}
// Only this pre-existing local metadata exception is optional. All other skills
// retain their fixed policy; a clean checkout must not depend on dirty metadata.
for (const name of optionalAutomaticNames) {
  if (!source.skills.find(skill => skill.name === name).disableModelInvocation) automaticNames.push(name);
}
automaticNames.sort();
assert.deepEqual(source.skills.filter(s => !s.disableModelInvocation).map(s => s.name).sort(), automaticNames);
const prompt = formatSkillsForPrompt(source.skills);
assert(prompt.includes('name>pstack</name>'));
for (const skill of source.skills) {
  assert.equal(prompt.includes(`<name>${skill.name}</name>`), automaticNames.includes(skill.name), `${skill.name}: 自动元数据策略`);
  const body = readFileSync(skill.filePath, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  assert.ok(body.length > 0 && !prompt.includes(body), `${skill.name}: 正文不得自动注入`);
}
const temporary = sourceOnly ? mkdtempSync(join(tmpdir(), 'pi-pstack-source-')) : undefined;
const agentDir = sourceOnly ? join(temporary, 'agent') : join(homedir(), '.pi/agent');
try {
if (sourceOnly) {
  mkdirSync(join(agentDir, 'skills'), { recursive: true });
  symlinkSync(root, join(agentDir, 'skills/pstack'), 'dir');
}
assert.equal(realpathSync(join(agentDir, 'skills/pstack')), realpathSync(root), 'pending drift: 全局pstack链接必须指向版本源');
// Check global discovery away from the workspace, and real-path dedup inside it.
for (const cwd of [sourceOnly ? temporary : tmpdir(), resolve(root, '../../..')]) {
  const loaded = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
  for (const expected of source.skills) {
    const found = loaded.skills.filter(s => s.name === expected.name);
    assert.equal(found.length, 1, `${cwd}: duplicate or missing ${expected.name}`);
    assert.equal(realpathSync(found[0].filePath), realpathSync(expected.filePath));
  }
  assert.deepEqual(loaded.diagnostics.filter(d => names.has(d.collision?.name) || d.path?.includes('/pstack/')), []);
}
console.log(JSON.stringify({ passed: true, mode: sourceOnly ? 'source' : 'runtime', skillCount: source.skills.length,
  automaticNames, optionalAutomaticNames, checks: ['55个唯一技能且无诊断', '基础两项自动、仅poteto-mode可选，其余手动且正文不注入', '全局发现与工作区真实路径去重'],
  scope: sourceOnly ? '无凭据临时agent目录/链接；不证明实际全局链接或已有会话生效。' : '实际全局链接与新进程SDK发现；不证明已有会话重载。',
  snapshot: '仅验证结构与发现合同，不验证上游固定提交的逐文件内容完整性。' }, null, 2));
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
