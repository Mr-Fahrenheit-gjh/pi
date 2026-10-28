// Verified Pi 1.2.0/1.3.0/1.4.0 hosts no longer import chord; keep all other hosts strict.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureHostSdk } from './host-sdk.mjs';
export const oldBlock = `    const isPreChord = stableVersion !== null && Number(stableVersion[1]) < 85;
    const required = [...HOST_PEER_ALIASES, ...(isPreChord ? [] : CHORD_PEER_ALIASES)];`;
export const legacyBlock = `    const isPreChord = stableVersion !== null && Number(stableVersion[1]) < 85;
    // Local compatibility: verified Pi 1.2.0 removed chord from the host import graph.
    // Never hide a missing declared dependency or relax unknown/prerelease hosts.
    const declaresChord = ["dependencies", "optionalDependencies", "peerDependencies"].some(
        (field) => Object.hasOwn(hostManifest?.[field] ?? {}, "@earendil-works/chord"));
    const isVerifiedPostChord = hostManifest?.version === "1.2.0" && !declaresChord;
    const required = [...HOST_PEER_ALIASES, ...(isPreChord || isVerifiedPostChord ? [] : CHORD_PEER_ALIASES)];`;
export const previousBlock = legacyBlock
  .replace('verified Pi 1.2.0 removed chord', 'verified Pi 1.2.0/1.3.0 removed chord')
  .replace('hostManifest?.version === "1.2.0"', '["1.2.0", "1.3.0"].includes(hostManifest?.version)');
export const newBlock = previousBlock
  .replace('verified Pi 1.2.0/1.3.0 removed chord', 'verified Pi 1.2.0/1.3.0/1.4.0 removed chord')
  .replace('["1.2.0", "1.3.0"]', '["1.2.0", "1.3.0", "1.4.0"]');
export function patch(source) {
  if (source.includes(newBlock)) return source;
  const before = source.includes(previousBlock) ? previousBlock : source.includes(legacyBlock) ? legacyBlock : oldBlock;
  if (source.split(before).length !== 2) throw new Error('Unrecognized runner-aliases source; refusing patch');
  return source.replace(before, newBlock);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Validate the explicit host before writing anything. The adapter configures
  // this same process-local override before loading the async runner.
  const host = configureHostSdk();
  const target=path.join(os.homedir(),'.pi/agent/npm/node_modules/pi-subagents/src/runs/background/runner-aliases.js');
  const old=fs.readFileSync(target,'utf8'), next=patch(old);
  if (next!==old) fs.writeFileSync(target,next);
  console.log(next===old?'Already patched':'Applied runner Pi 1.2.0/1.3.0/1.4.0 compatibility');
  // npm peer links are an optional upstream fallback, not our source of truth.
  // Do not create, remove or replace installation links during compatibility replay.
  console.log(`Explicit host SDK verified: ${host}`);
}
