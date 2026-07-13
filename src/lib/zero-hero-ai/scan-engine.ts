// DEPRECATED: duplicate of the consolidated Zero Hero engine in src/lib/zero-hero.ts.
// Kept on disk until production consolidation is verified (see AGENTS.md Architecture Guardian).
// Do NOT use in new code.

// Zero Hero Scanner — Full
// Runs the complete Zero Hero AI Engine for every near-ATM strike (CE & PE)
// and ranks candidates by the combined engine confidence.

import { getExpiryData } from '../expiry-engine';
import { marketRegimeEngine } from './market-regime-engine';
import { optionChainEngine } from './option-chain-engine';
import { smartMoneyEngine } from './smart-money-engine';
import { volumeOrderFlowEngine } from './volume-order-flow-engine';
import { greeksEngine } from './greeks-engine';
import { gammaThetaEngine } from './gamma-theta-engine';
import { probabilityCalculator } from './probability-calculator';
import { positionSizeCalculator } from './position-size-calculator';
import { entryTPSLEngine } from './entry-tp-sl-engine';
import { tradeExecutionEngine } from './trade-execution';

export interface ZHScanInput {
  instrument: string;
  spot: number;
  strikes: {
    strike: number;
    ce: { oi: number; oiChg: number; volume: number; ltp: number; iv: number; bid: number; ask: number } | null;
    pe: { oi: number; oiChg: number; volume: number; ltp: number; iv: number; bid: number; ask: number } | null;
  }[];
  candles: { open: number; high: number; low: number; close: number; volume: number; time: number }[];
  vix: number;
  atr: number;
  iv: number;               // avg ATM IV (percent)
  hv: number;
  capital?: number;
  riskPercent?: number;
  bandwidthPct?: number;    // scan window around spot (default 4%)
  topN?: number;
  referenceDate?: Date;
}

export interface ZHScanCandidate {
  rank: number;
  strike: number;
  type: 'CE' | 'PE';
  premium: number;
  // Engine outputs
  market_regime: ReturnType<typeof marketRegimeEngine>;
  option_chain: ReturnType<typeof optionChainEngine>;
  smart_money: ReturnType<typeof smartMoneyEngine>;
  volume_flow: ReturnType<typeof volumeOrderFlowEngine>;
  greeks: ReturnType<typeof greeksEngine>;
  gamma_theta: ReturnType<typeof gammaThetaEngine>;
  probability: ReturnType<typeof probabilityCalculator>;
  position_size: ReturnType<typeof positionSizeCalculator>;
  entry_tp_sl: ReturnType<typeof entryTPSLEngine>;
  execution: ReturnType<typeof tradeExecutionEngine>;
  signal: 'BUY_CALL' | 'BUY_PUT' | 'NO_TRADE';
  confidence: number;
  reason: string;
}

export interface ZHScanOutput {
  instrument: string;
  spot: number;
  expiry: ReturnType<typeof getExpiryData>;
  vix: number;
  atr: number;
  iv: number;
  candidates: ZHScanCandidate[];
  scanned: number;
}

