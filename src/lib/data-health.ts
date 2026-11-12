export interface HealthInput {
  latencyMs: number;
  lastUpdateMs: number;
  totalStrikes: number;
  strikesWithMissingData: number;
  atmHasGreeks: boolean;
  source: string;
}

export interface HealthReport {
  status: 'HEALTHY' | 'DEGRADED' | 'STALE' | 'CRITICAL' | 'OFFLINE';
  score: number;
  issues: string[];
}

// ─── Thresholds ──────────────────────────────────────────────────
const THRESHOLDS = {
  latency: { good: 500, degraded: 2000 },
  freshness: { good: 10000, stale: 60000 },
  completeness: { good: 0.95, degraded: 0.8 },
};

// ─── NOW ───────────────────────────────────────────────────────────
const NOW = () => Date.now();

// ─── Block Trade Logic ───────────────────────────────────────────────────
/** Block trade if data health is CRITICAL or OFFLINE, or score below minimum threshold */
export function shouldBlockTrades(health: DataHealthReport): boolean {
  const minScore = 50; // minimum confidence floor for trading
  if (health.status === 'CRITICAL' || health.status === 'OFFLINE') return true;
  if (health.score < minScore) return true;
  if (health.status === 'STALE') return true; // stale data = block
  return false;
}

// ─── Core Functions ────────────────────────────────────────────────

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
  // Count only strikes with truly missing critical data (ltp, bid, ask), not greeks
  const completeness =
    input.totalStrikes > 0
      ? 1 - Math.min(input.strikesWithMissingData / input.totalStrikes, 1)
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

  // 5. Source reliability (max -10 points, optional)
  // const sourceScore = input.source === 'NSE' ? 0 : -10;

  let status: 'HEALTHY' | 'DEGRADED' | 'STALE' | 'CRITICAL' | 'OFFLINE';
  if (score >= 80) {
    status = 'HEALTHY';
  } else if (score >= 50) {
    status = 'DEGRADED';
  } else if (score >= 20) {
    status = 'STALE';
  } else {
    status = 'CRITICAL';
  }

  return { status, score, issues };
}
