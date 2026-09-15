import { dec, max, ONE, ZERO, type Dec, type Numeric } from "@/lib/decimal";

export type Side = "YES" | "NO";

/** A binary share pays $1 if its outcome occurs, so its price is the implied probability. */
export function impliedProbability(price: Numeric): Dec {
  return dec(price);
}

/** Probability that `side` wins, given P(YES). */
export function sideProbability(probYes: Numeric, side: Side): Dec {
  return side === "YES" ? dec(probYes) : ONE.minus(probYes);
}

/** Raw edge in probability points: our probability minus the price we must pay. */
export function rawEdge(probSide: Numeric, price: Numeric): Dec {
  return dec(probSide).minus(price);
}

/** Expected profit per $1 spent buying at `price` (fees must already be in the price). */
export function evPerDollar(probSide: Numeric, price: Numeric): Dec {
  const p = dec(price);
  if (p.lte(0)) return ZERO;
  return dec(probSide).minus(p).div(p);
}

/**
 * Full-Kelly fraction of bankroll for buying a binary share at `price` when the
 * true win probability is `probSide`: f* = (q - p) / (1 - p). Zero if no edge.
 */
export function kellyFraction(probSide: Numeric, price: Numeric): Dec {
  const q = dec(probSide);
  const p = dec(price);
  if (p.lte(0) || p.gte(1) || q.lte(p)) return ZERO;
  return q.minus(p).div(ONE.minus(p));
}

/**
 * Shrink our estimate toward the market price in proportion to how little we
 * trust it. confidence=1 keeps our estimate, confidence=0 defers to the market.
 */
export function shrinkTowardMarket(probSide: Numeric, marketPrice: Numeric, confidence: Numeric): Dec {
  const m = dec(marketPrice);
  return m.plus(dec(confidence).times(dec(probSide).minus(m)));
}

export interface SideQuote {
  side: Side;
  /** Price we would pay to buy this side (best ask, or effective fill price). */
  price: Dec;
  probability: Dec;
  edge: Dec;
  evPerDollar: Dec;
}

/**
 * Evaluate buying YES and buying NO. We never short; "betting NO" means buying
 * the NO token at its ask. Returns the side with the higher EV per dollar, or
 * null if neither has positive edge.
 */
export function bestSide(probYes: Numeric, yesAsk: Numeric | null, noAsk: Numeric | null): {
  yes: SideQuote | null;
  no: SideQuote | null;
  best: SideQuote | null;
} {
  const build = (side: Side, ask: Numeric | null): SideQuote | null => {
    if (ask === null) return null;
    const price = dec(ask);
    if (price.lte(0) || price.gte(1)) return null;
    const probability = sideProbability(probYes, side);
    return { side, price, probability, edge: rawEdge(probability, price), evPerDollar: evPerDollar(probability, price) };
  };
  const yes = build("YES", yesAsk);
  const no = build("NO", noAsk);
  const candidates = [yes, no].filter((q): q is SideQuote => q !== null && q.edge.gt(0));
  const best = candidates.sort((a, b) => b.evPerDollar.comparedTo(a.evPerDollar))[0] ?? null;
  return { yes, no, best };
}

/** Brier score contribution for one resolved binary forecast. */
export function brierScore(probYes: Numeric, resolvedYes: boolean): Dec {
  const outcome = resolvedYes ? ONE : ZERO;
  return dec(probYes).minus(outcome).pow(2);
}

export function clampProbability(p: Numeric): Dec {
  return max(ZERO, dec(p).gt(1) ? ONE : dec(p));
}
