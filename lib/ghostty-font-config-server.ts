import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_GHOSTTY_FONT, parseGhosttyFontConfig, type GhosttyFontPreferences } from "./ghostty-font-config";

const execute = promisify(execFile);
let cached: { at: number; value: GhosttyFontPreferences } | undefined;
let pending: Promise<GhosttyFontPreferences> | undefined;

/** Native parser handles config.ghostty, includes and precedence. No shell or caller arguments. */
export function readGhosttyFontPreferences(): Promise<GhosttyFontPreferences> {
  if (cached && Date.now() - cached.at < 2000) return Promise.resolve(cached.value);
  if (pending) return pending;
  const executable = process.platform === "darwin" ? "/Applications/Ghostty.app/Contents/MacOS/ghostty" : "ghostty";
  pending = execute(executable, ["+show-config"], { timeout: 2000, maxBuffer: 512 * 1024 })
    .then(({ stdout }) => parseGhosttyFontConfig(stdout))
    .catch(() => ({ ...DEFAULT_GHOSTTY_FONT }))
    .then((value) => { cached = { at: Date.now(), value }; return value; })
    .finally(() => { pending = undefined; });
  return pending;
}
