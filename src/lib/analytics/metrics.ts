/**
 * Performance and calibration statistics for display. Accounting is done in
 * Decimal elsewhere; these summaries use plain numbers.
 */

export interface ResolvedForecast {
  probabilityYes: number;
  resolvedYes: boolean;
}

export interface CalibrationBucket {
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number | null;
  observedYesRate: number | null;
}

export function calibration(forecasts: ResolvedForecast[], bucketCount = 10) {
  const buckets: CalibrationBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    lower: i / bucketCount, upper: (i + 1) / bucketCount, count: 0, meanPredicted: null, observedYesRate: null,
  }));
  const sums = buckets.map(() => ({ p: 0, yes: 0 }));
  let brier = 0;
  let logLoss = 0;
  for (const f of forecasts) {
    const p = Math.min(1, Math.max(0, f.probabilityYes));
    const i = Math.min(bucketCount - 1, Math.floor(p * bucketCount));
    buckets[i]!.count++;
    sums[i]!.p += p;
    if (f.resolvedYes) sums[i]!.yes++;
    const o = f.resolvedYes ? 1 : 0;
    brier += (p - o) ** 2;
    const clipped = Math.min(1 - 1e-6, Math.max(1e-6, p));
    logLoss += -(o * Math.log(clipped) + (1 - o) * Math.log(1 - clipped));
  }
  buckets.forEach((b, i) => {
    if (b.count > 0) {
      b.meanPredicted = sums[i]!.p / b.count;
      b.observedYesRate = sums[i]!.yes / b.count;
    }
  });
  const n = forecasts.length;
  return { count: n, buckets, brier: n ? brier / n : null, logLoss: n ? logLoss / n : null };
}

export interface ClosedTrade {
  realizedPnl: number;
  /** Total dollars spent buying (notional + fees) over the position's life. */
  invested: number;
  category: string | null;
  entryConfidence: number;
  entryEdge: number;
}

export function tradeStats(trades: ClosedTrade[]) {
  const wins = trades.filter((t) => t.realizedPnl > 0);
  const losses = trades.filter((t) => t.realizedPnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.realizedPnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.realizedPnl, 0);
  const n = trades.length;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    count: n,
    wins: wins.length,
    losses: losses.length,
    winRate: n ? wins.length / n : null,
    lossRate: n ? losses.length / n : null,
    avgWin: mean(wins.map((t) => t.realizedPnl)),
    avgLoss: mean(losses.map((t) => t.realizedPnl)),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : null,
    totalPnl: grossProfit - grossLoss,
    avgEdge: mean(trades.map((t) => t.entryEdge)),
    avgConfidence: mean(trades.map((t) => t.entryConfidence)),
  };
}

export type Bracket = { label: string; lower: number; upper: number };

export const CONFIDENCE_BRACKETS: Bracket[] = [
  { label: "<60%", lower: 0, upper: 0.6 }, { label: "60–70%", lower: 0.6, upper: 0.7 }, { label: "70–80%", lower: 0.7, upper: 0.8 },
  { label: "80–90%", lower: 0.8, upper: 0.9 }, { label: "90%+", lower: 0.9, upper: Number.POSITIVE_INFINITY },
];

export const EDGE_BRACKETS: Bracket[] = [
  { label: "<5pp", lower: Number.NEGATIVE_INFINITY, upper: 0.05 }, { label: "5–10pp", lower: 0.05, upper: 0.1 },
  { label: "10–15pp", lower: 0.1, upper: 0.15 }, { label: "15–20pp", lower: 0.15, upper: 0.2 }, { label: "20pp+", lower: 0.2, upper: Number.POSITIVE_INFINITY },
];

export function bracketOf(value: number, brackets: Bracket[]): string {
  return brackets.find((b) => value >= b.lower && value < b.upper)?.label ?? "n/a";
}

export function groupReturns(trades: ClosedTrade[], keyOf: (t: ClosedTrade) => string, order?: string[]) {
  const groups = new Map<string, ClosedTrade[]>();
  for (const t of trades) {
    const k = keyOf(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const rows = [...groups.entries()].map(([key, ts]) => {
    const pnl = ts.reduce((s, t) => s + t.realizedPnl, 0);
    const invested = ts.reduce((s, t) => s + t.invested, 0);
    return { key, count: ts.length, pnl, invested, roi: invested > 0 ? pnl / invested : null, winRate: ts.filter((t) => t.realizedPnl > 0).length / ts.length };
  });
  if (order) rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  else rows.sort((a, b) => b.pnl - a.pnl);
  return rows;
}

/** Largest peak-to-trough decline as a fraction of the peak. */
export function maxDrawdown(equity: number[]) {
  let peak = equity[0] ?? 0;
  let worst = 0;
  const series = equity.map((e) => {
    peak = Math.max(peak, e);
    const dd = peak > 0 ? (peak - e) / peak : 0;
    worst = Math.max(worst, dd);
    return dd;
  });
  return { maxDrawdown: worst, series };
}
