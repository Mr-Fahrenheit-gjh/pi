import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import backgroundTaskExtension from "/Users/guojiahang/.pi/agent/npm/node_modules/pi-background-task/dist/index.js";

import { quietCompletionAPI } from "./quiet-api.ts";

export default function quietBackgroundTasks(pi: ExtensionAPI) {
  backgroundTaskExtension(quietCompletionAPI(pi));
}