export function runZeroHeroScan(input: ZHScanInput): ZHScanOutput {
  const { instrument, spot, strikes, candles, vix, atr, iv, hv } = input;
  const bandwidth = (input.bandwidthPct ?? 4) / 100;
  const topN = input.topN ?? 12;
  const capital = input.capital ?? 100000;
  const riskPercent = input.riskPercent ?? 2;

  const expiry = getExpiryData(instrument, input.referenceDate);

  // Global engines (computed once)
  const marketRegime = marketRegimeEngine({
    vix, atr, iv, hv,
    daysToExpiry: expiry?.days_to_expiry || 0,
    spot,
  });
  const optionChain = optionChainEngine({ strikes, spot });
  const smartMoney = smartMoneyEngine({ candles, spot });
  const volumeFlow = volumeOrderFlowEngine({ candles, spot });

  const ivDecimal = iv / 100;
  const threshold = spot * bandwidth;

  const candidates: ZHScanCandidate[] = [];

  for (const s of strikes) {
    if (Math.abs(s.strike - spot) > threshold) continue;

    for (const type of ['CE', 'PE'] as const) {
      const leg = type === 'CE' ? s.ce : s.pe;
      if (!leg || !leg.ltp || leg.ltp <= 0) continue;
      // Skip illiquid / deep premium extremes
      if (leg.ltp < 1) continue;

      const legIv = leg.iv > 0 ? leg.iv / 100 : ivDecimal;

      const greeks = greeksEngine({
        spot,
        strike: s.strike,
        expiryDays: expiry?.days_to_expiry || 1,
        iv: legIv,
        optionType: type,
      });

      const gammaTheta = gammaThetaEngine({
        gamma: greeks.gamma,
        theta: greeks.theta,
        delta: greeks.delta,
        iv_rank: marketRegime.iv_rank,
        atr,
        expected_move: marketRegime.expected_range,
        instrument,
      });

      const probability = probabilityCalculator({
        spot,
        strike: s.strike,
        expiryDays: expiry?.days_to_expiry || 1,
        iv: legIv,
        optionType: type,
        entryPremium: leg.ltp,
      });

      const positionSize = positionSizeCalculator({
        capital,
        riskPercent,
        entryPremium: leg.ltp,
        stopLossPremium: leg.ltp * 0.5,
        lotSize: expiry?.lot_size || 75,
        confidence: gammaTheta.score,
        probProfit: probability.prob_profit,
      });

      const entryTPSL = entryTPSLEngine({
        entryPremium: leg.ltp,
        spot,
        strike: s.strike,
        optionType: type,
        delta: greeks.delta,
        gamma: greeks.gamma,
        theta: greeks.theta,
        atr,
        daysToExpiry: expiry?.days_to_expiry || 0,
        bias: smartMoney.bias,
        expected_move: marketRegime.expected_range,
        instrument,
        expiry_mode: expiry?.expiry_mode || 'STANDARD',
      });

      const execution = tradeExecutionEngine({
        gamma_score: gammaTheta.score,
        smc_score: smartMoney.confidence,
        oi_score: optionChain.confidence,
        volume_score: volumeFlow.confidence,
        market_score: marketRegime.confidence,
        gamma: greeks.gamma,
        delta_change: 0.1,
        oi_change: optionChain.unusual_oi_buildup.reduce((a, u) => a + Math.abs(u.oiChg), 0),
        volume_ratio: volumeFlow.volume_trend === 'ACCELERATING' ? 2.5 : 1,
        iv_change: 1.5,
        theta: greeks.theta,
        atr,
        range_size: atr,
        minutes_to_close: 120,
        instrument,
      });

      let signal: 'BUY_CALL' | 'BUY_PUT' | 'NO_TRADE' = 'NO_TRADE';
      let reason = '';
      if (execution.decision === 'BUY_OPTION' || execution.decision === 'SMALL_POSITION') {
        if (type === 'CE' && smartMoney.bias !== 'BEARISH') {
          signal = 'BUY_CALL';
          reason = 'CE candidate + SMC bias supportive';
        } else if (type === 'PE' && smartMoney.bias !== 'BULLISH') {
          signal = 'BUY_PUT';
          reason = 'PE candidate + SMC bias supportive';
        } else {
          reason = 'Engine confirmed but SMC bias conflicts with direction';
        }
      } else {
        reason = 'Confidence below threshold';
      }

      candidates.push({
        rank: 0,
        strike: s.strike,
        type,
        premium: leg.ltp,
        market_regime: marketRegime,
        option_chain: optionChain,
        smart_money: smartMoney,
        volume_flow: volumeFlow,
        greeks,
        gamma_theta: gammaTheta,
        probability,
        position_size: positionSize,
        entry_tp_sl: entryTPSL,
        execution,
        signal,
        confidence: execution.confidence,
        reason,
      });
    }
  }

  // Rank by confidence desc
  candidates.sort((a, b) => b.confidence - a.confidence);
  const top = candidates.slice(0, topN).map((c, i) => ({ ...c, rank: i + 1 }));

  return {
    instrument,
    spot,
    expiry,
    vix,
    atr,
    iv,
    candidates: top,
    scanned: candidates.length,
  };
}
