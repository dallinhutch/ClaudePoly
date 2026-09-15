import { D, dec, type Dec, type Numeric } from "@/lib/decimal";
import type { StrategyConfig } from "@/lib/strategy/config";
import { feePerShare, type FeeModel } from "./execution";
import { evPerDollar } from "./probability";

export interface QualificationCheck {
  name: string;
  passed: boolean;
  value: string | number | boolean | null;
  threshold: string | number | boolean | null;
}

export interface QualificationInput {
  probSide: Numeric;
  /** All-in price per share at top of book (ask + taker fee). */
  allInPrice: Numeric;
  confidence: Numeric;
  evidenceQuality: Numeric;
  analystStdev: Numeric;
  liquidityUsd: Numeric | null;
  hoursToResolution: number | null;
  resolutionClarity: "clear" | "mostly_clear" | "ambiguous";
  unresolvedContradictions: number;
  /** Age of the newest supporting evidence; null when unknown. */
  newestEvidenceAgeHours: number | null;
}

/**
 * Every rule is evaluated (not short-circuited) so the stored decision shows
 * exactly which requirements a NO_TRADE failed.
 */
export function qualifyTrade(input: QualificationInput, cfg: StrategyConfig["qualification"]) {
  const edge = dec(input.probSide).minus(input.allInPrice);
  const ev = evPerDollar(input.probSide, input.allInPrice);
  const r4 = (v: Dec) => Number(v.toFixed(4));
  const checks: QualificationCheck[] = [
    { name: "confidence", passed: dec(input.confidence).gte(cfg.minConfidence), value: r4(dec(input.confidence)), threshold: cfg.minConfidence },
    { name: "edge_after_fees", passed: edge.gte(cfg.minEdge), value: r4(edge), threshold: cfg.minEdge },
    { name: "ev_per_dollar", passed: ev.gte(cfg.minEvPerDollar), value: r4(ev), threshold: cfg.minEvPerDollar },
    { name: "liquidity", passed: input.liquidityUsd != null && dec(input.liquidityUsd).gte(cfg.minLiquidityUsd), value: input.liquidityUsd == null ? null : r4(dec(input.liquidityUsd)), threshold: cfg.minLiquidityUsd },
    { name: "analyst_disagreement", passed: dec(input.analystStdev).lte(cfg.maxAnalystStdev), value: r4(dec(input.analystStdev)), threshold: cfg.maxAnalystStdev },
    { name: "evidence_quality", passed: dec(input.evidenceQuality).gte(cfg.minEvidenceQuality), value: r4(dec(input.evidenceQuality)), threshold: cfg.minEvidenceQuality },
    { name: "information_freshness", passed: input.newestEvidenceAgeHours != null && input.newestEvidenceAgeHours <= cfg.maxInformationAgeHours, value: input.newestEvidenceAgeHours, threshold: cfg.maxInformationAgeHours },
    { name: "clear_resolution", passed: !cfg.requireClearResolution || input.resolutionClarity !== "ambiguous", value: input.resolutionClarity, threshold: cfg.requireClearResolution ? "not ambiguous" : "any" },
    { name: "unresolved_contradictions", passed: input.unresolvedContradictions <= cfg.maxUnresolvedContradictions, value: input.unresolvedContradictions, threshold: cfg.maxUnresolvedContradictions },
    { name: "time_to_resolution", passed: input.hoursToResolution != null && input.hoursToResolution >= cfg.minHoursToResolution, value: input.hoursToResolution == null ? null : Math.round(input.hoursToResolution), threshold: cfg.minHoursToResolution },
  ];
  const failed = checks.filter((c) => !c.passed);
  return {
    qualified: failed.length === 0,
    checks,
    rejectionReasons: failed.map((c) => `${c.name}: ${c.value ?? "unknown"} vs ${c.threshold}`),
    edge,
    evPerDollar: ev,
  };
}

/**
 * Highest limit price (on the tick grid) whose all-in cost still leaves
 * `requiredEdge` below our probability, and never more than `maxSlippage`
 * above the current best ask. Returns null if no such price exists.
 */
export function buyLimitPrice(params: {
  probSide: Numeric;
  requiredEdge: Numeric;
  bestAsk: Numeric;
  maxSlippage: Numeric;
  tickSize: Numeric;
  fee: FeeModel;
}): Dec | null {
  const tick = dec(params.tickSize);
  const maxAllIn = dec(params.probSide).minus(params.requiredEdge);
  const cap = D.min(maxAllIn, dec(params.bestAsk).plus(params.maxSlippage), dec(1).minus(tick));
  let price = cap.div(tick).floor().times(tick);
  while (price.gt(0) && price.plus(feePerShare(price, params.fee)).gt(maxAllIn)) price = price.minus(tick);
  return price.gt(0) ? price : null;
}

/** Lowest acceptable price when exiting: best bid minus slippage, on the tick grid. */
export function sellLimitPrice(params: { bestBid: Numeric; maxSlippage: Numeric; tickSize: Numeric }): Dec {
  const tick = dec(params.tickSize);
  const raw = dec(params.bestBid).minus(params.maxSlippage);
  return D.max(tick, raw.div(tick).ceil().times(tick));
}
