import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { installAdapter } from "./adapter.js";
import { assertRuntimeCompatibility, resolveUpstreamRoot } from "./compat.js";

// Deliberately local, not an npm-distributed package. No package copy, cwd
// search, npm install, settings edits or network resolution at startup.
export default async function browserAdapter(pi: ExtensionAPI): Promise<void> {
  const upstreamRoot = resolveUpstreamRoot();
  assertRuntimeCompatibility(upstreamRoot, getPackageDir());
  // Pi's jiti loader supplies host peer aliases to this installed JS graph.
  // A standalone Node import is not equivalent: the upstream optional Pi peers
  // need not exist beside this adapter.
  const entry = pathToFileURL(join(upstreamRoot, "dist", "extensions", "agent-browser", "index.js")).href;
  const module = await import(entry);
  await installAdapter(pi, module.default as ExtensionFactory);
}
