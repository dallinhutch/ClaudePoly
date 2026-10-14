import { describe, expect, it } from "vitest";
import { dec } from "@/lib/decimal";
import { summarize } from "@/lib/rewards/robot";
import { splitSharedPools, type UsBook, type UsMarketInfo, type UsRewardMarket } from "@/lib/rewards/us/api";
import { applyUsScan, gameKeyOf, gatherUsScan, inferTradeFills, joinBest, newUsState, periodWindow, runUsCycle, US_CONFIG, type UsApi } from "@/lib/rewards/us/robot";
import { evaluateUsQuotes, scoreSide, type UsProgram } from "@/lib/rewards/us/scoring";

const prog = (over: Partial<UsProgram> = {}): UsProgram => ({ programId: "p1", period: "day_of", pool: 600, discountFactor: 0.3, targetSize: 1000, maxSpread: null, ...over });

describe("Polymarket US scoring (published rules)", () => {
  it("reproduces the docs example: discount 0.30, best-price order takes 70.6%", () => {
    const bids = [{ price: 0.5, size: 1000 }, { price: 0.49, size: 1000 }, { price: 0.48, size: 1000 }, { price: 0.47, size: 1000 }];
    const s = scoreSide(bids, null, 4000, 0.3, 0.01, "higher");
    expect(s.met).toBe(true);
    expect(s.total).toBeCloseTo(1417, 6);
    expect(1000 / s.total).toBeCloseTo(0.706, 3);
    expect(27 / s.total).toBeCloseTo(0.019, 3);
  });

  it("stops counting once Target Size is reached, and pays nobody on a side that never reaches it", () => {
    const deep = scoreSide([{ price: 0.5, size: 25000 }, { price: 0.49, size: 5000 }], { price: 0.49, size: 100 }, 20000, 0.3, 0.01, "higher");
    expect(deep.met).toBe(true);
    expect(deep.ours).toBe(0); // the second-best price is beyond the walk
    const thin = scoreSide([{ price: 0.5, size: 50 }], { price: 0.5, size: 20 }, 4000, 0.5, 0.01, "higher");
    expect(thin.met).toBe(false);
  });

  it("gives a small order at the best price most of a side whose bulk sits far away", () => {
    const asks = [{ price: 0.75, size: 9 }, { price: 0.76, size: 10 }, { price: 0.84, size: 4191 }];
    const s = scoreSide(asks, { price: 0.75, size: 100 }, 3000, 0.2, 0.01, "lower");
    expect(s.met).toBe(true);
    expect(s.ours / s.total).toBeGreaterThan(0.9);
  });

  it("counts each side as half the reward, and forfeits the second when Max Spread fails", () => {
    const book = { bids: [{ price: 0.49, size: 1000 }], asks: [{ price: 0.51, size: 1000 }] };
    const ours = { bid: { price: 0.49, size: 1000 }, ask: null };
    expect(evaluateUsQuotes(book, ours, prog({ targetSize: 1000 }), 0.01).share).toBeCloseTo(0.25, 10);
    const wide = { bids: [{ price: 0.49, size: 1000 }], asks: [{ price: 0.57, size: 1000 }] };
    expect(evaluateUsQuotes(wide, ours, prog({ targetSize: 1000, maxSpread: 0.035 }), 0.01).share).toBe(0);
    const ok = { bids: [{ price: 0.47, size: 1000 }], asks: [{ price: 0.54, size: 1000 }] };
    expect(evaluateUsQuotes(ok, { bid: { price: 0.47, size: 1000 }, ask: null }, prog({ targetSize: 1000, maxSpread: 0.035 }), 0.01).share).toBeGreaterThan(0);
  });
});

