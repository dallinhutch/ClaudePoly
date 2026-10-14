import { describe, expect, it } from "vitest";
import { dec } from "@/lib/decimal";
import { applyLpFill, emptyLpPosition, lpMarkValue, settleLpPosition, settleRewardDay } from "@/lib/rewards/account";
import type { RewardMarket } from "@/lib/rewards/api";
import { crossFills, matchTrades, yesEquivalent, type PublicTrade } from "@/lib/rewards/fills";
import { buildQuotes, quoteCapital, referencePrice, type QuoteConfig, type QuoteInput } from "@/lib/rewards/quoting";
import { applyScan, DEFAULT_CONFIG, gatherScan, newState, resumeAfterRestart, runCycle, summarize, type MarketInfo, type RobotApi } from "@/lib/rewards/robot";
import { adjustedMidpoint, crowdScoreUpperBound, evaluateQuotes, makerScore, orderScore, sideScores, type Level } from "@/lib/rewards/scoring";
import { isEligible } from "@/lib/rewards/select";

const cfgQ: QuoteConfig = DEFAULT_CONFIG.quoting;
const quoteInput = (over: Partial<QuoteInput> = {}): QuoteInput => ({
  bids: [{ price: 0.47, size: 50 }], asks: [{ price: 0.53, size: 50 }], lastPrice: null,
  minSize: 20, maxSpread: 0.045, tick: 0.01, yesShares: 0, noShares: 0, freeCash: 1000, ...over,
});

describe("reward scoring (published formula)", () => {
  it("weights an order by how close it sits to the midpoint, and not at all at the max spread", () => {
    expect(orderScore(0.03, 0.01)).toBeCloseTo(4 / 9, 10);
    expect(orderScore(0.03, 0.02)).toBeCloseTo(1 / 9, 10);
    expect(orderScore(0.03, 0.005)).toBeCloseTo(25 / 36, 10);
    expect(orderScore(0.03, 0.03)).toBe(0);
    expect(orderScore(0.03, 0.04)).toBe(0);
  });

  it("reproduces the worked example in the docs (Q_one = 111.11)", () => {
    // 100 at 1c and 200 at 2c on the bid, plus a 100-share ask on the other outcome at 0.51 (= a bid at 0.49 here).
    const bids: Level[] = [{ price: 0.49, size: 100 }, { price: 0.48, size: 200 }, { price: 0.49, size: 100 }];
    expect(sideScores(bids, [], 0.5, 0.03, 20).bid).toBeCloseTo(111.11, 2);
  });

  it("ignores orders under the minimum size, for the score and for the midpoint", () => {
    const bids: Level[] = [{ price: 0.55, size: 5 }, { price: 0.5, size: 20 }];
    const asks: Level[] = [{ price: 0.56, size: 19 }, { price: 0.6, size: 40 }];
    expect(adjustedMidpoint(bids, asks, 20)).toBeCloseTo(0.55, 10);
    expect(adjustedMidpoint(bids, [{ price: 0.56, size: 19 }], 20)).toBeNull();
    expect(sideScores([{ price: 0.54, size: 19 }], [], 0.55, 0.045, 20).bid).toBe(0);
  });

  it("needs both sides, except that one side alone counts for a third between 10c and 90c", () => {
    expect(makerScore({ bid: 30, ask: 12 }, 0.5)).toBe(12);
    expect(makerScore({ bid: 30, ask: 0 }, 0.5)).toBe(10);
    expect(makerScore({ bid: 30, ask: 0 }, 0.95)).toBe(0);
    expect(makerScore({ bid: 30, ask: 12 }, 0.95)).toBe(12);
  });

  it("never scores the competition below what any split of the book between makers could earn", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let trial = 0; trial < 500; trial++) {
      const mid = rnd() < 0.5 ? 0.5 : 0.95;
      const makers = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => ({ bid: rnd() < 0.3 ? 0 : rnd() * 100, ask: rnd() < 0.3 ? 0 : rnd() * 100 }));
      const total = { bid: makers.reduce((s, m) => s + m.bid, 0), ask: makers.reduce((s, m) => s + m.ask, 0) };
      const actual = makers.reduce((s, m) => s + makerScore(m, mid), 0);
      expect(actual).toBeLessThanOrEqual(crowdScoreUpperBound(total, mid) + 1e-9);
    }
  });

  it("gives a lone two-sided quote the whole sample, and less once someone else qualifies", () => {
    const wide = { bids: [{ price: 0.47, size: 7 }], asks: [{ price: 0.82, size: 153 }] };
    const ours = { bid: { price: 0.61, size: 20 }, ask: { price: 0.68, size: 20 } };
    expect(evaluateQuotes(wide, ours, 20, 0.045).share).toBe(1);
    const contested = { bids: [{ price: 0.63, size: 200 }], asks: [{ price: 0.66, size: 200 }] };
    const share = evaluateQuotes(contested, ours, 20, 0.045).share;
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(0.1);
  });

  it("moves the midpoint with our own orders: one order alone in a wide book earns nothing", () => {
    const wide = { bids: [{ price: 0.47, size: 40 }], asks: [{ price: 0.82, size: 153 }] };
    const ev = evaluateQuotes(wide, { bid: { price: 0.62, size: 20 }, ask: null }, 20, 0.045);
    expect(ev.mid).toBeCloseTo(0.72, 10);
    expect(ev.share).toBe(0);
  });
});

