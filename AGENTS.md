# SMDApp

Real-time option chain viewer for Indian markets (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX) with ICICI Breeze API integration and SDM analysis engine.

## Quick start

```bash
bun install
bun run db:push    # sync SQLite schema
bun run dev        # starts on :3000
```


**Holiday calendar consolidated** — Single source of truth `NSE_HOLIDAYS` in `src/lib/expiry-calculator.ts` (was 5 duplicated copies with `2026-11-11` for Diwali‑Balipratipada, real: `2026-11-10`; no `2026-11-24`). All modules import from this canonical set instead of maintaining private copies.
## Package manager

**bun** — not npm or yarn. Lockfile is `bun.lock`.

## Commands

| Command | Purpose |
|---|---|
| `bun run dev` | Dev server on port 3000, logs to `dev.log` |
| `bun run build` | Standalone build (output in `.next/standalone/`) |
| `bun run start` | Production server from standalone build |
| `bun run lint` | ESLint (very lenient — see below) |
| `bun run db:push` | Push Prisma schema to SQLite |
| `bun run db:generate` | Regenerate Prisma client |
| `bun run db:migrate` | Create migration |
| `bun run db:reset` | Reset database |

## Architecture

- **Framework**: Next.js 16, App Router, standalone output mode
- **Database**: SQLite via Prisma (`db/custom.db`), schema has Trade model (active), User/Post (unused)
- **UI**: shadcn/ui (new-york style), Tailwind CSS v4, lucide icons
- **State**: React Query for server state, Zustand for global state (`src/stores/useTradingStore.ts`), React useState for local UI state
- **Data flow**: ICICI Breeze → Motilal Oswal MOAPI → NSE → BSE → Moneycontrol (live data: quotes, option chain, candles, greeks, OI-PCR, spot). Exchange archives only for pre/post-market (pre-open, bhavcopy): NSE → BSE → Moneycontrol. **No Yahoo anywhere** — when data is unavailable the answer is `NO_DATA`/503, never a Yahoo quote. **Canonical document: [`SOP.md`](./SOP.md)** (provider hierarchy, live-verified endpoints/headers, freshness rules, circuit breaker, session clocks, pre-market readiness, cron schedule)
- **Analysis**: SDM Options Intelligence Engine (`src/lib/sdm-engine.ts`)
- **Market Intelligence**: Technical analysis engines, sector heatmap, breadth, regime, F&O scanner, expiry liquidity engine
- **Trade Backtest**: Real trade backtest against real historical candles (99/100 trades backtestable)

### Key source files

