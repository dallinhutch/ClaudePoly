/**
 * Polymarket liquidity-reward scoring, as published at
 * https://docs.polymarket.com/market-makers/liquidity-rewards
 *
 * Every minute the book is sampled. A resting order of at least the market's
 * minimum size, within the market's max spread of the midpoint, scores
 * ((v - s) / v)^2 * size. A maker's score for the sample is the smaller of
 * their bid-side and ask-side totals (one side alone counts for a third while
 * the midpoint is between 10c and 90c). The day's pool is shared pro rata.
 *
 * Scores are ratios, not money, so plain numbers are used here. Prices are
 * multiples of the tick size; EPS absorbs float noise in comparisons.
 */
export interface Level {
  price: number;
  size: number;
}

export interface SideScores {
  bid: number;
  ask: number;
}

export const EPS = 1e-9;
/** Single-sided liquidity is divided by this ("c" in the docs, 3.0 on all markets). */
export const SINGLE_SIDED_DIVISOR = 3;
const SINGLE_SIDED_LOW = 0.1;
const SINGLE_SIDED_HIGH = 0.9;

/** S(v, s): weight of an order s away from the midpoint when the max spread is v. Zero at or beyond v. */
export function orderScore(maxSpread: number, distance: number): number {
  if (maxSpread <= 0 || distance < -EPS || distance >= maxSpread - EPS) return 0;
  return ((maxSpread - Math.max(0, distance)) / maxSpread) ** 2;
}

/**
 * The "size-cutoff-adjusted midpoint": halfway between the best bid and best ask
 * that meet the minimum size. Dust orders do not move it. Null when either side
 * has no qualifying order, in which case nothing in the book can score.
 */
export function adjustedMidpoint(bids: Level[], asks: Level[], minSize: number): number | null {
  let bid: number | null = null;
  let ask: number | null = null;
  for (const l of bids) if (l.size >= minSize - EPS && (bid === null || l.price > bid)) bid = l.price;
  for (const l of asks) if (l.size >= minSize - EPS && (ask === null || l.price < ask)) ask = l.price;
  return bid === null || ask === null ? null : (bid + ask) / 2;
}

/** Total score resting on each side of a book. */
export function sideScores(bids: Level[], asks: Level[], mid: number, maxSpread: number, minSize: number): SideScores {
  let bid = 0;
  let ask = 0;
  for (const l of bids) if (l.size >= minSize - EPS) bid += orderScore(maxSpread, mid - l.price) * l.size;
  for (const l of asks) if (l.size >= minSize - EPS) ask += orderScore(maxSpread, l.price - mid) * l.size;
  return { bid, ask };
}

const singleSidedCounts = (mid: number) => mid >= SINGLE_SIDED_LOW - EPS && mid <= SINGLE_SIDED_HIGH + EPS;

/** Q_min for one maker. */
export function makerScore(s: SideScores, mid: number): number {
  const two = Math.min(s.bid, s.ask);
  return singleSidedCounts(mid) ? Math.max(two, Math.max(s.bid, s.ask) / SINGLE_SIDED_DIVISOR) : two;
}

/**
 * The book shows total resting score per side but not who owns it, and the sum
 * of the other makers' Q_min depends on how it is split between them. This is
 * the largest that sum can be for any split, so our share is never overstated.
 */
export function crowdScoreUpperBound(s: SideScores, mid: number): number {
  const two = Math.min(s.bid, s.ask);
  return singleSidedCounts(mid) ? (s.bid + s.ask + two) / SINGLE_SIDED_DIVISOR : two;
}

export interface QuoteEvaluation {
  /** Midpoint of the book with our orders in it; null if it has no qualifying order on some side. */
  mid: number | null;
  ours: SideScores;
  crowd: SideScores;
  /** Our fraction of this sample's reward, 0..1. */
  share: number;
}

/**
 * Score our (paper) orders against the real book. Our orders are added to the
 * book before the midpoint is taken, because real orders would move it.
 */
export function evaluateQuotes(book: { bids: Level[]; asks: Level[] }, ours: { bid: Level | null; ask: Level | null }, minSize: number, maxSpread: number): QuoteEvaluation {
  const none = { bid: 0, ask: 0 };
  const mid = adjustedMidpoint(ours.bid ? [...book.bids, ours.bid] : book.bids, ours.ask ? [...book.asks, ours.ask] : book.asks, minSize);
  if (mid === null) return { mid, ours: none, crowd: none, share: 0 };
  const mine = sideScores(ours.bid ? [ours.bid] : [], ours.ask ? [ours.ask] : [], mid, maxSpread, minSize);
  const crowd = sideScores(book.bids, book.asks, mid, maxSpread, minSize);
  const q = makerScore(mine, mid);
  return { mid, ours: mine, crowd, share: q > 0 ? q / (q + crowdScoreUpperBound(crowd, mid)) : 0 };
}
