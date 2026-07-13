# ARCHITECTURE

SMDApp historical market data infrastructure. This document is the system-of-record
for module ownership, data flow, and services. It supersedes any earlier ad-hoc notes.

## Principles

1. **No service sprawl.** The Market Recorder is a Next.js API route, not a standalone
   sidecar. An external timer (systemd timer / crontab) invokes the route every market
   minute; no long-running process is added.
2. **Dedicated databases by responsibility.** Three independent SQLite databases, each
   with a single clear owner:
   | Database | Responsibility | Access layer | Owner |
   |---|---|---|---|
   | `db/custom.db` | Application data (User, Post, Trade, DomAnalysis) | Prisma | Next.js app |
   | `db/trade_audit.db` | Trade audit ledger (MFE/MAE, outcomes) | better-sqlite3 (Node sidecar `:4001`) | Trade Audit engine |
   | `db/market_history.db` | Historical market data (snapshots, chain, candles, SMC, scanner results, replay, eval) | better-sqlite3 | Next.js app (Market Recorder) |
   Historical option-chain + scanner data is high-volume and therefore isolated from the
   application database on purpose.
3. **One canonical contract.** Every module consumes `CanonicalMarketSnapshot`
   (see `CONTRACTS.md`). No module independently recomputes market features; all feature
   math flows through `buildCanonicalSnapshot()` in `src/lib/market/canonical.ts`, which
   wraps the existing analytics libs exactly once.
4. **Versioned snapshots.** Every stored snapshot carries `schema_version`,
   `feature_version`, `engine_version` so replay/backtest stay reproducible after feature
   math evolves.
5. **Record every scanner cycle**, not just executed trades. `ScannerResult` stores the
   full feature vector + AI reasoning (decision, confidence, reasons, triggered engines,
   rejected conditions) with a `outcome` field filled later.

## Modules & Ownership

| Module | Path | Responsibility | Depends on |
|---|---|---|---|
| Canonical contract + builder | `src/lib/market/canonical.ts` | Build `CanonicalMarketSnapshot` from raw data using existing libs | sdm-oianalysis, greeks, market-structure, signal-engine, volume-analysis, yahoo-finance-api, nse-api, icici-breeze |
| Market History store | `src/lib/market-history/db.ts` | Open `market_history.db`, schema, insert/read helpers | better-sqlite3 |
| Recorder route | `src/app/api/market-recorder/record/route.ts` | Capture cycle for all symbols, persist canonical snapshot | canonical, market-history/db, Breeze/NSE fetchers |
| Recorder client | `src/lib/market-recorder-client.ts` | Frontend/Next access to stored history | market-history/db |
| Scanner-cycle recorder | `src/lib/market/record-scanner.ts` | Build/persist `ScannerResult` (ML training row) each scanner run | canonical, market-history/db |
| Scanner recording API | `src/app/api/market-recorder/scanner/route.ts` | POST cycle rows (resolves `snapshotId`); GET ML dataset | record-scanner, market-history/db |
| Replay Engine | `src/lib/market/replay-engine.ts` | Reconstruct exact session/snapshot from `market_history.db`; recorder integrity validation | canonical, market-history/db, recorder-config |
| Recorder integrity | `src/app/api/market-recorder/integrity/route.ts` | GET health: missing intervals, dup timestamps, incomplete captures | replay-engine |
| Backtest Data Provider (M6) | `src/lib/market/data-provider.ts` | Single interface for Backtest Engine: candles + option-chain from Replay / History / Live Breeze. `live` = pure delegation (fixes old interval/date arg swap); `history`/`replay` read `market_history.db`; `auto` = history-first then live | canonical, market-history/db, replay-engine, breeze-historical, icici-breeze/option-chain |
| Backtest rewire (M6) | `src/lib/sdm-backtest.ts`, `src/lib/backtest-engine.ts`, `src/lib/backtest-audit.ts` | Call `getBacktestDataProvider()` instead of importing Breeze fns directly; trading logic unchanged | market/data-provider |
| Evaluation Framework (M7) | `src/lib/market/evaluation-framework.ts`, `src/app/api/evaluate/route.ts` | Single `evaluate()` over reused data: trade metrics from **Trade Audit** (`trade-audit-client` → :4001), classification from **Scanner Results** (`scanner_results` in `market_history.db`, engine/feature version natively stored). No trading logic changed. | trade-audit-client, market-history/db, canonical |
| Trade feature snapshot | `src/app/api/trade/register/route.ts` | Attach canonical features to `market_context_json` | canonical, market-history/db |

