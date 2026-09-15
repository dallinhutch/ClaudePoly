import { Badge, PageTitle, Section, Stat, Table, Td } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { getOverview } from "@/lib/dashboard/queries";
import { dateTime, pct, pnlClass, signedPct, signedUsd, usd } from "@/lib/format";

export default async function OverviewPage() {
  await requireUser();
  const o = await getOverview();
  return (
    <>
      <PageTitle title="Overview" subtitle={`Starting bankroll ${usd(o.startingBankroll)} · ${o.orderCount} simulated orders to date`} />
      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Current bankroll" value={usd(o.equity)} hint="Cash + open positions at best bid" />
        <Stat label="Total return" value={signedPct(o.totalReturn)} valueClass={pnlClass(o.totalReturn)} />
        <Stat label="Today's P&L" value={signedUsd(o.todaysPnl)} valueClass={pnlClass(o.todaysPnl)} hint="Since 00:00 UTC" />
        <Stat label="Cash balance" value={usd(o.cash)} />
        <Stat label="Open-position value" value={usd(o.openMarkValue)} hint={`${o.openPositions} open position${o.openPositions === 1 ? "" : "s"}`} />
        <Stat label="Open exposure" value={usd(o.openExposure)} hint="Cost basis committed" />
        <Stat label="Realized P&L" value={signedUsd(o.realizedPnl)} valueClass={pnlClass(o.realizedPnl)} />
        <Stat label="Unrealized P&L" value={signedUsd(o.unrealizedPnl)} valueClass={pnlClass(o.unrealizedPnl)} />
        <Stat label="Max drawdown" value={pct(o.maxDrawdown)} hint={`Current ${pct(o.currentDrawdown)}`} />
        <Stat label="AI research spend today" value={usd(o.aiSpendToday)} hint="Real Anthropic API cost" />
      </div>
      <Section title="Latest system jobs">
        <Table head={["Job", "Status", "Started", "Finished", "Summary"]} empty="The worker hasn't run yet.">
          {o.recentJobs.map((j) => (
            <tr key={j.id}>
              <Td>{j.jobType}</Td>
              <Td><Badge value={j.status} /></Td>
              <Td>{dateTime(j.startedAt)}</Td>
              <Td>{dateTime(j.finishedAt)}</Td>
              <Td className="max-w-md truncate text-xs text-zinc-500">{j.error ? j.error.split("\n")[0] : JSON.stringify(j.summary ?? {})}</Td>
            </tr>
          ))}
        </Table>
      </Section>
    </>
  );
}
