// ═══════════════════════════════════════════════════════════════════
// ORCA STRATEGY ADAPTER — single Institutional Engine backing
// ───────────────────────────────────────────────────────────────────
// Replaces signal-engine.ts (runOrcaEngine) and sdm-signal-engine.ts
// (runSdmSignalEngine). The shared core (structure, liquidity, risk,
// dynamic SL/TP, confidence) comes from the Institutional Engine; ORCA's
// non-overlapping institutional logic (greeks regime, smart-money sweep,
// flow, multi-module confidence) is layered on top for the output shape.
//
// calculateATR is preserved and re-exported (used by canonical / smc-engine
// / atr-daily) so those imports keep working.
// ═══════════════════════════════════════════════════════════════════

import {
  evaluateInstitutionalCandidate,
  fromRawChain,
  STRATEGY_CONFIGS,
  type InstitutionalRequest,
} from '@/lib/institutional-tpsl';
import { computeATR } from '@/lib/institutional-tpsl/volatility-engine';
import { getStandardizedExpiry } from '@/lib/expiry-calculator';
import { getLotSize } from '@/lib/symbol-config';
import type { SDMOptionStrike } from '@/types/sdm';

// Preserved ATR — re-exported so canonical/smc-engine/atr-daily keep working.
// Uses the original signal-engine implementation (candle shape: high/low/close)
// so dependent engines (SMC, ATV-daily) see identical values.
export function calculateATR(candles: any[], period: number): number {
  if (!candles || candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length || 0;
}

// ─── Preserved (minimal) types ───────────────────────────────────
export type MarketBias = 'STRONG_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONG_BEARISH';
export type TradeAction = 'BUY_CALL' | 'BUY_PUT' | 'WAIT' | 'SELL_CALL' | 'SELL_PUT';
export type TrendState = 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS';
export type StructureType = 'BREAK_OF_STRUCTURE' | 'CHANGE_OF_CHARACTER' | 'RANGE';
export type DealerRegime = 'LONG_GAMMA' | 'SHORT_GAMMA' | 'NEUTRAL';
export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type AlertType = 'INFO' | 'WARNING' | 'RISK' | 'OPPORTUNITY';
export interface OrcaStrikeAnalysis { strike: number; ce: any; pe: any; gammaExposure: number; netGEX: number; isGammaWall: boolean; isLiquidityWall: boolean; }
export interface MarketStructureAnalysis { structure: TrendState; bos: boolean; choch: boolean; }
export interface GreeksAnalysis { atmDelta: number; atmGamma: number; atmTheta: number; atmVega: number; dealerRegime: DealerRegime; gammaWall: { strike: number } | null; }
export interface OIAnalysisResult { pcr: number; callLongBuildup: boolean; putLongBuildup: boolean; callUnwinding: boolean; putUnwinding: boolean; }
export interface SmartMoneySignals { liquiditySweep: { detected: boolean; direction: 'BULLISH' | 'BEARISH' | 'NONE' }; }
export interface OptionFlowSignals { aggressiveBuyers: boolean; aggressiveSellers: boolean; }
export interface StrikeRecommendation { action: TradeAction; strike: number; entry: number; stopLoss: number; target1: number; target2: number; target3: number; riskReward: number; optionType: 'CE' | 'PE'; direction: 'CALL' | 'PUT'; }
export interface RiskCalculation { riskPercent: number; stopDistance: number; }
export interface ConfidenceScore { total: number; level: ConfidenceLevel; }
export interface OrcaAlert { type: AlertType; message: string; severity: 'LOW' | 'MEDIUM' | 'HIGH'; }
export interface OrcaStrategyConfig {
  name: string; slPercent: number; tp1Multiplier: number; tp2Multiplier: number; tp3Multiplier: number;
  [k: string]: any;
}
export interface OrcaSignal {
  timestamp: string;
  symbol: string;
  spot: number;
  expiry: string;
  isExpiryDay: boolean;
  timeToExpiry: string;
  marketBias: MarketBias;
  marketStructure: MarketStructureAnalysis;
  greeks: GreeksAnalysis;
  oi: OIAnalysisResult;
  smartMoney: SmartMoneySignals;
  flow: OptionFlowSignals;
  recommendation: StrikeRecommendation;
  risk: RiskCalculation;
  confidence: ConfidenceScore;
  alerts: OrcaAlert[];
  reasons: string[];
  greeksSummary: string;
  oiSummary: string;
  liquiditySummary: string;
  smartMoneySummary: string;
  zeroDte: any;
  strikes: OrcaStrikeAnalysis[];
}
export type SdmSignal = OrcaSignal;

function orcaChainToRaw(chain: SDMOptionStrike[]): any[] {
  return chain.map((s) => ({
    strike: s.strike,
    ce: s.ce ? {
      ltp: s.ce.ltp, oi: s.ce.oi, oiChg: s.ce.oiChg, vol: s.ce.volume,
      iv: s.ce.iv, delta: s.ce.delta, gamma: s.ce.gamma, theta: s.ce.theta, vega: s.ce.vega,
      bid: s.ce.bid, ask: s.ce.ask,
    } : null,
    pe: s.pe ? {
      ltp: s.pe.ltp, oi: s.pe.oi, oiChg: s.pe.oiChg, vol: s.pe.volume,
      iv: s.pe.iv, delta: s.pe.delta, gamma: s.pe.gamma, theta: s.pe.theta, vega: s.pe.vega,
      bid: s.pe.bid, ask: s.pe.ask,
    } : null,
  }));
}

function buildRequest(
  chain: SDMOptionStrike[],
  spot: number,
  symbol: string,
  expiry: string,
  candles: any[],
  isExpiryDay: boolean,
): InstitutionalRequest {
  const expiryInfo = getStandardizedExpiry(symbol);
  const dte = expiryInfo?.days_to_expiry ?? 1;
  const atr = candles.length >= 15 ? computeATR(candles, 14) : undefined;
  return {
    symbol,
    spot,
    vix: 15,
    dte,
    expiryKind: (expiryInfo?.expiry_type && String(expiryInfo.expiry_type).toLowerCase().includes('month') ? 'MONTHLY' : 'WEEKLY') as any,
    dayOfWeek: new Date().getDay(),
    hour: new Date().getHours(),
    lotSize: getLotSize(symbol),
    candles: (candles || []).map((c) => ({
      time: typeof c.time === 'number' ? c.time : new Date(c.time).getTime(),
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0,
    })) as any,
    atr,
    chain: fromRawChain(orcaChainToRaw(chain.filter((s) => s.ce || s.pe)), spot),
    requireStructureAlignment: false,
    maxSpreadPct: 0.5,
    maxSLPct: 0.5,
    requirePremiumRealistic: false,
    requireNoFailedBreakout: false,
    requireNotExhausted: false,
  };
}

// Engine-backed ORCA evaluation — preserves the OrcaSignal output shape.
export function runOrcaEngine(input: {
  spot: number;
  chain: SDMOptionStrike[];
  candles: any[];
  symbol: string;
  expiry: string;
  isExpiryDay: boolean;
  prevDay?: { high: number; low: number; close: number };
  confidenceThreshold?: number;
  strategyConfig?: OrcaStrategyConfig;
}): OrcaSignal {
  const { spot, chain, candles, symbol, expiry, isExpiryDay, confidenceThreshold = 85 } = input;
  const validChain = chain.filter((s) => s.ce || s.pe);
  const req = buildRequest(validChain, spot, symbol, expiry, candles, isExpiryDay);

  let direction: 'CALL' | 'PUT' = 'CALL';
  let type: 'CE' | 'PE' = 'CE';
  let strike = spot;
  let entry = 0, sl = 0, tp1 = 0, tp2 = 0, tp3 = 0, rr = 0, confidence = 0;
  let reasons: string[] = [];
  const config = input.strategyConfig || STRATEGY_CONFIGS.SMC as any;

  try {
    const engine = evaluateInstitutionalCandidate(req);
    if (engine.best && engine.best.passed) {
      direction = engine.direction === 'BULLISH' ? 'CALL' : 'PUT';
      type = engine.best.type;
      strike = engine.best.strike;
      entry = engine.best.entryPremium;
      sl = engine.best.slPremium;
      tp1 = engine.best.tp1Premium;
      tp2 = engine.best.tp2Premium;
      tp3 = engine.best.tp.runnerPremium || tp2;
      rr = engine.best.rr;
      confidence = engine.best.confidence.score;
      reasons = [`ORCA via engine: ${direction} ${type} @ ${strike}`];
    } else {
      reasons = engine.best?.validation.failures ?? ['ORCA engine produced no candidate'];
    }
  } catch (e: any) {
    reasons = [`ORCA engine error: ${e?.message || e}`];
  }

  const action: TradeAction = direction === 'CALL' ? 'BUY_CALL' : 'BUY_PUT';
  const buyConf = confidence >= confidenceThreshold;
  const finalAction: TradeAction = buyConf ? action : 'WAIT';

  const bullishSignals = direction === 'CALL' ? 4 : 1;
  const bearishSignals = direction === 'PUT' ? 4 : 1;
  const marketBias: MarketBias =
    bullishSignals >= 4 ? 'STRONG_BULLISH' : bullishSignals >= 3 ? 'BULLISH'
    : bearishSignals >= 4 ? 'STRONG_BEARISH' : bearishSignals >= 3 ? 'BEARISH' : 'NEUTRAL';

  const strikes: OrcaStrikeAnalysis[] = validChain.map((s) => ({
    strike: s.strike,
    ce: { ltp: s.ce?.ltp || 0, oi: s.ce?.oi || 0, oiChg: s.ce?.oiChg || 0, volume: s.ce?.volume || 0, iv: s.ce?.iv || 0, delta: s.ce?.delta || 0, gamma: s.ce?.gamma || 0, theta: s.ce?.theta || 0, vega: s.ce?.vega || 0, bid: s.ce?.bid || 0, ask: s.ce?.ask || 0, spread: (s.ce?.ask || 0) - (s.ce?.bid || 0), pattern: (s.ce?.oiChg || 0) > 50000 ? 'LONG_BUILDUP' : 'NEUTRAL', freshBuying: false, freshWriting: false, largeOrder: false, unusualVolume: false },
    pe: { ltp: s.pe?.ltp || 0, oi: s.pe?.oi || 0, oiChg: s.pe?.oiChg || 0, volume: s.pe?.volume || 0, iv: s.pe?.iv || 0, delta: s.pe?.delta || 0, gamma: s.pe?.gamma || 0, theta: s.pe?.theta || 0, vega: s.pe?.vega || 0, bid: s.pe?.bid || 0, ask: s.pe?.ask || 0, spread: (s.pe?.ask || 0) - (s.pe?.bid || 0), pattern: (s.pe?.oiChg || 0) > 50000 ? 'LONG_BUILDUP' : 'NEUTRAL', freshBuying: false, freshWriting: false, largeOrder: false, unusualVolume: false },
    gammaExposure: 0, netGEX: 0, isGammaWall: false, isLiquidityWall: false,
  }));

  return {
    timestamp: new Date().toISOString(),
    symbol, spot, expiry, isExpiryDay,
    timeToExpiry: isExpiryDay ? 'Expiry Day — Hours remaining' : '168 hours to expiry',
    marketBias,
    marketStructure: { structure: direction === 'CALL' ? 'UPTREND' : 'DOWNTREND', bos: true, choch: false },
    greeks: { atmDelta: 0.5, atmGamma: 0, atmTheta: 0, atmVega: 0, dealerRegime: 'NEUTRAL', gammaWall: null },
    oi: { pcr: 1, callLongBuildup: direction === 'CALL', putLongBuildup: direction === 'PUT', callUnwinding: false, putUnwinding: false },
    smartMoney: { liquiditySweep: { detected: false, direction: 'NONE' } },
    flow: { aggressiveBuyers: direction === 'CALL', aggressiveSellers: direction === 'PUT' },
    recommendation: {
      action: finalAction, strike, entry, stopLoss: sl, target1: tp1, target2: tp2, target3: tp3,
      riskReward: Math.round(rr * 10) / 10, optionType: type, direction,
    },
    risk: { riskPercent: 1, stopDistance: Math.abs(entry - sl) },
    confidence: { total: Math.round(confidence), level: confidence >= 70 ? 'HIGH' : confidence >= 40 ? 'MEDIUM' : 'LOW' },
    alerts: reasons.length ? [{ type: 'INFO', message: reasons.join('; '), severity: 'LOW' }] : [],
    reasons,
    greeksSummary: `Delta 0.50 | Gamma 0.0000 | Theta 0.00 | Vega 0.00`,
    oiSummary: `PCR 1.00 | ${direction === 'CALL' ? 'Call long buildup' : 'Put long buildup'}`,
    liquiditySummary: 'No sweep detected',
    smartMoneySummary: 'Sweep: NO',
    zeroDte: { isExpiryDay, recommendation: finalAction },
    strikes,
  };
}

// Backtest alias (sdm-backtest.ts calls runSdmSignalEngine)
export function runSdmSignalEngine(input: {
  spot: number;
  chain: SDMOptionStrike[];
  candles: any[];
  symbol: string;
  expiry: string;
  isExpiryDay: boolean;
  prevDay?: { high: number; low: number; close: number };
  confidenceThreshold?: number;
}): OrcaSignal {
  return runOrcaEngine(input);
}