| File | Role |
|---|---|
| `src/app/page.tsx` | Main UI component — all views/tabs |
| `src/app/api/option-chain/route.ts` | Core API: orchestrates data sources + SDM analysis |
| `src/lib/icici-breeze/` | ICICI Breeze API: auth, option chain, orders, positions |
| `src/lib/nse-api.ts` | NSE India scraper (primary live source for NSE indices/equities) |
| `src/lib/sdm-engine.ts` | SDM 14-factor scoring engine |
| `src/lib/sdm-recommendation.ts` | V2 recommendation orchestrator |
| `src/lib/sdm-scores.ts` | 14-factor quality scoring |
| `src/lib/historical-data.ts` | Multi-source candle fetcher (real data) |
| `src/lib/greeks.ts` | Black-Scholes Greeks calculator (real math, may get fake inputs) |
| `src/lib/ml-engine.ts` | Technical indicator scoring (NOT machine learning — just RSI/Bollinger/VWAP/EMA/ADX) |
| `src/lib/master-bot-engine.ts` | Master Bot trade plans using live market data |
| `src/lib/backtest-engine.ts` | Breakout strategy backtest (real candles — skips days without data) |
| `src/lib/sdm-trade-tracker.ts` | Trade lifecycle: add/update/expire, DB persistence |
| `src/stores/useTradingStore.ts` | Zustand store for trading state |
| `src/app/api/agent/route.ts` | AI Agent API with LLM (Groq/OpenRouter) + 57 tools, SMDContext, memory, logging |
| `src/components/dashboard/AgentChat.tsx` | Agent chat UI with voice mode, 15 quick commands — calls `/api/agent` |
| `src/lib/smd-context.ts` | SMDContext — centralized market context builder for Hermes (aggregates all data sources) |
| `src/lib/agent-memory.ts` | Agent Memory — persistent trade patterns, setup memory, predictions, preferences |
| `src/lib/agent-logger.ts` | Agent Logger — tool call, LLM call, error, conversation observability (JSONL) |
| `src/app/api/agent-memory/route.ts` | Agent Memory REST API — CRUD for trades, setups, predictions, preferences |
| `src/lib/signalTracker.ts` | Full-day signal deduplication — prevents same trade from being re-sent |
| `src/lib/signal-veto.ts` | Hybrid veto overlay — old brain generates, new brain blocks/warns (no network, field-based) |
| `src/lib/morningSignalGenerator.ts` | Morning signal generator — scans NIFTY/SENSEX/Equity/MCX for high-accuracy trades |
| `src/lib/dailyDigest.ts` | End-of-day digest — sends summary of signals, active trades, market data |
| `src/app/api/morning-signals/route.ts` | Morning Signals API — call at 9:20 AM IST for daily trade recommendations |
| `src/app/api/daily-digest/route.ts` | Daily Digest API — call at 3:25 PM IST for end-of-day summary |
| `src/lib/telegram.ts` | Telegram sender — HTML messages, full-day dedup, trade alerts |
| `src/lib/session-health.ts` | **Session Health** — single owner of session-expiry classification, dedup'd `[SYSTEM][SESSION_EXPIRED]` alerts, live source probes, Hermes status report |
| `src/lib/agent-brain.ts` | SDM Agent Brain — system prompt (rules generated from GATE_CONFIG), AGENT_TOOLS (60), selectToolsV2 router, executeTool, agentRespondLLM tool loop (parallel + wall-clock cap + enforceSignalPolicy) |
| `src/lib/agent-brain-gate.ts` | **Discipline gate** (self-contained, no imports) — GATE_CONFIG single source of truth, evaluateTradeGate (TRADE/WAIT/SKIP), positionSize, ledger stats (Wilson/break-even/buckets), guardToolCall (SSRF + side-effect intent), selectToolsV2 (no padding, max 12), enforceSignalPolicy (🎯 only after gate TRADE) |
| `src/lib/option-chain-reader.ts` | Deterministic chain reader for the agent — OI walls (strengthening/weakening), BUYING/WRITING classification, PCR trend, gate layers (`layerForDirection`, `wallBeforeTarget`); `read_option_chain` tool + OPTION_CHAIN_KNOWLEDGE prompt block |
| `src/lib/indicators.ts` | Indicator engine for the agent — SuperTrend, EMA crossover (chop filter), VWAP, market structure (HH/HL/BOS/CHoCH), liquidity pools/sweeps/FVG, gate layer mapping, underlying stop/target suggestions, indicator backtest; `check_indicators` + `backtest_indicator` tools + INDICATOR_KNOWLEDGE prompt block. Also keeps the legacy chart-overlay exports (`Bar`, `sma`, `ema`, `bollinger`, `rsi`, `vwap`) used by `ChartToolbar.tsx` |
| `src/lib/market/candle-chain.ts` | Candle multi-source chain (live capture only): indices Breeze→MO→NSE index-only, stocks Breeze→MO; no timeframe/instrument substitution |
| `src/lib/motilal/candles.ts` | MO EOD candle wrapper (only daily OHLC endpoint MO exposes; no intraday on the platform) |
| `src/lib/telegramSend.ts` | Telegram sender — Markdown messages, used by cron/digest modules |
| `src/lib/option-acceleration-engine.ts` | Option Acceleration Engine (10 sub-engines: delta accel, gamma explosion, OI absorption, volume momentum, institutional flow, premium elasticity, historical memory, time decay, regime + premium velocity + TP1/TP2/TP3) |
| `src/app/api/greek-flow/route.ts` | Greek Flow API endpoint → runs acceleration engine |
| `src/components/terminal/GreekFlowHeatmap.tsx` | Option Acceleration UI (12 dashboard cards, premium race table, top 5 calls/puts, full heatmap) |
| `src/components/terminal/EnhancedOptionChain.tsx` | Enhanced Option Chain (Greeks, IV skew, OI bars, click-to-trade, sorting) |
| `trade-audit/` | Trade Audit / Backtest Verification engine (standalone sidecar, port 4001, Node + better-sqlite3) |
| `live-data-service/` | Standalone NSE Live Option Data Service (pure Python, port 8765) — spot/VIX/chain/PCR/FII feeds with read-time LIVE/STALE/CLOSED status; `live_data.json` + `/snapshot` + `/selector`; used by the option-buying-playbook skill (chain calls NSE `option-chain-v3`, not the retired `option-chain-indices`) |
| `src/components/backtest/BacktestDashboard.tsx` | Backtest tab — polls `:4001` for verification stats + trade ledger |
| `src/lib/trade-audit-client.ts` | Client lib for the audit engine (record/price/close/stats/trades) |
| `src/lib/audit-recorders.ts` | Records Terminal-tab Zero Hero + Smart Money candidates into the audit engine |
| `src/lib/fii-dii.ts` | FII/DII data scraper — NSE India primary + MrChartist 60-day history |
| `src/app/api/fii-dii/route.ts` | FII/DII API endpoint — latest + 30-day history |
| `src/lib/technical-analysis.ts` | Detection engines (breakout, pullback, momentum, breakdown, reversal), OI classification, trade scoring |
| `src/lib/nse-stock-data.ts` | Shared stock data fetcher with 3-tier fallback (Moneycontrol → live batch quotes) |
| `src/lib/fetch-with-fallback.ts` | Reusable fallback utility (`fetchWithFallback`, `fetchWithRetry`) |
| `src/lib/sentiment-analyzer.ts` | Deterministic keyword-based sentiment scoring (80+ keywords) |
| `src/lib/market-session.ts` | Centralized session config (CAS timeline, phases, confidence multipliers) |
| `src/lib/expiry-liquidity/` | Expiry Liquidity Shift Engine — 14 sub-engines (CAS, futures, OI, premium, IV, volume, gamma, auction, breadth, heatmap) |
| `src/lib/trade-backtest-engine.ts` | Real trade backtest — replays every trade against real historical candles |
| `src/stores/useWatchlistStore.ts` | Zustand store for watchlist state |
| `src/app/api/market/heatmap/route.ts` | Multi-market heatmap API (NIFTY50, BANKNIFTY, SENSEX, etc.) |
| `src/app/api/market/breadth/route.ts` | Enhanced breadth API (EMA, VWAP, RelVol) |
| `src/app/api/market/regime/route.ts` | Multi-factor regime engine with stock-based fallback |
| `src/app/api/market/opportunities/route.ts` | Trade opportunities — uses detection engines + intraday scanner |
| `src/app/api/alerts/route.ts` | Alert engine REST API (fire/acknowledge/history) |
| `src/app/api/watchlist/route.ts` | Watchlist CRUD with JSON file persistence |
| `src/app/api/scanner/fno/route.ts` | Dedicated F&O option scanner |
| `src/app/api/backtest/expiry/route.ts` | Deterministic expiry liquidity backtest |
| `src/app/api/backtest/trades/route.ts` | Real trade backtest against historical candles |

## Data Reality Check

| Component | Data Source | Real or Fake? |
|---|---|---|
| Option chain (live) | ICICI Breeze → MOAPI → NSE → BSE → Moneycontrol | **REAL** — exchange-aware; `NO_DATA`/503 when unavailable |
| Candle data (live) | ICICI Breeze → MOAPI → NSE index chart | **REAL** when session active |
| SDM signals | `api/sdm-signal/route.ts` | **REAL** — ICICI Breeze → MOAPI → NSE → BSE → Moneycontrol chain |
| Scanner data | `api/scanner/route.ts` | **REAL** — live stock quotes, Breeze for option chain context |
| Breakout data | `api/breakout/route.ts` + Breeze | **REAL** — Breeze for spot price, real candles when available |
| Backtest candles | `backtest-engine.ts` + Breeze historical | **REAL** — skips days with no Breeze data, no fake candle generation |
| Master Bot prices | Live market data | **REAL** |
| SDM scoring | `sdm-engine.ts` | Real math on whatever data is fed |
| SDM recommendation | `sdm-recommendation.ts` | Real math, but hardcoded VIX=15 fallback, capital=₹100K |
| ML/TA Engine | `ml-engine.ts` | Real TA indicators (RSI/Bollinger/VWAP/EMA/ADX). Classical TA, NOT ML — mislabeled |
| Greeks | `greeks.ts` | Real Black-Scholes math, risk-free rate hardcoded 7% |
| Trade journal | Prisma DB | **REAL** — stores actual trades generated by SDM engine |
| Breeze auth | `icici-breeze/auth.ts` | Auto-retry on auth errors, re-inits session |
| FII/DII flows | `fii-dii.ts` + `/api/fii-dii` | **REAL** — NSE India primary + MrChartist history |
| Gift Nifty | NIFTY 50 spot (`^NSEI`) | **REAL** — NIFTY 50 spot as proxy (SGX ticker dead) |

