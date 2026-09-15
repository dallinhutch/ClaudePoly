# Polytrader: AI research + Polymarket paper trading

A private web application that monitors real Polymarket markets, researches promising ones with Claude, estimates the true probability of each outcome, compares that with live prices, and executes **simulated** trades from a $1,000.00 paper bankroll.

> **Paper trading only.** There is no wallet, no private key, no order signing and no live execution adapter. The database rejects any order whose adapter isn't `paper`.

The experiment: *can an AI research system consistently identify mispriced contracts using only information available at the time of each trade?* The system is built so the answer can be measured honestly: predictions are immutable, fills use the real order book, and calibration is tracked for every forecast, traded or not.

---

## Architecture

```
                 ┌──────────── Hostinger VPS (Docker Compose) ────────────┐
 Browser ─HTTPS─▶│ Traefik (existing) ─▶ web (Next.js dashboard, auth)    │
                 │                        │                               │
                 │                        ▼                               │
                 │                    postgres (not exposed)              │
                 │                        ▲                               │
                 │ worker ────────────────┘                               │
                 │   ├─ scan_markets      Gamma API → markets, price history, stage-1 screen
                 │   ├─ research_pipeline stage 2 → stage 3 → qualification → sizing → paper fill
                 │   ├─ monitor_positions mark at bid, re-research when due, HOLD/REDUCE/EXIT/ADD
                 │   ├─ settle_resolutions real outcomes → payouts → realized P&L
                 │   └─ portfolio_snapshot equity / drawdown series
                 └────────────────────────────────────────────────────────┘
                     │                                   │
          Polymarket Gamma + CLOB (public, read-only)   Anthropic API (Claude Opus 5 + web search)
```

| Area | Location |
|---|---|
| Central strategy config (every threshold) | `src/lib/strategy/config.ts` |
| Database schema / migrations | `src/db/schema.ts`, `drizzle/` |
| Polymarket client + ingestion | `src/lib/polymarket/` |
| Stage-1 screening (no AI) | `src/lib/screening/screen.ts` |
| Research agents, prompts, aggregation, cost | `src/lib/research/` |
| Probability, sizing, qualification, fills, accounting | `src/lib/trading/` |
| Pipelines run by the worker | `src/lib/pipeline/`, `src/worker/` |
| Dashboard | `src/app/` |

### Tiered research (cost control)

1. **Stage 1: rules, free.** Every active market is scored on liquidity, volume, spread, time to resolution, price uncertainty, resolution-rule clarity and researchability. Random or unknowable markets (short-term crypto up/down, game handicaps, …) are excluded.
2. **Stage 2: one low-effort Claude call** with ≤4 web searches for the top-ranked markets. Escalates only if the estimated edge after fees is ≥ `research.stage3MinRawEdge`.
3. **Stage 3: deep research.** A research agent builds an evidence dossier (sources ranked by quality tier, YES/NO evidence, base rate, contradictions, resolution edge cases, freshness). Then **5 independent analysts** (outside-view, resolution-rules, inside-view, red-team, domain) each forecast, with a few searches of their own.

Every call's tokens, searches and estimated dollar cost go to `ai_usage`. A daily budget (`research.dailyBudgetUsd`) stops research; 25% is reserved for re-reviewing open positions.

**Anti-anchoring:** researchers and analysts are never shown the market price, and prediction-market/odds sites are blocked from web search. Estimates are formed blind, then compared with the market.

### From estimate to trade

- **Aggregation:** weak-evidence analyses are excluded; the rest are pooled in log-odds space, weighted by confidence × evidence quality. Confidence is penalized by analyst disagreement: `× exp(-(stdev/0.15)²)`.
- **Edge = probability − all-in price** (best ask + Polymarket taker fee `shares × rate × p(1−p)`). Buying NO means buying the NO token; nothing is shorted.
- **Qualification:** confidence, edge after fees, EV per dollar, liquidity, analyst disagreement, evidence quality, information freshness, resolution clarity, unresolved contradictions, time to resolution. Every check is stored with each TRADE/NO_TRADE decision.
- **Sizing:**
  - Base size is quarter Kelly on a probability shrunk toward the market by confidence.
  - It is then capped by: max per position, total exposure, category exposure, correlated (same event) exposure, cash reserve, and 25% of visible book depth.
  - It is throttled by drawdown (halt at 30%) and reduced for long-dated markets.
