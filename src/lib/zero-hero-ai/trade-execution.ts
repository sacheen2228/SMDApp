// DEPRECATED: duplicate of the consolidated Zero Hero engine in src/lib/zero-hero.ts.
// Kept on disk until production consolidation is verified (see AGENTS.md Architecture Guardian).
// Do NOT use in new code.

// Trade Execution
// Final decision: BUY_OPTION / SMALL_POSITION / NO_TRADE

import { gammaBlast, thetaKiller } from './gamma-theta-engine';

export interface TradeExecutionInput {
  gamma_score: number;        // from gammaThetaEngine
  smc_score: number;          // from smartMoneyEngine confidence
  oi_score: number;           // from optionChainEngine confidence
  volume_score: number;       // from volumeOrderFlowEngine confidence
  market_score: number;       // from marketRegimeEngine confidence
  gamma?: number;
  delta_change?: number;
  oi_change?: number;
  volume_ratio?: number;
  iv_change?: number;
  theta?: number;
  atr?: number;
  range_size?: number;
  minutes_to_close?: number;
  instrument?: string;
}

export type TradeDecision = 'BUY_OPTION' | 'SMALL_POSITION' | 'NO_TRADE';

export interface TradeExecutionOutput {
  decision: TradeDecision;
  confidence: number;
  adjustments: string[];
}

export function tradeExecutionEngine(input: TradeExecutionInput): TradeExecutionOutput {
  const {
    gamma_score, smc_score, oi_score, volume_score, market_score,
    gamma, delta_change, oi_change, volume_ratio, iv_change,
    theta, atr, range_size, minutes_to_close, instrument,
  } = input;

  // Base confidence (average of 5 engines)
  let confidence = (gamma_score + smc_score + oi_score + volume_score + market_score) / 5;
  const adjustments: string[] = [];

  // Gamma Blast boost
  if (gamma !== undefined && delta_change !== undefined &&
      oi_change !== undefined && volume_ratio !== undefined && iv_change !== undefined) {
    if (gammaBlast({ gamma, delta_change, oi_change, volume_ratio, iv_change, instrument })) {
      confidence += 15;
      adjustments.push('Gamma Blast detected: +15 confidence');
    }
  }

  // Theta Killer penalty
  if (theta !== undefined && atr !== undefined && range_size !== undefined && minutes_to_close !== undefined) {
    if (thetaKiller({ theta, atr, range_size, minutes_to_close })) {
      confidence -= 25;
      adjustments.push('Theta Killer detected: -25 confidence');
    }
  }

  confidence = Math.max(0, Math.min(100, confidence));

  let decision: TradeDecision;
  if (confidence > 90) {
    decision = 'BUY_OPTION';
  } else if (confidence > 80) {
    decision = 'SMALL_POSITION';
  } else {
    decision = 'NO_TRADE';
  }

  return {
    decision,
    confidence: Math.round(confidence * 10) / 10,
    adjustments,
  };
}
