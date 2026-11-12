import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installedPackageURL } from "./installed-package.mjs";

import { quietCompletionAPI } from "./quiet-api.ts";

export default async function quietBackgroundTasks(pi: ExtensionAPI) {
  const { default: backgroundTaskExtension } = await import(installedPackageURL());
  await backgroundTaskExtension(quietCompletionAPI(pi));
}
