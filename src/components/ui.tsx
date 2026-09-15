import type { ReactNode } from "react";

export function PageTitle({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>}
    </div>
  );
}

export function Stat({ label, value, hint, valueClass = "" }: { label: string; value: ReactNode; hint?: ReactNode; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${valueClass}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-zinc-200 bg-white p-4 ${className}`}>{children}</div>;
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: string }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <div className="table-wrap rounded-lg border border-zinc-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
          <tr>{head.map((h, i) => <th key={i} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {hasRows ? children : (
            <tr><td colSpan={head.length} className="px-3 py-6 text-center text-zinc-500">{empty ?? "Nothing here yet."}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`whitespace-nowrap px-3 py-2 ${className}`}>{children}</td>;
}

const BADGE: Record<string, string> = {
  TRADE: "bg-emerald-100 text-emerald-800", NO_TRADE: "bg-zinc-100 text-zinc-700", YES: "bg-sky-100 text-sky-800", NO: "bg-violet-100 text-violet-800",
  HOLD: "bg-zinc-100 text-zinc-700", ADD: "bg-emerald-100 text-emerald-800", REDUCE: "bg-amber-100 text-amber-800", EXIT: "bg-red-100 text-red-800",
  RESOLVE: "bg-sky-100 text-sky-800", OPEN: "bg-sky-100 text-sky-800", CLOSED: "bg-zinc-100 text-zinc-700", RESOLVED: "bg-zinc-100 text-zinc-700",
  FILLED: "bg-emerald-100 text-emerald-800", PARTIAL: "bg-amber-100 text-amber-800", UNFILLED: "bg-zinc-100 text-zinc-600",
  succeeded: "bg-emerald-100 text-emerald-800", failed: "bg-red-100 text-red-800", running: "bg-sky-100 text-sky-800",
  completed: "bg-emerald-100 text-emerald-800", queued: "bg-zinc-100 text-zinc-700",
};

export function Badge({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-zinc-400">—</span>;
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${BADGE[value] ?? "bg-zinc-100 text-zinc-700"}`}>{value.replace("_", " ")}</span>;
}
