import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { installInterruptSteer } from "../pi-web维护/pi-web-source-0.12.1-custom/lib/interrupt-steer.mjs";
import { quietSubagentAPI } from "./quiet-api.ts";
import { configureHostSdk } from "./host-sdk.mjs";
import { LOCAL_COMPLETION_POLICY } from "./notification-contract.mjs";

export default async function quietSubagents(pi: ExtensionAPI) {
  const host = configureHostSdk();
  const manifest = JSON.parse(readFileSync(`${host}/package.json`, "utf8"));
  if (!["1.3.0", "1.4.0"].includes(manifest.version)) throw new Error(`Interrupt steer requires verified SDK 1.3.0/1.4.0, got ${manifest.version}`);
  const { AgentSession } = await import(pathToFileURL(`${host}/dist/index.js`).href);
  // Local child factories share this SDK class. Their initial prompt promise is
  // held across replacement runs, so they cannot finalize/dispose at the abort.
  // Detached runners still require the auditable core+bundle adapter replay.
  installInterruptSteer(AgentSession);
  const { default: registerSubagents } = await import("/Users/guojiahang/.pi/agent/npm/node_modules/pi-subagents/index.js");
  await registerSubagents(quietSubagentAPI(pi));
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n<local_subagent_completion_policy>\n${LOCAL_COMPLETION_POLICY}\n</local_subagent_completion_policy>`,
  }));
}
