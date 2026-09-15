import { describe, expect, it } from "vitest";
import { defaultStrategyConfig } from "@/lib/strategy/config";
import { buyLimitPrice, qualifyTrade, sellLimitPrice, type QualificationInput } from "@/lib/trading/qualification";

const cfg = defaultStrategyConfig().qualification;
const good: QualificationInput = {
  probSide: "0.67",
  allInPrice: "0.45",
  confidence: "0.85",
  evidenceQuality: "0.8",
  analystStdev: "0.04",
  liquidityUsd: "50000",
  hoursToResolution: 24 * 20,
  resolutionClarity: "clear",
  unresolvedContradictions: 0,
  newestEvidenceAgeHours: 6,
};

describe("qualifyTrade", () => {
  it("qualifies when every rule passes", () => {
    const r = qualifyTrade(good, cfg);
    expect(r.rejectionReasons).toEqual([]);
    expect(r.qualified).toBe(true);
    expect(r.edge.toFixed(2)).toBe("0.22");
  });

  it("high probability but expensive is NOT a trade", () => {
    const r = qualifyTrade({ ...good, probSide: "0.85", allInPrice: "0.92" }, cfg);
    expect(r.qualified).toBe(false);
    expect(r.rejectionReasons.some((x) => x.startsWith("edge_after_fees"))).toBe(true);
  });

  it("evaluates all rules and reports each failure", () => {
    const r = qualifyTrade({ ...good, confidence: "0.5", analystStdev: "0.2", resolutionClarity: "ambiguous", newestEvidenceAgeHours: null }, cfg);
    const failed = r.checks.filter((c) => !c.passed).map((c) => c.name);
    expect(failed).toEqual(["confidence", "analyst_disagreement", "information_freshness", "clear_resolution"]);
    expect(r.checks).toHaveLength(11);
  });

  it("enforces a minimum probability for the side being bought", () => {
    const strict = { ...cfg, minSideProbability: 0.8 };
    expect(qualifyTrade({ ...good, probSide: "0.78", allInPrice: "0.55" }, strict).rejectionReasons.some((x) => x.startsWith("side_probability"))).toBe(true);
    expect(qualifyTrade({ ...good, probSide: "0.86", allInPrice: "0.66" }, strict).qualified).toBe(true);
  });

  it("rejects unknown liquidity and unresolved contradictions", () => {
    const r = qualifyTrade({ ...good, liquidityUsd: null, unresolvedContradictions: 1 }, cfg);
    expect(r.qualified).toBe(false);
    expect(r.rejectionReasons).toHaveLength(2);
  });
});

describe("limit prices", () => {
  const noFees = { feesEnabled: false, schedule: null };
  const fees = { feesEnabled: true, schedule: { rate: 0.05, exponent: 1 } };

  it("caps a buy at best ask + slippage when our fair value is far above", () => {
    expect(buyLimitPrice({ probSide: "0.80", requiredEdge: "0.12", bestAsk: "0.40", maxSlippage: "0.02", tickSize: "0.01", fee: noFees })!.toFixed(2)).toBe("0.42");
  });

  it("caps a buy so the all-in cost still leaves the required edge", () => {
    // max all-in = 0.55; with 5% fee at p~0.54, fee/share ~0.0124 -> 0.54 fails, 0.53 passes (0.5425)
    expect(buyLimitPrice({ probSide: "0.67", requiredEdge: "0.12", bestAsk: "0.53", maxSlippage: "0.05", tickSize: "0.01", fee: fees })!.toFixed(2)).toBe("0.53");
  });

  it("returns null when no price satisfies the edge", () => {
    expect(buyLimitPrice({ probSide: "0.10", requiredEdge: "0.12", bestAsk: "0.05", maxSlippage: "0.02", tickSize: "0.01", fee: noFees })).toBeNull();
  });

  it("respects the tick grid", () => {
    expect(buyLimitPrice({ probSide: "0.6555", requiredEdge: "0.1", bestAsk: "0.6", maxSlippage: "0.05", tickSize: "0.001", fee: noFees })!.toFixed(3)).toBe("0.555");
  });

  it("sell limit is bid minus slippage rounded up to tick, floored at one tick", () => {
    expect(sellLimitPrice({ bestBid: "0.455", maxSlippage: "0.02", tickSize: "0.01" }).toFixed(2)).toBe("0.44");
    expect(sellLimitPrice({ bestBid: "0.01", maxSlippage: "0.02", tickSize: "0.01" }).toFixed(2)).toBe("0.01");
  });
});
