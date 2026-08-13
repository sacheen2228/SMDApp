import type { ValidationResult } from './types';
import type { RegimeResult, SmartMoneyData, OpenInterestData } from '@/types/engine';

export interface ValidationInput {
  aiScore: number;
  confidence: number;
  rr: number;
  destinationProbability: number;
  dataQuality: number;
  direction: 'long' | 'short';
  regime: RegimeResult | null;
  smDirection: 'bullish' | 'bearish' | null;
  oiData: OpenInterestData | null;
}

export function validateTrade(input: ValidationInput): ValidationResult {
  const rejectReasons: string[] = [];
  let aiScore = input.aiScore;
  let confidence = input.confidence;
  let rr = input.rr;
  let destProb = input.destinationProbability;
  let dataQuality = input.dataQuality;

  // 1. AI Score < 70
  if (aiScore < 70) {
    rejectReasons.push(`AI Score ${aiScore} below minimum 70`);
  }

  // 2. Confidence < 70%
  if (confidence < 70) {
    rejectReasons.push(`Confidence ${(confidence * 100).toFixed(0)}% below minimum 70%`);
  }

  // 3. R:R < 1.5
  if (rr < 1.5) {
    rejectReasons.push(`Risk:Reward ${rr.toFixed(2)} below minimum 1.5`);
  }

  // 4. Trend conflicts with auction / smart money
  if (input.regime && input.smDirection) {
    const isBull = input.direction === 'long';
    const smConflicts = (isBull && input.smDirection === 'bearish') || (!isBull && input.smDirection === 'bullish');
    const regimeConflicts = input.regime.regime === 'compression' || input.regime.regime === 'range';
    if (smConflicts) {
      rejectReasons.push(`Trend conflicts with Smart Money: direction=${input.direction}, SM=${input.smDirection}`);
    }
    if (regimeConflicts) {
      rejectReasons.push(`Regime (${input.regime.regime}) conflicts with directional trade`);
    }
  }

  // 5. Data Quality < 75%
  if (dataQuality < 75) {
    rejectReasons.push(`Data quality ${dataQuality}% below minimum 75%`);
  }

  // 6. Destination Probability < 70%
  if (destProb < 70) {
    rejectReasons.push(`Destination probability ${destProb}% below minimum 70%`);
  }

  // 7. OI check for derivatives
  if (input.oiData && input.oiData.currentOi === null) {
    rejectReasons.push('Open Interest data unavailable for derivatives trade');
  }

  return {
    approved: rejectReasons.length === 0,
    aiScore,
    confidence,
    rr,
    destinationProbability: destProb,
    dataQuality,
    rejectReasons,
  };
}
