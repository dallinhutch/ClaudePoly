export interface FinalPayouts {
  payoutYes: string;
  payoutNo: string;
  winningSide: "YES" | "NO" | null;
}

/**
 * Decide whether a Gamma market has FINALLY resolved, and what each share pays.
 * Conservative: the market must be closed, its resolution settled (UMA
 * "resolved" or automatically resolved), and prices must be exactly 1/0, 0/1,
 * or 0.5/0.5. Anything else (e.g. 0.9995 while a dispute is pending) is not final.
 */
export function finalPayouts(m: {
  closed?: boolean | null;
  outcomePrices: string[];
  umaResolutionStatus?: string | null;
  automaticallyResolved?: boolean | null;
}): FinalPayouts | null {
  if (!m.closed || m.outcomePrices.length !== 2) return null;
  const settled = m.umaResolutionStatus === "resolved" || m.automaticallyResolved === true;
  if (!settled) return null;
  const [y, n] = m.outcomePrices.map((p) => Number(p));
  if (y === 1 && n === 0) return { payoutYes: "1", payoutNo: "0", winningSide: "YES" };
  if (y === 0 && n === 1) return { payoutYes: "0", payoutNo: "1", winningSide: "NO" };
  if (y === 0.5 && n === 0.5) return { payoutYes: "0.5", payoutNo: "0.5", winningSide: null };
  return null;
}
