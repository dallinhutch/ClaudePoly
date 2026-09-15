import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Polymarket network calls are replaced with TEST FIXTURES shaped like the real API.
vi.mock("@/lib/polymarket/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/polymarket/client")>();
  return { ...actual, fetchOrderBook: vi.fn(), fetchMarket: vi.fn() };
});

import type { Db } from "@/db/client";
import { ensureBootstrap } from "@/db/bootstrap";
import * as schema from "@/db/schema";
import { fetchMarket, fetchOrderBook, GammaMarketSchema } from "@/lib/polymarket/client";
import { getActiveStrategy } from "@/lib/strategy/service";
import { evaluateEntry } from "@/lib/trading/engine";
import { getCashBalance } from "@/lib/trading/ledger";
import { getPortfolioState } from "@/lib/trading/portfolio";
import { settleResolvedMarkets } from "@/lib/trading/settlement";

let db: Db;
const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  const pgliteDb = drizzle(new PGlite(), { schema });
  await migrate(pgliteDb, { migrationsFolder: "./drizzle" });
  db = pgliteDb as unknown as Db;
  await ensureBootstrap(db);
  vi.mocked(fetchOrderBook).mockImplementation(async (tokenId: string) => ({
    asset_id: tokenId,
    market: null,
    timestamp: "0",
    hash: "fixture",
    bids: [{ price: "0.48", size: "300" }],
    asks: [{ price: "0.52", size: "500" }, { price: "0.50", size: "200" }],
  }));
});

async function seedMarket(id: string) {
  await db.insert(schema.markets).values({
    id, conditionId: `0x${id}`, question: `TEST FIXTURE market ${id}?`, outcomes: ["Yes", "No"],
    yesTokenId: `${id}-yes`, noTokenId: `${id}-no`, endDate: new Date(Date.now() + 20 * 86_400_000),
    active: true, closed: false, acceptingOrders: true, enableOrderBook: true, category: "Economy",
    yesPrice: "0.500000", noPrice: "0.500000", liquidityUsd: "50000", volume24hUsd: "20000",
    feesEnabled: true, feeSchedule: { rate: 0.05, exponent: 1 }, minTickSize: "0.010000", minOrderSize: "5",
  });
}

async function seedEstimate(marketId: string, confidence = "0.850000") {
  const strategy = await getActiveStrategy(db);
  const dossier = {
    stage: 3,
    dossier: {
      resolution_analysis: { clarity: "clear", what_must_happen_for_yes: "fixture", resolution_source: "fixture", edge_cases: [] },
      timeline: "", base_rate: { reference_class: "", rate: null, notes: "" }, evidence_for_yes: [], evidence_for_no: [],
      contradictions: [], current_trends: "", possibly_underweighted: [], newest_evidence_date: TODAY,
      data_quality: { score: 0.8, notes: "" }, summary: "fixture", sources: [],
    },
    analystFailures: [],
  };
  const [run] = await db.insert(schema.researchRuns).values({
    marketId, stage: 3, status: "completed", strategyVersionId: strategy.id, trigger: "test", model: "fixture", effort: "high", dossier,
  }).returning();
  const [estimate] = await db.insert(schema.probabilityEstimates).values({
    marketId, researchRunId: run!.id, strategyVersionId: strategy.id, stage: 3, analystCount: 5,
    meanProb: "0.700000", medianProb: "0.700000", stdevProb: "0.040000", probabilityYes: "0.700000",
    confidence, evidenceQuality: "0.800000", bestSide: "YES", method: { fixture: true },
  }).returning();
  return estimate!.id;
}

describe("paper-trade lifecycle against the real schema and triggers", () => {
  it("opens a position at real book prices with fees, sized by the max-position cap", async () => {
    await seedMarket("m1");
    const outcome = await evaluateEntry(db, await seedEstimate("m1"));
    expect(outcome.decision).toBe("TRADE");
    if (outcome.decision !== "TRADE") return;

    // all-in top of book = 0.50 + 0.05*0.5*0.5 = 0.5125; quarter-Kelly ~$82 capped at 5% of $1,000.
    const [candidate] = await db.select().from(schema.tradeCandidates).where(eq(schema.tradeCandidates.id, outcome.candidateId));
    expect(candidate!.proposedUsd).toBe("50.000000");
    expect((candidate!.sizing as { bindingConstraint: string }).bindingConstraint).toBe("max_position");
    expect(candidate!.limitPrice).toBe("0.520000");

    expect(outcome.fill.status).toBe("FILLED");
    expect(outcome.fill.filledShares.toFixed(2)).toBe("97.56");
    expect(outcome.fill.fees.toFixed(5)).toBe("1.21950");

    const [position] = await db.select().from(schema.positions).where(eq(schema.positions.id, outcome.positionId!));
    expect(position!.costBasis).toBe("49.999500");
    expect(Number(position!.entryAvgPrice)).toBeCloseTo(0.5125, 6);
    expect((await getCashBalance(db)).toFixed(4)).toBe("950.0005");

    const fills = await db.select().from(schema.simulatedFills);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.price).toBe("0.500000");
    const snapshots = await db.select().from(schema.orderbookSnapshots);
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
  });

  it("does not open a second position in the same market", async () => {
    expect((await evaluateEntry(db, await seedEstimate("m1"))).decision).toBe("SKIPPED");
  });

  it("records NO_TRADE with the failed requirement and moves no money", async () => {
    await seedMarket("m2");
    const cashBefore = await getCashBalance(db);
    const outcome = await evaluateEntry(db, await seedEstimate("m2", "0.500000"));
    expect(outcome.decision).toBe("NO_TRADE");
    if (outcome.decision === "NO_TRADE") expect(outcome.reasons.some((r) => r.startsWith("confidence"))).toBe(true);
    expect((await getCashBalance(db)).eq(cashBefore)).toBe(true);
    expect(await db.select().from(schema.simulatedOrders).where(eq(schema.simulatedOrders.marketId, "m2"))).toHaveLength(0);
  });

  it("settles at the actual outcome exactly once and books realized P&L", async () => {
    vi.mocked(fetchMarket).mockImplementation(async (id: string) => GammaMarketSchema.parse({
      id, conditionId: `0x${id}`, question: "TEST FIXTURE", outcomes: '["Yes","No"]', outcomePrices: '["1","0"]',
      clobTokenIds: `["${id}-yes","${id}-no"]`, closed: true, active: false, acceptingOrders: false,
      umaResolutionStatus: "resolved", closedTime: new Date().toISOString(),
    }));

    const stats = await settleResolvedMarkets(db);
    expect(stats.positionsSettled).toBe(1);
    // 97.56 winning shares pay $97.56; cost was $49.9995.
    expect((await getCashBalance(db)).toFixed(4)).toBe("1047.5605");

    const state = await getPortfolioState(db);
    expect(state.open).toHaveLength(0);
    expect(state.realizedPnl.toFixed(4)).toBe("47.5605");
    expect(state.cash.plus(state.openCostBasis).toFixed(6)).toBe(state.startingBankroll.plus(state.realizedPnl).toFixed(6));

    await settleResolvedMarkets(db);
    expect((await getCashBalance(db)).toFixed(4)).toBe("1047.5605");

    // A resolved position can never be edited afterwards.
    await expect(db.execute(sql`update positions set shares = 1 where market_id = 'm1'`)).rejects.toThrow();
  });
});
