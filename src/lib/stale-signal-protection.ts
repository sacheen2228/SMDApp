// StaleSignalProtection — blocks execution of expired signals

export interface Signal {
  symbol: string;
  strategy: string;
  direction: string;
  score: number;
  entry: number;
  stopLoss: number;
  target1: number;
  createdAt: Date;
  expiresAt: Date;
}

export function isSignalExpired(signal: Signal): { expired: boolean; reason?: string } {
  const now = new Date();

  if (now > signal.expiresAt) {
    const ageMs = now.getTime() - signal.createdAt.getTime();
    const ageMinutes = Math.round(ageMs / 60000);
    return {
      expired: true,
      reason: `Signal expired: created ${ageMinutes} minutes ago, TTL exceeded`,
    };
  }

  return { expired: false };
}

export function createSignal(params: {
  symbol: string;
  strategy: string;
  direction: string;
  score: number;
  entry: number;
  stopLoss: number;
  target1: number;
  ttlMinutes?: number;
}): Signal {
  const now = new Date();
  const ttl = params.ttlMinutes || 30; // default 30 minute TTL

  return {
    symbol: params.symbol,
    strategy: params.strategy,
    direction: params.direction,
    score: params.score,
    entry: params.entry,
    stopLoss: params.stopLoss,
    target1: params.target1,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttl * 60_000),
  };
}

export function validateSignalForExecution(signal: Signal, currentLTP: number): {
  valid: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  // Check expiry
  const expiry = isSignalExpired(signal);
  if (expiry.expired) {
    reasons.push(expiry.reason!);
  }

  // Check price staleness (LTP should be within 2% of entry)
  if (currentLTP > 0 && signal.entry > 0) {
    const slippage = Math.abs(currentLTP - signal.entry) / signal.entry;
    if (slippage > 0.02) {
      reasons.push(`Price moved ${(slippage * 100).toFixed(1)}% since signal — recalculate`);
    }
  }

  // Check score validity
  if (signal.score < 50) {
    reasons.push(`Score ${signal.score} too low for execution`);
  }

  return { valid: reasons.length === 0, reasons };
}
