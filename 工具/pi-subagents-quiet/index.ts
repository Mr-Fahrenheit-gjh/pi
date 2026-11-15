import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { installedPackageURL } from "./installed-package.mjs";
import { pathToFileURL } from "node:url";
import { installInterruptSteer } from "./interrupt-steer.mjs";
import { quietSubagentAPI } from "./quiet-api.ts";
import { configureHostSdk } from "./host-sdk.mjs";
import { LOCAL_COMPLETION_POLICY } from "./notification-contract.mjs";

export default async function quietSubagents(pi: ExtensionAPI) {
  const host = configureHostSdk();
  const { AgentSession } = await import(pathToFileURL(join(host, "dist/index.js")).href);
  // Local child factories share this SDK class. Their initial prompt promise is
  // held across replacement runs, so they cannot finalize/dispose at the abort.
  // Detached runners still require the auditable core+bundle adapter replay.
  installInterruptSteer(AgentSession);
  const { default: registerSubagents } = await import(installedPackageURL());
  await registerSubagents(quietSubagentAPI(pi));
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n<local_subagent_completion_policy>\n${LOCAL_COMPLETION_POLICY}\n</local_subagent_completion_policy>`,
  }));
}
