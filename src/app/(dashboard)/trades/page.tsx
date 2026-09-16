import Link from "next/link";
import { PageTitle, Stat, Table, Td } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { getBets, summarizeBets, type Bet } from "@/lib/dashboard/queries";
import { cents, dateTime, pct, pnlClass, signedPct, signedUsd, usd } from "@/lib/format";

const FILTERS = [
  { key: "all", label: "All bets" },
  { key: "open", label: "Still running" },
  { key: "settled", label: "Finished" },
] as const;

const OUTCOME_STYLE: Record<Bet["outcome"], string> = {
  OPEN: "bg-sky-100 text-sky-800",
  WON: "bg-emerald-600 text-white",
  LOST: "bg-red-600 text-white",
  EVEN: "bg-zinc-200 text-zinc-700",
  SOLD: "bg-amber-100 text-amber-900",
};

const OUTCOME_LABEL: Record<Bet["outcome"], string> = {
  OPEN: "Running", WON: "Won", LOST: "Lost", EVEN: "Broke even", SOLD: "Sold early",
};

export default async function BetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser();
  const sp = await searchParams;
  const raw = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const filter = FILTERS.find((f) => f.key === raw)?.key ?? "all";

  const all = await getBets();
  const bets = filter === "open" ? all.filter((b) => b.outcome === "OPEN")
    : filter === "settled" ? all.filter((b) => b.outcome !== "OPEN")
    : all;
  const s = summarizeBets(all);

  return (
    <>
      <PageTitle
        title="My bets"
        subtitle="Every simulated bet the system placed, and how it went. “Stake” is what it put in, “price paid” is the cost per share including fees, and a share pays $1 if the bet is right and $0 if it's wrong."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Record" value={s.settled > 0 ? `${s.wins} W – ${s.losses} L` : "—"} hint={`${s.open} still running`} />
        <Stat label="Win rate" value={pct(s.winRate, 0)} hint={`${s.settled} finished`} />
        <Stat label="Total staked" value={usd(s.staked)} hint={`${s.total} bet${s.total === 1 ? "" : "s"}`} />
        <Stat label="Profit" value={signedUsd(s.profit)} valueClass={pnlClass(s.profit)} hint="settled + running" />
        <Stat label="Return on stake" value={signedPct(s.returnOnStake)} valueClass={pnlClass(s.returnOnStake)} />
      </div>

      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === "all" ? "/trades" : `/trades?status=${f.key}`}
            className={`rounded-md px-3 py-1 ${filter === f.key ? "bg-zinc-900 text-white" : "border border-zinc-300 text-zinc-600 hover:text-zinc-900"}`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      <Table
        head={["Bet", "Placed", "Stake", "Price paid", "Shares", "Worth now", "Profit", "Return", "Result"]}
        empty="No bets yet."
      >
        {bets.map((b) => (
          <tr key={b.positionId}>
            <Td className="max-w-sm whitespace-normal">
              <div>
                <span className="font-medium">{b.outcomeBought}</span>
                <span className="text-zinc-500"> on </span>
                <Link href={`/markets/${b.marketId}`} className="text-sky-800 hover:underline">{b.question}</Link>
              </div>
              <div className="text-xs text-zinc-500">
                {b.outcome === "OPEN" ? `resolves ${dateTime(b.resolvesAt)}` : `settled ${dateTime(b.settledAt ?? b.resolvesAt)}`}
                {b.url && <> · <a href={b.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">Polymarket</a></>}
              </div>
            </Td>
            <Td className="text-xs text-zinc-500">{dateTime(b.placedAt)}</Td>
            <Td>{usd(b.stake)}</Td>
            <Td>{cents(b.pricePaid)}</Td>
            <Td>{b.shares.toFixed(2)}</Td>
            <Td>{b.priceNow == null ? "—" : `${cents(b.priceNow)} (${usd(b.shares * b.priceNow)})`}</Td>
            <Td className={pnlClass(b.profit)}>{signedUsd(b.profit)}</Td>
            <Td className={pnlClass(b.returnPct)}>{signedPct(b.returnPct)}</Td>
            <Td><span className={`rounded px-2 py-0.5 text-xs font-semibold ${OUTCOME_STYLE[b.outcome]}`}>{OUTCOME_LABEL[b.outcome]}</span></Td>
          </tr>
        ))}
      </Table>

      <p className="mt-4 text-xs text-zinc-500">
        Profit for a running bet is what it would be worth if sold right now (at the best price someone is bidding), minus what it cost. That number moves
        around before the market settles. Click a bet to see the research behind it.
      </p>
    </>
  );
}
