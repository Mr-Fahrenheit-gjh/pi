import assert from 'node:assert/strict';
import { readFileSync, statSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const agent = join(homedir(), '.pi/agent');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mcp = () => json(join(agent, 'mcp.json'));
const config = () => json(join(agent, 'extensions/subagent/config.json'));
const baseline = process.env.PI_CONFIG_REPAIR_BASELINE;

function isolatedPrefix() {
  const entry = mcp().mcpServers.shadcn;
  assert.equal(entry.command, '/usr/bin/env');
  assert.equal(entry.args[0], '-i');
  assert(!Object.hasOwn(entry, 'inheritEnv'), 'Remove the unsupported, misleading field');
  const commandAt = entry.args.indexOf('npx');
  assert(commandAt > 1, 'Expected isolated npx entry');
  assert.deepEqual(entry.args.slice(commandAt), ['npx', '-y', 'shadcn@4.21.0', 'mcp']);
  const names = entry.args.slice(1, commandAt).map(item => item.split('=')[0]);
  assert.deepEqual(names.sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
  return { command: entry.command, args: entry.args.slice(0, commandAt) };
}

test('shadcn uses an executable environment boundary without dependency changes', () => {
  isolatedPrefix();
  assert.equal(statSync(join(agent, 'mcp.json')).mode & 0o777, 0o600);
});

test('actual env child drops synthetic provider secrets and arbitrary host variables', () => {
  const { command, args } = isolatedPrefix();
  const probe = `process.stdout.write(JSON.stringify({ secret: 'PI_CONFIG_TEST_SECRET' in process.env, provider: 'OPENAI_API_KEY' in process.env, arbitrary: 'UNLISTED' in process.env, path: !!process.env.PATH, home: !!process.env.HOME, tmp: !!process.env.TMPDIR }));`;
  const child = spawnSync(command, [...args, process.execPath, '-e', probe], {
    env: { PI_CONFIG_TEST_SECRET: 'fixture-only', OPENAI_API_KEY: 'fixture-only', UNLISTED: 'fixture-only', PATH: '/not-used' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 0, 'The isolated Node probe must exit normally');
  assert.deepEqual(JSON.parse(child.stdout), { secret: false, provider: false, arbitrary: false, path: true, home: true, tmp: true });
});

test('password-fill source and runtime agree and do not reroute other browser backends', () => {
  const source = readFileSync(join(root, '工具/密码管理/当前页凭据填充/skill/SKILL.md'), 'utf8');
  assert.equal(readFileSync(join(agent, 'skills/password-fill/SKILL.md'), 'utf8'), source);
  assert.doesNotMatch(source, /Use whenever a task hits a login form/);
  assert.match(source, /already.*agent-browser/);
  assert.match(source, /Playwright.*OpenCLI/);
  assert.match(source, /Do not switch/);
  assert.doesNotMatch(source, /2\. `agent-browser open/);
  assert.doesNotMatch(source, /open the https login page in agent-browser first/);
  assert.match(source, /`NO_BROWSER`: Stop filling/);
});

test('missing task browser returns a stop hint without looking up accounts or filling', async () => {
  const { main } = await import(join(root, '工具/密码管理/当前页凭据填充/pw.mjs'));
  let downstreamCalls = 0;
  const result = await main(['fill', '--session', 'fixture-only'], {
    currentPage: async () => { throw new Error('NO_BROWSER'); },
    candidates: async () => { downstreamCalls++; return []; },
    fill: async () => { downstreamCalls++; throw new Error('must not fill'); },
  });
  assert.equal(result.reason, 'NO_BROWSER');
  assert.equal(downstreamCalls, 0);
  assert.match(result.hint, /停止填写/);
  assert.doesNotMatch(result.hint, /agent-browser open/);
});

test('only obsolete parallel settings are removed, keeping effective concurrency and depth', () => {
  const value = config();
  assert(!Object.hasOwn(value, 'parallel'));
  assert.equal(value.globalConcurrencyLimit, 3);
  assert.equal(value.maxSubagentDepth, 2);
  assert(!Object.hasOwn(value, 'maxSubagentSpawnsPerRun'), 'Do not invent a new task budget');
});

test('unrelated private config stays byte-equivalent as JSON to the secure baseline', { skip: !baseline }, () => {
  const before = json(join(baseline, 'mcp.json'));
  const after = mcp();
  const priorEntry = { ...before.mcpServers.shadcn };
  const currentEntry = { ...after.mcpServers.shadcn };
  for (const entry of [priorEntry, currentEntry]) for (const key of ['command', 'args', 'inheritEnv']) delete entry[key];
  assert.equal(fingerprint(currentEntry), fingerprint(priorEntry), 'Unrelated shadcn fields must not change');
  delete before.mcpServers.shadcn; delete after.mcpServers.shadcn;
  assert.equal(fingerprint(after), fingerprint(before), 'Other servers/fields must not change');
  const priorConfig = json(join(baseline, 'subagent-config.json'));
  delete priorConfig.parallel;
  assert.equal(fingerprint(config()), fingerprint(priorConfig), 'Do not change other subagent settings');
});

test('MCP checker accepts SDK references without executing commands and still warns on literals', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-config-check-'));
  try {
    const checker = join(here, 'mcp-wiring/scripts/check.py');
    assert.equal(readFileSync(join(agent, 'skills/mcp-wiring/scripts/check.py'), 'utf8'), readFileSync(checker, 'utf8'));
    const marker = join(directory, 'command-must-not-run');
    const file = join(directory, 'mcp.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { fixture: { command: 'unused', headers: { Authorization: `!touch ${marker}`, token: '${FIXTURE_TOKEN}', 'X-API-KEY': 'Bearer ${FIXTURE_KEY}' } } } }));
    const referenced = spawnSync('python3', [checker, file], { encoding: 'utf8', timeout: 5000 });
    assert.equal(referenced.status, 0, 'SDK command/env references are not literal credentials');
    assert.equal(existsSync(marker), false);
    writeFileSync(file, JSON.stringify({ mcpServers: { fixture: { command: 'unused', headers: { token: 'TEST_ONLY_LITERAL_SECRET' } } } }));
    const literal = spawnSync('python3', [checker, file], { encoding: 'utf8', timeout: 5000 });
    assert.equal(literal.status, 1);
    assert(!literal.stdout.includes('TEST_ONLY_LITERAL_SECRET'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
