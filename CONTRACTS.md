# CONTRACTS

Shared interfaces for the historical market data infrastructure. These are the single
source of truth; `src/lib/market/canonical.ts` implements them. Engine code must consume
these types, never recompute equivalent shapes inline.

## Versioning

Every persisted snapshot carries three version axes:

| Field | Meaning |
|---|---|
| `schema_version` | Shape of the stored record (columns/JSON keys). Bump on structural change. |
| `feature_version` | Version of the feature math in `buildCanonicalSnapshot`. Bump when a formula changes. |
| `engine_version` | Version of the engine that produced the snapshot (semver). |

Current values (see `canonical.ts`): `SCHEMA_VERSION=1`, `FEATURE_VERSION=1`, `ENGINE_VERSION="1.0.0"`.

## CanonicalMarketSnapshot

```ts
export interface OptionLeg {
  strike: number;
  type: "CE" | "PE";
  ltp: number;
  oi: number;
  oiChg: number;
  iv: number | null;
  greeks: { delta: number; theta: number; gamma: number; vega: number };
  volume: number;
}

export type SmcEventType =
  | "BOS" | "CHoCH" | "FVG" | "ORDER_BLOCK" | "LIQUIDITY_SWEEP";

export interface SmcEvent {
  type: SmcEventType;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  price: number | null;
  details: Record<string, unknown>;
}

export interface VolumeProfile {
  poc: number;
  vah: number;
  val: number;
  bins: { price: number; volume: number }[];
}

export interface CanonicalMarketSnapshot {
  // --- versioning ---
  schema_version: number;
  feature_version: number;
  engine_version: string;

  // --- identity ---
  snapshotId: string; // stable: `${symbol}-${timestamp}`
  symbol: string;
  timestamp: string; // ISO 8601

  // --- market state ---
  spot: number;
  futures: number | null;
  indiaVix: number | null;
  pcrOi: number | null;
  pcrVol: number | null;
  maxPain: number | null;
  iv: number | null;
  atr: number | null;
  vwap: number | null;
  volume: number | null;
  breadth: { advancers: number; decliners: number } | null;

  // --- chain & structure ---
  optionChain: OptionLeg[];
  smcEvents: SmcEvent[];
  volumeProfile: VolumeProfile | null;

  // --- AI ---
  aiScores: Record<string, number>; // engine -> score (e.g. ZERO_HERO, SMC, ...)
  features: Record<string, number>;  // flat canonical feature vector
}
```

## ScannerResult (permanent AI training dataset)

Recorded **every scanner cycle** — including `REJECT` and `NO_TRADE` — in
`scanner_results`. Each row is one ML training example. The full structured object
is stored as a single `payload` JSON so the schema NEVER changes when fields are
added. A handful of scalar columns are mirrored for fast filtering/analytics.

**Never duplicates `CanonicalMarketSnapshot` fields** — it references the snapshot
by `snapshotId` only (see Replay Engine). `marketContext.snapshotId` is that
reference; the regime enums are scanner-derived, not copied market data.

```ts
export type ScannerDecision = "BUY" | "SELL" | "REJECT" | "NO_TRADE";
export type ScannerOutcome = "TP1" | "TP2" | "SL" | "TIMEOUT" | "CANCELLED" | null;

export interface ScannerResult {
  // --- Identity ---
  id: string;            // `${strategy}-${symbol}-${timestamp}-${snapshotId}`
  snapshotId: string;    // exact CanonicalMarketSnapshot reference (NEVER duplicated fields)
  sessionId: string;     // trading session for the day: `${symbol}-${date}`
  symbol: string;
  strategy: string;      // e.g. ZERO_HERO, SMC, INTRADAY, BTST
  engineVersion: string;
  featureVersion: number;
  schemaVersion: number;
  timestamp: string;

  // --- Decision ---
  decision: ScannerDecision;

  // --- Confidence ---
  confidence: number;                       // overall 0-100
  perEngineConfidence: Record<string, number>;
  riskScore: number;

  // --- Reasoning ---
  triggeredEngines: string[];
  rejectedConditions: string[];
  reasons: string[];                         // human-readable
  marketRegime: string;
  smartMoneyState: string;

  // --- Execution (null until a tradeable decision) ---
  selectedStrike: number | null;
  expiry: string | null;
  entry: number | null;
  tp1: number | null;
  tp2: number | null;
  sl: number | null;
  expectedRR: number | null;

  // --- Market Context (reference only) ---
  marketContext: {
    snapshotId: string;        // == Identity.snapshotId
    volatilityRegime: string;
    trendRegime: string;
    liquidityRegime: string;
  };

  // --- Outcome (filled later by audit/eval pipeline) ---
  outcome: {
    filled: boolean;
    result: ScannerOutcome;
    mfe: number | null;
    mae: number | null;
    finalPnl: number | null;
  };

  // --- Metadata ---
  metadata: {
    executionLatencyMs: number | null;
    recorderLatencyMs: number | null;
    dataCompleteness: number | null;   // 0-1
    replayCompatibility: boolean;
  };
}
```

