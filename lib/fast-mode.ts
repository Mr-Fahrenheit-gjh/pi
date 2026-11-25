import type { ExtensionCommandContext, ResolvedCommand } from "@earendil-works/pi-coding-agent";

export type FastMode = "auto" | "standard" | "fast" | "ultrafast";
export interface FastModeState {
  available: boolean;
  supported: boolean;
  ultrafastSupported: boolean;
  mode: FastMode;
}

export const isUltrafastModel = (provider: string, modelId: string) =>
  provider === "openai-codex" && modelId === "gpt-6.2-sol";

interface FastModeSession {
  extensionRunner: {
    getCommand?(name: string): Pick<ResolvedCommand, "handler" | "sourceInfo"> | undefined;
    createCommandContext?(): ExtensionCommandContext;
  };
  sessionManager: { getBranch(): readonly unknown[] };
}

function speedCommand(session: FastModeSession, name: "fast" | "ultrafast") {
  const command = session.extensionRunner.getCommand?.(name);
  const path = command?.sourceInfo?.path;
  return typeof path === "string" && /\/(?:pi-codex-speed|extensions\/codex-speed)\/index\.ts$/.test(path.replaceAll("\\", "/"))
    ? command : undefined;
}

export function readFastModeState(session: FastModeSession): FastModeState {
  const available = Boolean(speedCommand(session, "fast") && session.extensionRunner.createCommandContext);
  if (!available) return { available: false, supported: false, ultrafastSupported: false, mode: "auto" };
  const hasUltrafast = Boolean(speedCommand(session, "ultrafast"));
  const model = session.extensionRunner.createCommandContext!().model;
  const supported = Boolean(model && (
    (model.provider === "openai" && model.api === "openai-responses")
    || (model.provider === "openai-codex" && model.api === "openai-codex-responses")
  ));
  let mode: FastMode = "auto";
  for (const entry of session.sessionManager.getBranch()) {
    if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "custom"
      || !("customType" in entry) || entry.customType !== "codex-speed-mode" || !("data" in entry)) continue;
    const data = entry.data;
    const saved = data && typeof data === "object" && "mode" in data ? data.mode : undefined;
    if (saved === "auto" || saved === "standard" || saved === "fast") mode = saved;
    else if (saved === "ultrafast") {
      mode = hasUltrafast && data && typeof data === "object" && "version" in data && data.version === 2
        ? "ultrafast" : "standard";
    }
  }
  const ultrafastSupported = Boolean(hasUltrafast && model?.api === "openai-codex-responses"
    && isUltrafastModel(model.provider, model.id));
  return { available, supported, ultrafastSupported, mode };
}

export async function setFastMode(session: FastModeSession, mode: unknown): Promise<FastModeState> {
  if (mode !== "auto" && mode !== "standard" && mode !== "fast" && mode !== "ultrafast") throw new Error("Invalid fast mode");
  const state = readFastModeState(session);
  if (mode === "ultrafast" && !state.ultrafastSupported) {
    throw new Error("Ultrafast requires Codex GPT-6.2 Sol and an up-to-date speed extension");
  }
  if (!state.available) throw new Error("Fast control unavailable: reload the session with the Fast extension enabled");
  if (!state.supported) throw new Error("Fast requires an OpenAI Responses or Codex model");
  const runner = session.extensionRunner;
  // Fixed command and arguments only: no prompt, arbitrary extension dispatch or abort.
  const command = speedCommand(session, mode === "ultrafast" ? "ultrafast" : "fast")!;
  await command.handler(mode === "standard" ? "off" : mode === "auto" ? "auto" : "on", runner.createCommandContext!());
  const updated = readFastModeState(session);
  if (updated.mode !== mode) throw new Error("Speed switch was refused; reload the idle session to update its extension");
  return updated;
}
