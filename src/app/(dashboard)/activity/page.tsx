import Link from "next/link";
import { Badge, Card, PageTitle, Section, Stat, Table, Td } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { getActivity } from "@/lib/dashboard/queries";
import { dateTime, usd } from "@/lib/format";

type ScanSummary = { markets?: number; screened?: number; passed?: number; rejected?: number; topRejectionReasons?: Array<{ reason: string; count: number }> };

export default async function ActivityPage() {
  await requireUser();
  const a = await getActivity();
  const scan = (a.lastScan?.summary ?? {}) as ScanSummary;
  const auditBreak = a.today.audit_break;
  return (
    <>
      <PageTitle title="System activity" subtitle="What the worker is doing right now and what it has done." />
      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Markets in last scan" value={scan.markets ?? "—"} hint={a.lastScan ? dateTime(a.lastScan.finishedAt) : "no scan yet"} />
        <Stat label="Passed screening" value={scan.passed ?? "—"} hint={`${scan.rejected ?? "—"} rejected`} />
        <Stat label="Research today" value={`${a.today.stage2_today ?? 0} / ${a.today.stage3_today ?? 0}`} hint="stage 2 / stage 3" />
        <Stat label="Orders today" value={a.today.orders_today ?? 0} hint={`${a.today.no_trade_today ?? 0} NO TRADE decisions`} />
        <Stat label="AI cost today" value={usd(a.today.ai_cost_today ?? 0)} />
      </div>

      <Card className={`mb-8 ${auditBreak == null ? "border-emerald-200 bg-emerald-50" : "border-red-300 bg-red-50"}`}>
        {auditBreak == null
          ? "Audit log hash chain verified intact: no historical record has been altered."
          : `AUDIT CHAIN BROKEN at event #${auditBreak}. A historical record was modified outside the application.`}
      </Card>

      <Section title="Research running now">
        <Table head={["Market", "Stage", "Trigger", "Started"]} empty="Nothing running.">
          {a.running.map(({ run, question }) => (
            <tr key={run.id}><Td className="max-w-lg truncate"><Link href={`/markets/${run.marketId}`} className="text-sky-800 hover:underline">{question}</Link></Td><Td>{run.stage}</Td><Td>{run.trigger}</Td><Td>{dateTime(run.startedAt)}</Td></tr>
          ))}
        </Table>
      </Section>

      {scan.topRejectionReasons && scan.topRejectionReasons.length > 0 && (
        <Section title="Why markets were rejected (last scan)">
          <Table head={["Reason", "Markets"]}>
            {scan.topRejectionReasons.map((r) => <tr key={r.reason}><Td>{r.reason}</Td><Td>{r.count}</Td></tr>)}
          </Table>
        </Section>
      )}

      <Section title="Recent research runs">
        <Table head={["Queued", "Market", "Stage", "Trigger", "Status", "Cost", "Error"]}>
          {a.recentRuns.map(({ run, question }) => (
            <tr key={run.id}>
              <Td className="text-xs">{dateTime(run.queuedAt)}</Td>
              <Td className="max-w-md truncate"><Link href={`/markets/${run.marketId}`} className="text-sky-800 hover:underline">{question}</Link></Td>
              <Td>{run.stage}</Td><Td className="text-xs">{run.trigger}</Td><Td><Badge value={run.status} /></Td><Td>{usd(run.costUsd)}</Td>
              <Td className="max-w-xs truncate text-xs text-red-700">{run.error ?? ""}</Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Jobs">
        <Table head={["Job", "Status", "Started", "Finished", "Summary / error"]}>
          {a.jobs.map((j) => (
            <tr key={j.id}>
              <Td>{j.jobType}</Td><Td><Badge value={j.status} /></Td><Td className="text-xs">{dateTime(j.startedAt)}</Td><Td className="text-xs">{dateTime(j.finishedAt)}</Td>
              <Td className="max-w-xl truncate text-xs text-zinc-500"><span title={j.error ?? JSON.stringify(j.summary)}>{j.error ? j.error.split("\n")[0] : JSON.stringify(j.summary ?? {})}</span></Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Audit log (latest 100)">
        <Table head={["#", "Time", "Event", "Entity", "Hash"]}>
          {a.events.map((e) => (
            <tr key={e.id}>
              <Td>{e.id}</Td><Td className="text-xs">{dateTime(e.createdAt)}</Td><Td>{e.eventType}</Td>
              <Td className="text-xs">{e.entityType}:{e.entityId.slice(0, 12)}</Td><Td className="font-mono text-xs">{e.hash?.slice(0, 16)}…</Td>
            </tr>
          ))}
        </Table>
      </Section>
    </>
  );
}