## Data Flow

```
Breeze / NSE / Yahoo(VIX)
        │  (raw quotes, option chain, candles, breadth)
        ▼
/api/market-recorder/record   ◄──── systemd timer (every market minute)
        │
        ▼
buildCanonicalSnapshot()  ──►  CanonicalMarketSnapshot (+ versions)
        │                               │
        ▼                               ▼
market_history.db              consumed by: Zero Hero, SMC, Intraday, BTST,
(snapshots, chain, candles,           Replay, Backtest, Agent, AI, Dashboard
 SMC events, scanner results)
        │
        ▼
Replay Engine  ──► reconstruct session ──► Backtest / Evaluation
                                        Evaluation reads trades from trade_audit.db
```

## Backtest Data Provider (M6)

The Backtest Engine must not know where its market data originates. All three backtest
files (`sdm-backtest.ts`, `backtest-engine.ts`, `backtest-audit.ts`) now call a single
`getBacktestDataProvider()` instead of importing Breeze fetchers directly. The provider
insulates the unchanged trading logic from the data source.

`src/lib/market/data-provider.ts` exposes:

```ts
interface BacktestDataProvider {
  getIntradayCandles(symbol, interval, dateStr): Promise<IntradayCandleResult>;
  getOptionChain(symbol, expiryDate): Promise<OptionChainData | null>;
  getOptionChainExpiries(symbol): Promise<string[]>;
}
```

Implementations:

- **`live`** — pure delegation to `getIntradayCandles` / `getOptionChain` /
  `getOptionChainExpiries`. Corrects the pre-existing arg-order bug in the old live
  backtest calls (`getIntradayCandles(symbol, "5minute", dateStr)` had interval/date
  swapped vs the real `(symbol, dateStr, interval)` signature).
- **`history`** — reads stored candles + snapshot option-chain from `market_history.db`,
  rebuilding `OptionQuote` legs that carry both `strikePrice` (for the SDM `.find`)
  and `oi`/`oiChg`/greeks (for the SDM OI-pattern consumer).
- **`replay`** — reconstructs via `replay-engine` (`getSnapshotById`,
  `getSessionCandlesForReplay`).
- **`auto`** (default) — history first, live Breeze fallback.

Selection: `BACKTEST_DATA_SOURCE = live | history | replay | auto` (default `auto`).
Recorded option chains have no expiry list, so `getOptionChainExpiries` returns `[]`
and the backtest falls back to `dateStr` as the expiry.

### Evaluation Framework (M7)

Single `evaluate(filters)` that REUSES (never replaces) existing components:

- **Trade metrics** ← **Trade Audit** (`trade-audit-client` HTTP `:4001`). Reads
  recorded trades and computes: Win Rate, Profit Factor, Expectancy, Max
  Drawdown (+ %), Average R Multiple, Average Holding Time, avg MFE / MAE.
  Strategy/date/symbol filtering is server-side; Engine/Feature Version filtering
  is client-side via the trade's `snapshotId` → `market_history.snapshots`.
- **Classification metrics** ← **Scanner Results** (`scanner_results` in
  `market_history.db`). Each row's `decision` is the prediction; its `outcome`
  (filled by the audit/eval pipeline) is the ground truth. Computes: Precision,
  Recall, F1, Confusion Matrix (TP/FP/TN/FN). Engine Version + Feature
  Version are stored natively on every row, so they filter here directly.

The two legs are combined into one `EvaluationReport { filters, tradeMetrics,
classification, generatedAt }`. Trading logic is unchanged.

Filters (`EvaluationFilters`): `strategy` (Zero Hero | SMC | BTST | Intraday —
case-insensitive substring on both sources), `symbol`, `dateFrom`, `dateTo`,
`engineVersion`, `featureVersion`.

Endpoint: `GET /api/evaluate?strategy=&symbol=&dateFrom=&dateTo=&engineVersion=&featureVersion=`
returns the `EvaluationReport` JSON (500 on Trade Audit outage, with empty
trade metrics so the classification leg still answers).

### Per-execution provider metadata (pre-M7)

Every backtest execution records a `BacktestProviderMeta` (requested provider,
resolved provider, fallback used, fallback reason, snapshot count, candle count,
option-chain count, replay session ids) via `createBacktestRunMeta()` + the
provider writing into it. The metadata is attached to the backtest report
(`SdmBacktestResult.providerMeta`, `FullBacktestResult.providerMeta`,
`AuditReport.providerMeta`) so every result is fully reproducible. Trading logic
is untouched — the metadata is observation-only.

