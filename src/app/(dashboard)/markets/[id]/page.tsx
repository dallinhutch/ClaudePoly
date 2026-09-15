import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Badge, Card, PageTitle, Section, Stat, Table, Td } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { getMarketResearch } from "@/lib/dashboard/queries";
import { cents, compactUsd, dateTime, pct, pp, usd } from "@/lib/format";
import type { StoredDossier } from "@/lib/research/signals";

/** AI output is untrusted: only plain http(s) URLs become links. */
function SafeLink({ href, children }: { href: string; children: ReactNode }) {
  if (!/^https?:\/\//i.test(href)) return <span>{children}</span>;
  return <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-sky-800 hover:underline">{children}</a>;
}

function List({ items }: { items: string[] }) {
  if (items.length === 0) return <p className="text-sm text-zinc-500">None recorded.</p>;
  return <ul className="list-disc space-y-1 pl-5 text-sm">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
}

export default async function MarketResearchPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const data = await getMarketResearch(decodeURIComponent(id));
  if (!data) notFound();
  const { market, estimates, latestRun, analysts, sources, candidates, runs, resolution } = data;
  const estimate = estimates.find((e) => e.researchRunId === latestRun?.id) ?? estimates[0] ?? null;
  const stored = (latestRun?.dossier ?? null) as StoredDossier | null;
  const dossier = stored?.dossier;
  const quick = stored?.quickEstimate;
  const candidate = candidates.find((c) => c.probabilityEstimateId === estimate?.id) ?? null;
  const [yesLabel, noLabel] = [market.outcomes[0] ?? "Yes", market.outcomes[1] ?? "No"];

  return (
    <>
      <PageTitle
        title={market.question}
        subtitle={<>{market.category ?? "Uncategorized"} · resolves {dateTime(market.endDate)} · YES = “{yesLabel}”, NO = “{noLabel}” {market.slug && <>· <SafeLink href={`https://polymarket.com/market/${market.slug}`}>view on Polymarket</SafeLink></>}</>}
      />

      {resolution && (
        <Card className="mb-6 border-sky-200 bg-sky-50">
          <strong>Resolved:</strong> YES paid {resolution.payoutYes}, NO paid {resolution.payoutNo} (detected {dateTime(resolution.detectedAt)}).
        </Card>
      )}

      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Market YES price" value={cents(estimate?.marketMid ?? market.yesPrice)} hint={`bid ${cents(estimate?.yesBid)} / ask ${cents(estimate?.yesAsk)}`} />
        <Stat label="AI P(YES)" value={pct(estimate?.probabilityYes)} hint={estimate ? `stage ${estimate.stage} · ${dateTime(estimate.createdAt)}` : "not researched"} />
        <Stat label="Confidence" value={pct(estimate?.confidence, 0)} hint={`evidence quality ${pct(estimate?.evidenceQuality, 0)}`} />
        <Stat label="Edge (YES / NO)" value={<span className="text-lg">{pp(estimate?.edgeYes)} / {pp(estimate?.edgeNo)}</span>} hint={`best side: ${estimate?.bestSide ?? "none"} · liquidity ${compactUsd(market.liquidityUsd)}`} />
      </div>

      <Section title="Recommended action">
        {candidate ? (
          <Card>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge value={candidate.decision} /> <Badge value={candidate.side} />
              {candidate.decision === "TRADE" && <span className="text-sm">size {usd(candidate.proposedUsd)} · limit {cents(candidate.limitPrice)}</span>}
            </div>
            {candidate.rejectionReasons.length > 0 && <List items={candidate.rejectionReasons} />}
            {candidate.checks.length > 0 && (
              <div className="mt-3">
                <Table head={["Requirement", "Value", "Threshold", "Pass"]}>
                  {candidate.checks.map((c) => (
                    <tr key={c.name}><Td>{c.name}</Td><Td>{String(c.value ?? "—")}</Td><Td>{String(c.threshold ?? "—")}</Td><Td>{c.passed ? "✓" : "✗"}</Td></tr>
                  ))}
                </Table>
              </div>
            )}
          </Card>
        ) : <p className="text-sm text-zinc-500">{estimate?.stage === 2 ? "Stage-2 screening only; not escalated to deep research." : "No trade decision recorded for the latest estimate."}</p>}
      </Section>

      {dossier && (
        <>
          <Section title="Research summary"><Card><p className="whitespace-pre-wrap text-sm">{dossier.summary}</p></Card></Section>
          <div className="mb-8 grid gap-4 md:grid-cols-2">
            <Card>
              <h3 className="mb-2 font-semibold text-emerald-800">YES case</h3>
              <ul className="space-y-2 text-sm">{dossier.evidence_for_yes.map((e, i) => <li key={i}><Badge value={e.strength.toUpperCase()} /> {e.claim} <span className="text-xs text-zinc-500">{e.as_of ?? ""}</span></li>)}</ul>
            </Card>
            <Card>
              <h3 className="mb-2 font-semibold text-red-800">NO case</h3>
              <ul className="space-y-2 text-sm">{dossier.evidence_for_no.map((e, i) => <li key={i}><Badge value={e.strength.toUpperCase()} /> {e.claim} <span className="text-xs text-zinc-500">{e.as_of ?? ""}</span></li>)}</ul>
            </Card>
            <Card>
              <h3 className="mb-2 font-semibold">Base rate</h3>
              <p className="text-sm">{dossier.base_rate.reference_class}{dossier.base_rate.rate != null && <> — <strong>{pct(dossier.base_rate.rate)}</strong></>}</p>
              <p className="mt-1 text-sm text-zinc-600">{dossier.base_rate.notes}</p>
            </Card>
            <Card>
              <h3 className="mb-2 font-semibold">Resolution analysis <Badge value={dossier.resolution_analysis.clarity.toUpperCase()} /></h3>
              <p className="text-sm">{dossier.resolution_analysis.what_must_happen_for_yes}</p>
              <p className="mt-2 text-xs text-zinc-500">Source: {dossier.resolution_analysis.resolution_source}</p>
              <div className="mt-2"><List items={dossier.resolution_analysis.edge_cases} /></div>
            </Card>
            <Card>
              <h3 className="mb-2 font-semibold">Contradictory evidence</h3>
              <ul className="space-y-1 text-sm">{dossier.contradictions.length === 0 ? <li className="text-zinc-500">None recorded.</li> : dossier.contradictions.map((c, i) => <li key={i}>{c.resolved ? "✓ resolved: " : "⚠ unresolved: "}{c.description} <span className="text-zinc-500">{c.notes}</span></li>)}</ul>
            </Card>
            <Card>
              <h3 className="mb-2 font-semibold">Trends, timeline &amp; possibly mispriced information</h3>
              <p className="text-sm">{dossier.current_trends}</p>
              <p className="mt-2 text-sm text-zinc-600">{dossier.timeline}</p>
              <div className="mt-2"><List items={dossier.possibly_underweighted} /></div>
              <p className="mt-2 text-xs text-zinc-500">Newest evidence: {dossier.newest_evidence_date ?? "unknown"} · data quality {pct(dossier.data_quality.score, 0)} — {dossier.data_quality.notes}</p>
            </Card>
          </div>
        </>
      )}

      {quick && !dossier && (
        <Section title="Stage-2 quick estimate">
          <Card>
            <List items={quick.key_points} />
            <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-700">{quick.reasoning}</p>
          </Card>
        </Section>
      )}

      <Section title="Analyst estimates">
        <Table head={["Analyst", "P(YES)", "Confidence", "Evidence", "Reasoning"]} empty="No analyst estimates for the latest run.">
          {analysts.map((a) => (
            <tr key={a.id} className="align-top">
              <Td>{a.perspective}<div className="text-xs text-zinc-500">{a.model}</div></Td>
              <Td className="font-medium">{pct(a.probabilityYes)}</Td>
              <Td>{pct(a.confidence, 0)}</Td>
              <Td>{pct(a.evidenceQuality, 0)}</Td>
              <Td className="max-w-2xl whitespace-normal text-sm"><details><summary className="cursor-pointer text-zinc-600">{a.reasoning.slice(0, 140)}…</summary><p className="mt-2 whitespace-pre-wrap">{a.reasoning}</p></details></Td>
            </tr>
          ))}
        </Table>
        {estimate && (
          <p className="mt-2 text-xs text-zinc-500">
            Aggregate: mean {pct(estimate.meanProb)} · median {pct(estimate.medianProb)} · std-dev {pp(estimate.stdevProb)} · final {pct(estimate.probabilityYes)} ({String((estimate.method as { aggregation?: string }).aggregation ?? "")})
          </p>
        )}
      </Section>

      <Section title="Sources">
        <Table head={["Tier", "Type", "Source", "Published", "Used for"]} empty="No sources recorded.">
          {sources.map((src) => (
            <tr key={src.id} className="align-top">
              <Td>{src.qualityTier}</Td>
              <Td className="text-xs">{src.sourceType.replaceAll("_", " ")}</Td>
              <Td className="max-w-md whitespace-normal"><SafeLink href={src.url}>{src.title || src.url}</SafeLink><div className="text-xs text-zinc-500">{src.publisher}{src.excerpt?.startsWith("UNVERIFIED") && <span className="ml-1 text-amber-700">· unverified citation</span>}</div></Td>
              <Td className="text-xs">{src.publishedAt ? dateTime(src.publishedAt).slice(0, 10) : "—"}</Td>
              <Td className="max-w-md whitespace-normal text-xs">{src.usedFor}</Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Resolution rules (verbatim)">
        <Card><pre className="whitespace-pre-wrap font-sans text-sm">{market.description ?? "No rules text."}</pre>{market.resolutionSource && <p className="mt-2 text-xs text-zinc-500">Resolution source: {market.resolutionSource}</p>}</Card>
      </Section>

      <Section title="Research history">
        <Table head={["Queued", "Stage", "Trigger", "Status", "Model", "Searches", "Cost", "Error"]}>
          {runs.map((r) => (
            <tr key={r.id}>
              <Td className="text-xs">{dateTime(r.queuedAt)}</Td><Td>{r.stage}</Td><Td className="text-xs">{r.trigger}</Td><Td><Badge value={r.status} /></Td>
              <Td className="text-xs">{r.model} ({r.effort})</Td><Td>{r.webSearchRequests}</Td><Td>{usd(r.costUsd)}</Td>
              <Td className="max-w-xs truncate text-xs text-red-700">{r.error ?? ""}</Td>
            </tr>
          ))}
        </Table>
        <p className="mt-2 text-xs text-zinc-500"><Link href="/opportunities" className="underline">← back to opportunities</Link></p>
      </Section>
    </>
  );
}
