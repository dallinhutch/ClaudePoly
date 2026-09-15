import Link from "next/link";
import { AutoRefresh, LiveTimestamp } from "@/components/live";
import { Card, PageTitle } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { getActiveStrategy } from "@/lib/strategy/service";
import { getDb } from "@/db/client";
import { getRecommendations, type Recommendation } from "@/lib/dashboard/queries";
import { cents, dateTime, pct, usd } from "@/lib/format";

const STATUS_STYLE: Record<Recommendation["status"], string> = {
  ACTIVE: "bg-emerald-100 text-emerald-800",
  "PRICE MOVED": "bg-amber-100 text-amber-800",
  CLOSED: "bg-zinc-100 text-zinc-700",
  WON: "bg-emerald-600 text-white",
  LOST: "bg-red-600 text-white",
  VOID: "bg-zinc-200 text-zinc-700",
};

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
      {hint && <div className="text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

export default async function RecommendedPage() {
  await requireUser();
  const [recs, strategy] = await Promise.all([getRecommendations(), getActiveStrategy(getDb())]);
  const q = strategy.config.qualification;

  return (
    <>
      <AutoRefresh seconds={60} />
      <PageTitle
        title="Recommended for you"
        subtitle={`Trades the system qualified under strategy v${strategy.version}: at least ${pct(q.minSideProbability, 0)} likely to win and at least ${pct(q.minEvPerDollar, 0)} expected return after fees. Updates automatically.`}
      />

      {recs.length === 0 ? (
        <Card className="text-sm text-zinc-600">
          No recommendations right now. The system only recommends a bet when its research says the outcome is at least {pct(q.minSideProbability, 0)} likely
          <em> and</em> the price leaves a strong return. Most markets don&apos;t qualify, and that&apos;s by design.
        </Card>
      ) : (
        <div className="space-y-4">
          {recs.map((r) => (
            <Card key={r.candidateId}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-xs text-zinc-500">Recommended <LiveTimestamp iso={r.recommendedAt.toISOString()} /></div>
                  <h2 className="mt-1 text-lg font-semibold">
                    Buy <span className="rounded bg-sky-100 px-1.5 text-sky-900">{r.outcomeToBuy}</span> on “{r.question}”
                  </h2>
                  {r.eventTitle && <div className="text-sm text-zinc-500">{r.eventTitle}</div>}
                </div>
                <span className={`rounded px-2 py-1 text-xs font-semibold ${STATUS_STYLE[r.status]}`}>{r.status}</span>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-6">
                <Figure label="How sure" value={pct(r.probability, 0)} hint="chance this outcome wins" />
                <Figure label="Confidence" value={pct(r.confidence, 0)} hint="reliability of that estimate" />
                <Figure label="Price" value={cents(r.price)} hint={`incl. fees · max ${cents(r.limitPrice)}`} />
                <Figure label="Return if right" value={`+${pct(r.returnIfRight, 0)}`} />
                <Figure label="Expected return" value={`+${pct(r.expectedReturn, 0)}`} hint="probability-weighted" />
                <Figure label="Recommended amount" value={usd(r.recommendedUsd)} hint={r.bankrollPct != null ? `${pct(r.bankrollPct, 1)} of bankroll` : undefined} />
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-600">
                <span>Current price {cents(r.currentPrice)}</span>
                <span>Resolves {dateTime(r.resolvesAt)}</span>
                <span>{r.paperFilled ? "Paper trade placed" : "Paper order did not fill"}</span>
                <Link href={`/markets/${r.marketId}`} className="text-sky-800 underline">Full research</Link>
                {r.url && <a href={r.url} target="_blank" rel="noopener noreferrer nofollow" className="text-sky-800 underline">Open on Polymarket</a>}
              </div>
            </Card>
          ))}
        </div>
      )}
      <p className="mt-6 text-xs text-zinc-500">
        Research output from a paper-trading experiment, not financial advice. “Recommended amount” is sized for the simulated bankroll; scale it to your own risk tolerance.
        Don&apos;t buy above the max price shown.
      </p>
    </>
  );
}
