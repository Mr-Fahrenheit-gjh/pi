export type CacheTtl = "30m" | "12h" | null;
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
export type PricingModel = { id: string; baseUrl?: string; cost?: unknown; compat?: unknown };

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const rateFields = ["input", "output", "cacheRead", "cacheWrite"] as const;
const verifiedModels = new Set(["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"]);

export function readUsage(value: unknown): Usage | undefined {
  const data = record(value);
  if (!data || !fields.every(key => nonnegative(data[key])) || !fields.some(key => (data[key] as number) > 0)) return;
  return Object.fromEntries(fields.map(key => [key, data[key]])) as Usage;
}

export function estimateUsage(model: PricingModel, usage: Usage, actualTier: string | null, retention: unknown) {
  const unknown = (reason: string) => ({ estimatedCostUsd: null, costStatus: "unknown" as const, reason });
  if (actualTier === null) return unknown("missing-service-tier");
  if (!model.baseUrl || !/^https:\/\/api\.openai\.com\/v1\/?$/.test(model.baseUrl)) return unknown("unverified-pricing-endpoint");
  let multiplier: number;
  if (actualTier === "default") multiplier = 1;
  else if (actualTier === "priority" || actualTier === "fast") {
    if (model.id === "gpt-5.5") multiplier = 2.5;
    else if (verifiedModels.has(model.id)) multiplier = 2;
    else return unknown("unverified-tier-model");
  } else if (actualTier === "flex") {
    if (!verifiedModels.has(model.id)) return unknown("unverified-tier-model");
    multiplier = 0.5;
  } else if (actualTier === "ultrafast") {
    if (model.id !== "gpt-6-astra" && model.id !== "gpt-6.1-sol") return unknown("unverified-tier-model");
    multiplier = 6;
  } else return unknown("unknown-service-tier");

  const cost = record(model.cost);
  if (!cost) return unknown("incomplete-catalog-price");
  let rates = cost;
  let threshold = -1;
  // Core input excludes both cache categories. Tiers price the entire request.
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (cost.tiers !== undefined) {
    if (!Array.isArray(cost.tiers)) return unknown("invalid-catalog-tiers");
    for (const value of cost.tiers) {
      const tier = record(value);
      if (!tier || !nonnegative(tier.inputTokensAbove)) return unknown("invalid-catalog-tiers");
      if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
        rates = tier;
        threshold = tier.inputTokensAbove;
      }
    }
  }
  if (!rateFields.every(key => nonnegative(rates[key]))) return unknown("incomplete-catalog-price");
  // The SDK synthesizes four zero rates for ID-only imports; those values
  // cannot prove a deliberately free model. Never turn missing pricing into $0.
  if (rateFields.every(key => rates[key] === 0)) return unknown("unverified-zero-price");
  let writeMultiplier = 1;
  if (usage.cacheWrite > 0) {
    if (retention === "12h") {
      if (!verifiedModels.has(model.id) || record(model.compat)?.supportsExplicitPromptCacheMode !== true)
        return unknown("unverified-cache-retention-model");
      writeMultiplier = 2;
    } else if (retention != null && retention !== "30m") return unknown("unknown-cache-retention");
  }
  const total = ((rates.input as number) * usage.input + (rates.output as number) * usage.output +
    (rates.cacheRead as number) * usage.cacheRead + (rates.cacheWrite as number) * usage.cacheWrite * writeMultiplier) * multiplier / 1_000_000;
  if (!Number.isFinite(total)) return unknown("invalid-estimated-cost");
  return { estimatedCostUsd: total, costStatus: "estimated" as const };
}
