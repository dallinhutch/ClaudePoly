import { D, dec, ZERO, type Dec, type Numeric } from "@/lib/decimal";

/**
 * Pure position accounting. Cost basis always INCLUDES fees paid to acquire the
 * shares, so realized P&L is net of all trading costs.
 *
 * Invariant (tested): cash + sum(open cost basis) == initial deposit + sum(realized P&L)
 */
export interface PositionState {
  shares: Dec;
  costBasis: Dec;
  realizedPnl: Dec;
  totalFees: Dec;
}

export interface TradeFill {
  shares: Numeric;
  notional: Numeric;
  fees: Numeric;
}

const q6 = (v: Dec) => v.toDecimalPlaces(6, D.ROUND_HALF_EVEN);

export function emptyPosition(): PositionState {
  return { shares: ZERO, costBasis: ZERO, realizedPnl: ZERO, totalFees: ZERO };
}

/** Buy: cash out = notional + fees; all of it becomes cost basis. */
export function applyBuy(state: PositionState, fill: TradeFill): { next: PositionState; cashDelta: Dec } {
  const shares = dec(fill.shares);
  if (shares.lte(0)) throw new Error("applyBuy: shares must be positive");
  const cost = q6(dec(fill.notional).plus(fill.fees));
  return {
    next: {
      shares: state.shares.plus(shares),
      costBasis: state.costBasis.plus(cost),
      realizedPnl: state.realizedPnl,
      totalFees: state.totalFees.plus(fill.fees),
    },
    cashDelta: cost.neg(),
  };
}

/** Sell: cost basis relieved pro rata; realized = proceeds (net of fees) - relieved basis. */
export function applySell(state: PositionState, fill: TradeFill): { next: PositionState; cashDelta: Dec; realizedDelta: Dec } {
  const shares = dec(fill.shares);
  if (shares.lte(0)) throw new Error("applySell: shares must be positive");
  if (shares.gt(state.shares)) throw new Error(`applySell: selling ${shares} > held ${state.shares}`);
  const proceeds = q6(dec(fill.notional).minus(fill.fees));
  const remainingShares = state.shares.minus(shares);
  // Closing the whole position relieves the entire basis (no rounding dust left behind).
  const relieved = remainingShares.isZero() ? state.costBasis : q6(state.costBasis.times(shares).div(state.shares));
  const realizedDelta = proceeds.minus(relieved);
  return {
    next: {
      shares: remainingShares,
      costBasis: state.costBasis.minus(relieved),
      realizedPnl: state.realizedPnl.plus(realizedDelta),
      totalFees: state.totalFees.plus(fill.fees),
    },
    cashDelta: proceeds,
    realizedDelta,
  };
}

/** Resolution: each share pays `payoutPerShare` (1, 0, or e.g. 0.5), no fees. */
export function applyResolution(state: PositionState, payoutPerShare: Numeric): { next: PositionState; cashDelta: Dec; realizedDelta: Dec } {
  const proceeds = q6(state.shares.times(payoutPerShare));
  const realizedDelta = proceeds.minus(state.costBasis);
  return {
    next: { shares: ZERO, costBasis: ZERO, realizedPnl: state.realizedPnl.plus(realizedDelta), totalFees: state.totalFees },
    cashDelta: proceeds,
    realizedDelta,
  };
}

/** Conservative mark: what the shares would fetch at the best bid (before exit fees). */
export function markPosition(state: PositionState, bid: Numeric | null): { value: Dec; unrealizedPnl: Dec } {
  const value = bid == null ? ZERO : q6(state.shares.times(bid));
  return { value, unrealizedPnl: value.minus(state.costBasis) };
}

export function drawdown(equity: Numeric, highWaterMark: Numeric): Dec {
  const hwm = dec(highWaterMark);
  if (hwm.lte(0)) return ZERO;
  return D.max(ZERO, hwm.minus(equity).div(hwm));
}

export function returnPct(equity: Numeric, starting: Numeric): Dec {
  return dec(equity).minus(starting).div(starting);
}
