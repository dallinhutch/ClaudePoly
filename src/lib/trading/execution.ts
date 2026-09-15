import { D, dec, ZERO, type Dec, type Numeric } from "@/lib/decimal";

/**
 * Paper execution against a REAL order-book snapshot.
 *
 * Model: an immediate-or-cancel (fill-and-kill) limit order. It consumes visible
 * liquidity level by level up to the limit price, pays Polymarket's taker fee
 * on every level, and anything that can't fill right now is cancelled. We never
 * simulate resting orders, because assuming a passive order would have been
 * filled requires information we don't have (queue position) and flatters results.
 *
 * Polymarket taker fee (docs.polymarket.com, Trading > Fees):
 *   fee = shares * rate * (p * (1 - p))^exponent    (USDC, rounded to 5 dp)
 */

export interface BookLevelInput { price: string; size: string }
export interface FeeScheduleInput { rate: number; exponent: number }
export interface FeeModel { feesEnabled: boolean; schedule: FeeScheduleInput | null }

/** CLOB order sizes are in hundredths of a share. */
export const SHARE_DECIMALS = 2;
/** Used when a market says fees are enabled but publishes no schedule: assume a
 * relatively high rate so we never under-charge. */
export const FALLBACK_FEE_SCHEDULE: FeeScheduleInput = { rate: 0.07, exponent: 1 };

const SHARE_STEP = new D(1).div(10 ** SHARE_DECIMALS);

/** Build a fee model from a market row's `fees_enabled` + `fee_schedule` jsonb. */
export function feeModelFromMarket(feesEnabled: boolean, feeSchedule: unknown): FeeModel {
  const s = feeSchedule as { rate?: unknown; exponent?: unknown } | null;
  const valid = !!s && typeof s.rate === "number" && typeof s.exponent === "number";
  return { feesEnabled, schedule: valid ? { rate: s.rate as number, exponent: s.exponent as number } : null };
}

function schedule(fee: FeeModel): FeeScheduleInput | null {
  if (!fee.feesEnabled) return null;
  return fee.schedule ?? FALLBACK_FEE_SCHEDULE;
}

/** Unrounded fee per share at `price`. */
export function feePerShare(price: Numeric, fee: FeeModel): Dec {
  const s = schedule(fee);
  if (!s) return ZERO;
  const p = dec(price);
  return dec(s.rate).times(p.times(D.sub(1, p)).pow(s.exponent));
}

export function takerFee(shares: Numeric, price: Numeric, fee: FeeModel): Dec {
  return dec(shares).times(feePerShare(price, fee)).toDecimalPlaces(5, D.ROUND_HALF_UP);
}

export interface LevelFill { levelIndex: number; price: Dec; shares: Dec; notional: Dec; fee: Dec }

export interface FillResult {
  status: "FILLED" | "PARTIAL" | "UNFILLED";
  filledShares: Dec;
  /** Sum of shares * price, excluding fees. */
  notional: Dec;
  fees: Dec;
  /** Volume-weighted price excluding fees. */
  avgPrice: Dec | null;
  /** Buys: (notional + fees) / shares. Sells: (notional - fees) / shares. */
  allInPrice: Dec | null;
  fills: LevelFill[];
  reason: string;
}

const floorShares = (v: Dec) => v.toDecimalPlaces(SHARE_DECIMALS, D.ROUND_DOWN);

function sortedLevels(levels: BookLevelInput[], direction: "asc" | "desc") {
  return levels
    .map((l, originalIndex) => ({ price: dec(l.price), size: dec(l.size), originalIndex }))
    .filter((l) => l.size.gt(0) && l.price.gt(0) && l.price.lt(1))
    .sort((a, b) => (direction === "asc" ? a.price.comparedTo(b.price) : b.price.comparedTo(a.price)));
}

function summarize(fills: LevelFill[], minOrderShares: Numeric, buy: boolean): Omit<FillResult, "status" | "reason"> & { belowMin: boolean } {
  const filledShares = fills.reduce((s, f) => s.plus(f.shares), ZERO);
  const notional = fills.reduce((s, f) => s.plus(f.notional), ZERO);
  const fees = fills.reduce((s, f) => s.plus(f.fee), ZERO);
  const belowMin = filledShares.lt(minOrderShares) || filledShares.lte(0);
  if (belowMin) {
    return { filledShares: ZERO, notional: ZERO, fees: ZERO, avgPrice: null, allInPrice: null, fills: [], belowMin };
  }
  return {
    filledShares,
    notional,
    fees,
    avgPrice: notional.div(filledShares),
    allInPrice: (buy ? notional.plus(fees) : notional.minus(fees)).div(filledShares),
    fills,
    belowMin,
  };
}

