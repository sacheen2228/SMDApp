// Zero Hero Engine
// Dedicated high-risk strategy for experienced users
// Only activated when explicitly enabled by the user
// Requires stricter confirmation than standard trades

import type { SDMOptionStrike, SDMRecommendation, TradeDirection } from '@/types/sdm';

export interface ZeroHeroConfig {
  enabled: boolean;
  maxCapitalPerTrade: number;    // Max capital per ZH trade
  minQualityScore: number;       // Minimum quality score (higher than normal)
  minConfidence: number;         // Minimum confidence (higher than normal)
  minRiskReward: number;         // Minimum R:R ratio
  requireVolumeConfirm: boolean; // Require volume confirmation
  requireSpreadCheck: boolean;   // Require tight spread check
  maxSpreadPercent: number;      // Max bid-ask spread %
}

export const DEFAULT_ZERO_HERO_CONFIG: ZeroHeroConfig = {
  enabled: false,
  maxCapitalPerTrade: 25000,
  minQualityScore: 70,
  minConfidence: 65,
  minRiskReward: 2.5,
  requireVolumeConfirm: true,
  requireSpreadCheck: true,
  maxSpreadPercent: 5,
};

export interface ZeroHeroSignal {
  eligible: boolean;
  direction: 'CALL' | 'PUT' | null;
  strike: number;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  confidence: number;
  riskReward: number;
  reasons: string[];
  warnings: string[];
  premiumMetrics: {
    spread: number;
    spreadPercent: number;
    volume: number;
    oi: number;
    iv: number;
  };
}

// ─── Evaluate Zero Hero Eligibility ──────────────────────────────
export function evaluateZeroHero(
  optionChain: SDMOptionStrike[],
  spot: number,
  direction: 'CALL' | 'PUT',
  qualityScore: number,
  confidence: number,
  config: ZeroHeroConfig = DEFAULT_ZERO_HERO_CONFIG
): ZeroHeroSignal {
  const result: ZeroHeroSignal = {
    eligible: false,
    direction: null,
    strike: 0,
    entry: 0,
    sl: 0,
    tp1: 0,
    tp2: 0,
    confidence: 0,
    riskReward: 0,
    reasons: [],
    warnings: [],
    premiumMetrics: { spread: 0, spreadPercent: 0, volume: 0, oi: 0, iv: 0 },
  };

  if (!config.enabled) {
    result.warnings.push('Zero Hero is disabled. Enable in settings.');
    return result;
  }

  // Find ATM strike
  const atm = optionChain.reduce((best, s) =>
    Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best
  );
  if (!atm) {
    result.warnings.push('No ATM strike found');
    return result;
  }

  const leg = direction === 'CALL' ? atm.ce : atm.pe;
  if (!leg || leg.ltp <= 0) {
    result.warnings.push('ATM leg has no data');
    return result;
  }

  // Check quality score threshold
  if (qualityScore < config.minQualityScore) {
    result.warnings.push(`Quality score ${qualityScore} below ZH minimum ${config.minQualityScore}`);
    return result;
  }

  // Check confidence threshold
  if (confidence < config.minConfidence) {
    result.warnings.push(`Confidence ${confidence}% below ZH minimum ${config.minConfidence}%`);
    return result;
  }

  // Check spread
  const bid = leg.bid || 0;
  const ask = leg.ask || 0;
  const spread = ask > 0 && bid > 0 ? ask - bid : 0;
  const midPrice = (ask + bid) / 2 || leg.ltp;
  const spreadPercent = midPrice > 0 ? (spread / midPrice) * 100 : 0;

  result.premiumMetrics = {
    spread,
    spreadPercent: Math.round(spreadPercent * 10) / 10,
    volume: leg.volume,
    oi: leg.oi,
    iv: leg.iv,
  };

  if (config.requireSpreadCheck && spreadPercent > config.maxSpreadPercent) {
    result.warnings.push(`Spread ${spreadPercent.toFixed(1)}% exceeds max ${config.maxSpreadPercent}%`);
    return result;
  }

  // Check volume
  if (config.requireVolumeConfirm && leg.volume < 100) {
    result.warnings.push(`Volume ${leg.volume} too low for ZH entry`);
    return result;
  }

  // Calculate ZH-specific levels
  const entry = leg.ltp;
  const sl = entry * 0.80;  // Tighter SL for ZH (20% vs normal 15%)
  const tp1 = entry * 1.50; // Higher TP1 target
  const tp2 = entry * 2.50; // Aggressive TP2
  const riskReward = entry > sl ? (tp2 - entry) / (entry - sl) : 0;

  if (riskReward < config.minRiskReward) {
    result.warnings.push(`R:R ${riskReward.toFixed(1)} below ZH minimum ${config.minRiskReward}`);
    return result;
  }

  // All checks passed
  result.eligible = true;
  result.direction = direction;
  result.strike = atm.strike;
  result.entry = entry;
  result.sl = sl;
  result.tp1 = tp1;
  result.tp2 = tp2;
  result.confidence = Math.min(confidence + 5, 95); // Slight boost for ZH
  result.riskReward = Math.round(riskReward * 10) / 10;
  result.reasons.push(`ZH eligible: quality ${qualityScore}, confidence ${confidence}%, R:R 1:${riskReward.toFixed(1)}`);
  result.reasons.push(`Spread ${spreadPercent.toFixed(1)}%, volume ${leg.volume}, IV ${leg.iv.toFixed(1)}%`);

  return result;
}

// ─── Get Zero Hero Position Sizing ───────────────────────────────
export function getZeroHeroPositionSize(
  entry: number,
  sl: number,
  lotSize: number,
  config: ZeroHeroConfig = DEFAULT_ZERO_HERO_CONFIG
): { lots: number; quantity: number; maxLoss: number } {
  const riskPerLot = Math.abs(entry - sl) * lotSize;
  const lots = riskPerLot > 0 ? Math.floor(config.maxCapitalPerTrade / (riskPerLot * 2)) : 0;
  const clampedLots = Math.min(lots, 5); // Max 5 lots for ZH
  return {
    lots: clampedLots,
    quantity: clampedLots * lotSize,
    maxLoss: riskPerLot * clampedLots,
  };
}
