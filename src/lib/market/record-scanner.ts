// Scanner Recording — builds + persists the permanent AI training dataset.
//
// Design goal (M5): every scanner cycle is recorded as a flat, ML-ready row.
// The contract is stored as a single `payload` JSON so NO future schema change
// is required when fields are added. ScannerResult NEVER duplicates
// CanonicalMarketSnapshot fields — it references the snapshot by `snapshotId` only.
import { recordScannerResults, getScannerResults } from "@/lib/market-history-client";
import { SCHEMA_VERSION, FEATURE_VERSION, ENGINE_VERSION } from "@/lib/market/canonical";

export type ScannerDecision = "BUY" | "SELL" | "REJECT" | "NO_TRADE";

// Resolved outcome of a scanner result (populated by the Outcome Pipeline).
export type Outcome =
  | "WIN"        // trade executed and closed at a profit
  | "LOSS"       // trade executed and closed at a loss
  | "NO_FILL"    // tradeable signal but never executed / not tracked
  | "CANCELLED"  // reject / no-trade decision (correctly did not trade)
  | "EXPIRED";   // option expired worthless / at expiry

// Why the position exited (or why it was never taken).
export type ExitReason =
  | "TP1"
  | "TP2"
  | "SL"
  | "Manual"
  | "Time Exit"
  | "Expiry"
  | null;

// The permanent AI training dataset row's outcome block.
export interface ScannerOutcome {
  filled: boolean; // a real trade was executed & tracked (Trade Audit)
  outcome: Outcome;
  exitReason: ExitReason;
  exitPrice: number | null;
  exitTime: string | null;
  mfe: number | null; // max favourable excursion (price points)
  mae: number | null; // max adverse excursion (price points)
  finalRMultiple: number | null;
  holdingTimeSec: number | null;
  // retained for downstream compatibility:
  result: string | null; // legacy alias of exitReason
  finalPnl: number | null;
  resolvedAt: string | null;
}

// The permanent AI training dataset row.
export interface ScannerResult {
  // ── Identity ──
  id: string; // `${strategy}-${symbol}-${timestamp}-${snapshotId}`
  snapshotId: string; // exact CanonicalMarketSnapshot reference (NEVER duplicated fields)
  sessionId: string; // trading session for the day: `${symbol}-${date}`
  symbol: string;
  strategy: string; // e.g. ZERO_HERO, SMC, INTRADAY, BTST
  engineVersion: string;
  featureVersion: number;
  schemaVersion: number;
  timestamp: string;

  // ── Decision ──
  decision: ScannerDecision;

  // ── Confidence ──
  confidence: number; // overall 0-100
  perEngineConfidence: Record<string, number>;
  riskScore: number;

  // ── Reasoning ──
  triggeredEngines: string[];
  rejectedConditions: string[];
  reasons: string[];
  marketRegime: string;
  smartMoneyState: string;

  // ── Execution (null until a tradeable decision) ──
  selectedStrike: number | null;
  expiry: string | null;
  entry: number | null;
  tp1: number | null;
  tp2: number | null;
  sl: number | null;
  expectedRR: number | null;

  // ── Market Context (reference only — no snapshot field duplication) ──
  marketContext: {
    snapshotId: string;
    volatilityRegime: string;
    trendRegime: string;
    liquidityRegime: string;
  };

  // ── Outcome (filled later by the Outcome Pipeline) ──
  outcome: ScannerOutcome;

  // ── Metadata ──
  metadata: {
    executionLatencyMs: number | null;
    recorderLatencyMs: number | null;
    dataCompleteness: number | null; // 0-1
    replayCompatibility: boolean;
  };
}

