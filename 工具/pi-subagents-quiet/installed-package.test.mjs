import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installedPackageURL } from './installed-package.mjs';

test('installed package follows agent directory and explicit root, with URL-safe spaces', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet user space-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agent = path.join(home, 'custom agent');
  const root = path.join(agent, 'npm/node_modules/pi-subagents');
  fs.mkdirSync(path.dirname(path.join(root, 'index.js')), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pi-subagents' }));
  fs.writeFileSync(path.join(root, 'index.js'), '');
  const expected = pathToFileURL(path.join(root, 'index.js')).href;
  assert.equal(installedPackageURL({ PI_CODING_AGENT_DIR: agent }, home), expected);
  assert.equal(installedPackageURL({ PI_SUBAGENTS_PACKAGE_ROOT: root }, home), expected);
  assert.throws(() => installedPackageURL({ PI_SUBAGENTS_PACKAGE_ROOT: path.join(home, 'missing'), PI_CODING_AGENT_DIR: agent }, home), /ENOENT/);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'other' }));
  assert.throws(() => installedPackageURL({ PI_SUBAGENTS_PACKAGE_ROOT: root }, home), /Invalid/);
});
