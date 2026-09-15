import { describe, expect, it } from "vitest";
import { dec, ZERO } from "@/lib/decimal";
import { applyBuy, applyResolution, applySell, drawdown, emptyPosition, markPosition, returnPct } from "@/lib/trading/positionMath";

describe("position accounting", () => {
  it("buy puts notional + fees into cost basis and debits cash", () => {
    const { next, cashDelta } = applyBuy(emptyPosition(), { shares: "100", notional: "40", fees: "1.2" });
    expect(next.shares.toFixed(2)).toBe("100.00");
    expect(next.costBasis.toFixed(2)).toBe("41.20");
    expect(cashDelta.toFixed(2)).toBe("-41.20");
  });

  it("partial sell relieves basis pro rata and realizes net of fees", () => {
    const bought = applyBuy(emptyPosition(), { shares: "100", notional: "40", fees: "1.2" }).next;
    const { next, cashDelta, realizedDelta } = applySell(bought, { shares: "40", notional: "22", fees: "0.5" });
    expect(cashDelta.toFixed(2)).toBe("21.50");
    expect(realizedDelta.toFixed(2)).toBe("5.02"); // 21.50 - 41.20*0.4
    expect(next.shares.toFixed(2)).toBe("60.00");
    expect(next.costBasis.toFixed(2)).toBe("24.72");
  });

  it("full sell leaves zero basis with no rounding dust", () => {
    const bought = applyBuy(emptyPosition(), { shares: "33.33", notional: "13.3333", fees: "0.33" }).next;
    const a = applySell(bought, { shares: "11.11", notional: "5", fees: "0" }).next;
    const b = applySell(a, { shares: "22.22", notional: "9", fees: "0" }).next;
    expect(b.shares.isZero()).toBe(true);
    expect(b.costBasis.isZero()).toBe(true);
  });

  it("rejects overselling", () => {
    const bought = applyBuy(emptyPosition(), { shares: "10", notional: "5", fees: "0" }).next;
    expect(() => applySell(bought, { shares: "11", notional: "5", fees: "0" })).toThrow();
  });

  it("resolution pays $1 per winning share, $0 per losing share, 0.5 on a 50/50", () => {
    const pos = applyBuy(emptyPosition(), { shares: "50", notional: "20", fees: "0.5" }).next;
    expect(applyResolution(pos, 1).realizedDelta.toFixed(2)).toBe("29.50");
    expect(applyResolution(pos, 0).realizedDelta.toFixed(2)).toBe("-20.50");
    expect(applyResolution(pos, "0.5").cashDelta.toFixed(2)).toBe("25.00");
  });

  it("marks at the bid; no bid means zero value", () => {
    const pos = applyBuy(emptyPosition(), { shares: "50", notional: "20", fees: "0" }).next;
    expect(markPosition(pos, "0.45").unrealizedPnl.toFixed(2)).toBe("2.50");
    expect(markPosition(pos, null).value.isZero()).toBe(true);
  });

  it("preserves the accounting identity across a sequence of trades", () => {
    const deposit = dec(1000);
    let cash = deposit;
    let pos = emptyPosition();
    const steps: Array<["buy" | "sell", string, string, string]> = [
      ["buy", "100", "41", "1.23"], ["buy", "25.5", "11.475", "0.3"], ["sell", "60", "30.6", "0.76"],
      ["sell", "15.25", "6.1", "0.19"], ["buy", "10", "4.9", "0.12"],
    ];
    for (const [kind, shares, notional, fees] of steps) {
      const r = kind === "buy" ? applyBuy(pos, { shares, notional, fees }) : applySell(pos, { shares, notional, fees });
      pos = r.next;
      cash = cash.plus(r.cashDelta);
      expect(cash.plus(pos.costBasis).toFixed(6)).toBe(deposit.plus(pos.realizedPnl).toFixed(6));
    }
    const resolved = applyResolution(pos, 1);
    cash = cash.plus(resolved.cashDelta);
    expect(cash.toFixed(6)).toBe(deposit.plus(resolved.next.realizedPnl).toFixed(6));
    expect(resolved.next.costBasis.isZero()).toBe(true);
  });

  it("drawdown and return", () => {
    expect(drawdown(850, 1000).toFixed(2)).toBe("0.15");
    expect(drawdown(1100, 1000)).toEqual(ZERO);
    expect(returnPct(1125, 1000).toFixed(3)).toBe("0.125");
  });
});