## TradeRecord (trade feature snapshot)

Mirrors the operational trade ledger columns so replay/audit and the historical store
agree. Attached to a trade on register via `market_context_json`.

```ts
export interface TradeRecord {
  id: string;
  strategy: string;            // e.g. ZERO_HERO_AI
  symbol: string;
  strike: number;
  type: "CE" | "PE";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  exit: number | null;
  exitReason: string | null;   // TP1 / TP2 / SL / EXPIRY / MANUAL
  mfe: number | null;
  mae: number | null;
  holdingTimeSec: number | null;
  pnl: number | null;

  // --- feature snapshot at entry (from CanonicalMarketSnapshot) ---
  confidence: number;
  decision: Decision;
  reasons: string[];
  triggeredEngines: string[];
  rejectedConditions: string[];
  featureVector: Record<string, number>;
}
```

## EngineResult

```ts
export interface EngineResult {
  score: number;
  conf: number;
  direction: "CALL" | "PUT" | "NEUTRAL";
  prob: number;
  rr: number;
  sl: number;
  tp1: number;
  tp2: number;
  stars: number;
  lots: number;
  oiMatch: boolean;
  reasons: string[];
}
```

## ReplaySnapshot

A `CanonicalMarketSnapshot` exactly as reconstructed from `market_history.db` for a given
`(symbol, timestamp)`. Replay Engine returns them in time order; backtest and evaluation
consume them identically to live snapshots.

```ts
export interface ReplaySnapshot extends CanonicalMarketSnapshot {
  candles: Candle[]; // 1-minute OHLCV aligned to the snapshot timestamp
}

export interface Candle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
```

## EvaluationReport (M7 — Evaluation Framework)

Single `evaluate(filters)` that REUSES Trade Audit (trade metrics) and
Scanner Results (classification). No trading logic is modified. The 11
delivered metrics map exactly to the strategy-eval requirement.

```ts
export interface EvaluationFilters {
  strategy?: string;   // Zero Hero | SMC | BTST | Intraday (substring match)
  symbol?: string;
  dateFrom?: string;
  dateTo?: string;
  engineVersion?: string;
  featureVersion?: number;
}

export interface TradeMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  openTrades: number;
  winRate: number;
  profitFactor: number | null;
  expectancy: number;
  maxDrawdown: number;
  maxDrawdownPct: number | null;
  avgRMultiple: number;
  avgHoldingTimeSec: number | null;
  avgMfe: number | null;        // Mean Favorable Excursion
  avgMae: number | null;        // Mean Adverse Excursion
}

export interface ClassificationMetrics {
  totalScans: number;
  labeledSamples: number;     // scans with a filled outcome (ground truth)
  unlabeledSamples: number;   // outcome not yet filled
  tp: number; fp: number; tn: number; fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  confusionMatrix: { tp: number; fp: number; tn: number; fn: number };
}

export interface EvaluationReport {
  filters: EvaluationFilters;
  tradeMetrics: TradeMetrics;        // ← Trade Audit
  classification: ClassificationMetrics; // ← Scanner Results
  generatedAt: string;
}
```

Metric → source mapping:

| Metric | Source |
|---|---|
| Win Rate | Trade Audit (closed trades) |
| Profit Factor | Trade Audit |
| Expectancy | Trade Audit |
| Max Drawdown (+%) | Trade Audit (equity curve) |
| Average R Multiple | Trade Audit (`r_multiple`) |
| Average Holding Time | Trade Audit (`time_in_trade_sec`) |
| MFE / MAE | Trade Audit (`mfe`/`mae`) |
| Precision / Recall / F1 / Confusion | Scanner Results (`decision` vs `outcome`) |

Ground truth for classification comes from each `ScannerResult.outcome`
(filled by the audit/eval pipeline). A `decision` ∈ {BUY, BUY_CALL,
BUY_PUT, CALL, PUT, LONG} is a positive prediction; {REJECT, NO_TRADE,
HOLD, SELL, …} is negative. `outcome.filled === false` → unlabeled.