describe("paper quotes", () => {
  it("rests one minimum-size order each side, on the tick, inside the max spread", () => {
    const q = buildQuotes(quoteInput(), cfgQ);
    expect(q.bid).toEqual({ price: 0.47, size: 20 });
    expect(q.ask).toEqual({ price: 0.53, size: 20 });
    expect(evaluateQuotes({ bids: [], asks: [] }, q, 20, 0.045).share).toBe(1);
  });

  it("uses the last trade when the book is too wide for its middle to mean anything", () => {
    const bids = [{ price: 0.3, size: 10 }];
    const asks = [{ price: 0.7, size: 10 }];
    expect(referencePrice(bids, asks, 0.62)).toBe(0.62);
    expect(referencePrice(bids, asks, 0.75)).toBe(0.5);
    expect(referencePrice([{ price: 0.5, size: 1 }], [{ price: 0.52, size: 1 }], 0.9)).toBeCloseTo(0.51, 10);
    expect(referencePrice([], asks, 0.5)).toBeNull();
  });

  it("leans against inventory and stops adding at the cap", () => {
    const long = buildQuotes(quoteInput({ yesShares: 20 }), cfgQ);
    expect(long.bid?.price).toBe(0.46);
    expect(long.ask?.price).toBe(0.52);
    const capped = buildQuotes(quoteInput({ yesShares: 40 }), cfgQ);
    expect(capped.bid).toBeNull();
    expect(capped.ask).not.toBeNull();
  });

  it("pulls a quote back rather than crossing the real book", () => {
    const tight = quoteInput({ bids: [{ price: 0.5, size: 50 }], asks: [{ price: 0.51, size: 50 }], noShares: 40 });
    const q = buildQuotes(tight, { ...cfgQ, offsetFraction: 0.1 });
    expect(q.bid?.price).toBe(0.5);
    expect(q.ask).toBeNull();
  });

  it("only quotes what the account can fund, and stays out of extreme prices", () => {
    expect(quoteCapital({ bid: { price: 0.47, size: 20 }, ask: { price: 0.53, size: 20 } }, 0)).toBeCloseTo(18.8, 10);
    expect(quoteCapital({ bid: null, ask: { price: 0.53, size: 20 } }, 20)).toBe(0);
    const poor = buildQuotes(quoteInput({ freeCash: 9.4 }), cfgQ);
    expect(poor.bid).not.toBeNull();
    expect(poor.ask).toBeNull();
    expect(buildQuotes(quoteInput({ freeCash: 5 }), cfgQ)).toEqual({ bid: null, ask: null });
    expect(buildQuotes(quoteInput({ bids: [{ price: 0.94, size: 50 }], asks: [{ price: 0.96, size: 50 }] }), cfgQ)).toEqual({ bid: null, ask: null });
  });
});

