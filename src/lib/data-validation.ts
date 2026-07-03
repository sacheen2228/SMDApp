// Data Validation Layer
// Sanitizes and validates Breeze API responses before processing

import type { SDMOptionStrike } from '@/types/sdm';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  sanitizedStrikes: SDMOptionStrike[];
  spotPrice: number;
}

// ─── Validate & Sanitize Option Chain ────────────────────────────
export function validateAndSanitize(
  rawStrikes: SDMOptionStrike[],
  rawSpot: number,
  source: string
): ValidationResult {
  const result: ValidationResult = {
    valid: false,
    errors: [],
    warnings: [],
    sanitizedStrikes: [],
    spotPrice: 0,
  };

  // 1. Validate spot price
  if (!rawSpot || rawSpot <= 0 || isNaN(rawSpot)) {
    result.errors.push('Invalid spot price: ' + rawSpot);
    // Try to infer from first strike
    if (rawStrikes.length > 0) {
      result.warnings.push('Spot price invalid, inferring from option chain');
      result.spotPrice = rawStrikes[0].strike;
    } else {
      return result;
    }
  } else {
    result.spotPrice = rawSpot;
  }

  // 2. Validate strikes array
  if (!Array.isArray(rawStrikes) || rawStrikes.length === 0) {
    result.errors.push('Empty or invalid option chain data');
    return result;
  }

  // 3. Sanitize each strike
  const sanitized: SDMOptionStrike[] = [];
  let strikesWithCE = 0;
  let strikesWithPE = 0;
  let strikesWithBoth = 0;
  let strikesWithZeroLTP = 0;
  let totalStrikes = 0;

  for (const raw of rawStrikes) {
    // Skip strikes with invalid data
    if (!raw || typeof raw.strike !== 'number' || isNaN(raw.strike)) {
      result.warnings.push('Skipping strike with invalid strike price');
      continue;
    }

    totalStrikes++;

    // Sanitize CE leg
    const ce = raw.ce ? {
      ltp: sanitizeNumber(raw.ce.ltp, 0),
      oi: sanitizeNumber(raw.ce.oi, 0),
      oiChg: sanitizeNumber(raw.ce.oiChg, 0),
      volume: sanitizeNumber(raw.ce.volume, 0),
      iv: sanitizeNumber(raw.ce.iv, 0),
      delta: sanitizeNumber(raw.ce.delta, 0),
      theta: sanitizeNumber(raw.ce.theta, 0),
      gamma: sanitizeNumber(raw.ce.gamma, 0),
      vega: sanitizeNumber(raw.ce.vega, 0),
      bid: sanitizeNumber(raw.ce.bid, 0),
      ask: sanitizeNumber(raw.ce.ask, 0),
    } : null;

    // Sanitize PE leg
    const pe = raw.pe ? {
      ltp: sanitizeNumber(raw.pe.ltp, 0),
      oi: sanitizeNumber(raw.pe.oi, 0),
      oiChg: sanitizeNumber(raw.pe.oiChg, 0),
      volume: sanitizeNumber(raw.pe.volume, 0),
      iv: sanitizeNumber(raw.pe.iv, 0),
      delta: sanitizeNumber(raw.pe.delta, 0),
      theta: sanitizeNumber(raw.pe.theta, 0),
      gamma: sanitizeNumber(raw.pe.gamma, 0),
      vega: sanitizeNumber(raw.pe.vega, 0),
      bid: sanitizeNumber(raw.pe.bid, 0),
      ask: sanitizeNumber(raw.pe.ask, 0),
    } : null;

    if (ce) strikesWithCE++;
    if (pe) strikesWithPE++;
    if (ce && pe) strikesWithBoth++;
    if ((ce && ce.ltp <= 0) || (pe && pe.ltp <= 0)) strikesWithZeroLTP++;

    sanitized.push({ strike: raw.strike, ce, pe });
  }

  // 4. Quality checks
  if (totalStrikes < 5) {
    result.warnings.push(`Only ${totalStrikes} strikes available — data may be incomplete`);
  }

  if (strikesWithBoth < totalStrikes * 0.5) {
    result.warnings.push(`Less than 50% of strikes have both CE and PE data`);
  }

  if (strikesWithZeroLTP > totalStrikes * 0.3) {
    result.warnings.push(`${strikesWithZeroLTP}/${totalStrikes} strikes have zero LTP — market may be closed`);
  }

  // 5. Validate ATM proximity
  const nearestStrike = sanitized.reduce((best, s) =>
    Math.abs(s.strike - result.spotPrice) < Math.abs(best.strike - result.spotPrice) ? s : best
  );
  if (nearestStrike) {
    const distance = Math.abs(nearestStrike.strike - result.spotPrice) / result.spotPrice * 100;
    if (distance > 2) {
      result.warnings.push(`ATM strike ${nearestStrike.strike} is ${distance.toFixed(1)}% from spot — may be stale`);
    }
  }

  // 6. Validate Greeks
  const hasGreeks = sanitized.some(s => s.ce && s.ce.delta !== 0) || sanitized.some(s => s.pe && s.pe.delta !== 0);
  if (!hasGreeks && source !== 'simulation') {
    result.warnings.push('No Greeks data available — SDM analysis quality may be reduced');
  }

  result.sanitizedStrikes = sanitized;
  result.valid = sanitized.length >= 5;

  return result;
}

// ─── Sanitize Number ─────────────────────────────────────────────
function sanitizeNumber(value: any, fallback: number): number {
  if (typeof value === 'number' && !isNaN(value) && isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (!isNaN(parsed) && isFinite(parsed)) return parsed;
  }
  return fallback;
}

// ─── Check Data Freshness ────────────────────────────────────────
export function checkDataFreshness(
  lastUpdate: string,
  maxAgeMs: number = 30000
): { fresh: boolean; age: number; message: string } {
  const age = Date.now() - new Date(lastUpdate).getTime();
  const fresh = age < maxAgeMs;
  const ageSeconds = Math.round(age / 1000);

  return {
    fresh,
    age,
    message: fresh
      ? `Data is ${ageSeconds}s old`
      : `Data is ${ageSeconds}s old — may be stale`,
  };
}
