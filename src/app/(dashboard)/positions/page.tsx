import Link from "next/link";
import { Badge, PageTitle, Table, Td } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { getOpenPositions } from "@/lib/dashboard/queries";
import { cents, dateTime, pct, pnlClass, signedUsd, usd } from "@/lib/format";

export default async function PositionsPage() {
  await requireUser();
  const rows = await getOpenPositions();
  return (
    <>
      <PageTitle title="Open positions" subtitle="Marked at the best bid (what the shares would sell for now). Entry price includes fees." />
      <Table head={["Market", "Side", "Shares", "Entry price", "Current bid", "Entry P(YES)", "Current P(YES)", "Cost basis", "Value", "Unrealized", "Recommendation", "Opened"]} empty="No open positions.">
        {rows.map((p) => (
          <tr key={p.id}>
            <Td className="max-w-xs truncate whitespace-normal">
              <Link href={`/markets/${p.marketId}`} className="text-sky-800 hover:underline">{p.question}</Link>
              <div className="text-xs text-zinc-500">resolves {dateTime(p.endDate)}</div>
            </Td>
            <Td><Badge value={p.side} /> <span className="text-xs text-zinc-500">{p.outcomeLabel}</span></Td>
            <Td>{Number(p.shares).toFixed(2)}</Td>
            <Td>{cents(p.entryAvgPrice)}</Td>
            <Td>{cents(p.lastMarkPrice)}</Td>
            <Td>{pct(p.entryProbability)}</Td>
            <Td>{pct(p.currentProbability)}</Td>
            <Td>{usd(p.costBasis)}</Td>
            <Td>{usd(p.markValue)}</Td>
            <Td className={pnlClass(p.unrealizedPnl)}>{signedUsd(p.unrealizedPnl)}</Td>
            <Td><Badge value={p.recommendation} /></Td>
            <Td className="text-xs text-zinc-500">{dateTime(p.openedAt)}</Td>
          </tr>
        ))}
      </Table>
    </>
  );
}
