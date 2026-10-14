import { EPS, type Level } from "../scoring";

/**
 * Polymarket US liquidity-incentive scoring, as published at
 * https://docs.polymarket.us/incentives/liquidity
 *
 * Every second each side of the book is walked from its best price outward
 * until Target Size contracts (everyone's, raw size) have been counted. Orders
 * inside that walk score DiscountFactor^(ticks from best price) x size; orders
 * beyond it score nothing; a side that never reaches Target Size pays nobody
 * that second. Each side is normalised to 1, so a side is worth half the
 * second's reward. With a Max Spread, both sides must reach Target Size and
 * their size-adjusted prices (where each walk reached Target Size) must sit
 * within Max Spread of their midpoint, or the whole second is forfeited.
 */
export interface UsProgram {
  programId: string;
  period: string;
  /**
   * Dollars this one market can be expected to pay over the period: the programme's pool split evenly
   * across every market carrying the same programme on the same day (see splitSharedPools).
   */
  pool: number;
  /** The pool as the API shows it, which is one pot for the whole programme, not per market. */
  programPool?: number;
  /** How many markets share that pot. */
  sharedBy?: number;
  discountFactor: number;
  targetSize: number;
  /** Half-width in dollars, or null when the programme has none. */
  maxSpread: number | null;
}

export interface UsSideScore {
  met: boolean;
  /** Our score, and everyone's including ours, inside the walk. */
  ours: number;
  total: number;
  /** Where the walk reached Target Size. */
  sizeAdjustedPrice: number | null;
}

/**
 * Score one side. `levels` are the real book, best first; our order is added
 * to its price level (behind the orders already there, which does not matter
 * for the score). `better` says which way is better for this side.
 */
export function scoreSide(levels: Level[], ours: Level | null, targetSize: number, discountFactor: number, tick: number, better: "higher" | "lower"): UsSideScore {
  const merged = levels.map((l) => ({ price: l.price, size: l.size, mine: 0 }));
  if (ours && ours.size > 0) {
    const at = merged.find((l) => Math.abs(l.price - ours.price) < EPS);
    if (at) at.mine += ours.size;
    else merged.push({ price: ours.price, size: 0, mine: ours.size });
  }
  merged.sort((a, b) => (better === "higher" ? b.price - a.price : a.price - b.price));
  const best = merged[0]?.price;
  if (best === undefined) return { met: false, ours: 0, total: 0, sizeAdjustedPrice: null };
  let cum = 0;
  let total = 0;
  let mine = 0;
  for (const l of merged) {
    const weight = Math.pow(discountFactor, Math.round(Math.abs(l.price - best) / tick));
    total += weight * (l.size + l.mine);
    mine += weight * l.mine;
    cum += l.size + l.mine;
    if (cum >= targetSize - EPS) return { met: true, ours: mine, total, sizeAdjustedPrice: l.price };
  }
  return { met: false, ours: mine, total, sizeAdjustedPrice: null };
}

export interface UsEvaluation {
  bid: UsSideScore;
  ask: UsSideScore;
  /** False when a Max Spread programme forfeits the second. */
  spreadOk: boolean;
  /** Our fraction of this second's reward, 0..1 (each side is worth half). */
  share: number;
}

export function evaluateUsQuotes(book: { bids: Level[]; asks: Level[] }, ours: { bid: Level | null; ask: Level | null }, program: UsProgram, tick: number): UsEvaluation {
  const bid = scoreSide(book.bids, ours.bid, program.targetSize, program.discountFactor, tick, "higher");
  const ask = scoreSide(book.asks, ours.ask, program.targetSize, program.discountFactor, tick, "lower");
  let spreadOk = true;
  if (program.maxSpread != null) {
    if (!bid.met || !ask.met || bid.sizeAdjustedPrice === null || ask.sizeAdjustedPrice === null) spreadOk = false;
    else {
      const mid = (bid.sizeAdjustedPrice + ask.sizeAdjustedPrice) / 2;
      spreadOk = mid - bid.sizeAdjustedPrice <= program.maxSpread + EPS && ask.sizeAdjustedPrice - mid <= program.maxSpread + EPS;
    }
  }
  const side = (s: UsSideScore) => (s.met && s.total > 0 ? s.ours / s.total : 0);
  return { bid, ask, spreadOk, share: spreadOk ? (side(bid) + side(ask)) / 2 : 0 };
}
