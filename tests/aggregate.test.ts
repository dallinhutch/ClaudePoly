import { describe, expect, it } from "vitest";
import { aggregateAnalysts, type AnalystInput } from "@/lib/research/aggregate";

const opts = { minAnalystEvidenceQuality: 0.3, disagreementScale: 0.15 };
const a = (key: string, p: number, c = 0.8, q = 0.8): AnalystInput => ({ analystKey: key, probabilityYes: p, confidence: c, evidenceQuality: q });

describe("aggregateAnalysts", () => {
  it("computes mean, median, stdev for the spec example", () => {
    const r = aggregateAnalysts([a("A", 0.71), a("B", 0.78), a("C", 0.74), a("D", 0.65), a("E", 0.76)], opts);
    expect(r.mean.toFixed(4)).toBe("0.7280");
    expect(r.median.toFixed(2)).toBe("0.74");
    expect(r.stdev.toNumber()).toBeCloseTo(0.04534, 4);
    // Equal weights: log-odds pool stays near the mean.
    expect(r.probabilityYes.toNumber()).toBeGreaterThan(0.71);
    expect(r.probabilityYes.toNumber()).toBeLessThan(0.75);
  });

  it("large disagreement reduces confidence", () => {
    const agree = aggregateAnalysts([a("A", 0.7), a("B", 0.72), a("C", 0.71)], opts);
    const disagree = aggregateAnalysts([a("A", 0.4), a("B", 0.9), a("C", 0.7)], opts);
    expect(disagree.confidence.lt(agree.confidence)).toBe(true);
    expect(disagree.disagreementFactor.toNumber()).toBeLessThan(0.5);
  });

  it("excludes weak-evidence analyses instead of averaging them in", () => {
    const r = aggregateAnalysts([a("A", 0.7, 0.8, 0.9), a("B", 0.72, 0.8, 0.8), a("junk", 0.05, 0.9, 0.1)], opts);
    expect(r.excluded).toEqual(["junk"]);
    expect(r.usedCount).toBe(2);
    expect(r.probabilityYes.toNumber()).toBeGreaterThan(0.69);
  });

  it("keeps everyone if all analyses are weak (but confidence reflects it)", () => {
    const r = aggregateAnalysts([a("A", 0.6, 0.5, 0.1), a("B", 0.62, 0.5, 0.2)], opts);
    expect(r.usedCount).toBe(2);
    expect(r.confidence.toNumber()).toBeLessThan(0.3);
  });

  it("weights high-quality evidence more", () => {
    const r = aggregateAnalysts([a("strong", 0.8, 0.9, 0.95), a("weak", 0.4, 0.4, 0.35)], opts);
    expect(r.probabilityYes.toNumber()).toBeGreaterThan(r.mean.toNumber());
  });

  it("is deterministic and handles extremes", () => {
    const inputs = [a("A", 0, 0.9, 0.9), a("B", 1, 0.9, 0.9)];
    const r1 = aggregateAnalysts(inputs, opts);
    const r2 = aggregateAnalysts(inputs, opts);
    expect(r1.probabilityYes.toFixed(10)).toBe(r2.probabilityYes.toFixed(10));
    expect(r1.probabilityYes.toFixed(6)).toBe("0.500000");
  });

  it("rejects invalid input", () => {
    expect(() => aggregateAnalysts([], opts)).toThrow();
    expect(() => aggregateAnalysts([a("A", 1.2)], opts)).toThrow();
  });
});
