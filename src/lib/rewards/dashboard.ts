import { dec, type Dec } from "@/lib/decimal";
import { lpMarkValue } from "./account";
import { hoursLeft } from "./select";
import { summarize, type AccountState, type HeldMarket, type RobotState } from "./robot";

/** One self-contained page describing the paper robot's state in plain language. No scripts, no external assets. */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const usd = (v: Dec | number | string) => {
  const d = dec(v);
  return `${d.isNegative() ? "-" : ""}$${d.abs().toFixed(2)}`;
};
const signed = (v: Dec) => `${v.isNegative() ? "-" : "+"}$${v.abs().toFixed(2)}`;
const tone = (v: Dec) => (v.gt(0) ? "up" : v.lt(0) ? "down" : "");
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const cents = (p: number) => `${(p * 100).toFixed(1)}c`;

function ago(iso: string | null, now: Date): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} seconds ago`;
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  return `${(s / 3600).toFixed(1)} hours ago`;
}

function duration(hours: number): string {
  if (!Number.isFinite(hours)) return "no end date";
  if (hours < 48) return `${Math.max(0, hours).toFixed(0)} hours`;
  return `${(hours / 24).toFixed(0)} days`;
}

function holding(hm: HeldMarket): string {
  const yes = dec(hm.yes);
  const no = dec(hm.no);
  if (yes.isZero() && no.isZero()) return "nothing";
  return yes.gt(0) ? `${yes.toFixed(0)} YES` : `${no.toFixed(0)} NO`;
}

function marketRow(hm: HeldMarket, now: Date): string {
  const value = lpMarkValue({ yes: dec(hm.yes), no: dec(hm.no), cashFlow: dec(hm.cashFlow), fills: hm.fills }, hm.mark ?? 0.5);
  const fillResult = dec(hm.cashFlow).plus(value);
  const avgShare = hm.samples ? hm.shareSum / hm.samples : 0;
  const orders = hm.status !== "quoting" ? "none (left)"
    : `${hm.quotes.bid ? `buy at ${cents(hm.quotes.bid.price)}` : "no buy"} / ${hm.quotes.ask ? `sell at ${cents(hm.quotes.ask.price)}` : "no sell"}`;
  return `<tr>
    <td class="q">${esc(hm.question)}<div class="sub">${hm.status === "quoting" ? `orders: ${orders}` : `stopped: ${esc(hm.leftReason ?? "")}`}</div></td>
    <td>${usd(hm.dailyRate)}</td>
    <td>${hm.status === "quoting" ? `${pct(hm.share)} <span class="sub">(avg ${pct(avgShare)})</span>` : "-"}</td>
    <td>${usd(hm.rewardToday)}</td>
    <td>${usd(hm.rewardTotal)}</td>
    <td>${hm.fills}</td>
    <td>${holding(hm)}</td>
    <td class="${tone(fillResult)}">${signed(fillResult)}</td>
    <td>${duration(hoursLeft(hm.endDate, now))}</td>
  </tr>`;
}

function accountCard(acct: AccountState, now: Date, us: boolean): string {
  const s = summarize(acct, now);
  const change = s.total.minus(s.startingCash);
  const changeWithout = s.totalWithoutRewards.minus(s.startingCash);
  const rewards = s.rewardsPaid.plus(s.rewardsPendingCounted);
  const rows = acct.markets.map((hm) => marketRow(hm, now)).join("");
  const closed = acct.closed.slice(-8).reverse().map((c) => `<tr>
    <td class="q">${esc(c.question)}<div class="sub">${esc(c.reason)}</div></td>
    <td>${usd(c.rewardTotal)}</td><td>${c.fills}</td>
    <td class="${tone(dec(c.tradingResult))}">${signed(dec(c.tradingResult))}</td>
  </tr>`).join("");
  return `<section class="card">
    <h2>${esc(s.name)}</h2>
    <div class="big">Started with ${usd(s.startingCash)}.</div>
    <div class="two">
      <div><span>If rewards are paid the way Polymarket's formula says</span><b>${usd(s.total)}</b> <em class="${tone(change)}">${signed(change)}</em><small>unconfirmed: nobody has been paid anything</small></div>
      <div><span>If no reward is ever paid</span><b>${usd(s.totalWithoutRewards)}</b> <em class="${tone(changeWithout)}">${signed(changeWithout)}</em><small>this part is measured against real trades</small></div>
    </div>
    <div class="grid">
      <div><span>Rewards (estimated)</span><b class="${tone(rewards)}">${signed(rewards)}</b><small>from the published formula</small></div>
      <div><span>Result from fills</span><b class="${tone(s.tradingResult)}">${signed(s.tradingResult)}</b><small>shares we were left holding, at today's price</small></div>
      <div><span>${us ? "Earned in periods still running, under $1 so far" : "Earned today, not yet safe"}</span><b>${usd(s.rewardsPendingAtRisk)}</b><small>${us ? "a period that ends under $1 pays nothing" : "in markets still under the $1 daily minimum"}</small></div>
      <div><span>Lost to the $1 rule</span><b>${usd(s.rewardsForfeited)}</b><small>earned but too small to be paid</small></div>
      <div><span>Cash</span><b>${usd(s.cash)}</b><small>${s.quoting} market${s.quoting === 1 ? "" : "s"} being quoted</small></div>
      <div><span>Shares held</span><b>${usd(s.inventoryValue)}</b><small>${s.holding} market${s.holding === 1 ? "" : "s"} waiting to pay out</small></div>
    </div>
    ${rows ? `<table>
      <thead><tr><th>Market</th><th>${us ? "Pool (this period)" : "Pool / day"}</th><th>Our share</th><th>${us ? "Earned this period" : "Earned today"}</th><th>Earned in all</th><th>Fills</th><th>Holding</th><th>Fill result</th><th>${us ? "Period ends in" : "Ends in"}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>` : `<p class="sub">Not in any market yet. The first scan picks them.</p>`}
    ${closed ? `<h3>Markets it has left</h3><table>
      <thead><tr><th>Market</th><th>Rewards earned</th><th>Fills</th><th>Fill result</th></tr></thead>
      <tbody>${closed}</tbody>
    </table>` : ""}
  </section>`;
}

export function renderDashboard(state: RobotState, now: Date, opts: { backHref?: string } = {}): string {
  const us = state.venue === "us";
  const hours = (now.getTime() - Date.parse(state.startedAt)) / 3_600_000;
  const pools = state.poolsSeen;
  const candidates = state.candidates.map((c) => `<tr>
    <td class="q">${esc(c.question)}</td><td>${usd(c.dailyRate)}</td><td>${pct(c.share)}</td><td>${usd(c.expectedDailyReward)}</td><td>${usd(c.capital)}</td>
    ${us ? "" : `<td>${usd(c.volume24h)}</td>`}<td>${duration(c.hoursLeft ?? Infinity)}</td>
  </tr>`).join("");
  const events = state.events.slice(-40).reverse().map((e) => `<li><time>${esc(e.at.slice(5, 16).replace("T", " "))} UTC</time> <b>${esc(e.account)}</b> ${esc(e.text)}</li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>${us ? "Reward robot US (paper)" : "Reward robot (paper)"}</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --ink:#15181d; --dim:#667085; --line:#e4e7ec; --up:#0a7d43; --down:#b42318; --warn-bg:#fff4d6; --warn-ink:#6b4e00; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#181b21; --ink:#e8eaed; --dim:#98a2b3; --line:#2a2f38; --up:#4ade80; --down:#f97066; --warn-bg:#3a2f0b; --warn-ink:#fde68a; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px; background:var(--bg); color:var(--ink); font:15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width:1100px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:18px; margin:0 0 6px; } h3 { font-size:14px; margin:18px 0 6px; color:var(--dim); }
  .warn { background:var(--warn-bg); color:var(--warn-ink); padding:10px 12px; border-radius:8px; margin:10px 0 14px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:0 0 14px; overflow-x:auto; }
  .big { font-size:15px; margin-bottom:8px; color:var(--dim); }
  .two { display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:10px; margin-bottom:10px; }
  .two div { border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  .two span { display:block; color:var(--dim); font-size:12px; } .two b { font-size:24px; } .two em { font-style:normal; font-size:14px; } .two small { display:block; color:var(--dim); font-size:11px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:10px; margin-bottom:12px; }
  .grid div { border:1px solid var(--line); border-radius:8px; padding:8px 10px; }
  .grid span { display:block; color:var(--dim); font-size:12px; } .grid b { font-size:17px; } .grid small { display:block; color:var(--dim); font-size:11px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:right; padding:6px 8px; border-top:1px solid var(--line); white-space:nowrap; }
  th { color:var(--dim); font-weight:600; } th:first-child, td.q { text-align:left; white-space:normal; min-width:240px; }
  .sub, time { color:var(--dim); font-size:12px; } .up { color:var(--up); } .down { color:var(--down); }
  a { color:inherit; }
  ul { list-style:none; margin:0; padding:0; } li { padding:5px 0; border-top:1px solid var(--line); font-size:13px; }
</style>
</head>
<body><main>
${opts.backHref ? `<div class="sub"><a href="${esc(opts.backHref)}">&larr; Back to the trading dashboard</a></div>` : ""}
<h1>Reward robot${us ? " (Polymarket US)" : ""} &mdash; paper test</h1>
<div class="sub">Running ${hours < 1 ? `${Math.round(hours * 60)} minutes` : `${hours.toFixed(1)} hours`} &middot; last look ${ago(state.updatedAt, now)} &middot; last market scan ${ago(state.lastScanAt, now)} &middot; this page refreshes itself</div>
<div class="warn"><b>No real orders, no real money.</b> The robot works out where it would rest orders, then watches the real market to see which would have been hit. Rewards are <b>estimates</b> from Polymarket's published formula; only a real account can confirm they are paid.</div>
${pools ? (us
  ? `<p class="sub">Last scan: ${pools.markets.toLocaleString("en-US")} reward periods running now (${usd(pools.dailyTotal)} in their pools) &middot; ${pools.eligible.toLocaleString("en-US")} books checked &middot; in ${pools.uncontested.toLocaleString("en-US")} of them our order would take half the pool or more (${usd(pools.uncontestedDaily)}).</p>`
  : `<p class="sub">Last scan: ${pools.markets.toLocaleString("en-US")} pools paying ${usd(pools.dailyTotal)} a day in all &middot; ${pools.eligible.toLocaleString("en-US")} fit our rules &middot; ${pools.uncontested.toLocaleString("en-US")} of those had nobody collecting (${usd(pools.uncontestedDaily)} a day).</p>`) : ""}
${state.accounts.map((a) => accountCard(a, now, us)).join("")}
<section class="card">
  <h2>Best pools at the last scan</h2>
  ${candidates ? `<table>
    <thead><tr><th>Market</th><th>${us ? "Pool (period)" : "Pool / day"}</th><th>Our share</th><th>${us ? "We would earn (rest of period)" : "We would earn / day"}</th><th>Money tied up</th>${us ? "" : "<th>Traded in 24h</th>"}<th>${us ? "Period ends in" : "Ends in"}</th></tr></thead>
    <tbody>${candidates}</tbody>
  </table>` : `<p class="sub">Waiting for the first scan.</p>`}
</section>
<section class="card">
  <h2>What happened</h2>
  ${events ? `<ul>${events}</ul>` : `<p class="sub">Nothing yet.</p>`}
</section>
<p class="sub">How to read this: ${us
  ? `Polymarket US pays each market's pool per period (pre-game: the 6 hours before kick-off; in-game: from kick-off, spread here over ${4} hours, which understates it if games end sooner) to orders at or near the best price; the robot keeps one order at the best bid and one at the best offer. A period worth under $1 to us counts as nothing. Polymarket US publishes no trade feed, so fills are inferred from the running traded total and the last trade price against our place in line; that is approximate.`
  : `"our share" assumes every other qualifying order belongs to competitors scored at their maximum. A market that earns under $1 in a UTC day is counted as paying nothing. Fills are assumed whenever a real trade or the real book crossed one of our prices.`} Reward time is only counted while the robot was looking. ${state.lastError ? `Last data error: ${esc(state.lastError)}` : ""}</p>
</main></body></html>`;
}
