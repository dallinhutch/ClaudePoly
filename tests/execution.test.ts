import { describe, expect, it } from "vitest";
import { askDepthUsd, bestPrice, simulateBuy, simulateSell, takerFee, type FeeModel } from "@/lib/trading/execution";

const noFees: FeeModel = { feesEnabled: false, schedule: null };
const crypto7: FeeModel = { feesEnabled: true, schedule: { rate: 0.07, exponent: 1 } };

describe("taker fee", () => {
  it("matches Polymarket's documented example: 100 shares @ $0.50, rate 0.07 = $1.75", () => {
    expect(takerFee(100, "0.5", crypto7).toFixed(5)).toBe("1.75000");
  });
  it("is symmetric around 50c", () => {
    expect(takerFee(100, "0.3", crypto7).toFixed(5)).toBe(takerFee(100, "0.7", crypto7).toFixed(5));
  });
  it("is zero when fees are disabled", () => {
    expect(takerFee(100, "0.5", noFees).toNumber()).toBe(0);
  });
  it("falls back to a conservative rate if fees are enabled without a schedule", () => {
    expect(takerFee(100, "0.5", { feesEnabled: true, schedule: null }).toFixed(2)).toBe("1.75");
  });
});

describe("simulateBuy", () => {
  const asks = [
    { price: "0.41", size: "100" },
    { price: "0.40", size: "50" }, // deliberately unsorted
    { price: "0.45", size: "1000" },
  ];

  it("walks the book best-price-first and stops when the budget is spent", () => {
    const r = simulateBuy({ asks, budgetUsd: 30, limitPrice: "0.42", minOrderShares: 5, fee: noFees });
    expect(r.status).toBe("FILLED");
    expect(r.fills.map((f) => f.price.toFixed(2))).toEqual(["0.40", "0.41"]);
    expect(r.filledShares.toFixed(2)).toBe("74.39");
    expect(r.notional.lte(30)).toBe(true);
    expect(r.avgPrice!.gt("0.40") && r.avgPrice!.lt("0.41")).toBe(true);
  });

  it("partially fills when depth inside the limit runs out (no hindsight liquidity)", () => {
    const r = simulateBuy({ asks, budgetUsd: 100, limitPrice: "0.41", minOrderShares: 5, fee: noFees });
    expect(r.status).toBe("PARTIAL");
    expect(r.filledShares.toFixed(2)).toBe("150.00");
    expect(r.notional.toFixed(2)).toBe("61.00");
  });

  it("does not fill above the limit price", () => {
    const r = simulateBuy({ asks, budgetUsd: 100, limitPrice: "0.39", minOrderShares: 5, fee: noFees });
    expect(r.status).toBe("UNFILLED");
    expect(r.reason).toContain("above limit");
    expect(r.filledShares.toNumber()).toBe(0);
  });

  it("rejects fills below the exchange minimum order size", () => {
    const r = simulateBuy({ asks: [{ price: "0.40", size: "3" }], budgetUsd: 100, limitPrice: "0.5", minOrderShares: 5, fee: noFees });
    expect(r.status).toBe("UNFILLED");
    expect(r.fills).toHaveLength(0);
  });

  it("pays fees out of the budget", () => {
    const r = simulateBuy({ asks: [{ price: "0.50", size: "1000" }], budgetUsd: 10, limitPrice: "0.5", minOrderShares: 5, fee: crypto7 });
    expect(r.filledShares.toFixed(2)).toBe("19.32");
    expect(r.fees.toFixed(5)).toBe("0.33810");
    expect(r.notional.plus(r.fees).lte(10)).toBe(true);
    expect(r.allInPrice!.toFixed(4)).toBe("0.5175");
    expect(r.status).toBe("FILLED");
  });

  it("never spends more than the budget (randomized books)", () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 300; i++) {
      const book = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => ({
        price: (0.01 + Math.floor(rand() * 98) / 100).toFixed(2),
        size: (rand() * 500).toFixed(2),
      }));
      const budget = (rand() * 200).toFixed(2);
      const r = simulateBuy({ asks: book, budgetUsd: budget, limitPrice: "0.99", minOrderShares: 5, fee: crypto7 });
      expect(r.notional.plus(r.fees).lte(budget)).toBe(true);
      for (const f of r.fills) expect(f.shares.decimalPlaces()).toBeLessThanOrEqual(2);
    }
  });
});

describe("simulateSell", () => {
  const bids = [
    { price: "0.30", size: "500" },
    { price: "0.39", size: "20" },
    { price: "0.38", size: "100" },
  ];

  it("walks bids highest-first down to the limit", () => {
    const r = simulateSell({ bids, shares: 60, limitPrice: "0.35", minOrderShares: 5, fee: noFees });
    expect(r.status).toBe("FILLED");
    expect(r.notional.toFixed(2)).toBe("23.00");
  });

  it("leaves shares unsold rather than filling below the limit", () => {
    const r = simulateSell({ bids, shares: 200, limitPrice: "0.35", minOrderShares: 5, fee: noFees });
    expect(r.status).toBe("PARTIAL");
    expect(r.filledShares.toFixed(2)).toBe("120.00");
  });

  it("deducts fees from proceeds", () => {
    const r = simulateSell({ bids: [{ price: "0.5", size: "100" }], shares: 100, limitPrice: "0.5", minOrderShares: 5, fee: crypto7 });
    expect(r.notional.minus(r.fees).toFixed(2)).toBe("48.25");
    expect(r.allInPrice!.toFixed(4)).toBe("0.4825");
  });
});

describe("book helpers", () => {
  it("computes depth inside a limit and best prices", () => {
    const asks = [{ price: "0.41", size: "100" }, { price: "0.40", size: "50" }, { price: "0.45", size: "10" }];
    expect(askDepthUsd(asks, "0.41").toFixed(2)).toBe("61.00");
    expect(bestPrice(asks, "ask")!.toFixed(2)).toBe("0.40");
    expect(bestPrice([{ price: "0.2", size: "1" }, { price: "0.3", size: "1" }], "bid")!.toFixed(1)).toBe("0.3");
  });
});
