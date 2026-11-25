import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateUsage, readUsage, type CacheTtl, type PricingModel } from "./usage.ts";

type Mode = "auto" | "standard" | "fast" | "ultrafast";
type SpeedCommand = "fast" | "ultrafast";
type Model = ExtensionContext["model"];
const ENTRY = "codex-speed-mode";
const STATUS = "codex-speed";
const ULTRAFAST_VERSION = 2;
const TIERS = { standard: "default", fast: "priority", ultrafast: "ultrafast" } as const;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const isCodex = (model: Model) =>
  model?.provider === "openai-codex" && model.api === "openai-codex-responses";
const isOpenAI = (model: Model) =>
  model?.provider === "openai" && model.api === "openai-responses";
const isSupported = (model: Model) => isCodex(model) || isOpenAI(model);
const supportsUltrafast = (model: Model) => isCodex(model) && model?.id === "gpt-6.2-sol";
const isFastTier = (tier: unknown) => tier === "priority" || tier === "fast";
type Request = {
  mode: Mode;
  model: PricingModel;
  provider: string;
  api: string;
  requestedTier: string | null;
  actualTier: string | null;
  retention: unknown;
  responseId?: string;
};

function advertiseT3Tiers(model: Model) {
  if (!model || !isSupported(model)) return;
  const serviceTiers = [
    { id: TIERS.fast, name: "Fast" },
    ...(supportsUltrafast(model) ? [{ id: TIERS.ultrafast, name: "Ultra Fast" }] : []),
  ];
  // Pi's RPC returns these live catalog models to T3 Code's picker and request bridge.
  Object.assign(model, { serviceTiers });
}

