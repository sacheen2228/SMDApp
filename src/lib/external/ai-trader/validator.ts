// ═══════════════════════════════════════════════════════════════════════════
// AI-Trader Signal Validator — Validate external signals against SMDApp rules
// ═══════════════════════════════════════════════════════════════════════════

import type { AgentSignal } from '@/lib/agents/types';

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
  warnings: string[];
}

export function validateExternalSignal(signal: AgentSignal): ValidationResult {
  const reasons: string[] = [];
  const warnings: string[] = [];

  // HARD BLOCKS
  if (signal.direction === 'SELL_CE' || signal.direction === 'SELL_PE') {
    reasons.push('SELL signals are strictly forbidden in SMDApp');
  }

  if (signal.direction !== 'BUY_CE' && signal.direction !== 'BUY_PE' && signal.direction !== 'WAIT' && signal.direction !== 'EXIT') {
    reasons.push(`Invalid direction: ${signal.direction}`);
  }

  if (signal.optionType !== 'CE' && signal.optionType !== 'PE' && signal.direction !== 'WAIT' && signal.direction !== 'EXIT') {
    reasons.push(`Invalid option type: ${signal.optionType}`);
  }

  // Confidence threshold (external agents need higher threshold)
  if (signal.confidence < 0.5) {
    reasons.push(`Confidence ${signal.confidence} below minimum threshold 0.5 for external signals`);
  }

  // Strike must be present for BUY signals
  if ((signal.direction === 'BUY_CE' || signal.direction === 'BUY_PE') && !signal.strike) {
    reasons.push('Strike price required for BUY signals');
  }

  // Expiry must be present for BUY signals
  if ((signal.direction === 'BUY_CE' || signal.direction === 'BUY_PE') && !signal.expiry) {
    reasons.push('Expiry date required for BUY signals');
  }

  // Entry price must be positive
  if (signal.entryPrice !== null && signal.entryPrice !== undefined && signal.entryPrice <= 0) {
    reasons.push('Entry price must be positive');
  }

  // Stop loss must be below entry for BUY
  if (signal.direction === 'BUY_CE' || signal.direction === 'BUY_PE') {
    if (signal.stopLoss !== null && signal.stopLoss !== undefined && signal.entryPrice !== null && signal.entryPrice !== undefined) {
      if (signal.stopLoss >= signal.entryPrice) {
        reasons.push('Stop loss must be below entry price for BUY signals');
      }
    }
  }

  // Target must be above entry for BUY
  if (signal.direction === 'BUY_CE' || signal.direction === 'BUY_PE') {
    if (signal.target1 !== null && signal.target1 !== undefined && signal.entryPrice !== null && signal.entryPrice !== undefined) {
      if (signal.target1 <= signal.entryPrice) {
        reasons.push('Target 1 must be above entry price for BUY signals');
      }
    }
  }

  // WARNINGS (soft)
  if (signal.confidence < 0.7) {
    warnings.push(`Confidence ${signal.confidence} is below 0.7 — consider lower position size`);
  }

  if (!signal.evidence?.priceStructure && !signal.evidence?.volume) {
    warnings.push('No price structure or volume evidence provided');
  }

  // Must NOT bypass SMDApp's canonical pipeline
  if (signal.dataSource === 'EXTERNAL_AGENT') {
    warnings.push('External signal must go through SMDApp canonical pipeline before execution');
  }

  return {
    valid: reasons.length === 0,
    reasons,
    warnings,
  };
}
