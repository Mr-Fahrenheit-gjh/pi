/** Model maker, not the gateway that transports it (e.g. Claude via OpenRouter). */
export function modelManufacturerIcon(provider: string, model: string): string {
  const name = (model ?? "").toLowerCase().split("/").at(-1) ?? "";
  const families: [RegExp, string][] = [
    [/^(?:gpt[-_.]|chatgpt[-_.]|o[1-9](?:[-_.]|$))/, "openai"],
    [/^claude(?:[-_.]|$)/, "anthropic"],
    [/^gemini(?:[-_.]|$)/, "google"],
    [/^deepseek(?:[-_.]|$)/, "deepseek"],
    [/^qwen/, "qwen"],
    [/^glm(?:[-_.]|$)/, "zhipu"],
    [/^kimi(?:[-_.]|$)/, "moonshot"],
    [/^minimax(?:[-_.]|$)/, "minimax"],
    [/^grok(?:[-_.]|$)/, "xai"],
    [/^(?:mistral|mixtral)(?:[-_.]|$)/, "mistral"],
  ];
  return families.find(([pattern]) => pattern.test(name))?.[1] ?? provider.toLowerCase();
}
