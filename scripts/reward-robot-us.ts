/**
 * PAPER reward-collecting robot for Polymarket US. Public data only: no orders, no keys, no AI calls.
 *   npx tsx scripts/reward-robot-us.ts          run it and serve the dashboard on http://localhost:4320
 *   npx tsx scripts/reward-robot-us.ts --once   one market scan and one look, print the accounts, exit
 * State lives in data/reward-robot-us/ so a restart carries on where it left off.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { renderDashboard } from "@/lib/rewards/dashboard";
import { summarize, type RobotEvent, type RobotState } from "@/lib/rewards/robot";
import { applyUsScan, gatherUsScan, liveUsApi, newUsState, resumeUsAfterRestart, runUsCycle, US_CONFIG, type UsScanResult } from "@/lib/rewards/us/robot";

const DIR = path.resolve(process.env.REWARD_ROBOT_DIR ?? "data/reward-robot-us");
const STATE_FILE = path.join(DIR, "state.json");
const EVENTS_FILE = path.join(DIR, "events.jsonl");
const PORT = Number(process.env.REWARD_ROBOT_PORT ?? 4320);
const RETRY_SCAN_MS = 3 * 60_000;
const cfg = US_CONFIG;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

function loadState(): RobotState {
  if (fs.existsSync(STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as RobotState;
    const sameAccounts = saved.version === 1 && saved.venue === "us" && saved.accounts.length === cfg.accounts.length && saved.accounts.every((a, i) => a.name === cfg.accounts[i]?.name);
    if (sameAccounts) {
      resumeUsAfterRestart(saved);
      return saved;
    }
    fs.renameSync(STATE_FILE, path.join(DIR, `state-${Date.now()}.old.json`));
  }
  return newUsState(cfg, new Date());
}

function saveState(state: RobotState) {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

/** Run one step and append whatever it logged to the permanent event file (the in-memory list is capped). */
async function logged(state: RobotState, step: () => Promise<void>) {
  const before = new Set<RobotEvent>(state.events);
  try {
    await step();
  } finally {
    const added = state.events.filter((e) => !before.has(e));
    if (added.length) fs.appendFileSync(EVENTS_FILE, added.map((e) => JSON.stringify(e)).join("\n") + "\n");
    for (const e of added) console.log(`${e.at.slice(11, 19)} [${e.account}] ${e.text}`);
  }
}

function printAccounts(state: RobotState) {
  const now = new Date();
  for (const acct of state.accounts) {
    const s = summarize(acct, now);
    console.log(`${s.name}: with rewards $${s.total.toFixed(2)}, without $${s.totalWithoutRewards.toFixed(2)} (started $${s.startingCash.toFixed(2)}) | rewards counted $${s.rewardsPaid.plus(s.rewardsPendingCounted).toFixed(2)}, under $1 so far $${s.rewardsPendingAtRisk.toFixed(2)} | fills $${s.tradingResult.toFixed(2)} | quoting ${s.quoting}, holding ${s.holding}`);
  }
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const state = loadState();
  const stop = () => {
    saveState(state);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  if (process.argv.includes("--once")) {
    const scan = await gatherUsScan(cfg, liveUsApi, new Date());
    await logged(state, () => applyUsScan(state, cfg, liveUsApi, scan, new Date()));
    await logged(state, () => runUsCycle(state, cfg, liveUsApi, new Date()));
    saveState(state);
    printAccounts(state);
    return;
  }

  http.createServer((req, res) => {
    if (req.url === "/state.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(state));
    } else if (req.url === "/" || req.url?.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderDashboard(state, new Date()));
    } else {
      res.writeHead(404).end();
    }
  }).listen(PORT, "127.0.0.1", () => console.log(`reward robot US (paper) dashboard: http://localhost:${PORT}`));

  // The programme list is long and takes a couple of minutes to read, so the scan
  // runs beside the quick loop and its result is applied between looks.
  let scanning = false;
  let ready: UsScanResult | null = null;
  let nextScanAt = 0;

  for (;;) {
    const started = Date.now();
    if (!scanning && started >= nextScanAt) {
      scanning = true;
      gatherUsScan(cfg, liveUsApi, new Date())
        .then((scan) => {
          ready = scan;
          nextScanAt = Date.now() + cfg.scanMinutes * 60_000;
        })
        .catch((err) => {
          state.lastError = `${new Date().toISOString()} market scan: ${describe(err)}`;
          nextScanAt = Date.now() + RETRY_SCAN_MS;
        })
        .finally(() => {
          scanning = false;
        });
    }
    try {
      const scan = ready;
      if (scan) {
        ready = null;
        await logged(state, () => applyUsScan(state, cfg, liveUsApi, scan, new Date()));
      }
      await logged(state, () => runUsCycle(state, cfg, liveUsApi, new Date()));
      saveState(state);
    } catch (err) {
      state.lastError = `${new Date().toISOString()} ${describe(err)}`;
      console.error(state.lastError);
    }
    await sleep(Math.max(1000, cfg.cycleSeconds * 1000 - (Date.now() - started)));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
