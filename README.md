# SMDApp — Real-Time Options Intelligence Terminal

> A real-time option-chain viewer and trading-intelligence terminal for Indian equity indices
> (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX) with ICICI Breeze API integration and the
> **SDM Options Intelligence Engine**.

---

## 1. What this project is

SMDApp is a browser-based trading terminal that pulls **live** option-chain and market data for the
five major Indian indices, runs a 14-factor options-quality scoring engine (SDM), an institutional
AI layer (ORCA), and a classical technical-analysis engine (ML/TA), and presents everything through
two views:

- **Simple Mode** — a beginner-friendly card with the live PCR, India VIX, ATM strike, max pain,
  CE/PE OI, the current SDM trade recommendation, and a one-click "Go Pro" switch.
- **Pro / Terminal Mode** — full option chain, Greeks heatmaps, Smart Money (ICT/SMC) panel,
  FII/DII flow, news sentiment, and more.

It also ships an **AI chat agent** ("Angel") that can answer questions about any index, run scans,
pull news/correlation/gap analysis, and even place simulated trade plans — all through a hybrid
intent-resolution system (see §5).

On top of the UI there are two **automated Telegram alert pipelines**: a morning **daily digest**
of the top scan picks, and **intraday alerts** fired every 15 minutes during market hours.

---

## 2. Tech stack — what we used to build it

| Layer | Technology |
|---|---|
| Framework | **Next.js 16** (App Router, standalone output) |
| Language | **TypeScript** (lenient: `noImplicitAny: false`, `ignoreBuildErrors: true`) |
| UI | **React 19**, **Tailwind CSS v4**, **shadcn/ui** (new-york style), **lucide-react** icons |
| State | **Zustand** (global trading store) + **React Query** (server state) + local `useState` |
| Package manager | **bun** (lockfile = `bun.lock`) |
| Database | **SQLite** via **Prisma** (`db/custom.db`) — `Trade` model = live trade journal |
| Live market data | **ICICI Breeze API** (primary) → **NSE India** scraper (fallback) → **Yahoo Finance** (stock/candle prices) |
| AI / LLM | **Groq** (`llama-3.3-70b`, `llama-3.1-8b-instant`) + **OpenRouter** + optional **Ollama**, routed through a single `callLLM` helper |
| Scheduling | **pm2** running `scripts/dailyScanCron.ts` (via `node-cron` + `tsx`) |
| Analysis engines | `sdm-engine.ts` (14-factor SDM), `orca-engine.ts` (15-module ORCA), `ml-engine.ts` (RSI/Bollinger/VWAP/EMA/ADX), `intraday-scanner.ts` (stock scanner), `signal-engine.ts` (market structure / smart money / 0DTE) |

### Data reality (important)
All market data is **real** when API tokens / network are available. There is **no simulation
fallback**: if a data source is unavailable the APIs return `503` instead of fabricating numbers.
The scanner still uses *neutral technical defaults* (RSI 50, ADX 20, etc.) only for the rare stock
whose candle history Yahoo does not return — that is a data gap, never a fabricated quote.

---

## 3. Architecture at a glance

```
Browser (React)  ──React Query──▶  /api/option-chain   ──▶ Breeze API → NSE API → 503
                                     /api/scanner        ──▶ Yahoo Finance (quote + 3mo candles)
                                     /api/sdm-signal     ──▶ signal-engine (ORCA/SDM/0DTE)
                                     /api/sdm-chat       ──▶ LLM (Groq/OpenRouter)
                                     /api/intraday-scan  ──▶ Telegram (secret-gated cron)
                                     /api/daily-digest   ──▶ Telegram morning digest

Zustand store  ◀── option chain / spot / selection
SQLite (Prisma) ◀── trade journal written by SDM engine
pm2 cron       ──▶ dailyScanCron.ts ──▶ fetchSnapshot() ──▶ formatDailyDigest() ──▶ sendTelegramMessage()
```

**Key source files**

| File | Role |
|---|---|
| `src/app/page.tsx` | Main UI — both views, wires live `summary` + `recommendation` |
| `src/app/api/option-chain/route.ts` | Core API: orchestrates data sources + SDM analysis. Envelope `{success, source, lastUpdate, data, analysis}` |
| `src/lib/icici-breeze/` | ICICI Breeze auth, option chain, orders, positions |
| `src/lib/nse-api.ts` | NSE India scraper (fallback) |
| `src/lib/sdm-engine.ts` | SDM 14-factor scoring engine |
| `src/lib/sdm-recommendation.ts` | V2 recommendation orchestrator |
| `src/lib/orca-engine.ts` | ORCA institutional AI engine (15 modules) |
| `src/lib/signal-engine.ts` | Market structure / smart money / flow / 0DTE analytics |
| `src/lib/intraday-scanner.ts` | Stock scanner — **live Yahoo quote + 3mo daily candles → real RSI/EMA/MACD/ADX/ATR** |
| `src/lib/ml-engine.ts` | Classical TA indicators (`Candle`, `calculateRSI`/`calculateEMA`/`calculateADX`) |
| `src/lib/sdmChat.ts` / `llmResolve.ts` / `historyStore.ts` | Hybrid chat intent resolution |
| `src/lib/sendDailyDigest.ts` / `sendIntradayAlerts.ts` / `dailyScan.ts` / `dailyDigest.ts` / `telegramSend.ts` / `stockUniverse.ts` | Daily digest + intraday alert pipeline |
| `src/components/dashboard/SimpleMode.tsx` / `ScannerPanel.tsx` / `AgentChat.tsx` | Main UI panels |

