import { D, dec, min, ONE, ZERO, type Dec, type Numeric } from "@/lib/decimal";

/**
 * Paper inventory in one market. Selling YES we do not hold is done the way
 * Polymarket does it: by buying NO at (1 - price). A YES and a NO share
 * together are worth exactly $1 and are merged back into cash at once.
 */
export interface LpPosition {
  yes: Dec;
  no: Dec;
  /** Net cash this market has taken (negative) or returned (positive), fills and merges only. */
  cashFlow: Dec;
  fills: number;
}

/** Polymarket does not pay a market's daily reward if it comes to less than this. */
export const MIN_DAILY_PAYOUT = new D(1);

const q6 = (v: Dec) => v.toDecimalPlaces(6, D.ROUND_HALF_EVEN);

export function emptyLpPosition(): LpPosition {
  return { yes: ZERO, no: ZERO, cashFlow: ZERO, fills: 0 };
}

/** Our resting bid was hit (we buy YES) or our resting ask was lifted (we sell YES). Resting orders pay no fee. */
export function applyLpFill(pos: LpPosition, side: "BID" | "ASK", price: Numeric, size: Numeric): { next: LpPosition; cashDelta: Dec } {
  const p = dec(price);
  const n = dec(size);
  if (n.lte(0)) throw new Error("applyLpFill: size must be positive");
  if (p.lte(0) || p.gte(1)) throw new Error(`applyLpFill: price ${p} outside (0, 1)`);
  let { yes, no } = pos;
  let cashDelta = ZERO;
  if (side === "BID") {
    cashDelta = cashDelta.minus(n.times(p));
    yes = yes.plus(n);
    const pairs = min(yes, no);
    yes = yes.minus(pairs);
    no = no.minus(pairs);
    cashDelta = cashDelta.plus(pairs);
  } else {
    const fromInventory = min(yes, n);
    const short = n.minus(fromInventory);
    cashDelta = cashDelta.plus(fromInventory.times(p)).minus(short.times(ONE.minus(p)));
    yes = yes.minus(fromInventory);
    no = no.plus(short);
  }
  cashDelta = q6(cashDelta);
  return { next: { yes, no, cashFlow: pos.cashFlow.plus(cashDelta), fills: pos.fills + 1 }, cashDelta };
}

/** What the inventory is worth with YES at this price. */
export function lpMarkValue(pos: LpPosition, yesPrice: Numeric): Dec {
  const p = dec(yesPrice);
  return q6(pos.yes.times(p).plus(pos.no.times(ONE.minus(p))));
}

/** Market resolved: YES pays `payoutYes` (1, 0, or 0.5 when voided) and NO pays the rest. */
export function settleLpPosition(pos: LpPosition, payoutYes: Numeric): { cashDelta: Dec; realized: Dec } {
  const cashDelta = lpMarkValue(pos, payoutYes);
  return { cashDelta, realized: pos.cashFlow.plus(cashDelta) };
}

/** End of a UTC day for one market: the accrued reward is paid only if it reaches the minimum. */
export function settleRewardDay(accrued: Numeric): { paid: Dec; forfeited: Dec } {
  const a = dec(accrued);
  return a.gte(MIN_DAILY_PAYOUT) ? { paid: a, forfeited: ZERO } : { paid: ZERO, forfeited: a };
}
