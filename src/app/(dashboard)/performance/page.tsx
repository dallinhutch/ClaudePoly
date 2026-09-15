import { CalibrationChart, PnlBars, TimeSeriesChart } from "@/components/charts";
import { Card, PageTitle, Section, Stat, Table, Td } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { getPerformance } from "@/lib/dashboard/queries";
import { dateTime, pct, pnlClass, pp, signedPct, signedUsd, usd } from "@/lib/format";

type Group = { key: string; count: number; pnl: number; invested: number; roi: number | null; winRate: number };

function GroupTable({ rows }: { rows: Group[] }) {
  return (
    <Table head={["Group", "Trades", "Invested", "Realized P&L", "ROI", "Win rate"]} empty="No closed trades yet.">
      {rows.map((r) => (
        <tr key={r.key}>
          <Td>{r.key}</Td><Td>{r.count}</Td><Td>{usd(r.invested)}</Td>
          <Td className={pnlClass(r.pnl)}>{signedUsd(r.pnl)}</Td><Td>{signedPct(r.roi)}</Td><Td>{pct(r.winRate, 0)}</Td>
        </tr>
      ))}
    </Table>
  );
}

function Breakdown({ title, rows }: { title: string; rows: Group[] }) {
  return (
    <Section title={title}>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><PnlBars rows={rows} /></Card>
        <GroupTable rows={rows} />
      </div>
    </Section>
  );
}

export default async function PerformancePage() {
  await requireUser();
  const p = await getPerformance();
  const s = p.stats;
  const totalReturn = p.startingBankroll > 0 ? (p.equity - p.startingBankroll) / p.startingBankroll : 0;
  const pf = s.profitFactor == null ? "—" : Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "∞";

  return (
    <>
      <PageTitle title="Performance" subtitle="Closed and resolved simulated positions. Calibration counts every researched forecast, traded or not." />

      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <Stat label="Bankroll" value={usd(p.equity)} hint={`started ${usd(p.startingBankroll)}`} />
        <Stat label="Total return" value={signedPct(totalReturn)} valueClass={pnlClass(totalReturn)} />
        <Stat label="Realized P&L" value={signedUsd(p.realizedPnl)} valueClass={pnlClass(p.realizedPnl)} />
        <Stat label="Unrealized P&L" value={signedUsd(p.unrealizedPnl)} valueClass={pnlClass(p.unrealizedPnl)} />
        <Stat label="Max drawdown" value={pct(p.maxDrawdown)} />
        <Stat label="Closed trades" value={s.count} />
        <Stat label="Win rate" value={pct(s.winRate, 0)} hint={`loss rate ${pct(s.lossRate, 0)}`} />
        <Stat label="Average win" value={usd(s.avgWin)} />
        <Stat label="Average loss" value={usd(s.avgLoss)} />
        <Stat label="Profit factor" value={pf} hint="gross profit ÷ gross loss" />
        <Stat label="Avg edge at entry" value={pp(s.avgEdge)} />
        <Stat label="Avg confidence" value={pct(s.avgConfidence, 0)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Bankroll over time">
          <Card><TimeSeriesChart data={p.equitySeries.map((x) => ({ t: x.t, v: x.equity }))} format="usd" baseline={p.startingBankroll} label="equity" /></Card>
        </Section>
        <Section title="Cumulative return">
          <Card><TimeSeriesChart data={p.equitySeries.map((x) => ({ t: x.t, v: x.cumulativeReturn }))} format="pct" baseline={0} label="cumulative return" /></Card>
        </Section>
        <Section title="Drawdown from peak">
          <Card><TimeSeriesChart data={p.equitySeries.map((x) => ({ t: x.t, v: x.drawdown }))} format="pct" baseline={0} label="drawdown" invert /></Card>
        </Section>
        <Section title="Equity data">
          <Card>
            <details>
              <summary className="cursor-pointer text-sm text-zinc-600">Show the latest 50 snapshots as a table</summary>
              <div className="mt-3">
                <Table head={["Time", "Equity", "Return", "Drawdown"]}>
                  {p.equitySeries.slice(-50).reverse().map((x) => (
                    <tr key={x.t}><Td className="text-xs">{dateTime(x.t)}</Td><Td>{usd(x.equity)}</Td><Td>{signedPct(x.cumulativeReturn)}</Td><Td>{pct(x.drawdown)}</Td></tr>
                  ))}
                </Table>
              </div>
            </details>
          </Card>
        </Section>
      </div>

      <Section title="Probability calibration">
        <p className="mb-3 max-w-3xl text-sm text-zinc-600">
          Of all forecasts made at roughly 60%, how often did the contract actually resolve YES? Points on the diagonal mean the AI&apos;s probabilities are meaningful.
          Uses the first estimate for each market (made before resolution); 50/50 voids are excluded.
          Brier score (lower is better; 0.25 = always guessing 50%): deep research {p.calibrationDeep.brier?.toFixed(3) ?? "—"} (n={p.calibrationDeep.count}),
          quick screen {p.calibrationQuick.brier?.toFixed(3) ?? "—"} (n={p.calibrationQuick.count}).
        </p>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CalibrationChart series={[
              { name: "Deep research (stage 3)", buckets: p.calibrationDeep.buckets },
              { name: "Quick screen (stage 2)", buckets: p.calibrationQuick.buckets },
            ]} />
          </Card>
          <Table head={["Bucket", "Stage-3 n", "Predicted", "Resolved YES", "Stage-2 n", "Predicted", "Resolved YES"]}>
            {p.calibrationDeep.buckets.map((b, i) => {
              const q = p.calibrationQuick.buckets[i]!;
              return (
                <tr key={b.lower}>
                  <Td>{Math.round(b.lower * 100)}–{Math.round(b.upper * 100)}%</Td>
                  <Td>{b.count}</Td><Td>{pct(b.meanPredicted)}</Td><Td>{pct(b.observedYesRate)}</Td>
                  <Td>{q.count}</Td><Td>{pct(q.meanPredicted)}</Td><Td>{pct(q.observedYesRate)}</Td>
                </tr>
              );
            })}
          </Table>
        </div>
      </Section>

      <Breakdown title="Returns by confidence bracket" rows={p.byConfidence} />
      <Breakdown title="Returns by edge bracket (at entry)" rows={p.byEdge} />
      <Breakdown title="Returns by market category" rows={p.byCategory} />
    </>
  );
}