export default function codexSpeed(pi: ExtensionAPI) {
  const t3Picker = process.env.PI_CODEX_SPEED_T3 === "1";
  let mode: Mode = "auto";
  let observation = "未发送";
  let active: Request | undefined;
  let t3LastTier: string | undefined;

  function render(ctx: ExtensionContext) {
    if (!ctx.hasUI || t3Picker) return;
    const badge = mode === "ultrafast" && supportsUltrafast(ctx.model) ? "Codex ultrafast"
      : mode === "fast" && isSupported(ctx.model) ? `${isCodex(ctx.model) ? "Codex" : "OpenAI"} fast` : undefined;
    ctx.ui.setStatus(STATUS, badge);
  }

  function restore(ctx: ExtensionContext) {
    mode = "auto";
    if (!t3Picker) {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
        const saved = record(entry.data);
        const value = saved?.mode;
        if (value === "auto" || value === "standard" || value === "fast") mode = value;
        else if (value === "ultrafast") {
          // Only a new explicit opt-in may re-enable the retired paid mode.
          mode = saved?.version === ULTRAFAST_VERSION ? "ultrafast" : "standard";
        }
      }
    }
    observation = "未发送";
    active = undefined;
    t3LastTier = undefined;
    render(ctx);
  }

  pi.on("session_start", (_event, ctx) => {
    if (t3Picker) {
      for (const model of ctx.modelRegistry.getAvailable()) advertiseT3Tiers(model);
      advertiseT3Tiers(ctx.model);
    }
    restore(ctx);
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("model_select", (_event, ctx) => {
    if (t3Picker) advertiseT3Tiers(ctx.model);
    observation = "未发送";
    active = undefined;
    t3LastTier = undefined;
    render(ctx);
  });

  async function command(name: SpeedCommand, args: string, ctx: ExtensionContext) {
    const arg = args.trim().toLowerCase();
    if (t3Picker) {
      const picker = isSupported(ctx.model) ? "请在 T3 Code 模型菜单的 Service Tier 中选择速度。" : "当前模型没有可选的速度档位。";
      const detail = arg === "status" && t3LastTier ? `最近请求档位为 ${t3LastTier}。${observation}。` : "";
      ctx.ui.notify(`${picker}${detail}`, "info");
      return;
    }
    if (arg === "status") {
      const ultra = name === "ultrafast" || mode === "ultrafast";
      const unavailable = ultra ? !supportsUltrafast(ctx.model) : !isSupported(ctx.model);
      ctx.ui.notify(`${ultra ? "Ultrafast" : "Fast"} 模式：${mode}；${observation}。${unavailable ? "当前模型不适用。" : ""}\n仅当前会话分支保存；auto 继承 OpenAI 工作台请求档位，Codex 按标准速度。服务端权限和实际返回档位决定是否生效。Pi 金额估算不代表订阅额度或加速实际账单。`, "info");
      return;
    }
    let next: Mode;
    if (arg === "") next = mode === name ? "standard" : name;
    else if (arg === "on") next = name;
    else if (arg === "off" || arg === "standard") next = "standard";
    else if (arg === "auto" || (name === "fast" && arg === "fast")) next = arg;
    else {
      ctx.ui.notify(`用法：/${name} [on|off|auto|status]`, "warning");
      return;
    }
    if (next === "fast" && !isSupported(ctx.model)) {
      ctx.ui.notify("请先用 /model 选择 OpenAI Responses 或 Codex 模型。", "warning");
      return;
    }
    if (next === "ultrafast" && !supportsUltrafast(ctx.model)) {
      ctx.ui.notify("Ultrafast 仅适用于 Codex GPT‑6.2 Sol。", "warning");
      return;
    }
    mode = next;
    // An already-sent response keeps its tier, verification and usage ledger.
    // before_provider_request reads the new mode for the next request only.
    if (!active) observation = "未发送";
    pi.appendEntry(ENTRY, mode === "ultrafast" ? { mode, version: ULTRAFAST_VERSION } : { mode });
    render(ctx);
  }

  for (const [name, description] of [
    ["fast", "OpenAI / Codex fast 开关（增加费用或额度消耗）；on / off / auto / status"],
    ["ultrafast", "Codex GPT‑6.2 Sol ultrafast 开关（增加额度消耗）；on / off / auto / status"],
  ] as const) {
    pi.registerCommand(name, {
      description: t3Picker ? `查看 T3 Code ${name} 档位的使用方式或最近请求状态` : description,
      getArgumentCompletions: (prefix) => {
        const matches = (t3Picker ? ["status"] : ["on", "off", "auto", "status"])
          .filter(value => value.startsWith(prefix))
          .map(value => ({ value, label: value }));
        return matches.length ? matches : null;
      },
      handler: (args, ctx) => command(name, args, ctx),
    });
  }

  pi.on("before_provider_request", (event, ctx) => {
    const payload = record(event.payload);
    // This hook has no provider metadata; same-ID third-party nested calls
    // cannot be distinguished. Require the active adapter and payload model.
    const model = ctx.model;
    if (!model || !isSupported(model) || !payload || payload.model !== model.id) return;
    let requestMode = mode === "ultrafast" && !supportsUltrafast(model) ? "auto" : mode;
    let tier = requestMode === "auto"
      ? (isCodex(model) ? TIERS.standard : payload.service_tier ?? TIERS.standard)
      : TIERS[requestMode];
    if (t3Picker) {
      // T3's explicit RPC extension runs first and owns the request tier, including Standard.
      tier = payload.service_tier ?? TIERS.standard;
      t3LastTier = typeof tier === "string" ? tier : undefined;
      if (tier === TIERS.ultrafast && supportsUltrafast(model)) requestMode = "ultrafast";
      else if (isFastTier(tier)) requestMode = "fast";
    }
    active = {
      mode: requestMode,
      model: { id: model.id, baseUrl: model.baseUrl, cost: structuredClone(model.cost), compat: structuredClone(model.compat) },
      provider: model.provider, api: model.api,
      requestedTier: typeof tier === "string" ? tier : null,
      actualTier: null,
      // Modern Responses uses prompt_cache_options; an explicit options object
      // takes precedence over the legacy retention field, including no TTL.
      retention: payload.prompt_cache_options !== undefined
        ? record(payload.prompt_cache_options)?.ttl ?? null : payload.prompt_cache_retention,
    };
    observation = "已请求，待确认";
    render(ctx);
    if (!t3Picker) return { ...payload, service_tier: tier };
  });

  pi.on("provider_stream_event", (event, ctx) => {
    if (!active || !isSupported(ctx.model) || ctx.model?.provider !== active.provider || ctx.model.id !== active.model.id ||
        event.provider !== active.provider || event.api !== active.api || event.model !== active.model.id) return;
    const data = record(event.data);
    const response = record(data?.response);
    // A retry may start a new response without another payload hook.
    if (data?.type === "response.created") {
      active.actualTier = null;
      active.responseId = typeof response?.id === "string" ? response.id : undefined;
      observation = "已请求，待确认";
      return;
    }
    // Codex exposes raw events before Pi normalizes response.done to response.completed.
    if (data?.type !== "response.completed" && !(active.mode === "ultrafast" && data?.type === "response.done")) return;
    if (active.responseId && typeof response?.id === "string" && response.id !== active.responseId) return;
    active.responseId = typeof response?.id === "string" ? response.id : active.responseId;
    const tier = response?.service_tier;
    active.actualTier = typeof tier === "string" ? tier : null;
    if (typeof tier !== "string") observation = "服务端未报告档位";
    else if (active.mode === "auto" && isOpenAI(ctx.model) && ["default", "flex", "ultrafast"].includes(tier)) observation = `服务端返回 ${tier}`;
    else if (active.mode === "ultrafast" && tier === "ultrafast") observation = "服务端已确认 ultrafast";
    else if ((["default", "priority", "fast"].includes(tier) && tier === active.requestedTier) ||
        (!isCodex(ctx.model) && isFastTier(active.requestedTier) && isFastTier(tier))) observation = "服务端已确认";
    else if (tier === "default" && isCodex(ctx.model) && (isFastTier(active.requestedTier) || active.mode === "ultrafast")) {
      // Codex may report default for an accelerated request.
      observation = "已请求 · 返回 default，生效未知";
    } else {
      const actual = ["default", "priority", "ultrafast", "auto", "flex", "fast", "scale"].includes(tier)
        ? tier : "未知档位";
      observation = `服务端返回 ${actual}`;
    }
    render(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant" || !active || !isSupported(ctx.model) || ctx.model?.provider !== active.provider ||
        ctx.model.id !== active.model.id || msg.provider !== active.provider ||
        msg.model !== active.model.id || (msg.api && msg.api !== active.api)) return;
    const request = active;
    active = undefined;
    const usage = readUsage(msg.usage);
    if (isOpenAI(ctx.model) && usage && Number.isFinite(msg.timestamp)) {
      const matched = !msg.responseId || !request.responseId || msg.responseId === request.responseId;
      const actualTier = matched ? request.actualTier : null;
      const cacheTtl: CacheTtl = matched && (request.retention === "30m" || request.retention === "12h") ? request.retention : null;
      const responseId = msg.responseId || request.responseId;
      pi.appendEntry("openai-api-usage", {
        version: 1, messageTimestamp: msg.timestamp, model: msg.model,
        requestedTier: matched ? request.requestedTier : null, actualTier, cacheTtl, usage,
        ...estimateUsage(request.model, usage, actualTier, request.retention),
        pricingSource: "catalog",
        ...(responseId ? { responseId } : {}),
      });
    }
    if (msg.stopReason === "error" || msg.stopReason === "aborted") {
      observation = msg.stopReason === "error" ? "请求失败" : "已中止";
      render(ctx);
    }
  });
}