### What was changed/removed
- `historical-data.ts` — deleted (was 100% fake candle generator, no longer used)
- `option-chain-data.ts` — deleted (was 100% fake option chain generator, no longer used)
- `generateHistoricalChain()` — deleted from sdm-backtest.ts (was Math.random() fake option chains)
- All Math.random() for stock technicals — replaced with deterministic defaults when live data unavailable
- **No simulation fallback exists anywhere** — APIs return 503 errors when real data unavailable
- `auto-bot/` — removed (was a Breakout/Desk Python equity screener sidecar on port 8000; not aligned with the Indian F&O focus and unused by the data flow)

### Expiry day
**The exchange's own contract list is the authority** — a hardcoded weekday rule drifts. Live-verified against NSE `option-chain-contract-info` and the BSE chain on 2026-11-04:

| Symbol | Weekly | Monthly |
|---|---|---|
| NIFTY, NIFTYNXT50 | **Tuesday** | last Tuesday |
| BANKNIFTY, FINNIFTY, MIDCPNIFTY | none (discontinued Sep-2025) | last Tuesday |
| SENSEX | **Thursday** | last Thursday |
| BANKEX | none | last Thursday |
| NSE F&O stocks (RELIANCE, …) | none | last Tuesday |
| BSE F&O stocks | none | last Thursday |

Two facts that break a weekday rule:
1. **Holiday shift** — an expiry on an exchange holiday moves to the PREVIOUS trading day. NSE publishes `23-Nov-2026` (not 24-Nov) and `25-Jan-2027` (not 26-Jan, Republic Day).
2. **The published list is partial** — it carries the nearest weeklies + the monthlies. A date outside it is NOT a tradable contract (`EXPIRY_UNAVAILABLE`).

**Single source of truth: `src/lib/expiry-calculator.ts`** (`getNearestExpiry`, `getAllExpiries`, `setExchangeExpiries`). The option-chain route pushes the exchange list into it (`src/app/api/option-chain/route.ts`); `refreshNSEExpiryList()` in `src/lib/nse-api.ts` refreshes it server-side (never from the calculator — it is imported by client components). `src/lib/expiry-engine.ts` (deprecated) and `master-bot-engine.getExpiryStatus()` delegate to it. **Never format an expiry date with `toISOString()`** — it is UTC, so a local midnight date comes out a day EARLY on an IST server; use local date parts.

## Trade Audit — Backtest Verification Sidecar

Standalone Express + better-sqlite3 service on **port 4001** that records strategy signals,
tracks them live (MFE/MAE, TP/SL detection), and computes backtest verification metrics
(win rate, avg R, profit factor, expectancy, max drawdown) broken down by strategy/symbol/session.
The **Backtest** tab in the app polls `localhost:4001` every 5s.

### Startup
```bash
cd trade-audit && ./start.sh        # starts Node + ts-node-dev engine on port 4001
./stop.sh                           # stops the engine
```
> Runs under **Node** (not bun) — it uses the native `better-sqlite3` module, which bun cannot load.

### Recorded strategies
- `BTST` — from the daily BTST scan (`src/lib/btst-scanner.ts`); cron squares off next-day.
- `ZERO_HERO_AI` / `SMC` — from the Terminal tab's **Zero Hero** / **Smart Money** scanners
  (`src/components/terminal/ZeroHeroTerminal.tsx`); live premium fed as tracking ticks.
- Any strategy can record via `recordSignal()` (`src/lib/trade-audit-client.ts`).

### Hermes Pro Agent Architecture

```
User Input
    │
    ▼
┌─────────────────────┐
│  Intent / Task Router│  ← TOOL_ROUTER selects 8-14 tools per query
└──────────┬──────────┘
           │
    ┌──────┼──────┐
    │      │      │
Market  Trade  System
Research Research Tasks
    │      │      │
    ▼      ▼      ▼
NSE/Breeze OI/Greeks Backtest
MOAPI      Structure  Journal
MCX        CAS       Health
News       Gamma     Telegram
FII/DII    Vol Profile
VIX        S/R, Expiry
    │      │
    ▼      ▼
┌─────────────────────┐
│  HERMES DECISION    │  ← Groq openai/gpt-oss-120b (128K context)
│  ENGINE             │     57 tools total
└──────────┬──────────┘
           │
    ┌──────┴──────┐
    │             │
TRADE        NO TRADE
CANDIDATE    / WAIT
    │
    ▼
Risk Validation → Entry/SL/TP → Telegram Alert
```

### 57 Hermes Tools

**DISCIPLINE LAYER (added 2026-10-19):**
| Tool | Purpose |
|---|---|
| `strike_selector` | Playbook strike calculator — runs `skills/option-buying-playbook/scripts/strike_selector.py` (BS re-pricing at target/stop, option R:R + theta + break-even + risk-budget gates, lot sizing); output stashed into run state so the LLM cannot invent the numbers |
| `evaluate_trade_gate` | Deterministic TRADE/WAIT/SKIP gate (feed freshness, confidence floor, 5-layer agreement, delta/OTM/RR/lot checks, expiry/event, loss streak, ledger bucket veto). 🎯 TRADE SIGNAL is stripped from responses unless the gate passed |
| `read_option_chain` | Deterministic chain read: OI walls + trend, fresh call/put writing, CE/PE buying zones, PCR trend, ATM Greek checks |
| `check_live_feed` | Probes live-data-service /health before any levels are quoted |
| `ledger_edge_report` | Win-rate vs true break-even from the journal, bucketed by regime/window/strike distance |
| `check_indicators` | Computes SuperTrend, EMA crossover (chop-filtered), VWAP, structure (HH/HL, BOS, CHoCH) and liquidity (pools, equal highs/lows, sweeps, FVG) from real candles on a trend + entry TF; with direction also returns structure/trigger gate layers + structural stop/target on the underlying. Stashes `lastTech` into run state (evaluate_trade_gate reuses it) |
| `backtest_indicator` | Edge check for ema_cross / supertrend_flip / sweep_reclaim on real candles — trades, win-rate vs true break-even, expectancy in R, plain verdict |

