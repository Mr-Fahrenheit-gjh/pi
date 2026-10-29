/** Client-safe, deliberately conservative OpenAI API workbench contract. */
export type ServiceTier = "inherit" | "default" | "priority" | "ultrafast" | "flex";
export type CacheMode = "inherit" | "30m" | "12h" | "off";
export interface WorkbenchOptions {
  tier: ServiceTier;
  cache: CacheMode;
  verbosity: "inherit" | "low" | "medium" | "high";
  contextWindow: number;
  maxTokens: number;
}
export type ModelCapability = "chat" | "image" | "audio" | "embedding" | "moderation" | "video" | "classifier";
type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
export interface WorkbenchSourceModel {
  id: string;
  provider: string;
  api: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: readonly string[];
  cost: unknown;
  samplingParams?: unknown;
  samplingParamsByThinkingLevel?: unknown;
}
export interface WorkbenchModel {
  id: string;
  capability: ModelCapability;
  official: boolean;
  editable: boolean;
  reasoning: boolean;
  imageInput: boolean;
  needsRepair: boolean;
  thinkingOverrides: boolean;
  tiers: ServiceTier[];
  options: WorkbenchOptions;
  /** Reviewed Standard rates, USD / million tokens; not an account entitlement. */
  rates: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}
export interface WorkbenchSnapshot {
  revision: string;
  auth: "api-key" | "oauth" | "missing";
  models: WorkbenchModel[];
}
export class WorkbenchError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

