import { randomUUID } from "node:crypto";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installAutoTitle } from "./core.ts";
import { TITLE_TIMEOUT_MS, TITLE_MAX_TOKENS, TITLE_SYSTEM_PROMPT, TITLE_PROMPT, parseGeneratedSessionTitle } from "./title.ts";

export const TITLE_MODEL = { provider: "openai-codex", id: "gpt-6-luna" } as const;

export default function autoTitle(pi: ExtensionAPI) {
  installAutoTitle(pi, async (transcript, ctx, signal) => {
    const model = ctx.modelRegistry.find(TITLE_MODEL.provider, TITLE_MODEL.id);
    if (!model) throw new Error(`找不到标题模型 ${TITLE_MODEL.provider}/${TITLE_MODEL.id}`);
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error("GPT 6 Luna 尚未配置登录授权");
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, TITLE_TIMEOUT_MS);
    try {
      const reasoning = model.reasoning ? getSupportedThinkingLevels(model)[0] : "off";
      const response = await ctx.modelRegistry.streamSimple(model, {
        systemPrompt: TITLE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: [{ type: "text", text: `${transcript}\n\n${TITLE_PROMPT}` }], timestamp: Date.now() }],
      }, {
        maxTokens: TITLE_MAX_TOKENS,
        cacheRetention: "none",
        sessionId: randomUUID(),
        signal: controller.signal,
        ...(reasoning && reasoning !== "off" ? { reasoning } : {}),
      }).result();
      if (response.stopReason === "error") throw new Error(response.errorMessage || "标题模型请求失败");
      if (response.stopReason === "aborted" || controller.signal.aborted) throw new Error("标题模型请求已取消或超时");
      return parseGeneratedSessionTitle(response.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  });
}
