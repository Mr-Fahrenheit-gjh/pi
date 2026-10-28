import fs from 'node:fs';
import path from 'node:path';

export const HOST_ROOT_ENV = 'PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT';
export const WEB_SDK_ROOT = '/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent';

// Establish the host before importing pi-subagents: its async runner caches this
// value at module evaluation time. Do not depend on npm preserving a peer link.
export function configureHostSdk(env = process.env, fallback = WEB_SDK_ROOT) {
  const root = env[HOST_ROOT_ENV]?.trim() || fallback;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== '@earendil-works/pi-coding-agent') {
    throw new Error(`Invalid subagent SDK package: ${root}`);
  }
  for (const entry of ['dist/index.js', 'dist/cli.js']) {
    if (!fs.statSync(path.join(root, entry)).isFile()) {
      throw new Error(`Missing subagent SDK entry: ${entry}`);
    }
  }
  env[HOST_ROOT_ENV] = fs.realpathSync(root);
  return env[HOST_ROOT_ENV];
}