// Exact IDs only: snapshots and future models must not inherit guessed pricing or capabilities.
const PROFILES: Record<string, {input: number; output: number; cacheRead: number; cacheWrite: number; ultra: boolean; none: boolean}> = {
  "gpt-6-astra": {input:10,output:50,cacheRead:1,cacheWrite:12.5,ultra:true,none:false},
  "gpt-6.1-sol": {input:2,output:10,cacheRead:0.1,cacheWrite:2.5,ultra:true,none:false},
  "gpt-6.1-terra": {input:1,output:5,cacheRead:0.05,cacheWrite:1.25,ultra:false,none:true},
  "gpt-6-luna": {input:0.1,output:0.5,cacheRead:0.01,cacheWrite:0.125,ultra:false,none:true},
};
export function classifyOpenAIModel(id: string): ModelCapability {
  const name = id.toLowerCase();
  if (/decisions/.test(name)) return "classifier";
  if (/embedding|^text-search|^text-similarity/.test(name)) return "embedding";
  if (/moderation/.test(name)) return "moderation";
  if (/^sora(?:-|$)/.test(name)) return "video";
  if (/^dall-e|(?:^|-)image(?:-|$)|(?:^|-)flare(?:-|$)/.test(name)) return "image";
  if (/^tts-|^whisper|(?:^|-)(?:audio|realtime|live|transcribe|transcription|tts)(?:-|$)/.test(name)) return "audio";
  return "chat";
}
export function isChatModel(model: {provider: string; id: string; baseUrl?: string}): boolean {
  if (model.provider !== "openai" || (model.baseUrl && !/^https:\/\/api\.openai\.com\/v1\/?$/.test(model.baseUrl))) return true;
  return classifyOpenAIModel(model.id) === "chat";
}
export function isOfficialOpenAI(model: {provider: string; baseUrl: string; api: string}): boolean {
  return model.provider === "openai" && model.api === "openai-responses"
    && /^https:\/\/api\.openai\.com\/v1\/?$/.test(model.baseUrl);
}
function modelConfig(config: RecordValue, id: string) {
  const provider = record(record(config.providers).openai);
  const custom = Array.isArray(provider.models) ? record(provider.models.find((item) => record(item).id === id)) : {};
  const override = record(record(provider.modelOverrides)[id]);
  return {provider, custom, override};
}
const REPAIR_FIELDS = ["reasoning", "input", "cost", "thinkingLevelMap", "compat"] as const;
function repairFields(config: RecordValue, id: string): string[] {
  const {custom, override} = modelConfig(config, id);
  if (!PROFILES[id] || !custom.id) return [];
  return REPAIR_FIELDS.filter((key) => custom[key] === undefined && override[key] === undefined);
}
function managedFields(options: WorkbenchOptions): string[] {
  return ["max_output_tokens", ...(options.tier === "inherit" ? [] : ["service_tier"]),
    ...(options.cache === "inherit" ? [] : ["prompt_cache_options"]),
    ...(options.verbosity === "inherit" ? [] : ["text"])];
}
function hasThinkingOverrides(value: unknown, keys: string[]): boolean {
  return Object.values(record(value)).some((level) => keys.some((key) => key === "text"
    ? record(record(level).text).verbosity !== undefined : record(level)[key] !== undefined));
}
export function projectWorkbenchModel(model: WorkbenchSourceModel, config: RecordValue): WorkbenchModel {
  const profile = PROFILES[model.id];
  const official = isOfficialOpenAI(model);
  const sampling = record(model.samplingParams);
  const cache = record(sampling.prompt_cache_options);
  const tier = sampling.service_tier === "fast" ? "priority" : sampling.service_tier;
  const verbosity = record(sampling.text).verbosity;
  const {custom, override} = modelConfig(config, model.id);
  const levels = {...record(custom.samplingParamsByThinkingLevel), ...record(override.samplingParamsByThinkingLevel), ...record(model.samplingParamsByThinkingLevel)};
  const tiers: ServiceTier[] = ["default", "priority", ...(profile?.ultra ? ["ultrafast" as const] : []), "flex"];
  return {
    id:model.id, capability:classifyOpenAIModel(model.id), official,
    editable:official && !!profile, reasoning:model.reasoning, imageInput:model.input.includes("image"),
    needsRepair:official && repairFields(config,model.id).length > 0,
    thinkingOverrides:hasThinkingOverrides(levels,["service_tier","prompt_cache_options","text","max_output_tokens"]),
    tiers: official && profile ? tiers : [],
    options:{
      tier: typeof tier === "string" && tiers.includes(tier as ServiceTier) ? tier as ServiceTier : "inherit",
      cache:cache.mode === "explicit" && Array.isArray(cache.breakpoints) && cache.breakpoints.length === 0 ? "off"
        : cache.mode === "auto" && (cache.ttl === "30m" || cache.ttl === "12h") ? cache.ttl : "inherit",
      verbosity: verbosity === "low" || verbosity === "medium" || verbosity === "high" ? verbosity : "inherit",
      contextWindow:model.contextWindow, maxTokens:typeof sampling.max_output_tokens === "number" ? sampling.max_output_tokens : model.maxTokens,
    },
    rates:official && profile ? {input:profile.input,output:profile.output,cacheRead:profile.cacheRead,cacheWrite:profile.cacheWrite} : null,
  };
}

