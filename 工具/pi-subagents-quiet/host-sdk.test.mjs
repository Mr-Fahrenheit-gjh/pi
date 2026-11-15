import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureHostSdk, HOST_ROOT_ENV } from './host-sdk.mjs';
import { installInterruptSteer } from './interrupt-steer.mjs';

function fixture(t, name = '@earendil-works/pi-coding-agent', version = '1.5.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi sdk space-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version }));
  fs.mkdirSync(path.join(root, 'dist'));
  for (const entry of ['index.js', 'cli.js']) fs.writeFileSync(path.join(root, 'dist', entry), '');
  return root;
}

test('native CLI host is derived from its running entry, with no Web installation', t => {
  const root = fixture(t);
  const env = {};
  assert.equal(configureHostSdk(env, path.join(root, 'dist/cli.js')), fs.realpathSync(root));
  assert.equal(env[HOST_ROOT_ENV], fs.realpathSync(root));
});

test('explicit SDK root wins; invalid roots and versions never fall back', t => {
  const host = fixture(t);
  const explicit = fixture(t, '@earendil-works/pi-coding-agent', '1.3.0');
  const wrapper = fixture(t, 'custom-launcher');
  assert.equal(configureHostSdk({ [HOST_ROOT_ENV]: explicit }, path.join(wrapper, 'dist/cli.js')), fs.realpathSync(explicit));
  assert.throws(() => configureHostSdk({ [HOST_ROOT_ENV]: explicit }, path.join(host, 'dist/cli.js')), /differs from current Pi host/);
  for (const [name, version] of [['other', '1.5.0'], ['@earendil-works/pi-coding-agent', '1.6.0'], ['@earendil-works/pi-coding-agent', '1.5.0-rc.1']]) {
    const bad = fixture(t, name, version);
    assert.throws(() => configureHostSdk({ [HOST_ROOT_ENV]: bad }, path.join(host, 'dist/cli.js')), /Invalid subagent SDK|requires verified SDK/);
  }
  fs.unlinkSync(path.join(explicit, 'dist/cli.js'));
  assert.throws(() => configureHostSdk({ [HOST_ROOT_ENV]: explicit }), /ENOENT/);
});

test('unknown launcher requires explicit SDK instead of adapter peer fallback', t => {
  const root = fixture(t, 'custom-launcher');
  assert.throws(() => configureHostSdk({}, path.join(root, 'dist/cli.js')), /Cannot identify current Pi host/);
});

test('Web host uses its own SDK dependency', t => {
  const web = fixture(t, '@agegr/pi-web');
  const sdk = path.join(web, 'node_modules/@earendil-works/pi-coding-agent');
  fs.mkdirSync(path.join(sdk, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.4.0', main: 'dist/index.js' }));
  for (const file of ['index.js', 'cli.js']) fs.writeFileSync(path.join(sdk, 'dist', file), '');
  assert.equal(configureHostSdk({}, path.join(web, 'dist/cli.js')), fs.realpathSync(sdk));
});

test('runtime configures host before import and owns a self-contained interrupt helper', () => {
  const source = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.ok(source.indexOf('configureHostSdk();') < source.indexOf('await import('));
  assert.match(source, /from "\.\/interrupt-steer\.mjs"/);
  assert.throws(() => installInterruptSteer(class Unsupported {}), /Unsupported AgentSession/);
  const required = ['prompt', 'steer', '_queueSteer', '_startRun', '_prepareRun', '_emitAgentSettled', '_emit', 'abort', 'dispose'];
  class Supported {}
  for (const name of required) Supported.prototype[name] = function () {};
  installInterruptSteer(Supported);
  const prompt = Supported.prototype.prompt;
  installInterruptSteer(Supported);
  assert.equal(Supported.prototype.prompt, prompt);
});
