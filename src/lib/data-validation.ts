// Data Validation Layer
// Sanitizes and validates Breeze API responses before processing
// V2: Added hard quality gates that block signals from invalid data

import type { SDMOptionStrike } from '@/types/sdm';
import type { OptionChain } from '@/types/canonical';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  sanitizedStrikes: SDMOptionStrike[];
  spotPrice: number;
}

// ─── Hard Quality Gates ────────────────────────────────────────────
// These conditions MUST pass for any trade signal to be generated.
// A correct WAIT is better than a false trade.

export interface QualityGateResult {
  passed: boolean;
  gate: string;
  reason: string;
  severity: 'BLOCK' | 'WARN';
}

export function runQualityGates(
  chain: OptionChain | null,
  spot: number,
  vix: number,
  source: string
): QualityGateResult[] {
  const gates: QualityGateResult[] = [];

  if (!chain) {
    gates.push({ passed: false, gate: 'CHAIN_AVAILABLE', reason: 'No option chain data', severity: 'BLOCK' });
    return gates;
  }

  // Gate 1: Spot price validity
  if (spot <= 0 || isNaN(spot)) {
    gates.push({ passed: false, gate: 'SPOT_VALID', reason: `Invalid spot price: ${spot}`, severity: 'BLOCK' });
  } else {
    gates.push({ passed: true, gate: 'SPOT_VALID', reason: 'Spot price valid', severity: 'BLOCK' });
  }

  // Gate 2: Minimum strikes with data
  const strikesWithData = chain.strikes.filter(s => (s.ce && s.ce.premium > 0) || (s.pe && s.pe.premium > 0)).length;
  if (strikesWithData < 5) {
    gates.push({ passed: false, gate: 'STRIKESWithData', reason: `Only ${strikesWithData} strikes with valid premiums (need ≥5)`, severity: 'BLOCK' });
  } else {
    gates.push({ passed: true, gate: 'STRIKESWithData', reason: `${strikesWithData} strikes with data`, severity: 'BLOCK' });
  }

  // Gate 3: OI data availability
  const hasOI = chain.strikes.some(s => (s.ce && s.ce.oi > 0) || (s.pe && s.pe.oi > 0));
  if (!hasOI) {
    gates.push({ passed: false, gate: 'OI_AVAILABLE', reason: 'No OI data — all signals will be unreliable', severity: 'BLOCK' });
  } else {
    gates.push({ passed: true, gate: 'OI_AVAILABLE', reason: 'OI data available', severity: 'BLOCK' });
  }

  // Gate 4: Greeks availability
  const hasGreeks = chain.strikes.some(s => (s.ce && Math.abs(s.ce.delta) > 0.01) || (s.pe && Math.abs(s.pe.delta) > 0.01));
  if (!hasGreeks && source !== 'simulation') {
    gates.push({ passed: false, gate: 'GREEKS_AVAILABLE', reason: 'No valid Greeks data — option scoring unreliable', severity: 'BLOCK' });
  } else {
    gates.push({ passed: true, gate: 'GREEKS_AVAILABLE', reason: 'Greeks available', severity: 'BLOCK' });
  }

  // Gate 5: VIX validity
  if (vix <= 0 || isNaN(vix) || vix > 100) {
    gates.push({ passed: false, gate: 'VIX_VALID', reason: `Invalid VIX: ${vix}`, severity: 'BLOCK' });
  } else {
    gates.push({ passed: true, gate: 'VIX_VALID', reason: `VIX: ${vix}`, severity: 'BLOCK' });
  }

  // Gate 6: PCR reasonableness
  if (chain.pcr < 0.1 || chain.pcr > 10) {
    gates.push({ passed: false, gate: 'PCR_REASONABLE', reason: `PCR out of range: ${chain.pcr}`, severity: 'WARN' });
  } else {
    gates.push({ passed: true, gate: 'PCR_REASONABLE', reason: `PCR: ${chain.pcr.toFixed(2)}`, severity: 'WARN' });
  }

  // Gate 7: ATM strike proximity
  const atmDiff = Math.abs(chain.atmStrike - spot) / spot * 100;
  if (atmDiff > 2) {
    gates.push({ passed: false, gate: 'ATM_PROXIMITY', reason: `ATM ${chain.atmStrike} is ${atmDiff.toFixed(1)}% from spot`, severity: 'WARN' });
  } else {
    gates.push({ passed: true, gate: 'ATM_PROXIMITY', reason: 'ATM near spot', severity: 'WARN' });
  }

  // Gate 8: Volume data
  const hasVolume = chain.strikes.some(s => (s.ce && s.ce.volume > 0) || (s.pe && s.pe.volume > 0));
  if (!hasVolume) {
    gates.push({ passed: false, gate: 'VOLUME_AVAILABLE', reason: 'No volume data — liquidity assessment unreliable', severity: 'WARN' });
  } else {
    gates.push({ passed: true, gate: 'VOLUME_AVAILABLE', reason: 'Volume data available', severity: 'WARN' });
  }

  return gates;
}

export function shouldBlockTrade(gates: QualityGateResult[]): { block: boolean; reasons: string[] } {
  const blocked = gates.filter(g => !g.passed && g.severity === 'BLOCK');
  return {
    block: blocked.length > 0,
    reasons: blocked.map(g => `[${g.gate}] ${g.reason}`),
  };
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
