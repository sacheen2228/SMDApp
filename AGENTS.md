# SMDApp

Real-time option chain viewer for Indian markets (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX) with ICICI Breeze API integration and SDM analysis engine.

## Quick start

```bash
bun install
bun run db:push    # sync SQLite schema
bun run dev        # starts on :3000
```

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
- **Data flow**: Three-tier fallback: ICICI Breeze API → NSE API → Yahoo Finance
- **Analysis**: SDM Options Intelligence Engine (`src/lib/sdm-engine.ts`) + ORCA Engine (`src/lib/orca-engine.ts`)
- **Market Intelligence**: Technical analysis engines, sector heatmap, breadth, regime, F&O scanner, expiry liquidity engine
- **Trade Backtest**: Real trade backtest against Yahoo Finance historical candles (99/100 trades backtestable)

### Key source files

| File | Role |
|---|---|
| `src/app/page.tsx` | Main UI component — all views/tabs |
| `src/app/api/option-chain/route.ts` | Core API: orchestrates data sources + SDM analysis |
| `src/lib/icici-breeze/` | ICICI Breeze API: auth, option chain, orders, positions |
| `src/lib/nse-api.ts` | NSE India scraper (fallback when Breeze fails) |
| `src/lib/sdm-engine.ts` | SDM 14-factor scoring engine |
| `src/lib/sdm-recommendation.ts` | V2 recommendation orchestrator |
| `src/lib/sdm-scores.ts` | 14-factor quality scoring |
| `src/lib/orca-engine.ts` | ORCA institutional AI engine (15 modules) |
| `src/lib/historical-data.ts` | Breeze + Yahoo Finance candle fetcher (real data) |
| `src/lib/greeks.ts` | Black-Scholes Greeks calculator (real math, may get fake inputs) |
| `src/lib/ml-engine.ts` | Technical indicator scoring (NOT machine learning — just RSI/Bollinger/VWAP/EMA/ADX) |
| `src/lib/master-bot-engine.ts` | Master Bot trade plans using Yahoo Finance data |
| `src/lib/backtest-engine.ts` | Breakout strategy backtest (uses fake candles) |
| `src/lib/orca-backtest.ts` | ORCA backtest (uses fake option chains) |
| `src/lib/sdm-trade-tracker.ts` | Trade lifecycle: add/update/expire, DB persistence |
| `src/stores/useTradingStore.ts` | Zustand store for trading state |
| `src/app/api/agent/route.ts` | AI Agent API with LLM (Groq/OpenRouter) + 38 tools, SMDContext, memory, logging |
| `src/components/dashboard/AgentChat.tsx` | Agent chat UI with voice mode, 15 quick commands — calls `/api/agent` |
| `src/lib/smd-context.ts` | SMDContext — centralized market context builder for Hermes (aggregates all data sources) |
| `src/lib/agent-memory.ts` | Agent Memory — persistent trade patterns, setup memory, predictions, preferences |
| `src/lib/agent-logger.ts` | Agent Logger — tool call, LLM call, error, conversation observability (JSONL) |
| `src/app/api/agent-memory/route.ts` | Agent Memory REST API — CRUD for trades, setups, predictions, preferences |
| `src/lib/signalTracker.ts` | Full-day signal deduplication — prevents same trade from being re-sent |
| `src/lib/morningSignalGenerator.ts` | Morning signal generator — scans NIFTY/SENSEX/Equity/MCX for high-accuracy trades |
| `src/lib/dailyDigest.ts` | End-of-day digest — sends summary of signals, active trades, market data |
| `src/app/api/morning-signals/route.ts` | Morning Signals API — call at 9:20 AM IST for daily trade recommendations |
| `src/app/api/daily-digest/route.ts` | Daily Digest API — call at 3:25 PM IST for end-of-day summary |
| `src/lib/telegram.ts` | Telegram sender — HTML messages, full-day dedup, trade alerts |
| `src/lib/session-health.ts` | **Session Health** — single owner of session-expiry classification, dedup'd `[SYSTEM][SESSION_EXPIRED]` alerts, live source probes, Hermes status report |
| `src/lib/market/candle-chain.ts` | Candle multi-source chain (live capture only): indices Breeze→MO→NSE index-only, stocks Breeze→MO; no timeframe/instrument substitution |
| `src/lib/motilal/candles.ts` | MO EOD candle wrapper (only daily OHLC endpoint MO exposes; no intraday on the platform) |
| `src/lib/telegramSend.ts` | Telegram sender — Markdown messages, used by cron/digest modules |
| `src/lib/option-acceleration-engine.ts` | Option Acceleration Engine (10 sub-engines: delta accel, gamma explosion, OI absorption, volume momentum, institutional flow, premium elasticity, historical memory, time decay, regime + premium velocity + TP1/TP2/TP3) |
| `src/lib/greek-flow-engine.ts` | **@deprecated** — old Greek Flow scoring engine, replaced by option-acceleration-engine.ts |
| `src/app/api/greek-flow/route.ts` | Greek Flow API endpoint → runs acceleration engine |
| `src/components/terminal/GreekFlowHeatmap.tsx` | Option Acceleration UI (12 dashboard cards, premium race table, top 5 calls/puts, full heatmap) |
| `src/components/terminal/EnhancedOptionChain.tsx` | Enhanced Option Chain (Greeks, IV skew, OI bars, click-to-trade, sorting) |
| `ict_bot_v5.py` | Standalone Python ICT/SMC bot (not integrated into web app) |
| `trade-audit/` | Trade Audit / Backtest Verification engine (standalone sidecar, port 4001, Node + better-sqlite3) |
| `src/components/backtest/BacktestDashboard.tsx` | Backtest tab — polls `:4001` for verification stats + trade ledger |
| `src/lib/trade-audit-client.ts` | Client lib for the audit engine (record/price/close/stats/trades) |
| `src/lib/audit-recorders.ts` | Records Terminal-tab Zero Hero + Smart Money candidates into the audit engine |
| `src/lib/fii-dii.ts` | FII/DII data scraper — NSE India primary + MrChartist 60-day history |
| `src/app/api/fii-dii/route.ts` | FII/DII API endpoint — latest + 30-day history |
| `src/lib/technical-analysis.ts` | Detection engines (breakout, pullback, momentum, breakdown, reversal), OI classification, trade scoring |
| `src/lib/nse-stock-data.ts` | Shared stock data fetcher with 3-tier fallback (Moneycontrol → Yahoo batch → Yahoo per-stock) |
| `src/lib/fetch-with-fallback.ts` | Reusable fallback utility (`fetchWithFallback`, `fetchWithRetry`) |
| `src/lib/sentiment-analyzer.ts` | Deterministic keyword-based sentiment scoring (80+ keywords) |
| `src/lib/market-session.ts` | Centralized session config (CAS timeline, phases, confidence multipliers) |
| `src/lib/expiry-liquidity/` | Expiry Liquidity Shift Engine — 14 sub-engines (CAS, futures, OI, premium, IV, volume, gamma, auction, breadth, heatmap) |
| `src/lib/trade-backtest-engine.ts` | Real trade backtest — replays every trade against Yahoo Finance historical candles |
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
| Option chain (live) | ICICI Breeze API → NSE API | **REAL** when tokens valid, NSE as fallback |
| Candle data (live) | Breeze historical API | **REAL** when Breeze session active |
| SDM signals | `api/sdm-signal/route.ts` | **REAL** — Breeze → NSE fallback chain |
| Scanner data | `api/scanner/route.ts` + Yahoo Finance | **REAL** — Yahoo Finance for stock prices, Breeze for option chain context |
| Breakout data | `api/breakout/route.ts` + Breeze | **REAL** — Breeze for spot price, real candles when available |
| Backtest candles | `backtest-engine.ts` + Breeze historical | **REAL** — skips days with no Breeze data, no fake candle generation |
| Master Bot prices | Yahoo Finance API | **REAL** |
| SDM scoring | `sdm-engine.ts` | Real math on whatever data is fed |
| SDM recommendation | `sdm-recommendation.ts` | Real math, but hardcoded VIX=15 fallback, capital=₹100K |
| ML/TA Engine | `ml-engine.ts` | Real TA indicators (RSI/Bollinger/VWAP/EMA/ADX). Classical TA, NOT ML — mislabeled |
| Greeks | `greeks.ts` | Real Black-Scholes math, risk-free rate hardcoded 7% |
| Trade journal | Prisma DB | **REAL** — stores actual trades generated by SDM engine |
| Breeze auth | `icici-breeze/auth.ts` | Auto-retry on auth errors, re-inits session |
| Live data engine | `live-data-engine.ts` | Breeze → NSE fallback chain (no simulation) |
| FII/DII flows | `fii-dii.ts` + `/api/fii-dii` | **REAL** — NSE India primary + MrChartist history |
| Gift Nifty | Yahoo Finance `^NSEI` | **REAL** — NIFTY 50 spot as proxy (SGX ticker dead) |

