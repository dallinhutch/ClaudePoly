import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session";
import { logoutAction } from "../login/actions";

export const dynamic = "force-dynamic";

const NAV: Array<[string, string]> = [
  ["/", "Overview"],
  ["/recommended", "RECOMMENDED FOR YOU"],
  ["/opportunities", "Opportunities"],
  ["/positions", "Positions"],
  ["/trades", "My bets"],
  ["/performance", "Performance"],
  ["/activity", "System activity"],
  ["/strategy", "Strategy"],
];

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div className="min-h-screen">
      <div className="bg-amber-100 px-4 py-1 text-center text-xs font-medium text-amber-900">
        PAPER TRADING ONLY — simulated $1,000 bankroll against real Polymarket prices. No real money is used.
      </div>
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/" className="font-semibold">Polytrader</Link>
          <nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-600">
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} className="hover:text-zinc-900">{label}</Link>
            ))}
          </nav>
          <form action={logoutAction} className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-zinc-500 sm:inline">{user.email}</span>
            <button type="submit" className="text-zinc-600 underline hover:text-zinc-900">Sign out</button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