**NEW TOOLS (added earlier):**
| Tool | Purpose |
|---|---|
| `send_telegram_signal` | Push trade signal to Telegram phone (intent-guarded) |
| `scan_all_instruments` | Scan NIFTY/SENSEX/Equity/MCX all at once |
| `get_mcx_data` | MCX commodity data (CRUDEOIL/GOLD/SILVER/GAS) |
| `morning_scan` | Run morning signal generator → Telegram |
| `get_trade_recommendation` | Full structured trade card with entry/SL/TP |

**ORIGINAL 36 TOOLS:**
Market Data: `get_option_chain`, `get_sdm_signal`, `get_market_structure`, `get_vix`, `get_atm_straddle`, `get_gift_nifty`, `get_historical_data`
OI & Greeks: `get_options_edge`, `get_expiry_liquidity`, `get_cas_analysis`
Flow & Intelligence: `get_fii_dii`, `get_institutional_positioning`, `get_market_regime`, `get_market_breadth`, `get_correlation_signal`
Scanners: `get_scanner_picks`, `get_breakout_signals`, `get_unified_ranking`, `get_index_fo`, `get_stock_fo`, `get_equity_swing`
Risk & Portfolio: `get_risk_status`, `get_portfolio`, `get_challenge_status`, `calculate_position_size`, `get_trade_tracking`
Trade & Journal: `get_trade_history`, `get_trade_post_mortem`, `get_backtest_results`, `get_news_sentiment`
Memory: `search_memory`, `get_memory_summary`, `record_trade_memory`
System: `get_agent_analytics`, `answer_trading_question`
Session Health: `check_session_tokens` (live probes of breeze/mo/nse + recorded episodes), `set_breeze_session` (apply user-supplied Breeze token, re-arms episode)

