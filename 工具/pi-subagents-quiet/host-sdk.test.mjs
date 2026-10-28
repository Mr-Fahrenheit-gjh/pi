import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureHostSdk, HOST_ROOT_ENV, WEB_SDK_ROOT } from './host-sdk.mjs';

test('Web host resolves without an npm peer link', () => {
  const env = {};
  assert.equal(configureHostSdk(env), fs.realpathSync(WEB_SDK_ROOT));
  assert.equal(env[HOST_ROOT_ENV], fs.realpathSync(WEB_SDK_ROOT));
});
test('explicit SDK root is preserved and validated, never silently replaced', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sdk-test-'));
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({name:'another-package'}));
    const env = {[HOST_ROOT_ENV]: tmp};
    assert.throws(() => configureHostSdk(env), /Invalid subagent SDK/);
    assert.equal(env[HOST_ROOT_ENV], tmp);
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({name:'@earendil-works/pi-coding-agent'}));
    assert.throws(() => configureHostSdk(env), /ENOENT/);
    fs.mkdirSync(path.join(tmp, 'dist'));
    for (const entry of ['index.js','cli.js']) fs.writeFileSync(path.join(tmp, 'dist', entry), '');
    assert.equal(configureHostSdk(env), fs.realpathSync(tmp));
  } finally { fs.rmSync(tmp, {recursive:true,force:true}); }
});
test('runtime configures host before dynamically importing the cached async runner', () => {
  const source = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.ok(source.indexOf('configureHostSdk();') < source.indexOf('await import('));
  assert.doesNotMatch(source, /import registerSubagents from/);
});