describe("Polymarket US robot pieces", () => {
  const book = (over: Partial<UsBook> = {}): UsBook => ({ bids: [{ price: 0.74, size: 19 }, { price: 0.65, size: 2570 }, { price: 0.01, size: 5000 }], asks: [{ price: 0.75, size: 9 }, { price: 0.84, size: 4191 }], open: true, sharesTraded: 100, lastTradePx: 0.75, ...over });

  it("splits a programme's pot across every market carrying it on the same day", () => {
    const day1 = new Date("2026-10-15T00:00:00Z");
    const day2 = new Date("2026-10-16T00:00:00Z");
    const mk = (slug: string, eventStart: Date, programId = "props_day_of"): UsRewardMarket => ({ slug, subcategory: "MLB", eventStart, programs: [prog({ programId, pool: 850 })] });
    const out = splitSharedPools([mk("a", day1), mk("b", day1), mk("c", day1), mk("d", day1), mk("e", day2), mk("f", day1, "moneyline_day_of")]);
    expect(out[0]!.programs[0]).toMatchObject({ pool: 212.5, programPool: 850, sharedBy: 4 });
    expect(out[4]!.programs[0]).toMatchObject({ pool: 850, sharedBy: 1 });
    expect(out[5]!.programs[0]!.pool).toBe(850);
    // Splitting twice must not split again.
    expect(splitSharedPools(out)[0]!.programs[0]!.pool).toBe(212.5);
  });

  it("knows when each period pays", () => {
    const ev = new Date("2026-10-15T00:00:00Z");
    expect(periodWindow("day_of", ev, ev, 4)).toEqual({ start: new Date("2026-10-14T18:00:00Z"), end: ev });
    expect(periodWindow("live", ev, ev, 4)?.end).toEqual(new Date("2026-10-15T04:00:00Z"));
    expect(periodWindow("daily_event", null, new Date("2026-10-14T03:00:00Z"), 4)).toEqual({ start: new Date("2026-10-13T04:00:00Z"), end: new Date("2026-10-14T04:00:00Z") });
    expect(periodWindow("early", ev, ev, 4)).toBeNull();
  });

  it("groups props on the same game", () => {
    expect(gameKeyOf("astatc-mlb-mil-lad-2026-10-14-er-robgas-gte1")).toBe("mlb-mil-lad-2026-10-14");
    expect(gameKeyOf("astatc-mlb-mil-lad-2026-10-14-ha-blasne-gte5")).toBe("mlb-mil-lad-2026-10-14");
  });

  it("joins the best bid and offer, and stays out of wide books", () => {
    expect(joinBest(book(), 20, 0, 0, 2, 100, 0.05)).toEqual({ bid: { price: 0.74, size: 20 }, ask: { price: 0.75, size: 20 } });
    expect(joinBest(book({ asks: [{ price: 0.9, size: 9 }] }), 20, 0, 0, 2, 100, 0.05)).toEqual({ bid: null, ask: null });
    expect(joinBest(book(), 20, 40, 0, 2, 100, 0.05).bid).toBeNull();
  });

  it("fills us only after the orders ahead of us at our price, and fully when the price is swept", () => {
    const quotes = { bid: { price: 0.74, size: 20 }, ask: { price: 0.75, size: 20 } };
    const atPrice = inferTradeFills(quotes, { bid: 19, ask: 9 }, 15, 0.75, 1);
    expect(atPrice.fills).toEqual([{ side: "ASK", price: 0.75, size: 6, timestamp: 1, via: "trade" }]);
    expect(atPrice.queue.ask).toBe(0);
    expect(atPrice.remaining.ask?.size).toBe(14);
    const swept = inferTradeFills(quotes, { bid: 19, ask: 9 }, 50, 0.73, 1);
    expect(swept.fills).toEqual([{ side: "BID", price: 0.74, size: 20, timestamp: 1, via: "trade" }]);
    expect(inferTradeFills(quotes, { bid: 19, ask: 9 }, 5, 0.75, 1).fills).toEqual([]);
  });

  it("scans, joins, earns the pool over the period by its share, and records a fill", async () => {
    const now = new Date("2026-10-14T20:00:00Z");
    const market: UsRewardMarket = { slug: "astatc-mlb-mil-lad-2026-10-14-er-robgas-gte1", subcategory: "MLB", eventStart: new Date("2026-10-15T00:00:00Z"), programs: [prog({ pool: 21600, discountFactor: 0.2, targetSize: 3000 })] };
    const world = { book: book() };
    const api: UsApi = {
      rewardMarkets: async () => [market],
      book: async () => world.book,
      market: async (): Promise<UsMarketInfo> => ({ question: "Will Robert Gasser allow at least 1 earned run?", open: true, tick: 0.01 }),
      settlement: async () => null,
    };
    const cfg = { ...US_CONFIG, accounts: [{ name: "test", startingCash: 40, orderSize: 20 }] };
    const state = newUsState(cfg, now);
    await applyUsScan(state, cfg, api, await gatherUsScan(cfg, api, now), now);
    const acct = state.accounts[0]!;
    expect(acct.markets).toHaveLength(1);

    await runUsCycle(state, cfg, api, new Date(now.getTime() + 20_000));
    const hm = acct.markets[0]!;
    expect(hm.quotes).toEqual({ bid: { price: 0.74, size: 20 }, ask: { price: 0.75, size: 20 } });
    // $21,600 over a 6-hour period is $1 a second; we hold about 51% of the bid side and 69% of the offer side.
    expect(hm.share).toBeCloseTo((20 / 39 + 20 / (29 + 0.2 ** 9 * 4191)) / 2, 4);
    expect(dec(hm.rewardToday).toNumber()).toBeCloseTo(20 * hm.share, 4);

    // 20 more contracts trade at 75c: 9 were ahead of us, so 11 of ours sell.
    world.book = book({ sharesTraded: 120, lastTradePx: 0.75 });
    await runUsCycle(state, cfg, api, new Date(now.getTime() + 40_000));
    expect(hm.fills).toBe(1);
    expect(hm.no).toBe("11");
    expect(summarize(acct, new Date(now.getTime() + 40_000)).rewardsPendingCounted.gt(0)).toBe(true);
  });
});