### Session Health & Candle Fallback Chain
1. **session-health.ts** — SOLE sender of `[SYSTEM][SESSION_EXPIRED]` Telegram alerts (once per source per episode; retries when Telegram's 09:10-15:30 IST window suppresses a send). **Breeze push disabled 2026-10-19** (user directive — flapping SDK errors spammed duplicates; episode state/status/Hermes unchanged, MO still alerts once per episode). `classifySourceError()` → `SESSION_EXPIRED | NO_DATA | SOURCE_UNAVAILABLE`; NSE can NEVER classify as SESSION_EXPIRED (no token auth). Source modules report-then-return-null (contracts unchanged).
2. **Breeze expiry** — hooks in `icici-breeze/auth.ts` (`doInitSession` catch, `generateSession` 401, `withAuthRetry` retry) + `option-chain.ts` catch. Manual remedy: browser OTP at `api.icicidirect.com/apiuser/login?api_key=…` → Hermes `set breeze session <token>`.
3. **MO expiry** — `autoLogin()` is TOTP-first (`MOTILAL_TOTP_KEY`), OTP fallback leaves session UNVERIFIED. Candle chain attempts auto-recovery BEFORE alerting (self-healed blips never page). TOTP key re-registered 2026-09-27 — TOTP auto-login verified live. **Report endpoints work only on `/rest/report/v3/*`** — every `/rest/report/v1/*` path returns MO8001 "Invalid Token" even on a valid session (v1 auth broken; never call it — its auth-shaped error would fake an expiry alert). Candle capability (live-verified): NSE EOD v3 = equity **spot** daily bars (~9s); NSEFO dump = **derivatives only** (80–128s, zero spot rows); **no index spot OHLC anywhere** (IndexDataAPI is a code list only) → index symbols are an MO capability skip; CSV endpoints hang (>45s) — unused.
4. **Candle chain** (live capture only, enforced by import-scan test): first-success-wins, failures recorded to session-health + `recorderState.lastCandle`. MO = daily-only capability skip for intraday (no substitution). NSE chart `chart-databyindex?index=…` is index-only (allowlist: NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY; SENSEX/BANKEX excluded — BSE), current session only, close-only points labeled degraded + interval derived from real point spacing.
5. **Surfaces** — `/api/market-recorder/status` exposes `sessionHealth`/`sessionSummary`/`lastCandleCapture`; Hermes `check_session_tokens` returns live probes + recorded episodes + remedies.
6. **Not fixed by alerts**: `.env` secrets/config changes still require a human (alert states the remedy).

### Signal Deduplication (3 levels)
1. **signalTracker.ts** — Full-day signature dedup (same signal never sent twice per day)
2. **telegram.ts** — 5-minute short-term throttle
3. **intradayState.ts** — Per-day signature tracking for intraday alerts

### Trading brain v2 — measured, not guessed (2026-10-20)

**Data flow**
```
OLD BRAIN (generates)          VETO (fast, local only)              CANDIDATE LOG (Prisma)
SMART_MONEY / scanners  ──▶  signal-veto.ts  ──▶ Telegram alert   candidate_log: every candidate
Zero Hero / BTST / SDM        (O(1): cached tech + cached            sent / blocked / paper,
                              calibration — no network)              tier, warnings, config_hash
AGENT CHAT ──▶ agent-brain ──▶ evaluate_trade_gate (strict) ──▶ same funnel
```
**New files**
| File | Role |
|---|---|
| `src/lib/brain-flags.ts` | **ONE** config file for every behavioural flag (`BRAIN_FLAGS`) |
| `src/lib/signal-veto.ts` | Hybrid veto: PASS / WARN / BLOCK + tier A/B/C/NONE; hard safety never shadowed |
| `src/lib/candidate-log.ts` | Prisma writer/reader for `candidate_log` + `configHash()` + calibration cache |
| `src/lib/candidate-resolver.ts` | Simulates each candidate's outcome from subsequent candles → `simOutcomeR` |
| `src/lib/tech-read.ts` | **Canonical** technical engine (SuperTrend, EMA+chop, VWAP, structure, pools/sweeps/FVG, layers, backtest). `indicators.ts` re-exports it |
| `src/lib/tech-cache.ts` | Background-computed TfRead snapshots (15m trend + 5m trigger), TTL = bar interval |
| `src/lib/layer-builder.ts` | Builds the 5 gate layers from REAL sources (FII/DII, chain OI, VIX/delta/expiry, closed candles) |
| `src/lib/confidence-calibration.ts` | Stated band → realised WR/n/expectancy R, calibrated confidence, drift |
| `scripts/replay-veto.ts` | Source-stratified replay + separation check + 70/30 time split + reliability table |
| `scripts/brain-report.ts` | Daily report: per tier, per source, would-block precision/recall, calibration drift |
| `/api/tech-cache`, `/api/brain-report` | Cache refresh/status + report endpoints |

**Flags** (`src/lib/brain-flags.ts`, default = current behaviour): `shadowVeto` **ON** (quality blocks are logged as `would_block`, hard gates still suppress) · `candidateLog` **ON** · `strictGate` **off** (agent path uses strict gate; `hybrid:true` is the explicit fallback) · `tiering` **off** (A/B/C tiers computed always; tier C becomes paper-only when ON) · `resolverCosts` **off** · `promotion {minResolvedTrades:175, minExpectancyCiLowerR:0}`.

**Migrations** (additive, no data loss, no reset): `prisma/manual-migrations/20261019_add_candidate_log.sql` (candidate_log + `Trade.underlyingSpot`) · `prisma/manual-migrations/20261020_calibrated_confidence.sql` · `trade-audit/migrations/20261019_underlying_spot.sql` (`underlying_spot` column; the premium in `spot_price` is NEVER copied). Apply with `bunx prisma db execute --file …` + `prisma generate` (the app DB was created with `db push`, so `migrate dev` would demand a destructive reset).

### Option plan — rupee risk + R:R 1:2/1:3/1:4 (2026-10-20)

**The bug this fixed**: `sdm-engine.ts` (the option-chain-api path), `intraday-scanner.ts`
(stock-scanner) and `morning-scan.ts` each hardcoded their own % of premium for the
stop and the targets — `stop = entry×0.85`, `tp1 = entry×1.15` → **TP1 sat exactly 1R
away (R:R 1:1)**, which needs >50% win-rate before costs. The ledger shows those
engines at 21–24% WR (PF 0.81–1.05), while the one engine with a 1:3.2 plan
(SMART_MONEY) ran 64% WR / PF 4.70 / +₹351k.

**The rule (user-defined)**: "if I spend ₹10,000 I take ₹2,000 of risk and make ₹3,000"
→ risk is a RUPEE amount (a % of the amount deployed) and the targets are clean R
multiples of it.

`src/lib/option-plan.ts` → `buildOptionPlan()` — the single plan builder:
- `riskAmount = deployedAmount × 0.20` (₹10k deployed ⇒ ₹2,000 at risk)
- `riskPoints = riskAmount / units` → the stop distance in premium points
- `stopLoss = entry ∓ riskPoints`; `targets = entry ± {2R, 3R, 4R}` (R:R 1:2 / 1:3 / 1:4)
- guardrails: stop capped at 35% of the premium (the rupee risk shrinks, never grows),
  floored at 8 ticks (noise floor for cheap options), unreachable targets dropped and
  reported, and a plan below the gate's 1.5 R:R is flagged
- sizing (`lotsForBudget`) uses the live ₹20k-per-trade deployment rule — the user
  replaces lots/amount there; every engine then inherits the same ladder.

**P0 fix — "0 lots" is representable (2026-10-20)**: the sizing used to be
`Math.max(1, …)`, so a contract that did not fit the ₹20,000 per-trade cap was
traded as ONE lot anyway (RELIANCE CE ₹90 × lot 500 → ₹45,000 = 2.25× the cap;
SBIN CE ₹300 × lot 750 → ₹2,25,000 = 11× the cap), and the master bot's
`if (lots < 1) return null` was dead code. NOW:
- `lotsForBudget()` returns the **honest floor** (0 when one lot does not fit) and
  `sizeOptionTrade()` reports the verdict (`lots / units / ₹ deployed / ₹ at risk /
  tradable / reason`). The "at least 1 lot" rule is a **RECORDING convention**
  (`PLAN_CONFIG.recordingMinimumLots`) — it lives with the audit recorder, never
  with the sizing.
- `buildOptionPlan()` returns a plan with `lots: 0`, `deployed: 0`, `riskAmount: 0`,
  `tradable: false` and a note ("0 lots — 1 lot costs ₹X — over the ₹20,000
  per-trade budget"). A plan NEVER reports a deployment above the cap
  (`PLAN_CONFIG.maxDeployedAmount`). The per-unit levels stay meaningful; the ₹
  amounts are 0 because nothing is committed.
- every caller bails on 0 lots (no trade, no alert, no tracker row):
  `master-bot-engine.ts` (returns null → the plan is skipped, the reason is in
  `generateTradePlan().skipped`), `morning-scan.ts`, `morningSignalGenerator.ts`
  (the signal is dropped → never registered), `intraday-scanner.ts` (no monthly
  option trade → no alert).
- `signal-veto.ts` gained the **DEPLOYMENT/LOT hard gate**: an option candidate
  whose `entry × lot size × lots` exceeds `GATE_CONFIG.tradeBudget`, or whose lot
  count is 0, or whose stated `deployedAmount` is over the cap, is BLOCKED
  (fail closed). The lot size comes from the caller or from the LOCAL symbol
  master (`getLotSizeStrict`) — no network, so it is safe in the hot path. Equity
  (cash) candidates are not sized this way.
- tests: `tests/zero-lots-sizing.test.ts` (offline: the sizing floor, the cap
  invariant, the veto gate and every caller's bail).

**Measured counterfactual** on the 156 recorded option trades (using the recorded
highest/lowest, stop wins ties):

| Plan | TP hit | stopped | flat | avg R | break-even WR | expectancy |
|---|---|---|---|---|---|---|
| old (15% stop, TP1 = 1R) | 23.7% | 26.3% | 50.0% | −0.026R | 50% | negative |
| **new (20% stop, TP1 = 2R)** | 12.8% | 7.1% | 80.1% | **+0.186R** | 33% | **positive** |

Per source under the new plan: option-chain-api +0.419R (was +0.003R), SMART_MONEY
+0.267R, stock-scanner −0.214R (cheap-premium noise problem remains).

**Session rule**: no NEW option premium buys after 13:00 IST
(`BRAIN_FLAGS.noOptionBuysAfter13`, default ON) — the ledger shows option entries
13:00–14:59 went **0 wins / 34 trades** (option-chain-api 13h 0/12, 14h 0/22) while the
same engine at 10:00 was 63%. The veto judges this at the SIGNAL time (`nowMs`), so
replays and tests can pin the clock.

**Also fixed while measuring**: `loadBhavcopyForTrade()` returned the whole F&O file
(37k rows, every symbol) when one row matched — it now returns symbol-scoped rows;
and `agent-brain.ts` hardcoded lot sizes (NIFTY 75) that contradicted the NSE
bhavcopy and `symbol-config.ts` (NIFTY 65) — it now imports `SYMBOL_CONFIGS`.

### Hybrid Brain — old brain generates, new brain vetoes (2026-10-19)
The old brain (SMART_MONEY / scanners / Zero Hero / BTST) remains the **signal generator**; the new deterministic brain is a **veto overlay only** — it never creates signals, so it cannot reproduce the "zero TRADE verdicts" failure mode (gate needed 3-of-5 layers with flow + greeksVix always unknown).

`src/lib/signal-veto.ts` → `evaluateSignalVeto()` — wired into `sendTradeAlert` (telegram.ts), the central alert funnel (agent-brain, scanners, jarvis-adapters, api/telegram all flow through it).

| Verdict | Trigger | Effect |
|---|---|---|
| **BLOCK** | Stop not on the correct side of entry, or R:R < 1.5 (option + equity), or expiry-day index option | Alert not sent, console-logged `[Telegram] VETO BLOCK` |
| **WARN** | Confidence < 65, > 3 steps OTM, \|delta\| < 0.35 (lottery ticket, only when spot+expiry known) | Alert sent with `⚠ … — halve size` |
| **PASS** | Everything else | Alert sent as normal |

**Merge point 2 — the gate itself** (`evaluate_trade_gate` with `hybrid: true`, set in agent-brain.ts): the gate stops being a generator and becomes a veto. Soft checks (confidence below floor, layer agreement short of 3-of-5, unknown underlying R:R) are converted to **warnings**; only hard safety fails (option R:R, expiry day, delta, strike distance, risk budget, loss streak, daily-loss cap, ledger bucket) still produce SKIP. Without this, the agent path produced **zero** TRADE verdicts (flow + greeksVix layers are always `unknown`, so 3-of-5 agreement was unreachable). Strict mode (`hybrid` unset) is unchanged and still used by the Grade-1 replay.

**Measured on the real ledger (530 closed trades, replayed through the veto):**

| Veto verdict | n | Win rate | Net P&L | PF |
|---|---|---|---|---|
| PASS | 131 | 42.7% | +₹90,176 | 3.14 |
| WARN (half size) | 289 | **55.4%** | +₹249,814 | **3.37** |
| BLOCK | 110 | **23.6%** | **−₹11,674** | **0.94** |

The blocks land on the losing tail (`stock-scanner` / `option-chain-api` rows with R:R 1.00 and confidence 0). BTST (370 trades, median R:R 2.57) is unaffected.

Config comes from `GATE_CONFIG` in `agent-brain-gate.ts` (single source of truth). No network calls — the veto is field-based and fast, safe in the hot path.

**Audit hygiene**: `strategyId: "test"` is rejected by the trade-audit API (`newSignalSchema`) — external scripts were polluting the closed ledger with fake `monerr-*` rows (8 deleted 2026-10-19). Note: the ledger's `spotPrice` column stores the **option premium**, not the underlying — never use it as spot.

## NSE Options Signal — the A-E orchestrator + the GEX engine (2026-10-20)

Lives in the skill tree: `skills/nse-options-signal/` (Python, stdlib only).

| Piece | Where | Role |
|---|---|---|
| Orchestrator (the parent) | `scripts/orchestrator.py` | runs the panel, the consensus, the GEX isolation, the output |
| Agent A (context) | `scripts/agents/agent_a.py` | reads `data/context.json` — CONTEXT, never a vote |
| Agent B (levels) | `scripts/agents/agent_b.py` | chain/OI/PCR/level validation (two-source ±0.15%, wall ≥1.5×, not closed beyond, level stability) |
| Agent C (structure) | `scripts/agents/agent_c.py` | BOS/CHoCH/sweeps + the skill's existing `scripts/breakout.py` |
| Agent D (GEX) | `scripts/agents/agent_d.py` | runs `scripts/gex_engine.py`, validates `references/gex-output-schema.json`, checks the regime→strategy map |
| Agent E (the plan) | `scripts/agents/agent_e.py` | the SOLE owner of strike/stop/targets/sizing |
| GEX engine | `scripts/gex_engine.py` | the ONLY place gamma exposure is computed |
| Job registry | `src/lib/orchestrator/skill-jobs.ts` | the six scheduled jobs (the repo's `scripts/dailyScanCron.ts` runs them) |
| Rules + path mapping | `skills/nse-options-signal/references/agent-rules.md` | the veto catalogue, the A+ checklist, the vendored-file mapping |

**Delegation**: B, C and D are child processes (`python3 scripts/agents/agent_*.py`), concurrent, 20 s each; the task is JSON on stdin, the result JSON on stdout. A timeout / non-zero exit / invalid JSON / missing field is a **mandatory veto**.

**Consensus**: ≥2 of {B, C, D} on the same side, no opposing vote (neutral does not count), no veto. Agent A's context can only *conflict*: a conflict needs an objectively measured **A+ setup** (7 checks, `references/agent-rules.md` §5) + half size, else NO TRADE.

**GEX isolation**: `engine="GEX"`, `trade_id` = `GEX-…`, the alerts go to the GEX outbox only (`data/gex_alerts.jsonl`), the GEX record never enters the main bias score, and GEX contributes at most ONE vote. `scripts/gex_exit_monitor.py` raises the operational "exit at market" alert on a 15-min close back through the invalidation — and refuses to claim a close it cannot verify.

**Sizing**: the account equity is NEVER hardcoded — `scripts/account_equity.py` validates `data/account_equity.json` (`{equity, source, as_of}`) or the app's Breeze funds endpoint (`/api/positions` → `data.funds.allocated_equity`). The lot size comes from the contract master (`scripts/contract_master.py` → `src/lib/symbol-config.ts` / the bhavcopy `NewBrdLotQty`); a stock never inherits NIFTY's lot and an unknown lot fails closed.

**Cron mapping** (documented in `skills/nse-options-signal/config/crontab.txt` — NOT an installable crontab): `eod-pcr` 15:35, `eod-fetch` 19:05 (retries to 22:00), `daily-bias` 08:30, `live-breadth` every 5 min 09:00-14:55, `gex-engine` every 5 min 09:30-15:00 (the engine's own session gates hold the exact window), `holidays` Sunday 10:00. Every job runs through `scripts/cron_job.sh` (flock, timeout, bounded retries, a structured JSON log, the weekend/holiday gate, and a non-zero exit on failure).

**Tests**: `cd skills/nse-options-signal && python3 -m unittest discover -s tests` → 185 offline tests (68 pre-existing + 117 new), all green.

## Known Issues

### ML/AI module is NOT machine learning
`ml-engine.ts` is classical TA indicators (RSI, Bollinger, VWAP, EMA, ADX) with hardcoded weights. No neural networks, no training. The name is misleading. Works correctly on whatever data is fed.

## TypeScript / ESLint

- `noImplicitAny: false` — code uses untyped `any` freely
- `ignoreBuildErrors: true` in `next.config.ts` — build won't fail on TS errors
- ESLint has nearly all rules disabled (`no-unused-vars`, `no-console`, `no-explicit-any`, etc. all off)
- Do not add strict linting or typing without explicit request — it will conflict with existing code

## Build & deploy

The build creates a standalone Next.js bundle with Caddy as reverse proxy:

```bash
bun run build  # creates .next/standalone/
```

- Caddy listens on `:81`, proxies to Next.js on `:3000`
- `.zscripts/build.sh` handles full build + packaging (references `/home/z/my-project` — adjust if needed)
- `.zscripts/start.sh` runs production: Next.js + Caddy + optional mini-services

## Environment

The `.env` file (gitignored) is required for ICICI Breeze API access:

```
DATABASE_URL=file:/path/to/db/custom.db
BREEZE_API_KEY=...
BREEZE_SECRET_KEY=...
```

**Note**: Motilal Oswal API credentials in existing code are not currently used in the data flow.

## Server startup

The dev server is unreliable in background. Use systemd-run:

```bash
systemctl --user reset-failed smdapp.service 2>/dev/null
cd /home/sachin/Desktop/SMDApp && rm -rf .next
systemd-run --user --unit=smdapp \
  --property=WorkingDirectory=/home/sachin/Desktop/SMDApp \
  --property=StandardOutput=append:/tmp/smdapp.log \
  --property=StandardError=append:/tmp/smdapp.log \
  npx next dev -p 3000
```

First compile takes 15-30s. If it hangs, `rm -rf .next` and restart.

## Path references to fix

`.zscripts/build.sh` and `start-dev.sh` contain hardcoded path `/home/z/my-project`. If running locally, either:
- Symlink: `ln -s /home/sachin/Desktop/SMDApp /home/z/my-project`
- Or update the scripts to use the actual project path

## Development Skills

Three skills adapted from Superpowers (obra/superpowers) for SMDApp. Reference these during development.

| Skill | File | When to Use |
|---|---|---|
| **Test-Driven Development** | `skills/TDD.md` | New engines, bug fixes, scoring logic — test first, code second |
| **Git Worktrees** | `skills/GIT-WORKTREES.md` | Feature work touching 3+ files — isolate from main |
| **Systematic Debugging** | `skills/DEBUGGING.md` | Any bug — find root cause before fixing |
| **Option Buying Playbook** | `skills/option-buying-playbook/SKILL.md` | Trade plans, CE/PE buys, option-chain/OI/Greeks interpretation, stops, position sizing, setup scoring (also condensed into the SDM agent system prompt in `agent-brain.ts`) |

## Architecture Guardian (MANDATORY pre-coding workflow)

Every coding task MUST follow these phases, in order. Do NOT skip to coding.
Auditing/duplicating code BEFORE understanding the existing codebase is forbidden.

- **Phase 1 — Repository Audit**: Find every existing implementation related to the task (classes, services, APIs, hooks, stores, utilities, indicators, DB models, UI components).
- **Phase 2 — Dependency Graph**: For every file you intend to touch, record: imports, exports, callers, side effects, API usage, DB usage.
- **Phase 3 — Duplicate Detection**: Identify modules/engines/APIs/components that already do the requested job. Flag them.
- **Phase 4 — Integration Plan**: List files to modify, exact functions to modify, duplicate code to retire later, risk level per file, and a rollback plan. Do NOT write code yet.
- **Phase 5 — Approval**: Present the plan and wait for explicit confirmation before coding. (If the user says "proceed with consolidation" / "go ahead" that counts as approval.)
- **Phase 6 — Coding**: Only EXTEND or MERGE existing code. Rules (non-negotiable):
  - Do NOT create duplicate modules, engines, APIs, components, tabs, or DB models if equivalent functionality already exists.
  - Refactor before creating. Extend before replacing. Merge before deleting.
  - Integrate new logic into the existing production path; do not fork a parallel path.
  - Mark duplicate modules `@deprecated` and keep them until the production change is verified — never delete immediately.
  - **For new engines/logic**: Follow `skills/TDD.md` — write failing test first, then implement.
  - **For feature work 3+ files**: Follow `skills/GIT-WORKTREES.md` — isolate in worktree.
- **Phase 7 — Testing**: Run `bun test` + `bun run build`. Verify compilation, imports, dashboard, the affected feature, audit recording, API responses, backtest, and agent chat. Every existing feature must keep working.
- **Phase 8 — Cleanup**: Only AFTER every test passes, remove the deprecated duplicate files.

Production path of record for Zero Hero: `ZeroHeroTerminal.tsx` → `zhCandidates` → `FullZeroHero` → Trade Audit (`registerTrades("ZERO_HERO_AI", …)`). Everything Zero-Hero must integrate into this path.

## API Endpoints — Complete List

### Core
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/option-chain` | GET | Option chain data (ICICI Breeze → MOAPI → NSE → BSE → Moneycontrol) |
| `/api/agent` | POST | AI Agent with LLM + 57 tools |
| `/api/agent-memory` | GET/POST/PATCH | Agent Memory — CRUD for trades, setups, predictions, preferences |
| `/api/breeze-connect` | GET/POST | Breeze session management |
| `/api/sdm-signal` | GET | SDM scoring signals |
| `/api/trade-journal` | GET/POST/PATCH/DELETE | Trade CRUD with Prisma DB |
| `/api/today-trades` | GET | Live strike ranking via institutional engine |

### Market Intelligence
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/market/heatmap` | GET | Multi-market heatmap (NIFTY50, BANKNIFTY, SENSEX, etc.) — live quote providers |
| `/api/market/breadth` | GET | Enhanced breadth (EMA20/50/200, VWAP participation, RelVol) |
| `/api/market/regime` | GET | Multi-factor regime engine with stock-based index fallback |
| `/api/market/opportunities` | GET | Trade opportunities — technical analysis engines + intraday scanner merge |
| `/api/fii-dii` | GET | FII/DII flow data (NSE India + MrChartist history) |
| `/api/news` | GET | Market news with deterministic sentiment scoring |

### Scanners
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/scanner` | GET | Main intraday scanner (live candle chain, Auction Theory engine) |
| `/api/scanner/fno` | GET | Dedicated F&O option scanner (OI change, IV percentile, premium velocity, volume) |
| `/api/weekly-scanner` | GET | Weekly equity swing scanner |
| `/api/btst` | GET | BTST (Buy Today Sell Tomorrow) scanner |
| `/api/intraday-scan` | GET | Intraday equity scan |

### Backtesting
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/backtest` | GET | Multi-day breakout backtest (Breeze historical candles) |
| `/api/backtest/trades` | GET | **Real trade backtest** — replays every closed trade against real historical candles. Filters: strategyId, symbol, maxTrades, dateFrom, dateTo |
| `/api/backtest/expiry` | GET | Deterministic expiry liquidity backtest |
| `/api/backtest-analyzer` | GET | Trade validation and analysis |

### Expiry Liquidity Engine
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/expiry-liquidity` | GET/POST | Expiry Liquidity Shift Engine — 14 sub-engines (CAS reference/dislocation, futures, OI, premium/IV/volume velocity, gamma, auction, breadth, heatmap) |
| `/api/expiry-liquidity/opportunities` | GET | Expiry-specific trade opportunities |

### Alerts & Watchlist
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/alerts` | GET | Alert history, stats, unacknowledged count |
| `/api/alerts` | POST | Fire alert (type, symbol, message, severity) |
| `/api/alerts` | PATCH | Acknowledge alert by ID |
| `/api/watchlist` | GET | Returns watchlist (10 default symbols) |
| `/api/watchlist` | POST | Add symbol to watchlist |
| `/api/watchlist` | DELETE | Remove symbol from watchlist |

### Other
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/atm-straddle` | GET | ATM straddle data |
| `/api/dom-analysis` | GET | DOM (Depth of Market) analysis |
| `/api/institutional-greeks` | GET | Institutional positioning + Greeks |
| `/api/participant-oi` | GET | Participant-wise OI data |
| `/api/telegram` | GET/POST | Telegram bot integration |
| `/api/admin/system` | GET | System health check |

## Session: Sep 1 2026 — What We Built

### Expiry Liquidity Shift Engine (14 sub-engines)
- CAS Reference Engine — VWAP reference 15:00-15:15
- CAS Dislocation Engine — price vs CAS reference tracking
- Futures Dislocation Engine — futures basis tracking
- Option Chain Flow Engine — OI/volume/premium/IV per strike
- OI Classification Engine — Long/Short Buildup, Short Covering, Long Unwinding
- Premium Velocity Engine — rate of premium change
- IV Velocity Engine — implied volatility shifts
- Volume Velocity Engine — volume momentum
- Gamma Pressure Engine — dealer gamma exposure
- OI Concentration Engine — support/resistance from OI walls
- Support/Resistance Engine — key levels
- Auction Theory Engine — auction state classification
- Market Breadth Engine — sector breadth confirmation
- Heatmap Confirmation Engine — cross-sector confirmation

### Real Trade Backtest Engine
- Fetches closed trades from audit sidecar (port 4001)
- Groups by symbol, fetches daily/intraday candles from real candle providers
- Smart interval: 5m for recent intraday, 15m/1h for swing, 1d for older
- Replays each trade: detects TP1/TP2/TP3 and SL hits
- Computes actual MFE/MAE/P&L/R-multiple
- Compares with recorded P&L (correlation coefficient)
- Full summary: by-strategy, by-symbol, equity curve, P&L distribution
- Tested: 99/100 trades backtestable, 65.7% WR, +2882 P&L, 5.34 profit factor

### Data Source Upgrades
- Moneycontrol priceapi integration for NIFTY 50 stocks (48/50 mapped)
- Batch stock quotes with crumb auth
- Stock-based index fallback for regime when index APIs fail
- Deterministic keyword-based sentiment analyzer (80+ keywords)
- Technical analysis detection engines (breakout, pullback, momentum, breakdown, reversal)
- Entry state machine (WATCH → CONFIRMING → CONFIRMED → INVALIDATED)

### Market Session Config
- `market-session.ts` — general session info (SessionInfo type)
- `market-session-config.ts` — detailed CAS/F&O timings (SessionState type with phase, isCasActive, minutesRemaining)
- **IMPORTANT**: Files in `expiry-liquidity/` must import from `./market-session-config`, NOT `@/lib/market-session`
