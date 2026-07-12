# Trade Recorder & Backtest Verification Engine

A standalone TypeScript service that records every trade signal your
strategies generate, tracks it live, auto-closes it on TP/SL, and computes
backtest-verification metrics — win rate, R-multiple, profit factor,
expectancy, and max drawdown, both overall and broken down by strategy /
symbol / market session.

## Scope of this build

Your original spec covers an enormous surface (AI self-learning, trade
replay pages, 20+ charts, options-Greeks-specific accuracy scoring). Per
your last message, this pass builds the **core**:

- ✅ Signal recording with the full field set (entry/SL/TP1-3, confidence,
  AI confidence, probability, market context snapshot — Greeks, SMC
  structure, OI/PCR, etc. — captured as JSON per trade)
- ✅ Live tracking: MFE/MAE, TP1/TP2/TP3/SL detection, auto-close
- ✅ Per-trade verification heuristics (entry quality, SL/TP assessment)
- ✅ Aggregate stats: win rate, avg R, profit factor, expectancy, max
  drawdown, breakdowns by strategy/symbol/session
- ✅ Paginated/filterable trade search, CSV/JSON export
- ✅ Background queue so recording never blocks live trading, with retry
  and duplicate-signal protection

**Not built yet** (flagged as extension points, not faked):
- AI self-learning / pattern detection / auto-generated improvement
  suggestions
- Trade replay page (chart-at-entry/exit, full option chain snapshot UI)
- The 20+ chart types (equity curve, heatmaps, rolling profit factor, etc.)
  — the `/api/stats` endpoint gives you the numbers; charting them is a
  frontend task
- Sharpe/Sortino ratio (need a return series with a risk-free rate and
  consistent time buckets — happy to add once you tell me the bucketing
  you want, e.g. daily returns)
- "Did price reverse after exit" / "did another strategy have a better
  signal" — both need data this engine doesn't yet ingest (continuous
  post-exit price feed, cross-strategy signal correlation)

Ask for any of these next and I'll build on top of this foundation.

## Stack

Node.js + TypeScript + Express + SQLite (`better-sqlite3`). No external
services required — runs standalone. The repository pattern in
`src/repositories/` keeps all SQL in one place, so swapping SQLite for
Postgres later (for multi-process scale) only touches that file plus
`src/db/index.ts`.

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm start
# or, for development with auto-reload:
npm run dev
```

Server listens on `PORT` (default 4001).

## Integrating a strategy module

Every strategy calls one function the instant it generates a signal:

```ts
POST /api/signals
{
  "strategyId": "SMC",              // or ZERO_HERO_AI, BREAKOUT, MOMENTUM,
                                     // OI_GREEKS, OPTION_CHAIN, VOLUME_PROFILE,
                                     // VWAP, EMA, BTST, or any new string
  "strategyVersion": "1.2.0",
  "symbol": "NIFTY",
  "exchange": "NSE",
  "instrumentType": "OPTIONS",      // EQUITY | FUTURES | OPTIONS | INDEX
  "spotPrice": 24500,
  "strikePrice": 24500,
  "expiry": "2026-07-17",
  "optionType": "CE",
  "entryPrice": 120,
  "stopLoss": 100,
  "tp1": 150, "tp2": 170, "tp3": 200,
  "signalConfidence": 82,
  "aiConfidence": 77,
  "probabilityScore": 0.68,
  "trendDirection": "BULLISH",
  "signalReason": "BOS confirmed above order block with FVG fill",
  "marketSession": "MORNING",       // optional — inferred from time if omitted
  "marketContext": {
    "niftyLevel": 24500, "indiaVix": 13.2, "pcr": 1.15,
    "bos": true, "choch": false, "fvg": true,
    "orderBlock": "24450-24470 demand",
    "delta": 0.42, "gamma": 0.008, "theta": -6.1, "vega": 9.3
    // ... any other context fields; the shape is open-ended
  }
}
```

Returns `202 { tradeId, status: "queued" }` immediately — the DB write
happens on a background queue, so this call never blocks your strategy
loop. If you supply your own `tradeId` and call it twice, the second call
is a safe no-op (no duplicate row).

Feed live prices as they come in (from your existing market data feed):

```ts
POST /api/signals/:id/price
{ "price": 152.5 }
```

The engine updates MFE/MAE and TP/SL-hit flags, and **auto-closes** the
trade the moment SL or TP3 is touched. For a manual/time-based exit:

```ts
POST /api/signals/:id/close
{ "exitPrice": 145, "exitReason": "manual" }
```

## Reading results

```
GET /api/signals/:id            # single trade, full lifecycle + verification
GET /api/trades?strategyId=SMC&status=closed&page=1&pageSize=50
GET /api/stats?dateFrom=2026-07-01&strategyId=BTST
GET /api/export/csv?symbol=NIFTY
GET /api/export/json
```

`/api/trades` and `/api/stats` share the same filter set: `strategyId`,
`symbol`, `instrumentType`, `status`, `outcome` (win/loss), `marketSession`,
`minConfidence`/`maxConfidence`, `dateFrom`/`dateTo` (IST ISO strings).

## Architecture notes

- **Non-blocking by design**: `POST /api/signals` and the price/close
  endpoints enqueue a job and return in milliseconds. A single background
  worker (`src/queue.ts`) drains the queue in order, so updates to the same
  trade never race, and failed writes retry with backoff instead of being
  dropped. Jobs left "processing" from a crash are re-queued on startup.
- **Idempotency**: the `trades.id` primary key doubles as a dedup key —
  re-sending the same `tradeId` is a safe no-op.
- **Storage**: SQLite in WAL mode, with indices on strategy, symbol,
  status, created_at, market_session, and confidence — the columns you'd
  actually filter/sort on. High-cardinality context (Greeks, SMC state,
  option-chain snapshot) is stored as one JSON blob per trade rather than
  dozens of sparse columns.
- **Long-only assumption**: the tracking/close logic assumes `entry <= tp1`
  means a long/bullish trade (CE, long equity/futures) and treats
  `entry > tp1` as a short/bearish trade (PE, short futures) for MFE/MAE
  and TP/SL direction. Flag if you need explicit long/short signaling
  instead of inferring it from price levels.

## File structure

```
trade-audit-engine/
├── src/
│   ├── server.ts              # Express bootstrap
│   ├── config.ts
│   ├── types/index.ts         # domain types (Signal, MarketContext, TradeRecord, ...)
│   ├── queue.ts                # durable retry-safe background job queue
│   ├── db/index.ts            # SQLite schema + indices
│   ├── repositories/tradeRepository.ts   # all SQL lives here
│   ├── services/
│   │   ├── recorder.ts        # recordSignal / price tracking / close
│   │   ├── verification.ts    # per-trade heuristics + aggregate stats
│   │   └── export.ts          # CSV/JSON export
│   ├── routes/trades.ts       # REST API
│   └── utils/{ist.ts, validation.ts}
├── package.json
├── tsconfig.json
└── .env.example
```
