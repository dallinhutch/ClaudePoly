import Link from "next/link";
import { Badge, PageTitle, Table, Td } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { getOpportunities } from "@/lib/dashboard/queries";
import { cents, compactUsd, dateTime, pct, pp, usd } from "@/lib/format";

export default async function OpportunitiesPage() {
  await requireUser();
  const rows = await getOpportunities();
  return (
    <>
      <PageTitle
        title="Live opportunities"
        subtitle="Researched markets ranked by expected value per dollar × confidence. Edges are measured against the all-in ask (price + taker fee) when the estimate was made."
      />
      <Table head={["Market", "YES mid", "AI P(YES)", "Best side", "Edge", "Confidence", "Liquidity", "Recommended", "Status", "Researched"]} empty="No markets have been researched yet.">
        {rows.map((r) => (
          <tr key={r.estimateId}>
            <Td className="max-w-sm truncate whitespace-normal">
              <Link href={`/markets/${r.marketId}`} className="text-sky-800 hover:underline">{r.question}</Link>
              <div className="text-xs text-zinc-500">{r.category ?? "—"} · stage {r.stage}</div>
            </Td>
            <Td>{cents(r.mid)}</Td>
            <Td className="font-medium">{pct(r.probabilityYes)}</Td>
            <Td><Badge value={r.bestSide} /></Td>
            <Td className={r.bestEdge != null && r.bestEdge > 0 ? "text-emerald-700" : "text-zinc-500"}>{pp(r.bestEdge)}</Td>
            <Td>{pct(r.confidence, 0)}</Td>
            <Td>{compactUsd(r.liquidityUsd)}</Td>
            <Td>{r.decision === "TRADE" ? usd(r.proposedUsd) : "—"}</Td>
            <Td>
              {r.decision ? <Badge value={r.decision} /> : <span className="text-xs text-zinc-500">{r.stage === 2 ? "screened only" : "pending"}</span>}
              {r.decision === "NO_TRADE" && r.rejectionReasons[0] && <div className="max-w-[16rem] truncate text-xs text-zinc-500" title={r.rejectionReasons.join("\n")}>{r.rejectionReasons[0]}</div>}
            </Td>
            <Td className="text-xs text-zinc-500">{dateTime(r.createdAt)}</Td>
          </tr>
        ))}
      </Table>
    </>
  );
}
