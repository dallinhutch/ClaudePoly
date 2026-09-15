import { describe, expect, it } from "vitest";
import { bracketOf, calibration, CONFIDENCE_BRACKETS, EDGE_BRACKETS, groupReturns, maxDrawdown, tradeStats, type ClosedTrade } from "@/lib/analytics/metrics";

describe("calibration", () => {
  it("buckets forecasts and measures observed YES rate", () => {
    const forecasts = [
      ...Array.from({ length: 10 }, (_, i) => ({ probabilityYes: 0.62, resolvedYes: i < 6 })),
      ...Array.from({ length: 5 }, (_, i) => ({ probabilityYes: 0.91, resolvedYes: i < 4 })),
    ];
    const c = calibration(forecasts);
    const b60 = c.buckets[6]!;
    expect(b60.count).toBe(10);
    expect(b60.meanPredicted).toBeCloseTo(0.62);
    expect(b60.observedYesRate).toBeCloseTo(0.6);
    expect(c.buckets[9]!.observedYesRate).toBeCloseTo(0.8);
    expect(c.buckets[0]!.observedYesRate).toBeNull();
    expect(c.brier).toBeGreaterThan(0);
  });

  it("puts probability 1.0 in the top bucket and handles no data", () => {
    expect(calibration([{ probabilityYes: 1, resolvedYes: true }]).buckets[9]!.count).toBe(1);
    expect(calibration([]).brier).toBeNull();
  });
});

describe("trade stats", () => {
  const t = (pnl: number, invested = 50, conf = 0.85, edge = 0.14, category: string | null = "Politics"): ClosedTrade =>
    ({ realizedPnl: pnl, invested, entryConfidence: conf, entryEdge: edge, category });

  it("computes win rate, averages and profit factor", () => {
    const s = tradeStats([t(30), t(10), t(-20), t(0)]);
    expect(s.winRate).toBe(0.5);
    expect(s.lossRate).toBe(0.25);
    expect(s.avgWin).toBe(20);
    expect(s.avgLoss).toBe(-20);
    expect(s.profitFactor).toBe(2);
    expect(s.totalPnl).toBe(20);
  });

  it("groups returns by bracket", () => {
    const rows = groupReturns([t(10, 50, 0.82), t(-5, 50, 0.85), t(20, 100, 0.93)], (x) => bracketOf(x.entryConfidence, CONFIDENCE_BRACKETS), CONFIDENCE_BRACKETS.map((b) => b.label));
    expect(rows.map((r) => r.key)).toEqual(["80–90%", "90%+"]);
    expect(rows[0]!.roi).toBeCloseTo(0.05);
    expect(bracketOf(0.12, EDGE_BRACKETS)).toBe("10–15pp");
  });
});

describe("maxDrawdown", () => {
  it("finds the largest peak-to-trough decline", () => {
    expect(maxDrawdown([1000, 1100, 990, 1050, 880, 1200]).maxDrawdown).toBeCloseTo(0.2);
    expect(maxDrawdown([]).maxDrawdown).toBe(0);
  });
});
