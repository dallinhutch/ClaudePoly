import { EPS, type Level } from "./scoring";
import type { Quotes } from "./quoting";

/** One taker trade from the public feed. Either outcome token may have traded. */
export interface PublicTrade {
  key: string;
  timestamp: number;
  outcomeIndex: number;
  side: "BUY" | "SELL";
  price: number;
  size: number;
}

export interface PaperFill {
  side: "BID" | "ASK";
  price: number;
  size: number;
  timestamp: number;
  via: "trade" | "book";
}

/** Buying NO at q is the same exposure as selling YES at 1 - q, so every trade has a YES-equivalent. */
export function yesEquivalent(t: PublicTrade): { takerBoughtYes: boolean; yesPrice: number } {
  const takerBoughtYes = (t.outcomeIndex === 0) === (t.side === "BUY");
  return { takerBoughtYes, yesPrice: t.outcomeIndex === 0 ? t.price : 1 - t.price };
}

/**
 * Which of our resting paper orders would these real trades have hit?
 * A taker who bought YES at or above our ask would have been filled by us
 * first (ours was the better price); likewise a seller at or below our bid.
 * Returns the fills and what is left of each order.
 */
export function matchTrades(quotes: Quotes, trades: PublicTrade[]): { fills: PaperFill[]; remaining: Quotes } {
  let bidLeft = quotes.bid?.size ?? 0;
  let askLeft = quotes.ask?.size ?? 0;
  const fills: PaperFill[] = [];
  for (const t of [...trades].sort((a, b) => a.timestamp - b.timestamp)) {
    const { takerBoughtYes, yesPrice } = yesEquivalent(t);
    if (takerBoughtYes && quotes.ask && askLeft > EPS && yesPrice >= quotes.ask.price - EPS) {
      const size = Math.min(t.size, askLeft);
      askLeft -= size;
      fills.push({ side: "ASK", price: quotes.ask.price, size, timestamp: t.timestamp, via: "trade" });
    } else if (!takerBoughtYes && quotes.bid && bidLeft > EPS && yesPrice <= quotes.bid.price + EPS) {
      const size = Math.min(t.size, bidLeft);
      bidLeft -= size;
      fills.push({ side: "BID", price: quotes.bid.price, size, timestamp: t.timestamp, via: "trade" });
    }
  }
  return { fills, remaining: withSizes(quotes, bidLeft, askLeft) };
}

/**
 * The book can also move through a resting order without a visible trade (a
 * new sell order priced at or below our bid would have matched us on arrival).
 */
export function crossFills(quotes: Quotes, book: { bids: Level[]; asks: Level[] }, timestamp: number): { fills: PaperFill[]; remaining: Quotes } {
  const fills: PaperFill[] = [];
  let bidLeft = quotes.bid?.size ?? 0;
  let askLeft = quotes.ask?.size ?? 0;
  if (quotes.bid && bidLeft > EPS) {
    const bidPrice = quotes.bid.price;
    const through = book.asks.filter((l) => l.price <= bidPrice + EPS).reduce((s, l) => s + l.size, 0);
    const size = Math.min(bidLeft, through);
    if (size > EPS) {
      bidLeft -= size;
      fills.push({ side: "BID", price: bidPrice, size, timestamp, via: "book" });
    }
  }
  if (quotes.ask && askLeft > EPS) {
    const askPrice = quotes.ask.price;
    const through = book.bids.filter((l) => l.price >= askPrice - EPS).reduce((s, l) => s + l.size, 0);
    const size = Math.min(askLeft, through);
    if (size > EPS) {
      askLeft -= size;
      fills.push({ side: "ASK", price: askPrice, size, timestamp, via: "book" });
    }
  }
  return { fills, remaining: withSizes(quotes, bidLeft, askLeft) };
}

function withSizes(q: Quotes, bidLeft: number, askLeft: number): Quotes {
  return {
    bid: q.bid && bidLeft > EPS ? { price: q.bid.price, size: bidLeft } : null,
    ask: q.ask && askLeft > EPS ? { price: q.ask.price, size: askLeft } : null,
  };
}