/** Spend up to `budgetUsd` (fees included) buying shares at or below `limitPrice`. */
export function simulateBuy(params: {
  asks: BookLevelInput[];
  budgetUsd: Numeric;
  limitPrice: Numeric;
  minOrderShares: Numeric;
  fee: FeeModel;
}): FillResult {
  const limit = dec(params.limitPrice);
  let remaining = dec(params.budgetUsd);
  const fills: LevelFill[] = [];
  let lastUnitCost = ZERO;

  for (const level of sortedLevels(params.asks, "asc")) {
    if (level.price.gt(limit) || remaining.lte(0)) break;
    const unitCost = level.price.plus(feePerShare(level.price, params.fee));
    let take = floorShares(D.min(level.size, remaining.div(unitCost)));
    // Fee rounding can add a fraction of a cent; step down until the cost fits.
    while (take.gt(0) && take.times(level.price).plus(takerFee(take, level.price, params.fee)).gt(remaining)) {
      take = take.minus(SHARE_STEP);
    }
    if (take.lte(0)) break;
    const notional = take.times(level.price);
    const fee = takerFee(take, level.price, params.fee);
    remaining = remaining.minus(notional).minus(fee);
    lastUnitCost = unitCost;
    fills.push({ levelIndex: level.originalIndex, price: level.price, shares: take, notional, fee });
  }

  const s = summarize(fills, params.minOrderShares, true);
  const { belowMin, ...rest } = s;
  if (belowMin) {
    const bestAsk = sortedLevels(params.asks, "asc")[0]?.price;
    const reason = !bestAsk ? "no asks in book"
      : bestAsk.gt(limit) ? `best ask ${bestAsk.toFixed()} above limit ${limit.toFixed()}`
      : `fillable size below minimum order of ${dec(params.minOrderShares).toFixed()} shares`;
    return { ...rest, status: "UNFILLED", reason };
  }
  // Budget is exhausted if less than one share-step remains at the last price.
  const exhausted = remaining.lte(D.max("0.01", lastUnitCost.times(SHARE_STEP)));
  return exhausted
    ? { ...rest, status: "FILLED", reason: "filled within limit" }
    : { ...rest, status: "PARTIAL", reason: `insufficient depth at or below limit ${limit.toFixed()}; $${remaining.toFixed(2)} unfilled` };
}

/** Sell up to `shares` at or above `limitPrice`. */
export function simulateSell(params: {
  bids: BookLevelInput[];
  shares: Numeric;
  limitPrice: Numeric;
  minOrderShares: Numeric;
  fee: FeeModel;
}): FillResult {
  const limit = dec(params.limitPrice);
  let remaining = floorShares(dec(params.shares));
  const fills: LevelFill[] = [];

  for (const level of sortedLevels(params.bids, "desc")) {
    if (level.price.lt(limit) || remaining.lte(0)) break;
    const take = floorShares(D.min(level.size, remaining));
    if (take.lte(0)) break;
    const notional = take.times(level.price);
    fills.push({ levelIndex: level.originalIndex, price: level.price, shares: take, notional, fee: takerFee(take, level.price, params.fee) });
    remaining = remaining.minus(take);
  }

  const { belowMin, ...rest } = summarize(fills, params.minOrderShares, false);
  if (belowMin) {
    const bestBid = sortedLevels(params.bids, "desc")[0]?.price;
    const reason = !bestBid ? "no bids in book"
      : bestBid.lt(limit) ? `best bid ${bestBid.toFixed()} below limit ${limit.toFixed()}`
      : `fillable size below minimum order of ${dec(params.minOrderShares).toFixed()} shares`;
    return { ...rest, status: "UNFILLED", reason };
  }
  return remaining.lte(0)
    ? { ...rest, status: "FILLED", reason: "filled within limit" }
    : { ...rest, status: "PARTIAL", reason: `insufficient bids at or above ${limit.toFixed()}; ${remaining.toFixed()} shares unsold` };
}

/** Dollar value of ask liquidity at or below `limitPrice` (fees excluded). */
export function askDepthUsd(asks: BookLevelInput[], limitPrice: Numeric): Dec {
  const limit = dec(limitPrice);
  return sortedLevels(asks, "asc")
    .filter((l) => l.price.lte(limit))
    .reduce((s, l) => s.plus(l.price.times(l.size)), ZERO);
}

export function bestPrice(levels: BookLevelInput[], kind: "ask" | "bid"): Dec | null {
  return sortedLevels(levels, kind === "ask" ? "asc" : "desc")[0]?.price ?? null;
}
