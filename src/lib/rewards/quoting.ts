import { EPS, type Level } from "./scoring";

export interface QuoteConfig {
  /** How far from the reference price to rest, as a fraction of the market's max spread (1 = at the edge, scores nothing). */
  offsetFraction: number;
  /** Shift both quotes this much against our inventory, per minimum-size lot held. */
  skewPerLot: number;
  /** Never hold more than this many minimum-size lots net, either way. */
  capLots: number;
  /** Only quote while the reference price is inside this band. */
  minPrice: number;
  maxPrice: number;
}

export interface QuoteInput {
  bids: Level[];
  asks: Level[];
  /** Last traded YES price, if known. */
  lastPrice: number | null;
  minSize: number;
  maxSpread: number;
  tick: number;
  yesShares: number;
  noShares: number;
  /** Cash this market may tie up in resting orders. */
  freeCash: number;
}

export interface Quotes {
  bid: Level | null;
  ask: Level | null;
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;
const floorTick = (x: number, tick: number) => round4(Math.floor(x / tick + EPS) * tick);
const ceilTick = (x: number, tick: number) => round4(Math.ceil(x / tick - EPS) * tick);

/**
 * Where the market "is". With a normal spread that is the middle of the book.
 * When the book is more than 10c wide the middle means little, so the last
 * trade is used if it sits inside the book (the price Polymarket itself shows).
 */
export function referencePrice(bids: Level[], asks: Level[], lastPrice: number | null): number | null {
  const bestBid = bids.reduce<number | null>((b, l) => (b === null || l.price > b ? l.price : b), null);
  const bestAsk = asks.reduce<number | null>((a, l) => (a === null || l.price < a ? l.price : a), null);
  if (bestBid === null || bestAsk === null || bestAsk <= bestBid) return null;
  if (bestAsk - bestBid > 0.1 + EPS && lastPrice !== null && lastPrice > bestBid && lastPrice < bestAsk) return lastPrice;
  return (bestBid + bestAsk) / 2;
}

/** Capital a pair of resting orders ties up. Selling YES we hold is free; selling beyond that means buying NO at 1 - ask. */
export function quoteCapital(q: Quotes, yesShares: number): number {
  const bid = q.bid ? q.bid.size * q.bid.price : 0;
  const ask = q.ask ? Math.max(0, q.ask.size - yesShares) * (1 - q.ask.price) : 0;
  return bid + ask;
}

/**
 * One minimum-size order each side of the reference price. Resting orders only:
 * a quote is pulled back rather than crossing the real book.
 */
export function buildQuotes(input: QuoteInput, cfg: QuoteConfig): Quotes {
  const none: Quotes = { bid: null, ask: null };
  const ref = referencePrice(input.bids, input.asks, input.lastPrice);
  if (ref === null || ref < cfg.minPrice - EPS || ref > cfg.maxPrice + EPS) return none;
  const bestBid = Math.max(...input.bids.map((l) => l.price));
  const bestAsk = Math.min(...input.asks.map((l) => l.price));

  const net = input.yesShares - input.noShares;
  const center = ref - cfg.skewPerLot * (net / input.minSize);
  const offset = Math.min(Math.max(input.tick, input.maxSpread * cfg.offsetFraction), input.maxSpread - input.tick);
  let bidPrice = floorTick(center - offset, input.tick);
  let askPrice = ceilTick(center + offset, input.tick);
  if (bidPrice >= bestAsk - EPS) bidPrice = round4(bestAsk - input.tick);
  if (askPrice <= bestBid + EPS) askPrice = round4(bestBid + input.tick);
  if (bidPrice < input.tick - EPS || askPrice > 1 - input.tick + EPS || bidPrice >= askPrice - EPS) return none;

  const cap = cfg.capLots * input.minSize;
  const q: Quotes = {
    bid: net + input.minSize <= cap + EPS ? { price: bidPrice, size: input.minSize } : null,
    ask: -net + input.minSize <= cap + EPS ? { price: askPrice, size: input.minSize } : null,
  };
  // Drop whatever the account cannot fund, bid first (it is the side that spends the most).
  if (q.bid && quoteCapital({ bid: q.bid, ask: null }, input.yesShares) > input.freeCash + EPS) q.bid = null;
  if (q.ask && quoteCapital(q, input.yesShares) > input.freeCash + EPS) q.ask = null;
  return q;
}
