import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_ROOT_ENV } from './host-sdk.mjs';

const hosts = [
  '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent',
  process.env.PI_SUBAGENTS_TEST_HOST,
].filter(Boolean);
for (const host of hosts) test(`installed quiet extension registers on actual Pi 1.5 host: ${host}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-quiet-15-'));
  try {
    mkdirSync(join(root, 'extensions'));
    symlinkSync(dirname(fileURLToPath(import.meta.url)), join(root, 'extensions/subagents-quiet'));
    const script = `
      import { readFileSync } from 'node:fs';
      import { DefaultResourceLoader, SettingsManager } from ${JSON.stringify(join(realpathSync(host), 'dist/index.js'))};
      const manifest = JSON.parse(readFileSync(process.env[${JSON.stringify(HOST_ROOT_ENV)}] + '/package.json'));
      if (manifest.version !== '1.5.0') throw new Error('Test must exercise the actual 1.5.0 SDK');
      const loader = new DefaultResourceLoader({ cwd: process.argv[1], agentDir: process.argv[1],
        settingsManager: SettingsManager.inMemory({ packages: [], extensions: [] }),
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      const loaded = loader.getExtensions();
      if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
      if (!loaded.extensions.some(extension => extension.tools.has('subagent'))) throw new Error('quiet subagent tool not registered');
    `;
    const env = { ...process.env, [HOST_ROOT_ENV]: realpathSync(host), PI_PACKAGE_DIR: realpathSync(host), PI_OFFLINE: '1' };
    for (const name of ['PI_SUBAGENT_CHILD', 'PI_SUBAGENTS_HERDR_BRIDGE', 'PI_SESSION_ID', 'PI_SESSION_FILE']) delete env[name];
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '-e', script, root], { env, timeout: 30000, stdio: 'pipe' }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