export interface ScannerResultInput {
  symbol: string;
  strategy: string;
  decision: ScannerDecision;
  snapshotId: string;
  sessionId?: string;
  timestamp?: string;
  confidence?: number;
  perEngineConfidence?: Record<string, number>;
  riskScore?: number;
  triggeredEngines?: string[];
  rejectedConditions?: string[];
  reasons?: string[];
  marketRegime?: string;
  smartMoneyState?: string;
  selectedStrike?: number | null;
  expiry?: string | null;
  entry?: number | null;
  tp1?: number | null;
  tp2?: number | null;
  sl?: number | null;
  expectedRR?: number | null;
  volatilityRegime?: string;
  trendRegime?: string;
  liquidityRegime?: string;
  outcome?: Partial<ScannerOutcome>;
  executionLatencyMs?: number | null;
  recorderLatencyMs?: number | null;
  dataCompleteness?: number | null;
  replayCompatibility?: boolean;
}

export function buildSessionId(symbol: string, timestampISO: string): string {
  return `${symbol}-${timestampISO.slice(0, 10)}`;
}

export function buildScannerResult(input: ScannerResultInput): ScannerResult {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const sessionId = input.sessionId ?? buildSessionId(input.symbol, timestamp);
  // decision + strike make each cycle candidate a distinct training example,
  // while a re-post of the same cycle yields the SAME id (idempotent).
  const id = `${input.strategy}-${input.symbol}-${timestamp}-${input.snapshotId}-${input.decision}-${input.selectedStrike ?? 0}`;
  return {
    id,
    snapshotId: input.snapshotId,
    sessionId,
    symbol: input.symbol,
    strategy: input.strategy,
    engineVersion: ENGINE_VERSION,
    featureVersion: FEATURE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    timestamp,
    decision: input.decision,
    confidence: input.confidence ?? 0,
    perEngineConfidence: input.perEngineConfidence ?? {},
    riskScore: input.riskScore ?? 0,
    triggeredEngines: input.triggeredEngines ?? [],
    rejectedConditions: input.rejectedConditions ?? [],
    reasons: input.reasons ?? [],
    marketRegime: input.marketRegime ?? "UNKNOWN",
    smartMoneyState: input.smartMoneyState ?? "UNKNOWN",
    selectedStrike: input.selectedStrike ?? null,
    expiry: input.expiry ?? null,
    entry: input.entry ?? null,
    tp1: input.tp1 ?? null,
    tp2: input.tp2 ?? null,
    sl: input.sl ?? null,
    expectedRR: input.expectedRR ?? null,
    marketContext: {
      snapshotId: input.snapshotId,
      volatilityRegime: input.volatilityRegime ?? "UNKNOWN",
      trendRegime: input.trendRegime ?? "UNKNOWN",
      liquidityRegime: input.liquidityRegime ?? "UNKNOWN",
    },
    outcome: {
      filled: input.outcome?.filled ?? false,
      outcome: input.outcome?.outcome ?? "NO_FILL",
      exitReason: input.outcome?.exitReason ?? null,
      exitPrice: input.outcome?.exitPrice ?? null,
      exitTime: input.outcome?.exitTime ?? null,
      mfe: input.outcome?.mfe ?? null,
      mae: input.outcome?.mae ?? null,
      finalRMultiple: input.outcome?.finalRMultiple ?? null,
      holdingTimeSec: input.outcome?.holdingTimeSec ?? null,
      result: input.outcome?.result ?? null,
      finalPnl: input.outcome?.finalPnl ?? null,
      resolvedAt: input.outcome?.resolvedAt ?? null,
    },
    metadata: {
      executionLatencyMs: input.executionLatencyMs ?? null,
      recorderLatencyMs: input.recorderLatencyMs ?? null,
      dataCompleteness: input.dataCompleteness ?? null,
      replayCompatibility: input.replayCompatibility ?? true,
    },
  };
}

// Persist a scanner result (idempotent on id). Returns the full row.
export async function recordScannerResult(input: ScannerResultInput): Promise<ScannerResult> {
  const r = buildScannerResult(input);
  await recordScannerResults([r]);
  return r;
}

export { getScannerResults };
