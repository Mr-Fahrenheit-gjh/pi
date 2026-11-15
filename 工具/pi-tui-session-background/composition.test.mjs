import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { plan as attachments } from '../pi-attachment-presentation/install.mjs';
import { plan as interrupt } from '../pi-interrupt/install.mjs';
import { plan as background } from './install.mjs';

const source = realpathSync(process.env.PI_TUI_TEST_SDK ?? '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent');
const installer = (path) => fileURLToPath(new URL(path, import.meta.url));
const recovery = installer('../pi-web维护/native-agent-switcher/apply-candidate-recovery.mjs');
const scripts = ['../pi-interrupt/install.mjs', '../pi-attachment-presentation/install.mjs', './install.mjs'].map(installer);

test('real SDK and CLI chunks: recovery → interrupt → attachments → background replay twice, exact checks and unknown-byte refusal', { timeout: 30000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-cli-composition-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sdk = join(dir, 'node_modules/@earendil-works/pi-coding-agent');
  mkdirSync(sdk, { recursive: true });
  cpSync(join(source, 'dist'), join(sdk, 'dist'), { recursive: true });
  cpSync(join(source, 'package.json'), join(sdk, 'package.json'));
  // Restore the exact attachment originals only in our own copy. These also
  // precede the background adapter, according to the required replay order.
  for (const file of attachments(source).filter((file) => file.original !== null)) {
    const local = relative(source, file.path);
    assert.ok(!local.startsWith('..') && !local.startsWith('/'), 'fixture targets stay inside the isolated SDK');
    const path = join(sdk, local);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.original);
  }
  for (const name of ['pi-attachment-presentation-backup', 'pi-attachment-presentation-v2-backup', 'pi-tui-session-background-backup', 'pi-tui-session-background.mjs', 'pi-file-references.mjs']) {
    rmSync(join(sdk, 'dist', name), { recursive: true, force: true });
  }
  // Strip only the exact interrupt boundary, leaving any approved recovery
  // hooks in place. The next apply must regenerate both source forms.
  for (const [i, file] of interrupt(sdk).slice(0, 2).entries()) {
    const prefix = `import { installInterruptSteer as piInstallInterruptSteer } from '${i ? '../../' : '../'}pi-interrupt-engine.mjs';\n`;
    const suffix = '\n// pi-interrupt-steer-adapter:1\npiInstallInterruptSteer(AgentSession);\n';
    if (file.before.startsWith(prefix) && file.before.endsWith(suffix)) writeFileSync(file.path, file.before.slice(prefix.length, -suffix.length));
  }
  const run = (script, args) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe' });
  const replay = () => {
    run(recovery, [dir]);
    for (const script of scripts) run(script, ['--sdk', sdk, '--apply', '--allow-external']);
    run(recovery, [dir, '--check']);
    for (const script of scripts) run(script, ['--sdk', sdk, '--check']);
    for (const plan of [interrupt, attachments, background]) assert.ok(plan(sdk).every((file) => file.before === file.after));
  };
  replay();
  const snapshot = [...new Set([...interrupt(sdk), ...attachments(sdk), ...background(sdk)].map((file) => file.path))].map((path) => [path, readFileSync(path, 'utf8')]);
  replay();
  for (const [path, bytes] of snapshot) assert.equal(readFileSync(path, 'utf8'), bytes, path);
  for (const [path] of snapshot.filter(([path]) => path.endsWith('.js'))) execFileSync(process.execPath, ['--check', path]);
  const shared = background(sdk)[1];
  writeFileSync(shared.path, shared.before + '\n// unknown trailing source\n');
  assert.throws(() => interrupt(sdk), /Unrecognized/);
  assert.throws(() => attachments(sdk), /Unknown/);
  assert.throws(() => background(sdk), /fingerprint/);
  writeFileSync(shared.path, shared.before);
  const before = readFileSync(join(sdk, 'package.json'), 'utf8');
  writeFileSync(join(sdk, 'package.json'), before.replace(/"version":\s*"[^"]+"/, '"version":"1.5.1"'));
  for (const script of scripts) assert.notEqual(spawnSync(process.execPath, [script, '--sdk', sdk, '--apply', '--allow-external']).status, 0);
  assert.equal(readFileSync(shared.path, 'utf8'), shared.before);
});
