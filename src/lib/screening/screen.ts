import type { markets } from "@/db/schema";
import type { StrategyConfig } from "@/lib/strategy/config";

export type MarketRow = typeof markets.$inferSelect;

export interface ScreenResult {
  score: number;
  passed: boolean;
  /** Hard-rejection reasons (empty when every hard rule passed). */
  reasons: string[];
  features: Record<string, number | string | boolean | null>;
}

/** Tags whose outcomes tend to be researchable from official/primary data. */
const RESEARCHABLE_TAGS = new Set([
  "politics", "elections", "geopolitics", "world", "economy", "economic policy", "fed", "fed rates", "finance",
  "business", "tech", "ai", "science", "courts", "legal", "health", "weather", "climate", "inflation", "cpi release",
]);
/** Tags dominated by high-frequency noise or very efficient pricing. */
const LOW_RESEARCH_TAGS = new Set(["sports", "crypto", "esports", "pop culture", "mentions", "games"]);

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const num = (v: string | null | undefined) => (v == null ? null : Number(v));

/** Log-scaled 0..1 score: `lo` maps to 0, `hi` to 1. */
function logScore(v: number | null, lo: number, hi: number) {
  if (v == null || v <= 0) return 0;
  return clamp01((Math.log10(v) - Math.log10(Math.max(lo, 1))) / (Math.log10(hi) - Math.log10(Math.max(lo, 1))));
}

/**
 * Stage 1: cheap, deterministic, no AI. Hard rules reject markets outright;
 * a weighted score ranks the rest for (paid) stage-2 research.
 */
export function screenMarket(m: MarketRow, cfg: StrategyConfig["screening"], now: Date): ScreenResult {
  const reasons: string[] = [];
  const liquidity = num(m.liquidityUsd);
  const volume24h = num(m.volume24hUsd);
  const yesPrice = num(m.yesPrice);
  const spread = num(m.spread);
  const hoursLeft = m.endDate ? (m.endDate.getTime() - now.getTime()) / 3_600_000 : null;
  const question = m.question.toLowerCase();
  const tags = m.tags.map((t) => t.toLowerCase());

  if (m.closed || !m.active) reasons.push("market closed/inactive");
  if (!m.acceptingOrders || !m.enableOrderBook) reasons.push("order book not accepting orders");
  if (!m.yesTokenId || !m.noTokenId || m.outcomes.length !== 2) reasons.push("not a tradable binary market");
  if (liquidity == null || liquidity < cfg.minLiquidityUsd) reasons.push(`liquidity ${liquidity ?? "n/a"} < ${cfg.minLiquidityUsd}`);
  if (volume24h == null || volume24h < cfg.minVolume24hUsd) reasons.push(`24h volume ${volume24h ?? "n/a"} < ${cfg.minVolume24hUsd}`);
  if (hoursLeft == null) reasons.push("no resolution date");
  else {
    if (hoursLeft < cfg.minHoursToResolution) reasons.push(`resolves in ${hoursLeft.toFixed(1)}h < ${cfg.minHoursToResolution}h`);
    if (hoursLeft / 24 > cfg.maxDaysToResolution) reasons.push(`resolves in ${(hoursLeft / 24).toFixed(0)}d > ${cfg.maxDaysToResolution}d`);
  }
  if (yesPrice == null || yesPrice < cfg.minYesPrice || yesPrice > cfg.maxYesPrice) reasons.push(`YES price ${yesPrice ?? "n/a"} outside [${cfg.minYesPrice}, ${cfg.maxYesPrice}]`);
  if (spread != null && spread > cfg.maxSpread) reasons.push(`spread ${spread} > ${cfg.maxSpread}`);
  const pattern = cfg.excludedQuestionPatterns.find((p) => question.includes(p.toLowerCase()));
  if (pattern) reasons.push(`excluded question pattern "${pattern}"`);
  const excludedTag = cfg.excludedTags.find((t) => tags.includes(t.toLowerCase()));
  if (excludedTag) reasons.push(`excluded tag "${excludedTag}"`);

  const description = m.description ?? "";
  const descLower = description.toLowerCase();
  const clarity = clamp01(
    (description.length >= 250 ? 0.4 : description.length / 625) +
    (/resolve[sd]? to "?yes"?|will resolve/.test(descLower) ? 0.25 : 0) +
    (m.resolutionSource || /https?:\/\//.test(description) ? 0.25 : 0) +
    (/official|according to/.test(descLower) ? 0.1 : 0) -
    (/sole discretion|ambiguous|at the discretion/.test(descLower) ? 0.2 : 0),
  );
  const researchability = tags.some((t) => RESEARCHABLE_TAGS.has(t)) ? 0.9 : tags.some((t) => LOW_RESEARCH_TAGS.has(t)) ? 0.25 : 0.5;
  const days = hoursLeft == null ? 0 : hoursLeft / 24;
  // Sweet spot: enough time to research and for mispricing to correct, not capital locked for months.
  const timeScore = hoursLeft == null ? 0 : days < 3 ? clamp01(days / 3) * 0.6 : days <= 60 ? 1 : clamp01(1 - (days - 60) / Math.max(1, cfg.maxDaysToResolution - 60)) * 0.8 + 0.2;
  const uncertainty = yesPrice == null ? 0 : 4 * yesPrice * (1 - yesPrice);
  const spreadScore = spread == null ? 0.5 : clamp01(1 - spread / Math.max(cfg.maxSpread, 1e-9));

  const features = {
    liquidityScore: round6(logScore(liquidity, cfg.minLiquidityUsd, 1_000_000)),
    volumeScore: round6(logScore(volume24h, cfg.minVolume24hUsd, 250_000)),
    timeScore: round6(timeScore),
    uncertaintyScore: round6(uncertainty),
    spreadScore: round6(spreadScore),
    clarityScore: round6(clarity),
    researchabilityScore: researchability,
    hoursLeft: hoursLeft == null ? null : round6(hoursLeft),
    yesPrice,
    liquidity,
    volume24h,
    spread,
  };
  const score = round6(
    0.15 * features.liquidityScore + 0.1 * features.volumeScore + 0.15 * features.timeScore +
    0.15 * features.uncertaintyScore + 0.1 * features.spreadScore + 0.2 * features.clarityScore +
    0.15 * features.researchabilityScore,
  );
  if (reasons.length === 0 && score < cfg.minScreenScore) reasons.push(`score ${score} < ${cfg.minScreenScore}`);
  return { score, passed: reasons.length === 0, reasons, features };
}
