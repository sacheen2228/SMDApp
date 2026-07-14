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

Telegram Bot  ──poll──▶  /api/telegram/poll  ──▶ processMessage() → commands
   @Sacheen_SD_Bot                                   ├── /signal, /price, /status → SMDApp APIs

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

## 9. Telegram Bot

The Telegram bot (`@Sacheen_SD_Bot`) provides command-based access to SDM Trading analysis. Messages are received via **polling** (no webhook) and processed by the admin panel's "Check Messages" button.

### Available Commands

| Command | Description | Source |
|---|---|---|
| **📈 SDM Trading** | | |
| `/signal NIFTY` | Latest SDM trade signal for an index | `/api/option-chain` |
| `/price NIFTY` | Current spot price | `/api/option-chain` |
| `/status` | System health & trade stats | `/api/admin/system` + `/api/trade-journal` |

**Supported symbols**: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX

### How to use

1. Open Telegram and message **@Sacheen_SD_Bot**
2. Type a command (e.g., `/help` to see all options)
3. Go to the **Admin** tab → **Telegram Bot** → click **Check Messages** to process
4. The bot replies with the requested data

---

## 10b. BTST AI Dashboard (Buy Today Sell Tomorrow)

A dedicated next-day swing scanner + AI dashboard, **independent of the intraday engine**. It scans
the NIFTY 50 universe once daily between **3:10–3:20 PM IST** and grades stocks A+/A/B.

### 6-Factor BTST Score (out of 100)

| Factor | Weight | Inputs |
|---|---|---|
| Trend | 25 | RSI zone, EMA9>21>50 stack, MACD histogram, ADX |
| Smart Money | 20 | Delivery %, relative strength vs NIFTY, OI buildup (F&O) |
| OI | 20 | PCR, OI change, IV (F&O stocks only) |
| Volume | 15 | Relative volume (RVOL) |
| Sector | 10 | Sector strength |
| Breadth | 10 | Sector advance-decline ratio |

**Grade**: `A+` ≥85 · `A` ≥75 · `B` ≥65 · `C` ≥55 · `SKIP` <55
**Confidence** = `score × 0.92 + volume bonus`. **R:R** target ≈ 2.6 (ATR-based SL, 3 staged TPs).

### Features
- **Live Dashboard** (`BTST` tab): AI score breakdown, trend/sector/RS/volume/delivery/OI/PCR/
  smart-money/gap-risk, ATR-based SL + TP1/TP2/TP3, dynamic position sizing.
- **Risk Engine**: ATR stop-loss, 3 profit targets, expected overnight gap probability.
- **Backtesting**: independent localStorage trade log + metrics (win rate, avg overnight return,
  profit factor, expectancy, max drawdown) — separate from intraday trades.
- **Alerts**: end-of-day Telegram alerts for high-confidence setups (score ≥ 85, gap risk ≠ High).
- **Independent Operation**: own scanner, API (`/api/btst`), trade log, analytics — does not touch
  the intraday breakout strategy.

### API
- `GET /api/btst` — returns cached scan (5-min TTL) or runs a fresh one.
- `POST /api/btst?alert=1` — runs scan + sends Telegram alerts for score ≥ 85.

### Cron
`scripts/dailyScanCron.ts` fires the BTST scan at **15:15 IST, Mon–Fri** (window 3:10–3:20).
At **15:25 IST** it squares off the prior day's BTST signals into the backtest audit engine.

---

## 10c. Trade Audit / Backtest Verification Engine

A standalone sidecar (`trade-audit/`, **port 4001**) that records strategy signals, tracks them
live (MFE/MAE, TP/SL detection), and computes **backtest verification** metrics: win rate,
avg R-multiple, profit factor, expectancy, max drawdown — broken down by strategy, symbol, and
market session. It's the honest ledger that tells you whether a strategy actually worked.

### Architecture
```
SMDApp strategies ──POST /api/signals──▶ trade-audit:4001 (Express + better-sqlite3)
BTST scan (runBTSTScan)  records candidates as signals (idempotent by date)
dailyScanCron 15:25 IST  squares off prior-day BTST using next-day close
Browser ──GET /api/stats, /api/trades──▶ Backtest tab dashboard
```