---

## 4. Quick start

```bash
bun install
bun run db:push     # create SQLite schema (db/custom.db)
bun run dev         # dev server on :3000  (logs to dev.log)
```

Production build:

```bash
bun run build       # standalone bundle in .next/standalone/
bun run start
```

**Environment** — `.env` (gitignored) is required for live Breeze data:

```
DATABASE_URL=file:/path/to/db/custom.db
BREEZE_API_KEY=...
BREEZE_SECRET_KEY=...
OPENROUTER_API_KEY=...   # for chat LLM fallback
GROQ_API_KEY=...         # for chat LLM fallback
TELEGRAM_BOT_TOKEN=...
TELEGRAM_DIGEST_CHAT_IDS=7862815314
DAILY_SCAN_SECRET=sdm-cron-9f3a2b
```

> ⚠️ The `.env` file was once committed to git history. It has been **purged** (see §6) but the
> keys it contained should be considered compromised — **rotate them** in ICICI / Groq / OpenRouter /
> Telegram.

---

## 5. How we built it — step by step (development log)

This section records the actual work done so the design decisions are easy to recall.

### Step 1 — Hybrid chat intent resolution
- Goal: make the chat agent ("Angel") answer *every* user intent, including vague follow-ups
  ("same for sensex", "tell me a joke", Hindi questions).
- Built `src/lib/sdmChat.ts` with `resolveIntent()` that tries, in order:
  1. **Regex/keyword** matching (index names, "trade", "news", "correlation", "gap", "help"…);
  2. **LLM fallback** (`src/lib/llmResolve.ts`) when regex is unsure — routes through the existing
     `callLLM` (Groq → OpenRouter → Ollama) because no Anthropic key is present;
  3. **Last-turn heuristic** — inherits the previously discussed symbol for follow-ups, but an
     explicit `"unknown"` from the LLM always wins (no stale-trade inheritance).
- Added `src/lib/historyStore.ts` (per-chat history Map) so the LLM has conversation context.
- Added an **equity guard**: if a non-index symbol is mentioned and no equity lookup exists, the
  agent returns a graceful "Live option data for X isn't wired yet" (EN/HI) instead of a misleading
  Nifty trade.
- Fixed the Devanagari detection regex to `/[ऀ-ॿ]/` so Hindi prompts are correctly lang-tagged.

### Step 2 — Daily digest + intraday alert system
- Goal: push the best scan picks to Telegram automatically (morning digest + intraday alerts).
- Created the pipeline modules:
  - `stockUniverse.ts` — `ALL_SYMBOLS` (the 5 indices).
  - `dailyScan.ts` — `runDailyScan()` returns `SymbolSnapshot[]` + top `ScanPick[]`.
  - `dailyDigest.ts` — `formatDailyDigest()` (markdown for Telegram).
  - `telegramSend.ts` — `sendTelegramMessage()` (multipart, chunked).
  - `intradayState.ts` (fixed `buildSignature` to read `alert.side`) + `marketHours.ts`.
  - `sendDailyDigest.ts` — `fetchSnapshot()` pulls live data from `/api/option-chain` + `/api/news`
    (reads `pcr` from top level, `vix` from `greeks.vix`), builds the digest.
  - `sendIntradayAlerts.ts` — imports `fetchSnapshot`, fires alerts every 15 min during market hours.
- Added `src/app/api/intraday-scan/route.ts`, **secret-gated** by `DAILY_SCAN_SECRET`.
- Added `scripts/dailyScanCron.ts` (with a `.env` loader) and run it under **pm2** (`smd-daily-cron`):
  digest at 09:20 IST Mon–Fri, intraday every 15 min 09:00–15:30 IST (market-hours gated).
- Verified: 4 live picks (e.g. NIFTY 24250 CE 74%), route returns 401 without secret / 200 with it,
  pm2 process online.

### Step 3 — Fix the Simple tab (live data was showing zeros)
- Symptom: Simple Mode showed `PCR 0`, `VIX 0`, `CE OI 0`, `PE OI 0`, `ATM 0`, "Awaiting SDM analysis".
- Root cause: `page.tsx` built `summary` from the wrong path. The option-chain API wraps stats in
  `analysis` (`pcr`, `atmStrike`, `maxPain`, `totalCallOI`, `totalPutOI`, `greeks.vix`); the inner
  `data.summary` only carries `spotPrice`. Also the `<SimpleMode>` component was never passed
  `summary`/`expiries`/`dataSource`, and `recommendation` was declared but never set.
