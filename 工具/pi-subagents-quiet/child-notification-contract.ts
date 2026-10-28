import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { adaptAsyncReceipt, adaptToolContract, adaptDelegationText } from './notification-contract.mjs';

/** Child factories register tools outside the root proxy. Adapt only request-local declarations. */
export function registerChildNotificationContract(pi: ExtensionAPI) {
  pi.on('context_with_system', event => {
    let changed = false;
    const messages = event.messages.map(message => {
      if (message.role !== 'system') return message;
      const toolsAdded = message.toolsAdded?.map(adaptToolContract);
      const content = adaptDelegationText(message.content);
      const sections = message.sections && Object.fromEntries(Object.entries(message.sections).map(([key, value]) => [key, value === null ? null : adaptDelegationText(value)]));
      if (content === message.content && Object.entries(sections ?? {}).every(([key, value]) => value === message.sections?.[key])
        && (toolsAdded ?? []).every((tool, index) => tool === message.toolsAdded![index])) return message;
      changed = true;
      // Keep the leading system message, unrelated sections, timestamps and removal deltas.
      return { ...message, content,
        ...(message.sections === undefined ? {} : { sections }),
        ...(message.toolsAdded === undefined ? {} : { toolsAdded }),
      };
    });
    return changed ? { messages } : undefined;
  });
  pi.on('tool_result', event => {
    if (event.toolName !== 'subagent') return;
    const adapted = adaptAsyncReceipt(event);
    if (adapted === event) return;
    // Returning content alone makes the SDK drop structuredContent. This is wording, not redaction.
    return { content: adapted.content, structuredContent: event.structuredContent };
  });
}