describe("paper fills", () => {
  const trade = (over: Partial<PublicTrade>): PublicTrade => ({ key: Math.random().toString(36), timestamp: 100, outcomeIndex: 0, side: "BUY", price: 0.5, size: 10, ...over });
  const quotes = { bid: { price: 0.47, size: 20 }, ask: { price: 0.53, size: 20 } };

  it("reads a NO trade as its YES equivalent", () => {
    expect(yesEquivalent(trade({ outcomeIndex: 1, side: "BUY", price: 0.4 }))).toEqual({ takerBoughtYes: false, yesPrice: 0.6 });
    expect(yesEquivalent(trade({ outcomeIndex: 1, side: "SELL", price: 0.4 })).takerBoughtYes).toBe(true);
  });

  it("fills our ask when a buyer paid at least our price, up to our size", () => {
    const { fills, remaining } = matchTrades(quotes, [trade({ price: 0.6, size: 12 }), trade({ price: 0.55, size: 30, timestamp: 101 })]);
    expect(fills.map((f) => [f.side, f.price, f.size])).toEqual([["ASK", 0.53, 12], ["ASK", 0.53, 8]]);
    expect(remaining.ask).toBeNull();
    expect(remaining.bid).toEqual(quotes.bid);
  });

  it("fills our bid when a seller took no more than our price, including sellers who bought NO", () => {
    const { fills } = matchTrades(quotes, [trade({ outcomeIndex: 1, side: "BUY", price: 0.55, size: 5 }), trade({ side: "SELL", price: 0.47, size: 5 })]);
    expect(fills.map((f) => [f.side, f.size])).toEqual([["BID", 5], ["BID", 5]]);
  });

  it("leaves us alone when trades happen between our prices", () => {
    expect(matchTrades(quotes, [trade({ price: 0.5 }), trade({ side: "SELL", price: 0.5 })]).fills).toEqual([]);
  });

  it("fills an order the book has moved through", () => {
    const { fills, remaining } = crossFills(quotes, { bids: [{ price: 0.4, size: 9 }], asks: [{ price: 0.46, size: 8 }] }, 200);
    expect(fills).toEqual([{ side: "BID", price: 0.47, size: 8, timestamp: 200, via: "book" }]);
    expect(remaining.bid?.size).toBe(12);
  });
});

describe("paper account", () => {
  it("buys at the bid, sells at the ask and banks the difference", () => {
    const bought = applyLpFill(emptyLpPosition(), "BID", 0.47, 20);
    expect(bought.cashDelta.toFixed(2)).toBe("-9.40");
    const sold = applyLpFill(bought.next, "ASK", 0.53, 20);
    expect(sold.cashDelta.toFixed(2)).toBe("10.60");
    expect(sold.next.yes.isZero() && sold.next.no.isZero()).toBe(true);
    expect(sold.next.cashFlow.toFixed(2)).toBe("1.20");
  });

  it("sells short by buying NO, and merges YES + NO back into $1", () => {
    const short = applyLpFill(emptyLpPosition(), "ASK", 0.53, 20);
    expect(short.cashDelta.toFixed(2)).toBe("-9.40");
    expect(short.next.no.toFixed(0)).toBe("20");
    const covered = applyLpFill(short.next, "BID", 0.47, 20);
    expect(covered.cashDelta.toFixed(2)).toBe("10.60"); // pay 9.40 for YES, receive 20.00 for the pairs
    expect(covered.next.cashFlow.toFixed(2)).toBe("1.20");
  });

  it("values and settles what is left over", () => {
    const pos = applyLpFill(emptyLpPosition(), "BID", 0.6, 20).next;
    expect(lpMarkValue(pos, 0.5).toFixed(2)).toBe("10.00");
    expect(settleLpPosition(pos, 1).realized.toFixed(2)).toBe("8.00");
    expect(settleLpPosition(pos, 0).realized.toFixed(2)).toBe("-12.00");
    expect(settleLpPosition(pos, 0.5).realized.toFixed(2)).toBe("-2.00");
    const short = applyLpFill(emptyLpPosition(), "ASK", 0.6, 20).next;
    expect(settleLpPosition(short, 1).realized.toFixed(2)).toBe("-8.00");
  });

  it("does not count a market-day that earned under $1", () => {
    expect(settleRewardDay("0.99").paid.isZero()).toBe(true);
    expect(settleRewardDay("0.99").forfeited.toFixed(2)).toBe("0.99");
    expect(settleRewardDay("1").paid.toFixed(2)).toBe("1.00");
  });
});

