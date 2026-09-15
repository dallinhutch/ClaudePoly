import { describe, expect, it } from "vitest";
import { defaultStrategyConfig } from "@/lib/strategy/config";
import { sizePosition, type SizingInput } from "@/lib/trading/sizing";

const cfg = defaultStrategyConfig().sizing;
const base: SizingInput = {
  probSide: "0.65",
  confidence: "0.9",
  price: "0.40",
  equity: "1000",
  cash: "1000",
  openExposure: "0",
  categoryExposure: "0",
  correlatedExposure: "0",
  existingPositionCost: "0",
  availableDepthUsd: "100000",
  drawdown: "0",
  daysToResolution: 30,
};

describe("sizePosition", () => {
  it("caps a big edge at max position % of bankroll", () => {
    // Quarter Kelly here is ~$94; 5% cap = $50.
    const r = sizePosition(base, cfg);
    expect(r.usd.toFixed(2)).toBe("50.00");
    expect(r.bindingConstraint).toBe("max_position");
    expect(r.limits.kelly.toNumber()).toBeGreaterThan(50);
  });

  it("uses fractional Kelly when it is the tightest limit", () => {
    const r = sizePosition({ ...base, probSide: "0.44", confidence: "0.8" }, cfg);
    // q_adj = 0.40 + 0.8*0.04 = 0.432; f* = 0.032/0.6 = 0.05333; x0.25 = 0.01333 -> $13.33
    expect(r.adjustedProbability.toFixed(3)).toBe("0.432");
    expect(r.usd.toFixed(2)).toBe("13.33");
    expect(r.bindingConstraint).toBe("kelly");
  });

  it("returns zero with no edge", () => {
    const r = sizePosition({ ...base, probSide: "0.38" }, cfg);
    expect(r.usd.toNumber()).toBe(0);
    expect(r.bindingConstraint).toBe("no_edge");
  });

  it("respects the cash reserve", () => {
    const r = sizePosition({ ...base, cash: "220" }, cfg);
    expect(r.usd.toFixed(2)).toBe("20.00");
    expect(r.bindingConstraint).toBe("cash_reserve");
  });

  it("never goes negative when caps are already exceeded", () => {
    const r = sizePosition({ ...base, openExposure: "600" }, cfg);
    expect(r.usd.toNumber()).toBe(0);
    expect(r.bindingConstraint).toBe("total_exposure");
  });

  it("enforces correlated (same-event) exposure", () => {
    const r = sizePosition({ ...base, correlatedExposure: "80" }, cfg);
    expect(r.usd.toFixed(2)).toBe("20.00");
    expect(r.bindingConstraint).toBe("correlated_exposure");
  });

  it("limits to a fraction of visible book depth", () => {
    const r = sizePosition({ ...base, availableDepthUsd: "120" }, cfg);
    expect(r.usd.toFixed(2)).toBe("30.00");
    expect(r.bindingConstraint).toBe("book_depth");
  });

  it("halts at max drawdown and throttles before it", () => {
    expect(sizePosition({ ...base, drawdown: "0.30" }, cfg).bindingConstraint).toBe("drawdown_halt");
    const throttled = sizePosition({ ...base, probSide: "0.44", confidence: "0.8", drawdown: "0.20" }, cfg);
    expect(throttled.drawdownFactor.toFixed(2)).toBe("0.50");
    expect(throttled.usd.toFixed(2)).toBe("6.66");
  });

  it("sizes down long-dated markets", () => {
    const r = sizePosition({ ...base, probSide: "0.44", confidence: "0.8", daysToResolution: 200 }, cfg);
    expect(r.timeFactor.toFixed(1)).toBe("0.5");
    expect(r.usd.toFixed(2)).toBe("6.66");
  });

  it("drops orders below the minimum size", () => {
    const r = sizePosition({ ...base, probSide: "0.41", confidence: "0.5" }, cfg);
    expect(r.usd.toNumber()).toBe(0);
    expect(r.bindingConstraint).toBe("below_min_order");
  });

  it("accounts for existing position cost on ADD", () => {
    const r = sizePosition({ ...base, existingPositionCost: "45" }, cfg);
    expect(r.usd.toFixed(2)).toBe("5.00");
  });
});
