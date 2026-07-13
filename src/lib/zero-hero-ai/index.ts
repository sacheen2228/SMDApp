// DEPRECATED: duplicate of the consolidated Zero Hero engine in src/lib/zero-hero.ts.
// Kept on disk until production consolidation is verified (see AGENTS.md Architecture Guardian).
// Do NOT use in new code.

// Zero Hero AI Engine
// Orchestrates all sub-engines into a complete trade decision pipeline

import { getExpiryData } from '../expiry-engine';
import { marketRegimeEngine, MarketRegimeInput } from './market-regime-engine';
import { optionChainEngine, OptionChainInput } from './option-chain-engine';
import { smartMoneyEngine, SmartMoneyInput } from './smart-money-engine';
import { volumeOrderFlowEngine, VolumeInput } from './volume-order-flow-engine';
import { greeksEngine, GreeksInput } from './greeks-engine';
import { gammaThetaEngine, GammaThetaInput } from './gamma-theta-engine';
import { probabilityCalculator, ProbabilityInput } from './probability-calculator';
import { positionSizeCalculator, PositionSizeInput } from './position-size-calculator';
import { entryTPSLEngine, EntryTPSLInput } from './entry-tp-sl-engine';
import { tradeExecutionEngine, TradeExecutionInput } from './trade-execution';

export interface ZeroHeroInput {
  instrument: string;
  spot: number;
  strikes: OptionChainInput['strikes'];
  candles: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    time: number;
  }[];
  vix: number;
  atr: number;
  iv: number;               // avg ATM IV
  hv: number;               // historical volatility
  capital?: number;
  riskPercent?: number;
  referenceDate?: Date;
}

export interface ZeroHeroOutput {
  instrument: string;
  expiry: ReturnType<typeof getExpiryData>;
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
  summary: {
    signal: 'BUY_CALL' | 'BUY_PUT' | 'NO_TRADE';
    confidence: number;
    reason: string;
  };
}

export function runZeroHeroEngine(input: ZeroHeroInput): ZeroHeroOutput {
  const { instrument, spot, strikes, candles, vix, atr, iv, hv } = input;

  // 1. Expiry Engine
  const expiry = getExpiryData(instrument, input.referenceDate);

  // 2. Market Regime Engine
  const marketRegime = marketRegimeEngine({
    vix,
    atr,
    iv,
    hv,
    daysToExpiry: expiry?.days_to_expiry || 0,
    spot,
  });

  // 3. Option Chain Engine
  const optionChain = optionChainEngine({ strikes, spot });

  // 4. Smart Money Engine
  const smartMoney = smartMoneyEngine({ candles, spot });

  // 5. Volume & Order Flow Engine
  const volumeFlow = volumeOrderFlowEngine({ candles, spot });

  // 6. Greeks Engine (use ATM strike)
  const atmStrike = strikes.reduce((prev, curr) =>
    Math.abs(curr.strike - spot) < Math.abs(prev.strike - spot) ? curr : prev
  ).strike;
  const atmStrikeData = strikes.find(s => s.strike === atmStrike);
  const greeks = greeksEngine({
    spot,
    strike: atmStrike,
    expiryDays: expiry?.days_to_expiry || 1,
    iv: iv / 100,
    optionType: 'CE',
  });

  // 7. Gamma-Theta Decision Engine
  const gammaTheta = gammaThetaEngine({
    gamma: greeks.gamma,
    theta: greeks.theta,
    delta: greeks.delta,
    iv_rank: marketRegime.iv_rank,
    atr,
    expected_move: marketRegime.expected_range,
    instrument,
  });

  // 8. Probability Calculator
  const atmPremium = atmStrikeData?.ce?.ltp || 10;
  const probability = probabilityCalculator({
    spot,
    strike: atmStrike,
    expiryDays: expiry?.days_to_expiry || 1,
    iv: iv / 100,
    optionType: 'CE',
    entryPremium: atmPremium,
  });

  // 9. Position Size Calculator
  const positionSize = positionSizeCalculator({
    capital: input.capital || 100000,
    riskPercent: input.riskPercent || 2,
    entryPremium: atmPremium,
    stopLossPremium: atmPremium * 0.5,
    lotSize: expiry?.lot_size || 75,
    confidence: gammaTheta.score,
    probProfit: probability.prob_profit,
  });

  // 10. Entry/TP/SL Engine
  const entryTPSL = entryTPSLEngine({
    entryPremium: atmPremium,
    spot,
    strike: atmStrike,
    optionType: 'CE',
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

  // 11. Trade Execution
  const execution = tradeExecutionEngine({
    gamma_score: gammaTheta.score,
    smc_score: smartMoney.confidence,
    oi_score: optionChain.confidence,
    volume_score: volumeFlow.confidence,
    market_score: marketRegime.confidence,
    gamma: greeks.gamma,
    delta_change: 0.1, // placeholder - would be calculated from data
    oi_change: optionChain.unusual_oi_buildup.reduce((s, u) => s + Math.abs(u.oiChg), 0),
    volume_ratio: volumeFlow.volume_trend === 'ACCELERATING' ? 2.5 : 1,
    iv_change: 1.5,
    theta: greeks.theta,
    atr,
    range_size: atr,
    minutes_to_close: 120,
    instrument,
  });

  // Summary
  let signal: 'BUY_CALL' | 'BUY_PUT' | 'NO_TRADE' = 'NO_TRADE';
  let reason = '';
  if (execution.decision === 'BUY_OPTION' || execution.decision === 'SMALL_POSITION') {
    if (smartMoney.bias === 'BULLISH') {
      signal = 'BUY_CALL';
      reason = 'Bullish SMC bias + high confidence engines';
    } else if (smartMoney.bias === 'BEARISH') {
      signal = 'BUY_PUT';
      reason = 'Bearish SMC bias + high confidence engines';
    } else {
      reason = 'Neutral bias - no clear directional signal';
    }
  } else {
    reason = 'Low confidence - no trade recommended';
  }

  return {
    instrument,
    expiry,
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
    summary: {
      signal,
      confidence: execution.confidence,
      reason,
    },
  };
}