/** Only owned fields are changed. No raw configuration is sent to the browser. */
export function applyWorkbenchPatch(config: RecordValue, model: WorkbenchSourceModel, request: unknown): RecordValue {
  const req = record(request), opts = record(req.options);
  const view = projectWorkbenchModel(model, config), profile = PROFILES[model.id];
  if (!view.editable || !profile) throw new WorkbenchError("unsupported-model");
  if (opts.tier !== "inherit" && !view.tiers.includes(opts.tier as ServiceTier)) throw new WorkbenchError("unsupported-tier");
  if (!["inherit","30m","12h","off"].includes(opts.cache as string)
    || !["inherit","low","medium","high"].includes(opts.verbosity as string)) throw new WorkbenchError("invalid-options");
  if (!Number.isSafeInteger(opts.contextWindow) || (opts.contextWindow as number) < 1024 || (opts.contextWindow as number) > 1050000
    || !Number.isSafeInteger(opts.maxTokens) || (opts.maxTokens as number) < 16 || (opts.maxTokens as number) > 128000
    || (opts.maxTokens as number) > (opts.contextWindow as number)) throw new WorkbenchError("invalid-limits");
  const options = opts as unknown as WorkbenchOptions;
  const {provider, custom, override} = modelConfig(config, model.id);
  // SDK merges override maps by level; retain unrelated fields within each level too.
  const levels: RecordValue = {...record(model.samplingParamsByThinkingLevel)};
  for (const source of [custom.samplingParamsByThinkingLevel, override.samplingParamsByThinkingLevel]) {
    for (const [level, params] of Object.entries(record(source))) levels[level] = {...record(levels[level]), ...record(params)};
  }
  const keys = managedFields(options);
  const conflicts = hasThinkingOverrides(levels, keys);
  if (conflicts && req.clearThinkingOverrides !== true) throw new WorkbenchError("thinking-overrides");
  const sampling: RecordValue = {...record(model.samplingParams), ...record(custom.samplingParams), ...record(override.samplingParams)};
  if (options.tier !== "inherit") sampling.service_tier = options.tier;
  if (options.cache !== "inherit") sampling.prompt_cache_options = options.cache === "off"
    ? {mode:"explicit",breakpoints:[]} : {mode:"auto",ttl:options.cache};
  if (options.verbosity !== "inherit") sampling.text = {...record(sampling.text),verbosity:options.verbosity};
  // maxTokens is SDK metadata: retain its dynamic context clamp and minimum.
  // A raw sampling field is merged last and would bypass both protections.
  delete sampling.max_output_tokens;
  // A missing override key cannot delete a base-level value in the SDK's merge.
  // Pin conflicting fields to the chosen value instead; keep unrelated fields.
  if (conflicts) for (const [level, params] of Object.entries(levels)) {
    const unified = {...record(params)};
    for (const key of keys) if (unified[key] !== undefined) {
      if (key === "max_output_tokens") delete unified[key];
      else unified[key] = key === "text" ? {...record(unified.text),verbosity:options.verbosity} : sampling[key];
    }
    levels[level] = unified;
  }
  const next: RecordValue = {...override, samplingParams:sampling, contextWindow:options.contextWindow, maxTokens:options.maxTokens};
  if (conflicts) next.samplingParamsByThinkingLevel = levels;
  if (req.repair === true) {
    const fields: RecordValue = {
      reasoning:true, input:["text","image"],
      cost:{input:profile.input,output:profile.output,cacheRead:profile.cacheRead,cacheWrite:profile.cacheWrite,
        tiers:[{inputTokensAbove:272000,input:profile.input*2,output:profile.output*1.5,cacheRead:profile.cacheRead*2,cacheWrite:profile.cacheWrite*2}]},
      thinkingLevelMap:{off:profile.none ? "none" : null,minimal:null,low:"low",medium:"medium",high:"high",xhigh:"xhigh",max:"max"},
      compat:{supportsStrictMode:true,supportsOpenAIGrammarTools:true,supportsAdditionalTools:true,supportsToolSearch:true,supportsMidConvoSystemMessages:true,supportsExplicitPromptCacheMode:true,supportsMidConvoEffort:true},
    };
    for (const key of repairFields(config, model.id)) next[key] = fields[key];
  }
  // Deleting a key from modelOverrides alone cannot remove a custom model's
  // base value. Only output-limit fields in that base are owned by this edit.
  const customModels = Array.isArray(provider.models) ? provider.models.map((item) => {
    if (record(item).id !== model.id) return item;
    const clean = {...record(item)};
    if (record(clean.samplingParams).max_output_tokens !== undefined) {
      const params = {...record(clean.samplingParams)}; delete params.max_output_tokens; clean.samplingParams = params;
    }
    if (conflicts && hasThinkingOverrides(clean.samplingParamsByThinkingLevel,["max_output_tokens"])) {
      clean.samplingParamsByThinkingLevel = Object.fromEntries(Object.entries(record(clean.samplingParamsByThinkingLevel)).map(([level, value]) => {
        const params = {...record(value)}; delete params.max_output_tokens; return [level, params];
      }));
    }
    return clean;
  }) : undefined;
  return {...config,providers:{...record(config.providers),openai:{...provider,...(customModels ? {models:customModels} : {}),modelOverrides:{...record(provider.modelOverrides),[model.id]:next}}}};
}
