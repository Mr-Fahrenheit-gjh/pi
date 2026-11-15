import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Only intercept this plugin's completion notice; keep every other API unchanged. */
export function quietCompletionAPI(pi: ExtensionAPI): ExtensionAPI {
  return {
    ...pi,
    sendMessage(message, options) {
      if (message.customType === "pi-background-task:completion") {
        pi.appendEntry("local.pi.background-task.completion", {
          ...message.details,
          recordedAt: Date.now(),
        });
        return;
      }
      pi.sendMessage(message, options);
    },
  };
}
