import { describe, expect, it } from "vitest";
import {
  bestSide, brierScore, evPerDollar, kellyFraction, rawEdge, shrinkTowardMarket, sideProbability,
} from "@/lib/trading/probability";

describe("probability math", () => {
  it("computes raw edge in probability points (spec example: 0.67 vs $0.44 = +23pp)", () => {
    expect(rawEdge("0.67", "0.44").toFixed(4)).toBe("0.2300");
  });

  it("NO probability is the complement of YES", () => {
    expect(sideProbability("0.71", "NO").toFixed(2)).toBe("0.29");
  });

  it("high probability is not the same as a good trade", () => {
    // 85% event priced at 92c: negative EV.
    expect(evPerDollar("0.85", "0.92").isNegative()).toBe(true);
    expect(kellyFraction("0.85", "0.92").toNumber()).toBe(0);
    // 65% event priced at 40c: +62.5% EV per dollar.
    expect(evPerDollar("0.65", "0.40").toFixed(4)).toBe("0.6250");
  });

  it("Kelly fraction for a binary share: (q - p) / (1 - p)", () => {
    expect(kellyFraction("0.65", "0.40").toFixed(6)).toBe("0.416667");
    expect(kellyFraction("0.40", "0.40").toNumber()).toBe(0);
    expect(kellyFraction("0.99", "1").toNumber()).toBe(0);
    expect(kellyFraction("0.5", "0").toNumber()).toBe(0);
  });

  it("shrinks toward market by confidence", () => {
    expect(shrinkTowardMarket("0.70", "0.50", "0.5").toFixed(2)).toBe("0.60");
    expect(shrinkTowardMarket("0.70", "0.50", "0").toFixed(2)).toBe("0.50");
    expect(shrinkTowardMarket("0.70", "0.50", "1").toFixed(2)).toBe("0.70");
  });

  it("bestSide picks NO when YES is overpriced", () => {
    const r = bestSide("0.30", "0.55", "0.47");
    expect(r.yes!.edge.isNegative()).toBe(true);
    expect(r.best!.side).toBe("NO");
    expect(r.best!.edge.toFixed(2)).toBe("0.23");
  });

  it("bestSide returns null when neither side has edge", () => {
    expect(bestSide("0.50", "0.51", "0.51").best).toBeNull();
  });

  it("bestSide handles a missing book side", () => {
    expect(bestSide("0.80", null, "0.30").best).toBeNull();
    expect(bestSide("0.80", "0.60", null).best!.side).toBe("YES");
  });

  it("Brier score", () => {
    expect(brierScore("0.8", true).toFixed(2)).toBe("0.04");
    expect(brierScore("0.8", false).toFixed(2)).toBe("0.64");
  });
});
