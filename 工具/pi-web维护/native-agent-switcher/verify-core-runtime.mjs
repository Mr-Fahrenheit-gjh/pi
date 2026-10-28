// Read-only runtime identity/compatibility gate. Never opens a session or calls a model.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { configureHostSdk, HOST_ROOT_ENV } from '../../pi-subagents-quiet/host-sdk.mjs';

const names = ['pi-agent-core', 'pi-ai', 'pi-codemode', 'pi-coding-agent', 'pi-mcp', 'pi-telemetry', 'pi-tui'];
export async function verifyCoreRuntime(packageRoot, expectedVersion = '1.3.0') {
  assert.ok(['1.3.0', '1.4.0'].includes(expectedVersion), 'Unsupported core target');
  const root = realpathSync(packageRoot);
  const sdkRoot = realpathSync(join(root, 'node_modules/@earendil-works/pi-coding-agent'));
  assert.ok(sdkRoot.startsWith(root + '/'), 'SDK must belong to this runtime');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const requireFromSdk = createRequire(join(sdkRoot, 'package.json'));
  for (const name of names) {
    const specifier = '@earendil-works/' + name;
    assert.equal(pkg.dependencies[specifier], expectedVersion);
    assert.equal(lock.packages['node_modules/' + specifier].version, expectedVersion);
    // ESM-only packages deliberately have no require export. Compare the nearest
    // node_modules package identity rather than require.resolve() of their entry.
    const manifest = requireFromSdk.resolve.paths(specifier).map(base => join(base, specifier, 'package.json')).find(existsSync);
    assert.ok(manifest, `Missing SDK dependency: ${specifier}`);
    assert.equal(realpathSync(manifest), realpathSync(join(root, 'node_modules', specifier, 'package.json')), `Split SDK: ${specifier}`);
    assert.equal(JSON.parse(readFileSync(join(root, 'node_modules', specifier, 'package.json'), 'utf8')).version, expectedVersion);
  }
  const chunks = join(sdkRoot, 'dist/bundle/chunks');
  const bundled = readdirSync(chunks).filter(name => name.endsWith('.js')).map(name => join(chunks, name)).filter(path => readFileSync(path, 'utf8').includes('async _prepareRetry(message){'));
  assert.equal(bundled.length, 1);
  for (const path of [join(sdkRoot, 'dist/core/agent-session.js'), bundled[0]]) {
    assert.ok(realpathSync(path).startsWith(root + '/'));
    const text = readFileSync(path, 'utf8');
    for (const marker of ['piRecoveryStop(this.sessionManager)', 'piRecoverySpent(this.sessionManager)', 'piRecoveryRetry(this.sessionManager']) assert.equal(text.split(marker).length, 2, `Missing/duplicate recovery hook: ${path}`);
  }
  // Explicit candidate-local host identity; no shell config or npm peer links.
  const env = { [HOST_ROOT_ENV]: sdkRoot };
  assert.equal(configureHostSdk(env), sdkRoot);
  const { resolveHostPeerAliases } = await import(pathToFileURL(join(homedir(), '.pi/agent/npm/node_modules/pi-subagents/src/runs/background/runner-aliases.js')));
  const peers = resolveHostPeerAliases(sdkRoot);
  assert.deepEqual(peers.missing, []);
  assert.ok(realpathSync(peers.aliases['@earendil-works/pi-coding-agent']).startsWith(sdkRoot + '/'));
  const sdk = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')));
  assert.equal(typeof sdk.createAgentSessionFromServices, 'function');
  assert.equal(typeof sdk.createAgentSessionServices, 'function');
  assert.equal(typeof sdk.SessionManager.open, 'function');
  return { sdkVersion: expectedVersion, sdkRoot, sharedRecoveryHooksVerified: true, subagentPeerAliasesVerified: true, sdkImportsVerified: true, realModelRequests: 0 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = realpathSync(process.argv[2]);
  const result = { passed: true, ...await verifyCoreRuntime(root, process.argv[3] || '1.3.0'), packageRoot: root, buildId: readFileSync(join(root, '.next/BUILD_ID'), 'utf8').trim(), at: new Date().toISOString() };
  const out = join(root, 'test-results/core-upgrade');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
