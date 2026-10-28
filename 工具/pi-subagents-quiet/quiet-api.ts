import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { adaptAsyncReceipt, adaptToolContract } from "./notification-contract.mjs";

const COMPLETION_TYPES = new Set([
  "subagent-notify",
  "subagent-incremental-child-notify",
]);

/** Keep results durable without creating a message or another model turn. */
export function quietSubagentAPI(pi: ExtensionAPI): ExtensionAPI {
  return {
    ...pi,
    registerTool(tool) {
      const contract = adaptToolContract(tool);
      if (tool.name !== "subagent") return pi.registerTool(contract);
      const execute: typeof tool.execute = async (id, params, signal, onUpdate, ctx) => {
        const update = onUpdate ? (result: Parameters<typeof onUpdate>[0]) => onUpdate(adaptAsyncReceipt(result)) : undefined;
        return adaptAsyncReceipt(await tool.execute.call(tool, id, params, signal, update, ctx));
      };
      pi.registerTool({ ...contract, execute });
    },
    sendMessage(message, options) {
      if (COMPLETION_TYPES.has(message.customType)) {
        pi.appendEntry("local.pi.subagents.completion", {
          originalType: message.customType,
          content: message.content,
          details: message.details,
          recordedAt: Date.now(),
        });
        return;
      }
      // Supervisor requests, infrastructure failures and explicit wait
      // subscriptions are not routine completion notifications.
      pi.sendMessage(message, options);
    },
  };
}
