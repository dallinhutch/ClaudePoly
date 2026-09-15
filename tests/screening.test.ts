import { describe, expect, it } from "vitest";
import { screenMarket, type MarketRow } from "@/lib/screening/screen";
import { defaultStrategyConfig } from "@/lib/strategy/config";

const cfg = defaultStrategyConfig().screening;
const NOW = new Date("2026-09-15T00:00:00Z");

/** TEST FIXTURE — not real market data. */
function fixture(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    id: "fixture-1", conditionId: "0xfixture", eventId: null, slug: "fixture", groupItemTitle: null,
    question: "Will the Fed cut rates at the October 2026 meeting?",
    description: "This market will resolve to \"Yes\" if the FOMC announces a cut to the target federal funds range at its October 2026 meeting, according to the official statement published at https://www.federalreserve.gov. Otherwise, this market will resolve to \"No\". The primary resolution source is the official FOMC statement.",
    resolutionSource: "https://www.federalreserve.gov", category: "Economy", tags: ["Economy", "Fed Rates"],
    outcomes: ["Yes", "No"], yesTokenId: "111", noTokenId: "222",
    startDate: new Date("2026-08-01T00:00:00Z"), endDate: new Date("2026-10-28T00:00:00Z"),
    active: true, closed: false, acceptingOrders: true, enableOrderBook: true, negRisk: false,
    yesPrice: "0.420000", noPrice: "0.580000", bestBid: "0.415000", bestAsk: "0.425000", lastTradePrice: "0.420000",
    spread: "0.010000", liquidityUsd: "150000", volumeUsd: "2000000", volume24hUsd: "40000",
    feesEnabled: true, feeSchedule: { rate: 0.05, exponent: 1 }, minTickSize: "0.001", minOrderSize: "5",
    umaResolutionStatus: null, firstSeenAt: NOW, updatedAt: NOW, raw: null,
    ...overrides,
  };
}

describe("screenMarket", () => {
  it("passes a liquid, clearly-worded, researchable market", () => {
    const r = screenMarket(fixture(), cfg, NOW);
    expect(r.reasons).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.score).toBeGreaterThan(cfg.minScreenScore);
  });

  it.each([
    ["illiquid", { liquidityUsd: "900" }, /liquidity/],
    ["closed", { closed: true }, /closed/],
    ["resolving too soon", { endDate: new Date("2026-09-15T12:00:00Z") }, /resolves in/],
    ["too far out", { endDate: new Date("2028-01-01T00:00:00Z") }, /resolves in/],
    ["extreme price", { yesPrice: "0.990000" }, /YES price/],
    ["wide spread", { spread: "0.200000" }, /spread/],
    ["random short-term crypto", { question: "Bitcoin Up or Down - 3PM ET?" }, /excluded question/],
    ["excluded tag", { tags: ["Crypto Prices"] }, /excluded tag/],
    ["non-binary", { noTokenId: null }, /binary/],
  ])("rejects %s", (_label, overrides, pattern) => {
    const r = screenMarket(fixture(overrides as Partial<MarketRow>), cfg, NOW);
    expect(r.passed).toBe(false);
    expect(r.reasons.join("; ")).toMatch(pattern);
  });

  it("ranks vague resolution wording and low researchability lower", () => {
    const clear = screenMarket(fixture(), cfg, NOW).score;
    const vague = screenMarket(fixture({ description: "Resolves at the sole discretion of the market creator.", resolutionSource: null, tags: ["Sports"] }), cfg, NOW).score;
    expect(vague).toBeLessThan(clear);
  });

  it("is deterministic", () => {
    expect(screenMarket(fixture(), cfg, NOW)).toEqual(screenMarket(fixture(), cfg, NOW));
  });
});