## Services

- **Next.js backend** (port 3000): all recorder/store/replay/eval logic. Uses
  `better-sqlite3` (Node-compatible) for `market_history.db` — **no Bun runtime
  requirement**, consistent with the existing production architecture (the trade-audit
  sidecar already runs on Node + better-sqlite3).
- **Trade Audit engine** (port 4001, Node sidecar): pre-existing operational trade ledger.
  Not modified by this work except receiving feature snapshots via `market_context_json`.

## Scheduler (no sidecar, config-driven)

A host systemd timer (or crontab) issues `POST /api/market-recorder/record` with
`{"auto":true}`. The app applies a **config-driven per-mode interval** and a `MANUAL`-mode
skip — no code change is needed to alter cadence. The timer fires at the finest granularity
(`RECORDER_TICK_GRANULARITY`, default 30s) and the app throttles to the active interval.

Files: `market-recorder/tick.sh` (flock-guarded, off-hours guard),
`market-recorder/smdapp-recorder.service`, `market-recorder/smdapp-recorder.timer`
(`OnCalendar=Mon-Fri *-*-* 09:15..15:30:00/30`). Enable with:
`systemctl --user enable --now market-recorder.timer`.

### Recorder modes & intervals (env-configurable)

| Env var | Default | Meaning |
|---|---|---|
| `RECORDER_MODE` | (auto) | Force a mode: `MANUAL` disables auto capture; else auto-detected |
| `RECORDER_INTERVAL_NORMAL` | `60` | Seconds between captures on normal days |
| `RECORDER_INTERVAL_WEEKLY_EXPIRY` | `60` | Seconds between captures on Thursdays (weekly expiry) |
| `RECORDER_INTERVAL_MONTHLY_EXPIRY` | `30` | Seconds between captures on last-Thursday week (monthly expiry) |
| `RECORDER_SYMBOLS` | NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY,SENSEX | Comma list of symbols to record |
| `RECORDER_TICK_GRANULARITY` | `30` | Timer tick granularity (seconds); must be <= smallest interval |
| `MARKET_RECORDER_BASE` | `http://localhost:3000` | Base URL used by `tick.sh` |

Mode auto-detection: Thursday ⇒ `WEEKLY_EXPIRY`; last-Thursday week ⇒ `MONTHLY_EXPIRY`;
otherwise `NORMAL`. `MANUAL` mode accepts only forced (manual) `POST` captures.

### Idempotency

Every snapshot key is `symbol + bucketed_timestamp` (bucket = active interval). The
`market_snapshots` table has `UNIQUE(symbol, timestamp)` and `insertSnapshot` uses
`INSERT OR IGNORE`, so duplicate scheduler ticks can never create duplicate rows.

### Endpoints

- `POST /api/market-recorder/record` — body `{symbols?, auto?, force?}`. `auto` applies
  mode+throttle; `force` bypasses (manual capture always allowed).
- `GET  /api/market-recorder/snapshots?symbol=&date=` — stored snapshot summaries.
- `GET  /api/market-recorder/status` — `state`, `mode`, `captureIntervalSeconds`,
  `lastSuccessfulCapture`, `lastFailedCapture`, `totalSnapshots`, `databaseSizeBytes`,
  `uptimeMs`.

This matches the existing `/api/cron/dom-analysis` pattern. No new long-running process.

## Reproducibility

`market_history.db` rows are immutable once written (append-only per timestamp). Version
columns on every snapshot let the Replay Engine and Backtest pin to the exact feature math
that produced a recorded session, eliminating silent drift when `FEATURE_VERSION` changes.

### Backward compatibility (schema evolution)

Historical sessions must replay correctly even as `CanonicalMarketSnapshot` evolves. Rules:

- **Additive schema changes only.** New columns/fields are added; existing ones are never
  renamed or removed. Legacy rows simply carry `NULL` for new columns and readers default
  them (`readSnapshot` already tolerates missing fields).
- **Version-pinned replay.** Every stored snapshot carries `schema_version`,
  `feature_version`, `engine_version`. `migrateSnapshot(raw, version)` in
  `src/lib/market/canonical.ts` upgrades older raw rows to the current shape; v1 is a
  pass-through and future versions transform legacy rows while filling new fields with safe
  defaults. Replay Engine / Backtest therefore never break on legacy recordings.
