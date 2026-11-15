import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

// The npm package now registers the backend in Web and terminal sessions.
// This adapter only retains terminal policy and resource discovery.
export default async function (pi: ExtensionAPI) {
  if (process.env.PI_WEB_HOSTNAME !== undefined) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const args = process.argv.slice(2);
  if (args.some((arg) => ["--print", "-p", "--mode", "--help", "-h", "--version", "-v"].includes(arg) || arg.startsWith("--mode="))) return;
  const { registerRequiredChildExtensions } = await import("../npm/node_modules/pi-subagents/src/api/required-child-extensions.js");
  let policy: { dispose(): void } | undefined;
  pi.on("session_start", (_event, ctx) => {
    policy?.dispose();
    policy = registerRequiredChildExtensions({ sessionId: ctx.sessionManager.getSessionId(), extensions: [{ id: "shared-subagent-policy", path: fileURLToPath(new URL("./subagent/shared-policy.ts", import.meta.url)) }], requireForAllRunners: true });
  });
  pi.on("session_shutdown", () => policy?.dispose());
  pi.on("resources_discover", async () => ({
    skillPaths: [fileURLToPath(new URL("../npm/node_modules/pi-subagents/skills", import.meta.url))],
    promptPaths: [fileURLToPath(new URL("../npm/node_modules/pi-subagents/prompts", import.meta.url))],
  }));
}
