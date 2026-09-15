import Link from "next/link";
import { Badge, PageTitle, Table, Td } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { getTradeCategories, getTrades, type TradeFilters } from "@/lib/dashboard/queries";
import { cents, dateTime, usd } from "@/lib/format";

const SIDES = ["YES", "NO"] as const;
const ACTIONS = ["OPEN", "ADD", "REDUCE", "EXIT"] as const;
const STATUSES = ["FILLED", "PARTIAL", "UNFILLED"] as const;

function pick<T extends string>(value: string | string[] | undefined, allowed: readonly T[]): T | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return allowed.includes(v as T) ? (v as T) : undefined;
}

export default async function TradesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser();
  const sp = await searchParams;
  const categories = await getTradeCategories();
  const filters: TradeFilters = {
    side: pick(sp.side, SIDES),
    action: pick(sp.action, ACTIONS),
    status: pick(sp.status, STATUSES),
    category: pick(sp.category, categories),
  };
  const rows = await getTrades(filters);

  const select = (name: string, label: string, options: readonly string[], value?: string) => (
    <label className="text-sm">
      <span className="mr-1 text-zinc-500">{label}</span>
      <select name={name} defaultValue={value ?? ""} className="rounded-md border border-zinc-300 bg-white px-2 py-1">
        <option value="">All</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );

  return (
    <>
      <PageTitle title="Trade history" subtitle="Every simulated order, including unfilled ones. Records are append-only and cannot be edited." />
      <form method="get" className="mb-4 flex flex-wrap items-center gap-3">
        {select("side", "Side", SIDES, filters.side)}
        {select("action", "Action", ACTIONS, filters.action)}
        {select("status", "Fill", STATUSES, filters.status)}
        {select("category", "Category", categories, filters.category)}
        <button type="submit" className="rounded-md bg-zinc-900 px-3 py-1 text-sm text-white">Filter</button>
        <Link href="/trades" className="text-sm text-zinc-500 underline">Reset</Link>
      </form>
      <Table head={["Time", "Market", "Action", "Side", "Fill", "Requested", "Limit", "Shares", "Avg price", "Notional", "Fees", "Strategy", "Reason"]} empty="No simulated orders match.">
        {rows.map(({ order: o, question, category, strategyVersion }) => (
          <tr key={o.id}>
            <Td className="text-xs text-zinc-500">{dateTime(o.createdAt)}</Td>
            <Td className="max-w-xs truncate whitespace-normal">
              <Link href={`/markets/${o.marketId}`} className="text-sky-800 hover:underline">{question}</Link>
              <div className="text-xs text-zinc-500">{category ?? "—"}</div>
            </Td>
            <Td><Badge value={o.action} /> <span className="text-xs text-zinc-500">{o.direction}</span></Td>
            <Td><Badge value={o.side} /></Td>
            <Td><Badge value={o.status} /></Td>
            <Td>{o.requestedUsd ? usd(o.requestedUsd) : o.requestedShares ? `${Number(o.requestedShares).toFixed(2)} sh` : "—"}</Td>
            <Td>{cents(o.limitPrice)}</Td>
            <Td>{Number(o.filledShares).toFixed(2)}</Td>
            <Td>{cents(o.avgFillPrice)}</Td>
            <Td>{usd(o.notionalUsd)}</Td>
            <Td>{usd(o.feesUsd, 4)}</Td>
            <Td>v{strategyVersion}</Td>
            <Td className="max-w-xs truncate text-xs text-zinc-500"><span title={o.reason}>{o.reason}</span></Td>
          </tr>
        ))}
      </Table>
    </>
  );
}