### Startup
```bash
cd trade-audit && ./start.sh     # Node + ts-node-dev engine on :4001
./stop.sh                        # stops it
```
> Runs under **Node** (not bun) — it uses the native `better-sqlite3` module, which bun cannot load.

### Backtest tab
The **Backtest** tab polls `:4001` every 5s and shows aggregate stats (win rate, avg R, profit
factor, net P&L, max drawdown), breakdowns by strategy/symbol/session, a filterable trade ledger,
and CSV/JSON export. If the engine isn't running it shows a "start the engine" hint.

### API
- `POST /api/signals` — record a signal (returns `tradeId`, 202; written async via durable queue)
- `POST /api/signals/:id/price` — live price tick (MFE/MAE, TP/SL detection)
- `POST /api/signals/:id/close` — explicitly close (manual / time / btst_square_off)
- `GET /api/trades` — paginated, filterable trade search
- `GET /api/stats` — aggregate verification stats (win rate, R, profit factor, drawdown, breakdowns)
- `GET /api/export/:format` — CSV or JSON export (filtered)

### Strategy recording
- **BTST** (`src/lib/btst-scanner.ts`): every daily scan records its A+/A/B candidates as `BTST`
  signals; the cron closes them next-day (`btst_square_off`) using the realized close, so real
  backtest stats accumulate automatically.
- **Zero Hero** + **Smart Money** (Terminal tab, `src/components/terminal/ZeroHeroTerminal.tsx`):
  when you open the **Zero Hero** or **Smart Money** tab, the displayed option candidates are
  recorded as `ZERO_HERO_AI` / `SMC` signals (direction-corrected CE/PE levels) on every scan,
  with the live premium fed as a tracking tick so the engine computes MFE/MAE and auto-closes on
  SL/TP. Idempotent per day+strike+type, so re-scans don't duplicate.
- Any strategy can record by calling `recordSignal()` / `recordOptionSignals()` from
  `src/lib/trade-audit-client.ts` / `src/lib/audit-recorders.ts`.

---

## 11. Key source files

| File | Role |
|---|---|
| `src/app/page.tsx` | Main UI — all views/tabs |
| `src/app/api/option-chain/route.ts` | Core API: orchestrates data sources + SDM analysis |
| `src/app/api/telegram/webhook/route.ts` | Telegram webhook handler (commands → bot, NL → SDM chat) |
| `src/lib/telegram-bot.ts` | Telegram command processor (SDM Trading commands) |
| `src/lib/icici-breeze/` | ICICI Breeze API: auth, option chain, orders, positions |
| `src/lib/sdm-engine.ts` | SDM 14-factor scoring engine |
| `src/lib/orca-engine.ts` | ORCA institutional AI engine (15 modules) |
| `src/lib/sdmChat.ts` / `llmResolve.ts` | Hybrid chat intent resolution |
| `src/lib/intraday-scanner.ts` | Stock scanner — live Yahoo quote + real TA |
| `src/lib/btst-engine.ts` | BTST 6-factor scoring engine + risk engine |
| `src/lib/btst-scanner.ts` | BTST scanner (reuses intraday scanner real data) |
| `src/app/api/btst/route.ts` | BTST scan API + Telegram alerts |
| `src/components/btst/BTSTDashboard.tsx` | BTST AI dashboard tab (scanner + performance) |

---

## 12. Environment Variables

All configuration is supplied through environment variables. **Never commit `.env`** — it holds
secrets and is git-ignored. The repo ships a safe, placeholder-only template at `.env.example`.

### 12.1 Setup

```bash
# 1. Copy the template
cp .env.example .env

# 2. Fill in real values in .env (every REPLACE_WITH_* / placeholder)
#    At minimum you need:
#      DATABASE_URL, BREEZE_APP_KEY, BREEZE_SECRET_KEY, BREEZE_USERNAME,
#      TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GROQ_API_KEY (or OPENROUTER_API_KEY),
#      AUTH_SECRET (if you enable Auth.js login)

# 3. Generate the Auth.js secret (only needed when using next-auth login)
openssl rand -base64 32
```

