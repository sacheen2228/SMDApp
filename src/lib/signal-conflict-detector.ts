// Signal Conflict Detection — prevents conflicting BUY CE / BUY PE signals
//
// When multiple engines produce signals, this layer detects conflicts
// and resolves them. A correct WAIT is better than a false trade.

import type { OptionChain } from '@/types/canonical';
import type { TradeDecision } from '@/lib/dynamic-options-engine';

export interface ConflictResult {
  hasConflict: boolean;
  resolvedDirection: 'CE' | 'PE' | 'BOTH' | 'NO_TRADE' | 'WAIT';
  confidence: number;
  reasons: string[];
  ceScore: number;
  peScore: number;
}

export interface EngineSignal {
  source: string;
  direction: 'CE' | 'PE' | 'BOTH' | 'NO_TRADE';
  confidence: number;
  score: number;
}

// ─── Detect and Resolve Conflicts ──────────────────────────────────

export function detectAndResolveConflicts(
  signals: EngineSignal[],
  chain: OptionChain | null,
  trend: 'bullish' | 'bearish' | 'neutral'
): ConflictResult {
  const reasons: string[] = [];
  let ceScore = 0;
  let peScore = 0;
  let ceCount = 0;
  let peCount = 0;

  for (const sig of signals) {
    if (sig.direction === 'CE' || sig.direction === 'BOTH') {
      ceScore += sig.score;
      ceCount++;
    }
    if (sig.direction === 'PE' || sig.direction === 'BOTH') {
      peScore += sig.score;
      peCount++;
    }
  }

  // Normalize scores
  const maxSignals = Math.max(signals.length, 1);
  ceScore = Math.round(ceScore / maxSignals);
  peScore = Math.round(peScore / maxSignals);

  // Check for direct conflict
  const hasCE = signals.some(s => s.direction === 'CE');
  const hasPE = signals.some(s => s.direction === 'PE');
  const hasConflict = hasCE && hasPE;

  if (!hasConflict) {
    // No conflict — use consensus direction
    if (hasCE && !hasPE) {
      return {
        hasConflict: false,
        resolvedDirection: 'CE',
        confidence: ceScore,
        reasons: ['All engines agree: CE'],
        ceScore,
        peScore,
      };
    }
    if (hasPE && !hasCE) {
      return {
        hasConflict: false,
        resolvedDirection: 'PE',
        confidence: peScore,
        reasons: ['All engines agree: PE'],
        ceScore,
        peScore,
      };
    }
    return {
      hasConflict: false,
      resolvedDirection: 'NO_TRADE',
      confidence: 0,
      reasons: ['No directional signal from any engine'],
      ceScore,
      peScore,
    };
  }

  // CONFLICT DETECTED — resolve using evidence
  reasons.push(`CONFLICT: ${ceCount} engine(s) say CE, ${peCount} say PE`);

  // Check data quality
  if (chain) {
    const strikesWithOI = chain.strikes.filter(s =>
      (s.ce && s.ce.oi > 0) || (s.pe && s.pe.oi > 0)
    ).length;
    if (strikesWithOI < 5) {
      reasons.push('Insufficient OI data for conflict resolution');
      return {
        hasConflict: true,
        resolvedDirection: 'WAIT',
        confidence: 0,
        reasons: [...reasons, 'Data quality too low to resolve conflict'],
        ceScore,
        peScore,
      };
    }
  }

  // Check trend alignment
  if (trend === 'bullish' && ceScore > peScore) {
    reasons.push('Trend bullish + CE score higher → resolved CE');
    return {
      hasConflict: true,
      resolvedDirection: 'CE',
      confidence: Math.round((ceScore - peScore) * 0.7),
      reasons,
      ceScore,
      peScore,
    };
  }
  if (trend === 'bearish' && peScore > ceScore) {
    reasons.push('Trend bearish + PE score higher → resolved PE');
    return {
      hasConflict: true,
      resolvedDirection: 'PE',
      confidence: Math.round((peScore - ceScore) * 0.7),
      reasons,
      ceScore,
      peScore,
    };
  }

  // Score difference too small to resolve
  const scoreDiff = Math.abs(ceScore - peScore);
  if (scoreDiff < 15) {
    reasons.push(`Score difference too small (${scoreDiff} pts) — cannot resolve`);
    return {
      hasConflict: true,
      resolvedDirection: 'WAIT',
      confidence: 0,
      reasons: [...reasons, 'Insufficient evidence to pick direction'],
      ceScore,
      peScore,
    };
  }

  // One direction clearly wins despite conflict
  if (ceScore > peScore + 15) {
    reasons.push(`CE score (${ceScore}) significantly higher than PE (${peScore}) → resolved CE`);
    return {
      hasConflict: true,
      resolvedDirection: 'CE',
      confidence: Math.round(scoreDiff * 0.6),
      reasons,
      ceScore,
      peScore,
    };
  }
  if (peScore > ceScore + 15) {
    reasons.push(`PE score (${peScore}) significantly higher than CE (${ceScore}) → resolved PE`);
    return {
      hasConflict: true,
      resolvedDirection: 'PE',
      confidence: Math.round(scoreDiff * 0.6),
      reasons,
      ceScore,
      peScore,
    };
  }

  // Cannot resolve
  reasons.push('Cannot resolve conflict with available evidence');
  return {
    hasConflict: true,
    resolvedDirection: 'WAIT',
    confidence: 0,
    reasons,
    ceScore,
    peScore,
  };
}

