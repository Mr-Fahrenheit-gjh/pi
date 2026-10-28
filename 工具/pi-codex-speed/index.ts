import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Mode = "standard" | "fast";
const ENTRY = "codex-speed-mode";
const STATUS = "codex-speed";
const TIERS = { standard: "default", fast: "priority" } as const;
const isMode = (value: unknown): value is Mode =>
  value === "standard" || value === "fast";
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const isCodex = (ctx: ExtensionContext) =>
  ctx.model?.provider === "openai-codex" && ctx.model.api === "openai-codex-responses";

const isSupported = (ctx: ExtensionContext) => isCodex(ctx) ||
  (ctx.model?.provider === "openai" && ctx.model.api === "openai-responses");
const providerLabel = (ctx: ExtensionContext) => isCodex(ctx) ? "Codex" : "OpenAI";

export default function codexSpeed(pi: ExtensionAPI) {
  let mode: Mode = "standard";
  let observation = "未发送";
  let activeModel: string | undefined;

  function render(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS, isSupported(ctx) && mode === "fast" ? `${providerLabel(ctx)} fast` : undefined);
  }

  function restore(ctx: ExtensionContext) {
    mode = "standard";
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
      const saved = record(entry.data)?.mode;
      if (isMode(saved)) mode = saved;
      else if (saved === "ultrafast") mode = "standard"; // Retired mode: never reactivate it.
    }
    observation = "未发送";
    activeModel = undefined;
    render(ctx);
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("model_select", (_event, ctx) => {
    observation = "未发送";
    activeModel = undefined;
    render(ctx);
  });

  async function command(args: string, ctx: ExtensionContext) {
    const arg = args.trim().toLowerCase();
    if (arg === "status") {
      ctx.ui.notify(`Fast 模式：${mode}；${observation}。${isSupported(ctx) ? "" : "当前模型不适用。"}\n仅当前会话分支保存；服务端权限和实际返回档位决定是否生效。Pi 金额估算不代表订阅额度或加速实际账单。`, "info");
      return;
    }
    let next: Mode;
    if (arg === "") next = mode === "fast" ? "standard" : "fast";
    else if (arg === "on") next = "fast";
    else if (arg === "off" || arg === "standard") next = "standard";
    else if (isMode(arg)) next = arg;
    else {
      ctx.ui.notify("用法：/fast [on|off|status]", "warning");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("请等待当前回复结束后再切换速度。", "warning");
      return;
    }
    if (next !== "standard" && !isSupported(ctx)) {
      ctx.ui.notify("请先用 /model 选择 OpenAI Responses 或 Codex 模型。", "warning");
      return;
    }
    mode = next;
    observation = "未发送";
    activeModel = undefined;
    pi.appendEntry(ENTRY, { mode });
    render(ctx);

  }

  pi.registerCommand("fast", {
    description: "OpenAI / Codex fast 开关（增加费用或额度消耗）；on / off / status",
    getArgumentCompletions: (prefix) => {
      const matches = ["on", "off", "status"]
        .filter(value => value.startsWith(prefix))
        .map(value => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: command,
  });

  pi.on("before_provider_request", (event, ctx) => {
    const payload = record(event.payload);
    // The hook has no provider metadata. Require a supported active adapter
    // and matching payload model; do not rewrite unrelated models.
    const model = ctx.model;
    if (!model || !isSupported(ctx) || !payload || payload.model !== model.id) return;
    activeModel = model.id;
    observation = "已请求，待确认";
    render(ctx);
    return { ...payload, service_tier: TIERS[mode] };
  });

  pi.on("provider_stream_event", (event, ctx) => {
    if (!isSupported(ctx) || event.provider !== ctx.model?.provider ||
        event.api !== ctx.model?.api || event.model !== activeModel) return;
    const data = record(event.data);
    if (data?.type !== "response.completed") return;
    const tier = record(data.response)?.service_tier;
    if (typeof tier !== "string") observation = "服务端未报告档位";
    else if (tier === TIERS[mode] || (!isCodex(ctx) && mode === "fast" && tier === "fast")) observation = "服务端已确认";
    else if (tier === "default" && mode === "fast" && isCodex(ctx)) {
      // Pi's Codex adapter explicitly tolerates priority requests reporting
      // default. That response alone proves neither activation nor rejection.
      observation = "已请求 · 返回 default，生效未知";
    }
    else {
      // Display only known values, not arbitrary remote text/control sequences.
      const actual = ["default", "priority", "ultrafast", "auto", "flex", "fast", "scale"].includes(tier)
        ? tier : "未知档位";
      observation = `服务端返回 ${actual}`;

    }
    render(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant" || !isSupported(ctx) || msg.provider !== ctx.model?.provider || msg.model !== activeModel) return;
    if (msg.stopReason === "error" || msg.stopReason === "aborted") {
      observation = msg.stopReason === "error" ? "请求失败" : "已中止";
      render(ctx);
    }
    activeModel = undefined;
  });
}