### 12.2 Configuring Google OAuth (Auth.js / next-auth v5)

1. Go to **https://console.cloud.google.com/apis/credentials**.
2. Create an **OAuth 2.0 Client ID** of type *Web application*.
3. Add an **Authorized redirect URI**:
   - Local:  `http://localhost:3000/api/auth/callback/google`
   - Prod:   `https://<your-domain>/api/auth/callback/google`
4. Copy the **Client ID** → `AUTH_GOOGLE_ID` and **Client Secret** → `AUTH_GOOGLE_SECRET` in `.env`.
5. Set `AUTH_SECRET` (see 12.1) and `AUTH_URL` to your app base URL.
6. Restart the server. The callback route is provided by next-auth v5 automatically.

> Google OAuth is optional. The app runs fully without it; it is only used if you wire up
> `next-auth` login in your code.

### 12.3 Variable reference

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | SQLite path for Prisma (e.g. `file:./db/custom.db`). |
| `DB_PATH` | Optional raw DB path used by helpers. |
| `AUTH_SECRET` | Auth.js session-encryption secret (`openssl rand -base64 32`). |
| `AUTH_GOOGLE_ID` | Google OAuth client ID. |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret. |
| `AUTH_URL` | Base URL of the app (local or production). |
| `BREEZE_APP_KEY` | ICICI Breeze app key (server-side). |
| `BREEZE_SECRET_KEY` | ICICI Breeze secret key (server-side). |
| `BREEZE_SESSION_TOKEN` | Optional pre-generated session token. |
| `BREEZE_USERNAME` | Breeze account username. |
| `BREEZE_PASSWORD` | Breeze account password. |
| `NEXT_PUBLIC_BREEZE_API_KEY` | Breeze app key exposed to the browser. |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for alerts. |
| `TELEGRAM_CHAT_ID` | Primary Telegram chat ID for alerts. |
| `TELEGRAM_DAILY_CHAT_ID` | Chat ID for the daily digest. |
| `TELEGRAM_DIGEST_CHAT_IDS` | Comma-separated digest recipient chat IDs. |
| `TELEGRAM_ALLOW_OFFHOURS` | `true`/`false` — allow alerts outside market hours. |
| `GROQ_API_KEY` | Groq LLM API key (agent chat). |
| `OPENROUTER_API_KEY` | OpenRouter LLM API key (agent chat). |
| `DEEPSEEK_API_KEY` | Optional DeepSeek key (unused by default). |
| `NVIDIA_API_KEY` | Optional NVIDIA key (unused by default). |
| `API_SECRET_KEY` / `API_SECRET` | Internal API shared secrets. |
| `DAILY_SCAN_SECRET` | Secret authenticating the daily-scan cron. |
| `NEXT_PUBLIC_TRADE_AUDIT_URL` | Trade Audit sidecar URL (default `:4001`). |
| `NEXT_PUBLIC_MARKET_HISTORY_URL` | Market History sidecar URL (default `:4002`). |
| `NEXT_PUBLIC_MARKET_RECORDER_URL` | Market Recorder URL. |
| `NEXT_PUBLIC_BASE_URL` | Public base URL of this Next.js app. |
| `INTERNAL_API_BASE` / `SMDAPP_API_BASE` | Server-side API base URLs. |
| `NUXT_PUBLIC_API_BASE` | Legacy Nuxt client base (unused). |
| `MARKET_HISTORY_DB` | SQLite path for the Market History sidecar. |
| `MARKET_HISTORY_PORT` | Market History sidecar port (default `4002`). |
| `PORT` | Main app / server port (default `3000`). |
| `BACKTEST_DATA_SOURCE` | Backtest source: `breeze` \| `simulated`. |
| `RECORDER_MODE` | Recorder tick mode: `realtime` \| `batch`. |
| `RECORDER_SYMBOLS` | Comma-separated symbols the recorder tracks. |
| `DEFAULT_FEES_PER_TRADE` | Default brokerage fee per trade (P&L calc). |
| `NODE_ENV` | `development` \| `production`. | |
