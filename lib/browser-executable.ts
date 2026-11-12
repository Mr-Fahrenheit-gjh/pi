import { win32 } from "node:path";

/** Known Chrome locations on the server; never search the user's browser profile. */
export function chromeExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates = env.PI_WEB_CHROME_EXECUTABLE ? [env.PI_WEB_CHROME_EXECUTABLE] : [];
  if (platform === "win32") {
    for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]) {
      if (root) candidates.push(win32.join(root, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium");
  }
  return [...new Set(candidates)];
}