// ─── Validate Trade Decision Against Chain Quality ─────────────────

export function validateDecisionAgainstData(
  decision: TradeDecision,
  chain: OptionChain | null,
  dataQuality: { quality: string; issues: string[] }
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (decision.action === 'NO_TRADE') {
    return { valid: false, reasons: ['Decision is NO_TRADE'] };
  }

  if (dataQuality.quality === 'INVALID') {
    reasons.push('Option chain data quality is INVALID');
    return { valid: false, reasons };
  }

  if (dataQuality.quality === 'POOR') {
    reasons.push('Option chain data quality is POOR');
    reasons.push(...dataQuality.issues);
  }

  if (!chain) {
    reasons.push('No option chain available');
    return { valid: false, reasons };
  }

  // Check the recommended strike has valid data
  const strike = chain.strikes.find(s => s.strike === decision.strike);
  if (!strike) {
    reasons.push(`Strike ${decision.strike} not found in chain`);
    return { valid: false, reasons };
  }

  const leg = decision.optionType === 'CE' ? strike.ce : strike.pe;
  if (!leg) {
    reasons.push(`${decision.optionType} leg not found at strike ${decision.strike}`);
    return { valid: false, reasons };
  }

  if (leg.premium <= 0) {
    reasons.push('Premium is zero or negative');
    return { valid: false, reasons };
  }

  if (leg.premium < 1) {
    reasons.push('Premium too low (< ₹1)');
    return { valid: false, reasons };
  }

  if (leg.oi <= 0 && leg.volume <= 0) {
    reasons.push('No OI or volume at selected strike');
    return { valid: false, reasons };
  }

  if (Math.abs(leg.delta) < 0.05) {
    reasons.push(`Delta too low (${leg.delta.toFixed(4)})`);
    return { valid: false, reasons };
  }

  // Check SL/TP validity
  if (decision.stopLoss <= 0 || decision.target1 <= 0) {
    reasons.push('Invalid SL or TP values');
    return { valid: false, reasons };
  }

  if (decision.target1 <= decision.entry) {
    reasons.push('TP1 must be above entry for BUY');
    return { valid: false, reasons };
  }

  if (decision.stopLoss >= decision.entry) {
    reasons.push('SL must be below entry for BUY');
    return { valid: false, reasons };
  }

  return { valid: reasons.length === 0, reasons };
}