- Fixes in `src/app/page.tsx`:
  - Derived `summary` from `data.analysis` (PCR / VIX / OI / max pain / ATM).
  - Moved the `summary` + `recommendation` memo hooks **after** the `data` useQuery (they referenced
    `data` before declaration → `ReferenceError: Cannot access 'data' before initialization`).
  - Mapped `recommendation` from `analysis.recommendation` onto the `SDMRecommendation` shape
    (direction / strike / entry / SL / TP / confidence / riskReward / grade / marketContext).
  - Passed `summary`, `expiries`, `dataSource`, `selectedExpiry`, `onExpiryChange` to `<SimpleMode>`.
- Result: Simple Mode now shows real PCR 1.27, VIX 15, max pain 24150, ATM 24200, and a live
  CALL 24200 recommendation (entry 104 / SL 88 / TP1 120 / conf 54).

### Step 4 — Scanner: make it 100% live with real technicals
- Symptom: the Scanner tab crashed (`Cannot read properties of undefined (reading 'candidates')`)
  and, once fixed, still faked data (`dataQuality: SIMULATED`, some prices hardcoded to `500`).
- Server fixes (`intraday-scanner.ts` + `route.ts`):
  - `runIntradayScan` was calling the `async` `generateCandidates` **without `await`** →
    `candidates.filter is not a function`. Made it `async` and awaited it; awaited it in the route.
  - Removed a dead `yahooQuotes` reference that threw once the await was fixed.
  - **No fabricated prices**: `generateCandidates` now skips any stock with no real Yahoo quote
    (removed the `: 500` fallback) and reports `liveCount`/`total`.
- Real OHLC candles:
  - Added `fetchYahooData()` — a **single** Yahoo chart call per symbol
    (`range=3mo&interval=1d`) that returns BOTH the live quote (`meta`) **and** 3 months of daily
    OHLC candles (`indicators.quote`). Fetched in bounded-concurrency batches (6 at a time) → ~10 s
    for all 50 NIFTY50 stocks (down from 29 s sequential).
  - Computed **genuine** `RSI(14)`, `EMA(9/21/50)`, `MACD(12,26,9)`, `ADX(14)`, `ATR(14)` from the
    candles, reusing `Candle` / `calculateRSI` / `calculateEMA` / `calculateADX` from `ml-engine.ts`
    plus a new `calcATR()` helper. Neutral defaults only when a symbol's candle history is truly
    unavailable (0 such cases in practice).
  - `dataQuality` is now honestly `LIVE` / `PARTIAL` based on quote coverage; the route returns
    **503** if zero real quotes come back (no silent simulation).
- Client fix (`ScannerPanel.tsx`): moved the `if (!result)` null guard **before** accessing
  `result.candidates`, made `filteredCandidates` / `candidates.length` null-safe, and defaulted
  `useLive = true`.
- Result: `/api/scanner?symbol=NIFTY&live=true` → 200, 30 candidates, `dataQuality: LIVE`,
  **0 fake prices, 0 neutral TA**.

### Step 5 — Secrets hygiene / git history purge (this repo)
- Problem: `db/custom.db` (real trades) and `.env` (API keys) were present in git history.
- Added `.breeze-session.json`, `*.db`, `db/`, `*.sqlite` to `.gitignore`.
- Used `git filter-repo --invert-paths` to **remove `db/custom.db` and `.env*` from every commit**,
  rewrote all 38 commits, and force-pushed. The working files remain (gitignored); only history is clean.
- ⚠️ Because `.env` lived in history, **rotate all API keys** (Breeze, Groq, OpenRouter, Telegram).

---

## 6. Security notes

- `.env`, `db/custom.db`, `.breeze-session.json`, `node_modules`, `.next` are gitignored.
- Secrets were purged from git history with `git filter-repo`; **rotate the exposed keys anyway**.
- `db/custom.db` is regenerated with `bun run db:push` — do not commit it.
- The `/api/intraday-scan` cron endpoint is protected by `DAILY_SCAN_SECRET`.

---

## 7. Known limitations

- The `ml-engine.ts` is classical TA (RSI/Bollinger/VWAP/EMA/ADX), **not** machine learning — the
  name is historical.
- Per-stock **options flow** (PCR/OI per stock) and per-stock **candle history** beyond 3 months
  would need Breeze per-symbol option data; currently stock TA uses Yahoo daily candles.
- All indices expire on **Thursday** (SEBI rule), fixed in `master-bot-engine.ts` / `icici-breeze/option-chain.ts`.

---

## 8. Useful commands

| Command | Purpose |
|---|---|
| `bun run dev` | Dev server on :3000 (logs to `dev.log`) |
| `bun run build` | Standalone build (`.next/standalone/`) |
| `bun run db:push` | Sync Prisma schema to SQLite |
| `bun run lint` | ESLint (lenient) |
| `pm2 start "bun x tsx scripts/dailyScanCron.ts" --name smd-daily-cron` | Run the alert scheduler |
| `curl "http://localhost:3000/api/intraday-scan?secret=$DAILY_SCAN_SECRET"` | Trigger an intraday scan manually |

---

_Built with Next.js 16, bun, ICICI Breeze, NSE, Yahoo Finance, Groq/OpenRouter, Prisma, React Query,
Zustand, Tailwind v4 and shadcn/ui._