- **Execution:** a fill-and-kill limit order walks the live order book, which is snapshotted and stored first. Partial fills happen when depth runs out, and there are no resting orders.
- **Monitoring:**
  - Positions are marked at the best bid.
  - Every 12h, or after a 7pp price move, a stage-2 review runs; a large change triggers stage-3 re-research.
  - **EXIT** when the remaining edge vs. selling now < −3pp; **REDUCE** when it's < +2pp.
  - **ADD** needs a fresh stage-3 estimate that fully qualifies, is blocked if the price moved against the entry (no averaging down), and is limited to 1 per position.
- **Resolution:** a market settles only when Polymarket reports it closed, resolved, and priced exactly 1/0, 0/1 or 0.5/0.5.

### Integrity guarantees (enforced by the database, not just the app)

- **Append-only tables:** strategy versions, price history, order-book snapshots, screening results, sources, analyst predictions, probability estimates, trade candidates, orders, fills, position updates, resolutions, the cash ledger, portfolio snapshots, AI usage and audit events. Triggers reject `UPDATE`, `DELETE` and `TRUNCATE`.
- **Research runs** are frozen once completed or failed.
- **Positions:** entry facts can never change, and closed positions are frozen.
- **Cash ledger:** exactly one `DEPOSIT` is allowed (so losses can't be hidden by topping up), running balances are verified, and cash can never go negative.
- **Audit events** are SHA-256 hash-chained. `audit_chain_first_break()` verifies the chain, and the Activity page shows its status.
- **Calibration** uses the first estimate per market made before resolution, whether or not it was traded.

---

## Local development

Requirements: Node 22+, PostgreSQL 16 (or Docker).

```bash
npm install
cp .env.example .env        # set DATABASE_URL (localhost), SESSION_SECRET, ANTHROPIC_API_KEY
npm run db:migrate          # applies migrations, creates strategy v1 and the $1,000 deposit
npm run create-admin -- you@example.com
npm run dev                 # dashboard on http://localhost:3000
npm run worker              # background jobs (uses real Polymarket data and real AI spend)
```

Tests (use an in-process Postgres, so no database is needed):

```bash
npm test
npm run typecheck
```

After changing `src/db/schema.ts`: `npm run db:generate` creates a new migration in `drizzle/`. Never edit an applied migration.

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | postgres | Database credentials |
| `DATABASE_URL` | web, worker, migrate | `postgres://user:pass@postgres:5432/db` |
| `ANTHROPIC_API_KEY` | worker | Claude API (server-side only) |
| `SESSION_SECRET` | web | 32+ random chars; HMAC key for session ids |
| `APP_URL` | web | Public URL |
| `APP_HOSTNAME` | compose/Traefik | Root domain; routes `@`, `www.` and `trade.` |
| `ADMIN_EMAIL` | create-admin | Default admin login |
| `WORKER_ENABLED` | worker | `false` idles the worker |
| `TZ` | all | Keep `UTC` |

No variable is exposed to the browser (there are no `NEXT_PUBLIC_*` variables).

## Deployment (Hostinger VPS)

The VPS already runs Traefik on 80/443 (network `root_default`, cert resolver `mytlschallenge`). This stack joins that network; the database has no published ports.

First-time setup on the VPS:

```bash
mkdir -p /opt/polytrader && cd /opt/polytrader
# create /opt/polytrader/.env from .env.example (chmod 600)
git clone https://github.com/dallinhutch/ClaudePoly.git app
cd app && ln -sfn ../.env .env
docker compose build
docker compose up -d
docker compose run --rm web npm run create-admin -- you@example.com
```

Updates: `bash /opt/polytrader/app/scripts/deploy.sh` (pulls, builds, migrates, restarts).

DNS: A records for `@`, `www` and `trade` → VPS IP (CDN disabled). Traefik obtains Let's Encrypt certificates automatically.

Operations:

```bash
docker compose logs -f worker          # what the system is doing
docker compose ps
bash scripts/backup-db.sh              # pg_dump to /opt/polytrader/backups (add to cron nightly)
```

## Security

- Single admin login with Argon2id password hashing. Failed logins are rate-limited per IP (5 per 15 min) and per email (10 per 15 min).
- Sessions use random 256-bit tokens in `__Host-` HttpOnly, Secure, SameSite=Strict cookies; only an HMAC of the token is stored.
- Every page, route and server action checks the session server-side.
- AI and Polymarket calls happen only on the server. Links from AI output are restricted to http(s).
- Secrets live only in `/opt/polytrader/.env` (mode 600) and are never committed.

## Future real-money mode (not implemented)

`src/lib/trading/adapter.ts` defines the `ExecutionAdapter` boundary with a single implementation, `PaperTradingExecutionAdapter`. A live adapter would need wallet custody, order signing, reconciliation and a separate risk review. It is deliberately absent from this build.