describe("reward robot", () => {
  const T0 = new Date("2026-10-13T12:00:00Z");
  const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
  const pool = (over: Partial<RewardMarket> = {}): RewardMarket => ({
    conditionId: "0xaaa", marketId: "1", question: "Quiet market?", eventSlug: "quiet", dailyRate: 144, minSize: 20, maxSpread: 0.045,
    competitiveness: 0, spread: 0.3, volume24h: 10, endDate: "2026-10-30T00:00:00Z", yesTokenId: "yes-1", yesPrice: 0.5, ...over,
  });

  function fakeApi(pools: RewardMarket[]) {
    const world = {
      book: { bids: [{ price: 0.35, size: 100 }], asks: [{ price: 0.65, size: 100 }] } as { bids: Level[]; asks: Level[] },
      trades: [] as PublicTrade[],
      info: { closed: false, payoutYes: null, acceptingOrders: true, tick: 0.01 } as MarketInfo,
    };
    const api: RobotApi = {
      rewardMarkets: async () => pools,
      book: async () => world.book,
      trades: async () => world.trades,
      market: async () => world.info,
    };
    return { api, world };
  }

  it("screens out pools that are too small, too big to enter, about to end, extreme, or weather", () => {
    const sel = DEFAULT_CONFIG.selection;
    expect(isEligible(pool(), sel, T0)).toBe(true);
    expect(isEligible(pool({ dailyRate: 4 }), sel, T0)).toBe(false);
    expect(isEligible(pool({ minSize: 100 }), sel, T0)).toBe(false);
    expect(isEligible(pool({ endDate: "2026-10-14T00:00:00Z" }), sel, T0)).toBe(false);
    expect(isEligible(pool({ yesPrice: 0.95 }), sel, T0)).toBe(false);
    expect(isEligible(pool({ question: "Will the highest temperature in Paris be 18C?" }), sel, T0)).toBe(false);
  });

  it("joins the best pool, earns the pool pro rata by the minute while alone, and takes a fill when a trade crosses", async () => {
    const cfg = { ...DEFAULT_CONFIG, accounts: [{ name: "test", startingCash: 40 }] };
    const { api, world } = fakeApi([pool()]);
    const state = newState(cfg, T0);
    await applyScan(state, cfg, api, await gatherScan(cfg, api, T0), T0);
    const acct = state.accounts[0]!;
    expect(acct.markets).toHaveLength(1);

    await runCycle(state, cfg, api, minutes(1));
    const hm = acct.markets[0]!;
    expect(hm.quotes).toEqual({ bid: { price: 0.47, size: 20 }, ask: { price: 0.53, size: 20 } });
    expect(hm.share).toBe(1);
    expect(dec(hm.rewardToday).toFixed(4)).toBe("0.1000"); // $144 a day = 10c a minute

    // A seller hits 20 YES at 47c: our bid was resting there, so it is ours.
    world.trades = [{ key: "t1", timestamp: Math.floor(minutes(1.5).getTime() / 1000), outcomeIndex: 0, side: "SELL", price: 0.47, size: 20 }];
    await runCycle(state, cfg, api, minutes(2));
    expect(hm.fills).toBe(1);
    expect(hm.yes).toBe("20");
    expect(dec(acct.cash).toFixed(2)).toBe("30.60");
    expect(dec(hm.rewardToday).toFixed(4)).toBe("0.2000");
    // The same trade is not counted twice.
    await runCycle(state, cfg, api, minutes(3));
    expect(hm.fills).toBe(1);

    const s = summarize(acct, minutes(3));
    expect(s.rewardsPendingAtRisk.toFixed(2)).toBe("0.30"); // under $1 so far today
    expect(s.total.toFixed(2)).toBe("40.00"); // 30.60 cash + 20 shares marked at the 47c last trade
  });

  it("after a restart counts no fills or rewards for the time it was off", async () => {
    const cfg = { ...DEFAULT_CONFIG, accounts: [{ name: "test", startingCash: 40 }] };
    const { api, world } = fakeApi([pool()]);
    const state = newState(cfg, T0);
    await applyScan(state, cfg, api, await gatherScan(cfg, api, T0), T0);
    await runCycle(state, cfg, api, minutes(1));
    const hm = state.accounts[0]!.markets[0]!;
    // Ten hours later, same UTC day: a trade went through our old price while the robot was stopped.
    world.trades = [{ key: "t-off", timestamp: Math.floor(minutes(300).getTime() / 1000), outcomeIndex: 0, side: "SELL", price: 0.3, size: 20 }];
    const back = minutes(600);
    resumeAfterRestart(state, back);
    await runCycle(state, cfg, api, back);
    expect(hm.fills).toBe(0);
    expect(dec(hm.rewardToday).toFixed(4)).toBe("0.2000"); // one minute before the stop, one on return; nothing for the gap
  });

  it("pays a finished day only where it reached $1, and settles shares when the market resolves", async () => {
    const cfg = { ...DEFAULT_CONFIG, accounts: [{ name: "test", startingCash: 40 }] };
    const { api, world } = fakeApi([pool()]);
    const state = newState(cfg, T0);
    await applyScan(state, cfg, api, await gatherScan(cfg, api, T0), T0);
    const acct = state.accounts[0]!;
    for (let m = 1; m <= 12; m++) await runCycle(state, cfg, api, minutes(m));
    expect(dec(acct.rewardDays["2026-10-13|0xaaa"] ?? 0).toFixed(2)).toBe("1.20");
    acct.rewardDays["2026-10-13|0xbbb"] = "0.40";

    await runCycle(state, cfg, api, new Date("2026-10-14T00:01:00Z"));
    expect(dec(acct.rewardsPaid).toFixed(2)).toBe("1.20");
    expect(dec(acct.rewardsForfeited).toFixed(2)).toBe("0.40");
    expect(dec(acct.cash).toFixed(2)).toBe("41.20");
    expect(summarize(acct, new Date("2026-10-14T00:01:00Z")).totalWithoutRewards.toFixed(2)).toBe("40.00");

    // Left holding 20 YES bought at 47c; the market resolves NO.
    world.trades = [{ key: "t2", timestamp: Math.floor(new Date("2026-10-14T00:01:30Z").getTime() / 1000), outcomeIndex: 0, side: "SELL", price: 0.3, size: 20 }];
    await runCycle(state, cfg, api, new Date("2026-10-14T00:02:00Z"));
    world.info = { closed: true, payoutYes: 0, acceptingOrders: false, tick: 0.01 };
    const later = new Date("2026-10-14T00:30:00Z");
    await applyScan(state, cfg, api, await gatherScan(cfg, { ...api, rewardMarkets: async () => [] }, later), later);
    expect(acct.markets).toHaveLength(0);
    expect(acct.closed[0]?.tradingResult).toBe("-9.4");
    expect(dec(acct.tradingRealized).toFixed(2)).toBe("-9.40");
    expect(dec(acct.cash).toFixed(2)).toBe("31.80"); // 41.20 - 9.40 spent on shares that paid nothing
  });
});
