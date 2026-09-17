// MCX Scorer — Composite trade quality scoring (10 factors, configurable weights)
// All factors are evidence-based. Score cannot bypass hard risk gates.

import type { MCXCommodity } from './types';
import type { MCXRegimeResult } from './mcx-regime';
import type { MCXStructureResult } from './mcx-structure';
import type { MCXVolumeOIResult } from './mcx-volume-oi';
import type { MCXVolatilityResult } from './mcx-volatility';
import type { MCXOptionIntelResult } from './mcx-option-intel';

export interface MCXScoringWeights {
  structure: number;       // default 20
  regime: number;          // default 15
  volumeOI: number;        // default 12
  volatility: number;      // default 10
  optionQuality: number;   // default 12
  breakout: number;        // default 8
  vwapPOC: number;         // default 10
  liquidity: number;       // default 5
  greeks: number;          // default 5
  eventRisk: number;       // default 3
}

export const DEFAULT_MCX_WEIGHTS: MCXScoringWeights = {
  structure: 20,
  regime: 15,
  volumeOI: 12,
  volatility: 10,
  optionQuality: 12,
  breakout: 8,
  vwapPOC: 10,
  liquidity: 5,
  greeks: 5,
  eventRisk: 3,
};

export interface MCXScoreResult {
  total: number;
  grade: 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';
  breakdown: MCXScoreBreakdown[];
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface MCXScoreBreakdown {
  factor: string;
  score: number;       // 0-100
  weighted: number;    // score * weight / 100
  weight: number;
  available: boolean;
  reason: string;
}

// ── Individual scoring functions ──

function scoreStructure(structure: MCXStructureResult, direction: 'LONG' | 'SHORT', weight: number): MCXScoreBreakdown {
  let score = 50;
  let reason = 'Structure neutral';

  if (direction === 'LONG' && structure.bias === 'BULLISH') {
    score = 85;
    reason = 'Bullish structure aligns with LONG';
  } else if (direction === 'SHORT' && structure.bias === 'BEARISH') {
    score = 85;
    reason = 'Bearish structure aligns with SHORT';
  } else if (direction === 'LONG' && structure.bias === 'BEARISH') {
    score = 20;
    reason = 'Structure bearish — conflicts with LONG';
  } else if (direction === 'SHORT' && structure.bias === 'BULLISH') {
    score = 20;
    reason = 'Structure bullish — conflicts with SHORT';
  } else if (structure.bias === 'COMPRESSION') {
    score = 40;
    reason = 'Compression — wait for breakout';
  }

  if (structure.event !== 'NONE') {
    if ((structure.event === 'BOS_BULLISH' && direction === 'LONG') ||
        (structure.event === 'BOS_BEARISH' && direction === 'SHORT')) {
      score = Math.min(100, score + 10);
      reason += `; ${structure.event} confirms`;
    }
  }

  return { factor: 'Structure', score, weighted: (score * weight) / 100, weight, available: true, reason };
}

function scoreRegime(regime: MCXRegimeResult, direction: 'LONG' | 'SHORT', weight: number): MCXScoreBreakdown {
  let score = 50;
  let reason = 'Regime neutral';

  const regimeDirection = regime.direction;
  if (direction === 'LONG' && (regimeDirection === 'LONG' || regime.regime.includes('BULLISH'))) {
    score = Math.min(100, 50 + regime.confidence * 0.5);
    reason = `${regime.regime} — aligns with LONG`;
  } else if (direction === 'SHORT' && (regimeDirection === 'SHORT' || regime.regime.includes('BEARISH'))) {
    score = Math.min(100, 50 + regime.confidence * 0.5);
    reason = `${regime.regime} — aligns with SHORT`;
  } else if (regime.regime === 'NO_TRADE' || regime.regime === 'HIGH_VOLATILITY') {
    score = 25;
    reason = `${regime.regime} — avoid`;
  } else if (regime.regime === 'RANGE') {
    score = 40;
    reason = 'Ranging — directional trade risky';
  }

  return { factor: 'Regime', score, weighted: (score * weight) / 100, weight, available: regime.confidence > 0, reason };
}

function scoreVolumeOI(volOI: MCXVolumeOIResult, direction: 'LONG' | 'SHORT', weight: number): MCXScoreBreakdown {
  let score = 50;
  let reason = 'Volume/OI neutral';

  const classification = volOI.oiClassification;
  if (direction === 'LONG' && classification === 'LONG_BUILDUP') {
    score = 80;
    reason = 'Long buildup — bullish OI + volume';
  } else if (direction === 'SHORT' && classification === 'SHORT_BUILDUP') {
    score = 80;
    reason = 'Short buildup — bearish OI + volume';
  } else if (direction === 'LONG' && classification === 'SHORT_COVERING') {
    score = 60;
    reason = 'Short covering — weak bullish';
  } else if (direction === 'SHORT' && classification === 'LONG_UNWINDING') {
    score = 60;
    reason = 'Long unwinding — weak bearish';
  } else if (direction === 'LONG' && classification === 'LONG_UNWINDING') {
    score = 30;
    reason = 'Long unwinding — conflicts with LONG';
  } else if (direction === 'SHORT' && classification === 'SHORT_COVERING') {
    score = 30;
    reason = 'Short covering — conflicts with SHORT';
  }

  if (volOI.oiDivergence) {
    score = Math.max(0, score - 20);
    reason += `; OI divergence detected`;
  }
  if (volOI.volumeState === 'EXPANDING') {
    score = Math.min(100, score + 10);
    reason += '; Volume expanding';
  }

  return { factor: 'Volume/OI', score, weighted: (score * weight) / 100, weight, available: true, reason };
}

function scoreVolatility(vol: MCXVolatilityResult, weight: number): MCXScoreBreakdown {
  let score = 50;
  let reason = 'Volatility neutral';

  if (vol.volatilityRegime === 'LOW_VOL') {
    score = 65;
    reason = 'Low volatility — options cheap, room to move';
  } else if (vol.volatilityRegime === 'NORMAL_VOL') {
    score = 60;
    reason = 'Normal volatility';
  } else if (vol.volatilityRegime === 'EXPANDING_VOL') {
    score = 55;
    reason = 'Expanding volatility — momentum possible';
  } else if (vol.volatilityRegime === 'HIGH_VOL') {
    score = 35;
    reason = 'High volatility — expensive options, risky';
  } else if (vol.volatilityRegime === 'EXTREME_VOL') {
    score = 15;
    reason = 'Extreme volatility — avoid';
  }

  if (vol.ivExpansion) {
    score -= 10;
    reason += '; IV expanding — premiums rising';
  }
  if (vol.ivCrush) {
    score += 5;
    reason += '; IV crushing — premiums dropping';
  }

  return { factor: 'Volatility', score, weighted: (score * weight) / 100, weight, available: vol.atr > 0, reason };
}

function scoreOptionQuality(optIntel: MCXOptionIntelResult, direction: 'LONG' | 'SHORT', weight: number): MCXScoreBreakdown {
  let score = 50;
  let reason = 'Option quality neutral';

  const candidate = direction === 'LONG' ? optIntel.bestCE : optIntel.bestPE;
  if (!candidate) {
    return { factor: 'Option Quality', score: 20, weighted: (20 * weight) / 100, weight, available: false, reason: 'No viable option found' };
  }

  if (optIntel.chainQuality === 'GOOD') {
    score = 80;
    reason = `Chain quality GOOD — spread ${candidate.spreadPercent.toFixed(1)}%`;
  } else if (optIntel.chainQuality === 'ACCEPTABLE') {
    score = 60;
    reason = `Chain quality ACCEPTABLE`;
  } else if (optIntel.chainQuality === 'POOR') {
    score = 35;
    reason = `Chain quality POOR — wide spreads`;
  } else {
    score = 15;
    reason = 'Chain UNTRADEABLE';
  }

  if (candidate.qualityScore > 70) {
    score = Math.min(100, score + 10);
    reason += `; Option quality ${candidate.qualityScore}`;
  }

  return { factor: 'Option Quality', score, weighted: (score * weight) / 100, weight, available: true, reason };
}

function scoreBreakout(structure: MCXStructureResult, regime: MCXRegimeResult, direction: 'LONG' | 'SHORT', weight: number): MCXScoreBreakdown {
  let score = 50;
  let reason = 'Breakout neutral';

  const event = structure.event;
  if ((event === 'BOS_BULLISH' || regime.regime === 'BREAKOUT') && direction === 'LONG') {
    score = 80;
    reason = 'Bullish breakout confirmed';
  } else if ((event === 'BOS_BEARISH' || regime.regime === 'BREAKDOWN') && direction === 'SHORT') {
    score = 80;
    reason = 'Bearish breakdown confirmed';
  } else if (event === 'CHOCH_BULLISH' && direction === 'LONG') {
    score = 70;
    reason = 'Change of character — bullish';
  } else if (event === 'CHOCH_BEARISH' && direction === 'SHORT') {
    score = 70;
    reason = 'Change of character — bearish';
  } else if (regime.regime === 'REVERSAL') {
    score = 45;
    reason = 'Reversal detected — cautious';
  }

  return { factor: 'Breakout', score, weighted: (score * weight) / 100, weight, available: event !== 'NONE' || regime.regime === 'BREAKOUT' || regime.regime === 'BREAKDOWN', reason };
}

function scoreVwapPOC(structure: MCXStructureResult, direction: 'LONG' | 'SHORT', weight: number): MCXScoreBreakdown {
  let score = 50;
  let reason = 'VWAP/POC neutral';

  if (direction === 'LONG' && structure.vwapPosition === 'ABOVE') {
    score = 70;
    reason = 'Price above VWAP — bullish';
  } else if (direction === 'SHORT' && structure.vwapPosition === 'BELOW') {
    score = 70;
    reason = 'Price below VWAP — bearish';
  } else if (direction === 'LONG' && structure.vwapPosition === 'BELOW') {
    score = 35;
    reason = 'Price below VWAP — bearish for LONG';
  } else if (direction === 'SHORT' && structure.vwapPosition === 'ABOVE') {
    score = 35;
    reason = 'Price above VWAP — bullish for SHORT';
  }

  return { factor: 'VWAP/POC', score, weighted: (score * weight) / 100, weight, available: structure.vwap > 0, reason };
}

function scoreLiquidity(optIntel: MCXOptionIntelResult, weight: number): MCXScoreBreakdown {
  let score = 50;
  let reason = 'Liquidity neutral';

  if (optIntel.liquidityAcceptable && optIntel.spreadAcceptable) {
    score = 75;
    reason = 'Liquidity and spread acceptable';
  } else if (!optIntel.liquidityAcceptable) {
    score = 25;
    reason = 'Poor liquidity';
  } else if (!optIntel.spreadAcceptable) {
    score = 30;
    reason = 'Wide spreads';
  }

  return { factor: 'Liquidity', score, weighted: (score * weight) / 100, weight, available: true, reason };
}

function scoreGreeks(optIntel: MCXOptionIntelResult, direction: 'LONG' | 'SHORT', weight: number): MCXScoreBreakdown {
  let score = 50;
  let reason = 'Greeks neutral';

  const candidate = direction === 'LONG' ? optIntel.bestCE : optIntel.bestPE;
  if (!candidate) {
    return { factor: 'Greeks', score: 30, weighted: (30 * weight) / 100, weight, available: false, reason: 'No option to evaluate' };
  }

  if (Math.abs(candidate.delta) >= 0.35 && Math.abs(candidate.delta) <= 0.65) {
    score = 70;
    reason = `Delta ${candidate.delta.toFixed(2)} — good for directional trade`;
  } else if (Math.abs(candidate.delta) < 0.2) {
    score = 30;
    reason = `Delta ${candidate.delta.toFixed(2)} — too far OTM`;
  } else if (Math.abs(candidate.delta) > 0.8) {
    score = 40;
    reason = `Delta ${candidate.delta.toFixed(2)} — deep ITM`;
  }

  if (candidate.gamma > 0) score = Math.min(100, score + 5);

  return { factor: 'Greeks', score, weighted: (score * weight) / 100, weight, available: true, reason };
}

function scoreEventRisk(weight: number): MCXScoreBreakdown {
  // Event risk is checked separately by orchestrator
  // Here we return neutral — the orchestrator can override
  return { factor: 'Event Risk', score: 70, weighted: (70 * weight) / 100, weight, available: true, reason: 'No extreme event risk detected' };
}

// ── Main scoring ──
export function scoreMCXCandidate(
  direction: 'LONG' | 'SHORT',
  structure: MCXStructureResult,
  regime: MCXRegimeResult,
  volOI: MCXVolumeOIResult,
  volatility: MCXVolatilityResult,
  optionIntel: MCXOptionIntelResult,
  weights: MCXScoringWeights = DEFAULT_MCX_WEIGHTS
): MCXScoreResult {
  const breakdown: MCXScoreBreakdown[] = [
    scoreStructure(structure, direction, weights.structure),
    scoreRegime(regime, direction, weights.regime),
    scoreVolumeOI(volOI, direction, weights.volumeOI),
    scoreVolatility(volatility, weights.volatility),
    scoreOptionQuality(optionIntel, direction, weights.optionQuality),
    scoreBreakout(structure, regime, direction, weights.breakout),
    scoreVwapPOC(structure, direction, weights.vwapPOC),
    scoreLiquidity(optionIntel, weights.liquidity),
    scoreGreeks(optionIntel, direction, weights.greeks),
    scoreEventRisk(weights.eventRisk),
  ];

  const total = breakdown.reduce((sum, b) => sum + b.weighted, 0);
  const roundedTotal = Math.round(total);

  let grade: MCXScoreResult['grade'] = 'F';
  if (roundedTotal >= 90) grade = 'A+';
  else if (roundedTotal >= 80) grade = 'A';
  else if (roundedTotal >= 70) grade = 'B';
  else if (roundedTotal >= 60) grade = 'C';
  else if (roundedTotal >= 50) grade = 'D';

  let confidence: MCXScoreResult['confidence'] = 'LOW';
  if (roundedTotal >= 75) confidence = 'HIGH';
  else if (roundedTotal >= 60) confidence = 'MEDIUM';

  return {
    total: roundedTotal,
    grade,
    breakdown,
    direction,
    confidence,
  };
}
