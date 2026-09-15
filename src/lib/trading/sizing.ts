import { dec, floorCents, max, min, ONE, ZERO, type Dec, type Numeric } from "@/lib/decimal";
import type { StrategyConfig } from "@/lib/strategy/config";
import { kellyFraction, shrinkTowardMarket } from "./probability";

export interface SizingInput {
  /** Our probability that the side we're buying wins. */
  probSide: Numeric;
  /** Aggregate confidence 0..1. */
  confidence: Numeric;
  /** Expected average fill price including fees (what we actually pay per share). */
  price: Numeric;
  /** Current account equity (cash + marked positions). */
  equity: Numeric;
  cash: Numeric;
  /** Cost basis of all open positions. */
  openExposure: Numeric;
  /** Cost basis of open positions in the same category. */
  categoryExposure: Numeric;
  /** Cost basis of open positions in the same Polymarket event (correlated). */
  correlatedExposure: Numeric;
  /** Cost basis already in this exact market+side (for ADD). */
  existingPositionCost: Numeric;
  /** Dollar value of ask depth available at or below our limit price. */
  availableDepthUsd: Numeric;
  /** Current drawdown from high-water mark, 0..1. */
  drawdown: Numeric;
  daysToResolution: number;
}

export type SizingConstraint =
  | "kelly" | "max_position" | "total_exposure" | "category_exposure" | "correlated_exposure"
  | "cash_reserve" | "book_depth" | "drawdown_halt" | "no_edge" | "below_min_order";

export interface SizingResult {
  usd: Dec;
  bindingConstraint: SizingConstraint;
  adjustedProbability: Dec;
  fullKelly: Dec;
  appliedFraction: Dec;
  drawdownFactor: Dec;
  timeFactor: Dec;
  limits: Record<Exclude<SizingConstraint, "no_edge" | "below_min_order" | "drawdown_halt">, Dec>;
}

/**
 * Conservative fractional-Kelly sizing with hard risk caps. Returns whole cents,
 * rounded down. All limits are computed so the result can be audited.
 */
export function sizePosition(input: SizingInput, cfg: StrategyConfig["sizing"]): SizingResult {
  const equity = dec(input.equity);
  const adjustedProbability = shrinkTowardMarket(input.probSide, input.price, input.confidence);
  const fullKelly = kellyFraction(adjustedProbability, input.price);

  const dd = dec(input.drawdown);
  let drawdownFactor = ONE;
  if (dd.gte(cfg.drawdownHalt)) drawdownFactor = ZERO;
  else if (dd.gt(cfg.drawdownThrottleStart)) {
    drawdownFactor = ONE.minus(dd.minus(cfg.drawdownThrottleStart).div(dec(cfg.drawdownHalt).minus(cfg.drawdownThrottleStart)));
  }
  const timeFactor = input.daysToResolution > cfg.longDatedDays ? dec(cfg.longDatedFactor) : ONE;
  const appliedFraction = fullKelly.times(cfg.kellyFraction).times(drawdownFactor).times(timeFactor);

  const limits = {
    kelly: equity.times(appliedFraction),
    max_position: equity.times(cfg.maxPositionPctBankroll).minus(input.existingPositionCost),
    total_exposure: equity.times(cfg.maxTotalExposurePct).minus(input.openExposure),
    category_exposure: equity.times(cfg.maxCategoryExposurePct).minus(input.categoryExposure),
    correlated_exposure: equity.times(cfg.maxCorrelatedExposurePct).minus(input.correlatedExposure),
    cash_reserve: dec(input.cash).minus(equity.times(cfg.minCashReservePct)),
    book_depth: dec(input.availableDepthUsd).times(cfg.maxBookDepthFraction),
  };

  const base = { adjustedProbability, fullKelly, appliedFraction, drawdownFactor, timeFactor, limits };
  if (fullKelly.lte(0)) return { ...base, usd: ZERO, bindingConstraint: "no_edge" };
  if (drawdownFactor.lte(0)) return { ...base, usd: ZERO, bindingConstraint: "drawdown_halt" };

  let binding: SizingConstraint = "kelly";
  let usd = limits.kelly;
  for (const [name, value] of Object.entries(limits) as [keyof typeof limits, Dec][]) {
    if (value.lt(usd)) {
      usd = value;
      binding = name;
    }
  }
  usd = floorCents(max(ZERO, min(usd)));
  if (usd.lt(cfg.minOrderUsd)) return { ...base, usd: ZERO, bindingConstraint: usd.gt(0) ? "below_min_order" : binding };
  return { ...base, usd, bindingConstraint: binding };
}
