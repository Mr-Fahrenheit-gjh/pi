import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withFilteredFooter } from "./footer-status-filter.ts";
import { withSessionRenderReset } from "./session-render-reset.ts";

// Preserve the installed UI; filter footer statuses and coordinate its session clear.
export default async function (pi) {
  const { default: beautifulTui } = await import(join(getAgentDir(), "npm/node_modules/pi-beautiful-tui/index.ts"));
  beautifulTui(withSessionRenderReset(withFilteredFooter(pi)));
}
