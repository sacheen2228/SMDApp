// DEPRECATED: duplicate of the consolidated Zero Hero engine in src/lib/zero-hero.ts.
// Kept on disk until production consolidation is verified (see AGENTS.md Architecture Guardian).
// Do NOT use in new code.

// Market Regime Engine
// Analyzes India VIX, ATR, IV, HV to determine market regime

export interface MarketRegimeInput {
  vix: number;          // India VIX value
  atr: number;          // Average True Range of underlying
  iv: number;           // Implied Volatility (avg of ATM)
  hv: number;           // Historical Volatility (realized)
  daysToExpiry: number;
  spot: number;
}

export interface MarketRegimeOutput {
  regime: 'HIGH_VOL' | 'LOW_VOL' | 'TRENDING' | 'RANGING' | 'NEUTRAL';
  volatility_state: 'EXTREME' | 'HIGH' | 'NORMAL' | 'LOW';
  iv_rank: number;       // IV percentile (0-100)
  vix_percentile: number;
  expected_range: number;  // Expected move in points
  confidence: number;      // 0-100
}

export function marketRegimeEngine(input: MarketRegimeInput): MarketRegimeOutput {
  const { vix, atr, iv, hv, daysToExpiry, spot } = input;

  // VIX-based volatility state
  let volatility_state: 'EXTREME' | 'HIGH' | 'NORMAL' | 'LOW';
  if (vix > 25) volatility_state = 'EXTREME';
  else if (vix > 18) volatility_state = 'HIGH';
  else if (vix > 12) volatility_state = 'NORMAL';
  else volatility_state = 'LOW';

  // IV Rank (simplified - ratio of current IV to HV)
  const ivRank = hv > 0 ? Math.min(100, Math.max(0, (iv / hv) * 50)) : 50;

  // Expected move (using ATR * sqrt(daysToExpiry))
  const expectedRange = atr * Math.sqrt(Math.max(1, daysToExpiry)) * 1.5;

  // Regime classification
  let regime: 'HIGH_VOL' | 'LOW_VOL' | 'TRENDING' | 'RANGING' | 'NEUTRAL';
  if (volatility_state === 'EXTREME' || volatility_state === 'HIGH') {
    regime = 'HIGH_VOL';
  } else if (volatility_state === 'LOW') {
    regime = 'LOW_VOL';
  } else {
    // Determine trending vs ranging
    if (iv > hv * 1.1) regime = 'TRENDING';
    else if (iv < hv * 0.9) regime = 'RANGING';
    else regime = 'NEUTRAL';
  }

  return {
    regime,
    volatility_state,
    iv_rank: ivRank,
    vix_percentile: Math.min(100, (vix / 30) * 100),
    expected_range: expectedRange,
    confidence: 75,
  };
}
