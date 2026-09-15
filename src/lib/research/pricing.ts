import { dec, type Dec } from "@/lib/decimal";

/** USD per million tokens (Anthropic first-party list prices, 2026). */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const UNKNOWN_MODEL = { input: 10, output: 50 }; // assume the most expensive tier
const WEB_SEARCH_USD_PER_REQUEST = 0.01; // $10 per 1,000 searches
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

export function estimateCostUsd(model: string, usage: UsageLike): Dec {
  const p = MODEL_PRICING[model] ?? UNKNOWN_MODEL;
  const perToken = (usd: number) => dec(usd).div(1_000_000);
  return perToken(p.input).times(usage.input_tokens)
    .plus(perToken(p.input).times(CACHE_WRITE_MULTIPLIER).times(usage.cache_creation_input_tokens ?? 0))
    .plus(perToken(p.input).times(CACHE_READ_MULTIPLIER).times(usage.cache_read_input_tokens ?? 0))
    .plus(perToken(p.output).times(usage.output_tokens))
    .plus(dec(WEB_SEARCH_USD_PER_REQUEST).times(usage.server_tool_use?.web_search_requests ?? 0))
    .toDecimalPlaces(6);
}