### What was changed/removed
- `historical-data.ts` — deleted (was 100% fake candle generator, no longer used)
- `option-chain-data.ts` — deleted (was 100% fake option chain generator, no longer used)
- `generateHistoricalChain()` — deleted from orca-backtest.ts and sdm-backtest.ts (was Math.random() fake option chains)
- All Math.random() for stock technicals — replaced with deterministic defaults when Yahoo Finance data unavailable
- **No simulation fallback exists anywhere** — APIs return 503 errors when real data unavailable
- `auto-bot/` — removed (was a Breakout/Desk Python equity screener sidecar on port 8000; not aligned with the Indian F&O focus and unused by the data flow)

### Expiry day
All indices expire on **Thursday** (weekday 3) per current SEBI rules. Fixed in master-bot-engine.ts and icici-breeze/option-chain.ts.

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
Yahoo      CAS       Health
News       Gamma     Telegram
FII/DII    Vol Profile
VIX        S/R, Expiry
    │      │
    ▼      ▼
┌─────────────────────┐
│  HERMES DECISION    │  ← Groq openai/gpt-oss-120b (128K context)
│  ENGINE             │     41 tools total
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

### 41 Hermes Tools (36 original + 5 new)

**NEW TOOLS (added this session):**
| Tool | Purpose |
|---|---|
| `send_telegram_signal` | Push trade signal to Telegram phone |
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
1. **session-health.ts** — SOLE sender of `[SYSTEM][SESSION_EXPIRED]` Telegram alerts (once per source per episode; retries when Telegram's 09:10-15:30 IST window suppresses a send). `classifySourceError()` → `SESSION_EXPIRED | NO_DATA | SOURCE_UNAVAILABLE`; NSE can NEVER classify as SESSION_EXPIRED (no token auth). Source modules report-then-return-null (contracts unchanged).
2. **Breeze expiry** — hooks in `icici-breeze/auth.ts` (`doInitSession` catch, `generateSession` 401, `withAuthRetry` retry) + `option-chain.ts` catch. Manual remedy: browser OTP at `api.icicidirect.com/apiuser/login?api_key=…` → Hermes `set breeze session <token>`.
3. **MO expiry** — `autoLogin()` is TOTP-first (`MOTILAL_TOTP_KEY`), OTP fallback leaves session UNVERIFIED. Candle chain attempts auto-recovery BEFORE alerting (self-healed blips never page). TOTP key re-registered 2026-09-27 — TOTP auto-login verified live. **Report endpoints work only on `/rest/report/v3/*`** — every `/rest/report/v1/*` path returns MO8001 "Invalid Token" even on a valid session (v1 auth broken; never call it — its auth-shaped error would fake an expiry alert). Candle capability (live-verified): NSE EOD v3 = equity **spot** daily bars (~9s); NSEFO dump = **derivatives only** (80–128s, zero spot rows); **no index spot OHLC anywhere** (IndexDataAPI is a code list only) → index symbols are an MO capability skip; CSV endpoints hang (>45s) — unused.
4. **Candle chain** (live capture only, enforced by import-scan test): first-success-wins, failures recorded to session-health + `recorderState.lastCandle`. MO = daily-only capability skip for intraday (no substitution). NSE chart `chart-databyindex?index=…` is index-only (allowlist: NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY; SENSEX/BANKEX excluded — BSE), current session only, close-only points labeled degraded + interval derived from real point spacing.
5. **Surfaces** — `/api/market-recorder/status` exposes `sessionHealth`/`sessionSummary`/`lastCandleCapture`; Hermes `check_session_tokens` returns live probes + recorded episodes + remedies.
6. **Not fixed by alerts**: `.env` secrets/config changes still require a human (alert states the remedy).

### Signal Deduplication (3 levels)
1. **signalTracker.ts** — Full-day signature dedup (same signal never sent twice per day)
2. **telegram.ts** — 5-minute short-term throttle
3. **intradayState.ts** — Per-day signature tracking for intraday alerts

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
| `/api/option-chain` | GET | Option chain data (Breeze → NSE fallback) |
| `/api/agent` | POST | AI Agent with LLM + 38 tools |
| `/api/agent-memory` | GET/POST/PATCH | Agent Memory — CRUD for trades, setups, predictions, preferences |
| `/api/breeze-connect` | GET/POST | Breeze session management |
| `/api/sdm-signal` | GET | SDM scoring signals |
| `/api/trade-journal` | GET/POST/PATCH/DELETE | Trade CRUD with Prisma DB |
| `/api/today-trades` | GET | Live strike ranking via institutional engine |

### Market Intelligence
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/market/heatmap` | GET | Multi-market heatmap (NIFTY50, BANKNIFTY, SENSEX, etc.) — Moneycontrol → Yahoo batch → Yahoo per-stock |
| `/api/market/breadth` | GET | Enhanced breadth (EMA20/50/200, VWAP participation, RelVol) |
| `/api/market/regime` | GET | Multi-factor regime engine with stock-based index fallback |
| `/api/market/opportunities` | GET | Trade opportunities — technical analysis engines + intraday scanner merge |
| `/api/fii-dii` | GET | FII/DII flow data (NSE India + MrChartist history) |
| `/api/news` | GET | Market news with deterministic sentiment scoring |

### Scanners
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/scanner` | GET | Main intraday scanner (Breeze → Yahoo candles, Auction Theory engine) |
| `/api/scanner/fno` | GET | Dedicated F&O option scanner (OI change, IV percentile, premium velocity, volume) |
| `/api/weekly-scanner` | GET | Weekly equity swing scanner |
| `/api/btst` | GET | BTST (Buy Today Sell Tomorrow) scanner |
| `/api/intraday-scan` | GET | Intraday equity scan |

### Backtesting
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/backtest` | GET | Multi-day breakout backtest (Breeze historical candles) |
| `/api/backtest/trades` | GET | **Real trade backtest** — replays every closed trade against Yahoo Finance candles. Filters: strategyId, symbol, maxTrades, dateFrom, dateTo |
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
- Groups by symbol, fetches daily/intraday candles from Yahoo Finance
- Smart interval: 5m for recent intraday, 15m/1h for swing, 1d for older
- Replays each trade: detects TP1/TP2/TP3 and SL hits
- Computes actual MFE/MAE/P&L/R-multiple
- Compares with recorded P&L (correlation coefficient)
- Full summary: by-strategy, by-symbol, equity curve, P&L distribution
- Tested: 99/100 trades backtestable, 65.7% WR, +2882 P&L, 5.34 profit factor

### Data Source Upgrades
- Moneycontrol priceapi integration for NIFTY 50 stocks (48/50 mapped)
- Yahoo Finance batch quotes with crumb auth (v7/finance/quote)
- Stock-based index fallback for regime when index APIs fail
- Deterministic keyword-based sentiment analyzer (80+ keywords)
- Technical analysis detection engines (breakout, pullback, momentum, breakdown, reversal)
- Entry state machine (WATCH → CONFIRMING → CONFIRMED → INVALIDATED)

### Market Session Config
- `market-session.ts` — general session info (SessionInfo type)
- `market-session-config.ts` — detailed CAS/F&O timings (SessionState type with phase, isCasActive, minutesRemaining)
- **IMPORTANT**: Files in `expiry-liquidity/` must import from `./market-session-config`, NOT `@/lib/market-session`
