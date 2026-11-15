import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const HOST_ROOT_ENV = 'PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT';
const SDK_NAME = '@earendil-works/pi-coding-agent';
const VERIFIED_VERSIONS = new Set(['1.3.0', '1.4.0', '1.5.0']);

// Only inspect the running executable's package, never this adapter's npm peers.
// A detached/custom launcher must supply an explicit root instead of guessing.
export function currentHostSdk(argvEntry = process.argv[1]) {
  if (!argvEntry) throw new Error(`Cannot identify current Pi host; set ${HOST_ROOT_ENV}`);
  let entry;
  try { entry = fs.realpathSync(argvEntry); }
  catch { throw new Error(`Cannot identify current Pi host; set ${HOST_ROOT_ENV}`); }
  let dir = path.dirname(entry);
  while (true) {
    const manifestFile = path.join(dir, 'package.json');
    if (fs.existsSync(manifestFile)) {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (manifest.name === SDK_NAME) return dir;
      if (manifest.name === '@agegr/pi-web') {
        const expected = fs.realpathSync(path.join(dir, 'node_modules', SDK_NAME));
        const entry = createRequire(manifestFile).resolve(SDK_NAME);
        const root = sdkRootForEntry(entry);
        if (root !== expected) throw new Error('Current Web host resolved a different Pi SDK');
        return root;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Cannot identify current Pi host; set ${HOST_ROOT_ENV}`);
}

function sdkRootForEntry(entry) {
  let dir = path.dirname(fs.realpathSync(entry));
  while (true) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).name === SDK_NAME) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Current host resolved an invalid Pi SDK');
    dir = parent;
  }
}

// Establish the host before importing pi-subagents: its async runner caches this
// value at module evaluation time. Explicit invalid roots must fail closed.
export function configureHostSdk(env = process.env, argvEntry = process.argv[1]) {
  const root = env[HOST_ROOT_ENV]?.trim() || currentHostSdk(argvEntry);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== SDK_NAME) throw new Error(`Invalid subagent SDK package: ${root}`);
  if (!VERIFIED_VERSIONS.has(manifest.version)) {
    throw new Error(`Interrupt steer requires verified SDK 1.3.0/1.4.0/1.5.0, got ${manifest.version}`);
  }
  for (const entry of ['dist/index.js', 'dist/cli.js']) {
    if (!fs.statSync(path.join(root, entry)).isFile()) throw new Error(`Missing subagent SDK entry: ${entry}`);
  }
  const verified = fs.realpathSync(root);
  if (env[HOST_ROOT_ENV]?.trim()) {
    let current;
    try { current = currentHostSdk(argvEntry); }
    catch (error) {
      if (!error.message.startsWith('Cannot identify current Pi host')) throw error;
    }
    if (current && fs.realpathSync(current) !== verified) {
      throw new Error('Explicit subagent SDK differs from current Pi host');
    }
  }
  env[HOST_ROOT_ENV] = verified;
  return verified;
}
