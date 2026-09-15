import { Card, PageTitle, Section, Table, Td } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { getStrategyPage } from "@/lib/dashboard/queries";
import { dateTime } from "@/lib/format";
import { StrategyForm } from "./StrategyForm";

export default async function StrategyPage() {
  await requireUser();
  const { active, versions } = await getStrategyPage();
  return (
    <>
      <PageTitle
        title={`Strategy v${active.version}`}
        subtitle="All thresholds live here. Saving creates a new immutable version; past predictions and trades stay linked to the version they were made under."
      />
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Section title="Active configuration">
          <StrategyForm initialConfig={JSON.stringify(active.config, null, 2)} />
        </Section>
        <div>
          <Section title="What the key settings mean">
            <Card className="space-y-2 text-sm text-zinc-700">
              <p><strong>qualification.minEdge</strong> — required gap between our probability and the all-in price (0.12 = 12 percentage points).</p>
              <p><strong>qualification.minConfidence</strong> — minimum aggregate reliability score; disagreement between analysts lowers it.</p>
              <p><strong>sizing.kellyFraction</strong> — fraction of full Kelly bet size (0.25 = quarter Kelly), before hard caps.</p>
              <p><strong>sizing.max*Pct</strong> — hard caps as a fraction of equity: per position, total, per category, per correlated event.</p>
              <p><strong>research.dailyBudgetUsd</strong> — cap on real Anthropic API spend per UTC day.</p>
              <p><strong>research.blockedDomains</strong> — sites research may not read (prediction markets), so estimates are formed blind to market odds.</p>
            </Card>
          </Section>
          <Section title="Version history">
            <Table head={["Version", "Created", "Notes"]}>
              {versions.map((v) => (
                <tr key={v.id} className={v.id === active.id ? "bg-emerald-50" : ""}>
                  <Td>v{v.version}{v.id === active.id && " (active)"}</Td>
                  <Td className="text-xs">{dateTime(v.createdAt)}</Td>
                  <Td className="max-w-xs whitespace-normal text-xs">{v.notes}</Td>
                </tr>
              ))}
            </Table>
          </Section>
        </div>
      </div>
    </>
  );
}
