// Data Health Monitor - Evaluates data quality and determines trade readiness
// Provides health scoring, trade blocking, and warning indicators

// ─── Types ───────────────────────────────────────────────────────
export interface DataHealthReport {
  score: number; // 0-100
  status: "HEALTHY" | "DEGRADED" | "CRITICAL" | "OFFLINE";
  latencyMs: number;
  freshnessMs: number;
  completeness: number; // 0-1
  greeksAvailable: boolean;
  source: string;
  issues: string[];
  timestamp: string;
}

interface HealthInput {
  latencyMs: number;
  lastUpdateMs: number;
  totalStrikes: number;
  strikesWithMissingData: number;
  atmHasGreeks: boolean;
  source: string;
}

// ─── Thresholds ──────────────────────────────────────────────────
const THRESHOLDS = {
  latency: { good: 500, degraded: 2000 },
  freshness: { good: 10000, stale: 60000 },
  completeness: { good: 0.95, degraded: 0.8 },
};

const NOW = () => Date.now();

// ─── Core Functions ──────────────────────────────────────────────

/**
 * Evaluate data health from raw metrics.
 * Returns a DataHealthReport with score (0-100) and status.
 */
export function evaluateDataHealth(input: HealthInput): DataHealthReport {
  const issues: string[] = [];
  let score = 100;

  // 1. Latency scoring (max -25 points)
  const latencyScore =
    input.latencyMs <= THRESHOLDS.latency.good
      ? 0
      : input.latencyMs <= THRESHOLDS.latency.degraded
        ? -10
        : -25;
  if (latencyScore < 0) {
    issues.push(`High latency: ${input.latencyMs}ms`);
  }
  score += latencyScore;

  // 2. Freshness scoring (max -30 points)
  const freshnessMs = NOW() - input.lastUpdateMs;
  const freshnessScore =
    freshnessMs <= THRESHOLDS.freshness.good
      ? 0
      : freshnessMs <= THRESHOLDS.freshness.stale
        ? -15
        : -30;
  if (freshnessScore < 0) {
    issues.push(`Data is stale: ${Math.round(freshnessMs / 1000)}s old`);
  }
  score += freshnessScore;

  // 3. Completeness scoring (max -25 points)
  const completeness =
    input.totalStrikes > 0
      ? 1 - input.strikesWithMissingData / input.totalStrikes
      : 0;
  const completenessScore =
    completeness >= THRESHOLDS.completeness.good
      ? 0
      : completeness >= THRESHOLDS.completeness.degraded
        ? -10
        : -25;
  if (completenessScore < 0) {
    issues.push(
      `Incomplete data: ${(completeness * 100).toFixed(1)}% strikes populated`
    );
  }
  score += completenessScore;

  // 4. Greeks availability (max -20 points)
  const greeksScore = input.atmHasGreeks ? 0 : -20;
  if (!input.atmHasGreeks) {
    issues.push("ATM Greeks missing");
  }
  score += greeksScore;

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  // Determine status
  let status: DataHealthReport["status"];
  if (score >= 80) status = "HEALTHY";
  else if (score >= 50) status = "DEGRADED";
  else if (score > 0) status = "CRITICAL";
  else status = "OFFLINE";

  return {
    score,
    status,
    latencyMs: input.latencyMs,
    freshnessMs,
    completeness: Math.round(completeness * 100) / 100,
    greeksAvailable: input.atmHasGreeks,
    source: input.source,
    issues,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Returns true if trades should be completely blocked.
 * Triggers when data is CRITICAL or OFFLINE.
 */
export function shouldBlockTrades(health: DataHealthReport): boolean {
  return health.status === "CRITICAL" || health.status === "OFFLINE" || health.score < 30;
}

/**
 * Returns true if a warning banner should be shown.
 * Triggers when data is DEGRADED or has any issues.
 */
export function shouldShowWarning(health: DataHealthReport): boolean {
  return health.status !== "HEALTHY" || health.issues.length > 0;
}
