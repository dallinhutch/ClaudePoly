import Decimal from "decimal.js";

/**
 * All financial math goes through this Decimal clone. Never use JS floats for
 * prices, shares, dollars, or probabilities that feed accounting.
 */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
export type Dec = Decimal;
export type Numeric = Decimal | string | number;

export const ZERO = new D(0);
export const ONE = new D(1);

export function dec(v: Numeric): Dec {
  return new D(v);
}

export function min(...vals: Numeric[]): Dec {
  return D.min(...vals.map(dec));
}

export function max(...vals: Numeric[]): Dec {
  return D.max(...vals.map(dec));
}

export function clamp(v: Numeric, lo: Numeric, hi: Numeric): Dec {
  return max(lo, min(hi, v));
}

/** Round dollars to whole cents, always DOWN (never spend money we don't have). */
export function floorCents(v: Numeric): Dec {
  return dec(v).toDecimalPlaces(2, D.ROUND_DOWN);
}

/** Serialize for NUMERIC columns. Scale must match the column definition. */
export function toDb(v: Numeric, scale = 6): string {
  return dec(v).toDecimalPlaces(scale, D.ROUND_HALF_EVEN).toFixed(scale);
}

export function toNum(v: Numeric): number {
  return dec(v).toNumber();
}
