import type { ExtensionCommandContext, ResolvedCommand } from '@earendil-works/pi-coding-agent';

export interface HistorySuggestionRunner {
  getCommand?(name: string): Pick<ResolvedCommand, 'handler' | 'sourceInfo'> | undefined;
  createCommandContext?(): ExtensionCommandContext;
}

export async function dispatchHistoryPromptSuggestion(
  runner: HistorySuggestionRunner,
  busy: boolean,
  leafId: unknown,
): Promise<{ available: boolean }> {
  if (busy || !runner.getCommand || !runner.createCommandContext
    || (leafId !== null && typeof leafId !== 'string')) return { available: false };
  const command = runner.getCommand('prompt-suggestions-history');
  if (!command || typeof command.sourceInfo?.path !== 'string'
    || !/\/pi-prompt-suggestions\/(?:src\/)?index\.ts$/.test(command.sourceInfo.path.replaceAll('\\', '/'))) {
    return { available: false };
  }
  await command.handler(JSON.stringify({ leafId }), runner.createCommandContext());
  return { available: true };
}

export async function requestOpenedPromptSuggestion(options: {
  sessionId: string;
  leafId: string | null;
  isCurrent(): boolean;
  hasDraft(): boolean;
  ensureConnected(sessionId: string): Promise<unknown>;
  send(sessionId: string, command: Record<string, unknown>): Promise<unknown>;
}): Promise<void> {
  if (!options.isCurrent() || options.hasDraft()) return;
  try {
    await options.ensureConnected(options.sessionId);
    if (!options.isCurrent() || options.hasDraft()) return;
    await options.send(options.sessionId, { type: 'request_prompt_suggestion', leafId: options.leafId });
  } catch {
    // Suggestions must not interrupt opening a session, including older servers without this command.
  }
}
