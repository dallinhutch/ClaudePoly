import type { DbOrTx } from "@/db/client";
import { orderbookSnapshots, type markets } from "@/db/schema";
import { toDb } from "@/lib/decimal";
import { bestPrice } from "@/lib/trading/execution";
import { fetchOrderBook, normalizeBook, type OrderBook } from "./client";

type MarketRow = typeof markets.$inferSelect;

export interface StoredBook {
  snapshotId: string;
  side: "YES" | "NO";
  tokenId: string;
  book: OrderBook;
  bestBid: string | null;
  bestAsk: string | null;
  observedAt: Date;
}

/**
 * Fetch the live book for one side and persist it BEFORE it is used, so every
 * estimate and simulated fill references the exact liquidity that existed then.
 */
export async function captureBook(db: DbOrTx, market: MarketRow, side: "YES" | "NO"): Promise<StoredBook> {
  const tokenId = side === "YES" ? market.yesTokenId : market.noTokenId;
  if (!tokenId) throw new Error(`market ${market.id} has no ${side} token`);
  const book = normalizeBook(await fetchOrderBook(tokenId));
  const observedAt = new Date();
  const bid = bestPrice(book.bids, "bid");
  const ask = bestPrice(book.asks, "ask");
  const [row] = await db.insert(orderbookSnapshots).values({
    marketId: market.id,
    tokenId,
    side,
    observedAt,
    exchangeTimestamp: book.timestamp ?? null,
    bookHash: book.hash ?? null,
    bestBid: bid ? toDb(bid) : null,
    bestAsk: ask ? toDb(ask) : null,
    bids: book.bids,
    asks: book.asks,
  }).returning({ id: orderbookSnapshots.id });
  return { snapshotId: row!.id, side, tokenId, book, bestBid: bid?.toFixed() ?? null, bestAsk: ask?.toFixed() ?? null, observedAt };
}

export async function captureBothBooks(db: DbOrTx, market: MarketRow) {
  const [yes, no] = await Promise.all([captureBook(db, market, "YES"), captureBook(db, market, "NO")]);
  return { yes, no };
}
