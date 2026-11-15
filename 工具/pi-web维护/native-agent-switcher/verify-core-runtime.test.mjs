import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyCoreRuntime } from './verify-core-runtime.mjs';
const names = ['pi-agent-core', 'pi-ai', 'pi-codemode', 'pi-coding-agent', 'pi-mcp', 'pi-telemetry', 'pi-tui'];
function fixture(version = '1.3.0') {
  const root = mkdtempSync(join(tmpdir(), 'pi-core-gate-'));
  const packagesForVersion = [...names, ...(version === '1.5.0' ? ['pi-schema'] : [])];
  const deps = Object.fromEntries(packagesForVersion.map(name => ['@earendil-works/' + name, version]));
  const packages = {};
  for (const name of packagesForVersion) {
    const relative = 'node_modules/@earendil-works/' + name;
    mkdirSync(join(root, relative), { recursive: true });
    writeFileSync(join(root, relative, 'package.json'), JSON.stringify({ name: '@earendil-works/' + name, version, main: './dist/index.js' }));
    packages[relative] = { version };
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: deps }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages }));
  const sdk = join(root, 'node_modules/@earendil-works/pi-coding-agent');
  mkdirSync(join(sdk, 'dist/core'), { recursive: true });
  mkdirSync(join(sdk, 'dist/bundle/chunks'), { recursive: true });
  const hooks = 'piRecoveryStop(this.sessionManager);piRecoverySpent(this.sessionManager);piRecoveryRetry(this.sessionManager, 1);';
  const normal = join(sdk, 'dist/core/agent-session.js');
  writeFileSync(normal, hooks);
  writeFileSync(join(sdk, 'dist/bundle/chunks/agent.js'), 'async _prepareRetry(message){' + hooks);
  writeFileSync(join(sdk, 'dist/index.js'), '');
  writeFileSync(join(sdk, 'dist/cli.js'), '');
  return { root, sdk, normal, hooks };
}
for (const [name, modify, pattern] of [
  ['missing recovery hook', f => writeFileSync(f.normal, f.hooks.replace('piRecoveryStop(this.sessionManager);', '')), /Missing\/duplicate recovery hook/],
  ['duplicate recovery hook', f => writeFileSync(f.normal, f.hooks + 'piRecoveryStop(this.sessionManager);'), /Missing\/duplicate recovery hook/],
  ['split nested SDK dependency', f => { const p = join(f.sdk, 'node_modules/@earendil-works/pi-ai'); mkdirSync(p, { recursive: true }); writeFileSync(join(p, 'package.json'), '{"version":"1.3.0"}'); }, /Split SDK/],
  ['missing runner peers', () => {}, /Expected values to be strictly deep-equal/],
]) test(`core gate refuses ${name}`, async () => {
  const f = fixture();
  try { modify(f); await assert.rejects(verifyCoreRuntime(f.root), pattern); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});
for (const version of ['1.4.0', '1.5.0']) test(`${version} gate rejects a wrong target and still checks recovery hooks`, async () => {
  const f = fixture(version);
  try {
    await assert.rejects(verifyCoreRuntime(f.root, '1.3.0'), /Expected values/);
    writeFileSync(f.normal, '');
    await assert.rejects(verifyCoreRuntime(f.root, version), /Missing\/duplicate recovery hook/);
    await assert.rejects(verifyCoreRuntime(f.root, '1.6.0'), /Unsupported core target/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('core gate refuses an outside SDK even when its version is correct', async () => {
  const f = fixture(); const other = fixture();
  try {
    rmSync(f.sdk, { recursive: true }); symlinkSync(other.sdk, f.sdk);
    await assert.rejects(verifyCoreRuntime(f.root), /SDK must belong to this runtime/);
  } finally { rmSync(f.root, { recursive: true, force: true }); rmSync(other.root, { recursive: true, force: true }); }
});
