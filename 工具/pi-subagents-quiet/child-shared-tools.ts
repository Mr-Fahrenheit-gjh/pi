// SDK children need the official MCP/search factories; normal extensions remain ambient.
import { createMcpExtension, createToolSearchExtension, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerChildNotificationContract } from './child-notification-contract.ts';

export default async function childSharedTools(pi: ExtensionAPI) {
  registerChildNotificationContract(pi);
  // Codemode is already provided by pi-subagents' official SDK factory.
  await createToolSearchExtension()(pi);
  await createMcpExtension()(pi);
  pi.on('session_start', () => {
    pi.setActiveTools([...new Set([...pi.getActiveTools(), 'codemode', 'tool_search'])]);
  });
}
