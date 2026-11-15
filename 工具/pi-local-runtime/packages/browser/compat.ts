import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

export const COMPATIBILITY = Object.freeze({
  hostPackage: "@earendil-works/pi-coding-agent",
  hostVersion: "0.85.1",
  upstreamPackage: "pi-agent-browser-native",
  upstreamVersion: "0.6.10",
});

interface PackageInfo {
  name?: string;
  version?: string;
}

export interface UpstreamResolutionOptions {
  home?: string;
  piAgentDir?: string;
  moduleUrl?: string;
}

function readPackage(path: string): PackageInfo {
  return JSON.parse(readFileSync(path, "utf8")) as PackageInfo;
}

/** Resolve only from Pi-owned install roots or Node module resolution; never cwd/network. */
export function resolveUpstreamRoot(options: UpstreamResolutionOptions = {}): string {
  const home = options.home ?? homedir();
  const piAgentDir = options.piAgentDir ?? process.env.PI_CODING_AGENT_DIR;
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const candidates: Array<{ source: string; root: string }> = [];
  if (piAgentDir) candidates.push({ source: "PI_CODING_AGENT_DIR npm root", root: join(piAgentDir, "npm", "node_modules", COMPATIBILITY.upstreamPackage) });
  if (home) candidates.push({ source: "HOME Pi npm root", root: join(home, ".pi", "agent", "npm", "node_modules", COMPATIBILITY.upstreamPackage) });
  try {
    const packageJson = createRequire(moduleUrl).resolve(`${COMPATIBILITY.upstreamPackage}/package.json`);
    candidates.push({ source: "Node module resolution", root: dirname(packageJson) });
  } catch {
    // Reported with the filesystem candidates below.
  }

  const seen = new Set<string>();
  const diagnostics: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.root)) continue;
    seen.add(candidate.root);
    const packageJson = join(candidate.root, "package.json");
    if (!existsSync(packageJson)) {
      diagnostics.push(`${candidate.source}: not found at ${candidate.root}`);
      continue;
    }
    try {
      const info = readPackage(packageJson);
      if (info.name !== COMPATIBILITY.upstreamPackage) {
        diagnostics.push(`${candidate.source}: expected package ${COMPATIBILITY.upstreamPackage}, found ${info.name ?? "unnamed"} at ${candidate.root}`);
      } else if (info.version !== COMPATIBILITY.upstreamVersion) {
        diagnostics.push(`${candidate.source}: found ${info.version ?? "unknown version"} at ${candidate.root}; expected ${COMPATIBILITY.upstreamVersion}`);
      } else {
        return candidate.root;
      }
    } catch (error) {
      diagnostics.push(`${candidate.source}: unreadable package.json at ${candidate.root} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  throw new Error(
    `Browser adapter requires ${COMPATIBILITY.upstreamPackage} ${COMPATIBILITY.upstreamVersion}, but no compatible installed package was found. ` +
    `Checked only Pi npm roots and local module resolution (no cwd search or network).\n- ${diagnostics.join("\n- ") || "Node module resolution did not find the package."}`,
  );
}

export function assertRuntimeCompatibility(upstreamRoot: string, hostRoot: string): { upstream: string; host: string } {
  const upstream = readPackage(join(upstreamRoot, "package.json")).version ?? "unknown";
  const host = readPackage(join(hostRoot, "package.json")).version ?? "unknown";
  if (upstream !== COMPATIBILITY.upstreamVersion || host !== COMPATIBILITY.hostVersion) {
    throw new Error(
      `Browser adapter compatibility check failed: ` +
      `${COMPATIBILITY.upstreamPackage} expected ${COMPATIBILITY.upstreamVersion}, found ${upstream} at ${upstreamRoot}; ` +
      `${COMPATIBILITY.hostPackage} expected ${COMPATIBILITY.hostVersion}, found ${host} at ${hostRoot}. ` +
      `Re-audit before upgrading; use the original browser package meanwhile.`,
    );
  }
  return { upstream, host };
}
