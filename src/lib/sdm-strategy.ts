// ═══════════════════════════════════════════════════════════════════
// SDM STRATEGY ADAPTER — single Institutional Engine backing for SDM
// ───────────────────────────────────────────────────────────────────
// Replaces the legacy sdm-engine.ts (runFullAnalysis) and
// sdm-recommendation.ts (generateTradeRecommendation) with ONE engine
// call. The shared core (structure, liquidity, risk, dynamic SL/TP,
// confidence, validation) is computed by the Institutional Engine; SDM's
// non-overlapping logic (PCR/MaxPain sentiment) is layered on top.
//
// Public function signatures are preserved so every existing consumer
// (option-chain route, sdm-signal route, SDMBot, SimpleMode, dashboards)
// keeps working unchanged.
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
import type { SDMOptionStrike, SDMRecommendation, CandleData } from '@/types/sdm';

// Preserved alias (consumers imported this from sdm-engine)
export type OptionChainStrike = SDMOptionStrike;

// ─── Preserved type exports (consumers import these from sdm-engine) ──
export interface StrikeOI {
  strike: number;
  callOI: number;
  callOIChange: number;
  callVolume: number;
  putOI: number;
  putOIChange: number;
  putVolume: number;
  sentiment: string;
  classification: string;
}
export interface GammaWall {
  strike: number;
  type: string;
  greeks: number;
  description?: string;
}
export interface MoneyFlow {
  direction: string;
  smartMoneyDirection: string;
  callWriting: boolean;
  putWriting: boolean;
}
export interface SDMScore {
  total: number;
  sentiment: string;
  confidence: number;
  pcr: number;
  maxPain: number;
  breakdown: Record<string, string>;
}
export interface TradeRecommendation {
  confidence: number;
  action: string;
  strike: number;
  direction: 'CALL' | 'PUT' | 'WAIT';
  optionType: 'CE' | 'PE' | null;
  sdmScore?: number;
  riskLevel: string;
  oibuildup: string;
  gammaWallSupport: number;
  gammaWallResistance: number;
  entryPrice: number;
  idealBuyRange: { low: number; high: number };
  lateEntryWarning: boolean;
  stopLoss: number;
  stopLossReason: string;
  tp1Pct: number;
  tp1: number;
  tp2Pct: number;
  tp2: number;
  tp3Pct: number;
  tp3: number;
  trailingTarget: boolean;
  reasons: string[];
}
export interface FullAnalysis {
  spotPrice: number;
  expiryDate: string;
  atmStrike: number;
  pcr: number;
  maxPain: number;
  totalCallOI: number;
  totalPutOI: number;
  totalCallVolume: number;
  totalPutVolume: number;
  sentiment: string;
  recommendation: TradeRecommendation;
  sdm: SDMScore;
  spot: { spot: number; atmStrike: number; change: number; changePct: number };
  expiry: { label: string; daysToExpiry: number; date: string };
  oiAnalysis: { totalCallOI: number; totalPutOI: number; pcr: number; maxPain: number; sentiment: string };
  gammaWalls: GammaWall[];
  moneyFlow: MoneyFlow;
  greeks: any;
  strikes: StrikeOI[];
}

// ─── Helpers ─────────────────────────────────────────────────────
function sdmChainToRaw(chain: SDMOptionStrike[]): any[] {
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
  expiryDate: string,
  candles: CandleData[] = [],
): InstitutionalRequest {
  const lotSize = getLotSize(symbol);
  const expiry = getStandardizedExpiry(symbol);
  const dte = expiry?.days_to_expiry ?? 1;
  const atr = candles.length >= 15 ? computeATR(candles as any, 14) : undefined;
  const rawChain = sdmChainToRaw(chain);
  return {
    symbol,
    spot,
    vix: 15,
    dte,
    expiryKind: (expiry?.expiry_type && String(expiry.expiry_type).toLowerCase().includes('month') ? 'MONTHLY' : 'WEEKLY') as any,
    dayOfWeek: new Date().getDay(),
    hour: new Date().getHours(),
    lotSize,
    candles: (candles || []).map((c) => ({
      time: typeof c.time === 'number' ? c.time : new Date(c.time).getTime(),
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0,
    })) as any,
    atr,
    chain: fromRawChain(rawChain, spot),
    // SDM path uses relaxed gates (near-ATM premium buying is direction-agnostic
    // at entry) — matching the ZERO_HERO config, NOT SMC's strict alignment gate.
    requireStructureAlignment: false,
    maxSpreadPct: 0.5,
    maxSLPct: 0.5,
    requirePremiumRealistic: false,
    requireNoFailedBreakout: false,
    requireNotExhausted: false,
  };
}

// ─── runFullAnalysis (replaces sdm-engine.runFullAnalysis) ─────────
export function runFullAnalysis(
  strikes: SDMOptionStrike[],
  spotPrice: number,
  expiryDate: string,
  symbol = 'NIFTY',
): FullAnalysis {
  const chain = strikes.filter((s) => s.ce || s.pe);
  if (chain.length === 0) {
    // No usable strikes — return a safe empty analysis instead of crashing
    // on chain[0].strike. The route will still surface spot price / errors.
    return emptyAnalysis(spotPrice, expiryDate, symbol);
  }
  let totalCEOI = 0, totalPEOI = 0, totalCallVolume = 0, totalPutVolume = 0;
  let maxPain = spotPrice, maxTotalOI = 0;
  let ceWallStrike = spotPrice, peWallStrike = spotPrice;

  for (const s of chain) {
    const ceOI = s.ce?.oi || 0, peOI = s.pe?.oi || 0;
    const ceVol = s.ce?.volume || 0, peVol = s.pe?.volume || 0;
    totalCEOI += ceOI; totalPEOI += peOI; totalCallVolume += ceVol; totalPutVolume += peVol;
    if (ceOI > (chain.find((x) => x.strike === ceWallStrike)?.ce?.oi || 0)) ceWallStrike = s.strike;
    if (peOI > (chain.find((x) => x.strike === peWallStrike)?.pe?.oi || 0)) peWallStrike = s.strike;
    const totalOI = ceOI + peOI;
    if (totalOI > maxTotalOI) { maxTotalOI = totalOI; maxPain = s.strike; }
  }

  const pcr = totalPEOI > 0 ? totalCEOI / totalPEOI : 1;
  const atmStrike = chain.reduce((b, s) =>
    Math.abs(s.strike - spotPrice) < Math.abs(b.strike - spotPrice) ? s : b
  , chain[0]).strike;

  const sentiment = pcr > 1.2 ? 'bearish' : pcr < 0.8 ? 'bullish' : 'neutral';
  const confidence = Math.min(100, Math.max(20,
    pcr > 1.2 ? 50 + (pcr - 1.2) * 50 : pcr < 0.8 ? 50 + (0.8 - pcr) * 50 : 40));

  const isCall = sentiment === 'bullish';
  const fallbackDirection: 'CALL' | 'PUT' = isCall ? 'CALL' : 'PUT';
  const entryLeg = isCall
    ? chain.find((s) => s.strike === atmStrike)?.ce
    : chain.find((s) => s.strike === atmStrike)?.pe;
  const fallbackEntry = entryLeg?.ltp || 0;

  // Engine-backed candidate (single source of truth for direction / strike /
  // entry / SL / TP). PCR sentiment above is layered in as market context only.
  let stopLoss = fallbackEntry, tp1 = fallbackEntry, tp2 = fallbackEntry, tp3 = fallbackEntry;
  let engineConfidence = confidence;
  let engineDirection: 'CALL' | 'PUT' = fallbackDirection;
  let optionType: 'CE' | 'PE' | null = isCall ? 'CE' : 'PE';
  let recStrike = atmStrike;
  let entryPrice = fallbackEntry;
  let engineFailed = false;
  try {
    const req = buildRequest(chain, spotPrice, symbol, expiryDate);
    const engine = evaluateInstitutionalCandidate(req);
    if (engine.best && engine.best.passed) {
      engineDirection = engine.direction === 'BULLISH' ? 'CALL' : 'PUT';
      optionType = engine.best.type;
      recStrike = engine.best.strike;
      entryPrice = engine.best.entryPremium;
      engineConfidence = engine.best.confidence.score;
      // Apply same ATR-based SL override as scoreCandidate: the engine's
      // slPremiumRef is broken for index options (delta*indexDistance → clamped to 0).
      const eSl = engine.best.slPremium;
      const slBroken = eSl <= 0 || eSl >= entryPrice;
      if (slBroken && entryPrice > 0) {
        const atrVal = req.atr ?? engine.best.vol?.atr ?? 0;
        const atrPct = atrVal > 0 && entryPrice > 0 ? atrVal / entryPrice : 0.35;
        const slPct = Math.max(0.2, Math.min(0.5, 0.35 - atrPct * 2));
        // Both CE and PE buyers profit when premium rises — SL below, TP above
        stopLoss = entryPrice * (1 - slPct);
        tp1 = entryPrice * (1 + slPct * 1.5);
        tp2 = entryPrice * (1 + slPct * 2.5);
        tp3 = entryPrice * (1 + slPct * 3.75);
      } else {
        stopLoss = eSl;
        tp1 = engine.best.tp1Premium;
        tp2 = engine.best.tp2Premium;
        tp3 = engine.best.tp.runnerPremium || tp2;
      }
    } else {
      // No engine candidate — degrade gracefully to a sentiment-only idea with
      // a real (premium-space) SL/TP instead of a degenerate flat level.
      engineFailed = true;
      stopLoss = fallbackEntry * (engineDirection === 'CALL' ? 0.85 : 1.15);
      tp1 = fallbackEntry * (engineDirection === 'CALL' ? 1.15 : 0.85);
      tp2 = fallbackEntry * (engineDirection === 'CALL' ? 1.5 : 0.66);
      tp3 = fallbackEntry * (engineDirection === 'CALL' ? 2 : 0.5);
    }
  } catch {
    engineFailed = true;
    stopLoss = fallbackEntry * (fallbackDirection === 'CALL' ? 0.85 : 1.15);
    tp1 = fallbackEntry * (fallbackDirection === 'CALL' ? 1.15 : 0.85);
    tp2 = fallbackEntry * (fallbackDirection === 'CALL' ? 1.5 : 0.66);
    tp3 = fallbackEntry * (fallbackDirection === 'CALL' ? 2 : 0.5);
  }
  void engineFailed;

  const riskLevel = engineConfidence >= 70 ? 'LOW' : engineConfidence >= 50 ? 'MEDIUM' : engineConfidence >= 30 ? 'HIGH' : 'EXTREME';
  const daysToExpiry = getStandardizedExpiry(symbol)?.days_to_expiry ?? 1;

  const strikesOI: StrikeOI[] = chain.map((s) => ({
    strike: s.strike,
    callOI: s.ce?.oi || 0,
    callOIChange: s.ce?.oiChg || 0,
    callVolume: s.ce?.volume || 0,
    putOI: s.pe?.oi || 0,
    putOIChange: s.pe?.oiChg || 0,
    putVolume: s.pe?.volume || 0,
    sentiment,
    classification: '',
  }));

  return {
    spotPrice,
    expiryDate,
    atmStrike,
    pcr,
    maxPain,
    totalCallOI: totalCEOI,
    totalPutOI: totalPEOI,
    totalCallVolume,
    totalPutVolume,
    sentiment,
    recommendation: {
      confidence: Math.round(engineConfidence),
      action: engineDirection === 'CALL' ? 'BUY CALL' : 'BUY PUT',
      strike: recStrike,
      direction: engineDirection,
      optionType,
      sdmScore: Math.round(engineConfidence),
      riskLevel,
      oibuildup: sentiment,
      gammaWallSupport: peWallStrike,
      gammaWallResistance: ceWallStrike,
      entryPrice,
      idealBuyRange: {
        low: entryPrice > 0 ? Math.round(entryPrice * 0.95) : 0,
        high: entryPrice > 0 ? Math.round(entryPrice * 1.05) : 0,
      },
      lateEntryWarning: daysToExpiry <= 1,
      stopLoss,
      stopLossReason: `Engine SL — invalidate if spot crosses ${maxPain}`,
      tp1Pct: entryPrice ? Math.round(((tp1 - entryPrice) / entryPrice) * 100) : 15,
      tp1,
      tp2Pct: entryPrice ? Math.round(((tp2 - entryPrice) / entryPrice) * 100) : 50,
      tp2,
      tp3Pct: entryPrice ? Math.round(((tp3 - entryPrice) / entryPrice) * 100) : 100,
      tp3,
      trailingTarget: engineConfidence >= 65,
      reasons: [
        `Engine ${engineDirection} ${optionType} @ ${recStrike}`,
        `Confidence ${engineConfidence.toFixed(0)}%`,
        `PCR ${pcr.toFixed(2)} (${sentiment} context)`,
        `Max Pain ${maxPain}`,
        engineFailed ? 'Engine gated — levels from sentiment fallback' : '',
      ].filter(Boolean),
    },
    sdm: {
      total: Math.round(engineConfidence),
      sentiment,
      confidence: engineConfidence,
      pcr,
      maxPain,
      breakdown: {
        'PCR': pcr.toFixed(2),
        'Max Pain': maxPain.toString(),
        'CE OI': `${(totalCEOI / 100000).toFixed(1)}L`,
        'PE OI': `${(totalPEOI / 100000).toFixed(1)}L`,
      },
    },
    spot: { spot: spotPrice, atmStrike, change: 0, changePct: 0 },
    expiry: { label: expiryDate, daysToExpiry, date: expiryDate },
    oiAnalysis: {
      totalCallOI: totalCEOI, totalPutOI: totalPEOI, pcr, maxPain, sentiment,
    },
    gammaWalls: [
      { strike: ceWallStrike, type: 'CALL', greeks: 1 },
      { strike: peWallStrike, type: 'PUT', greeks: 1 },
    ],
    moneyFlow: {
      direction: sentiment,
      smartMoneyDirection: sentiment,
      callWriting: false,
      putWriting: false,
    },
    greeks: { vix: 15 },
    strikes: strikesOI,
  };
}

// Safe fallback when the option chain has no usable strikes (e.g. after-hours
// when BSE/NSE return empty data). Prevents the chain[0].strike crash in
// runFullAnalysis and lets the route surface a clear "no data" response.
function emptyAnalysis(spotPrice: number, expiryDate: string, symbol: string): FullAnalysis {
  return {
    spotPrice,
    expiryDate,
    atmStrike: spotPrice,
    pcr: 1,
    maxPain: spotPrice,
    totalCallOI: 0,
    totalPutOI: 0,
    totalCallVolume: 0,
    totalPutVolume: 0,
    sentiment: 'neutral',
    recommendation: {
      confidence: 0,
      action: 'NO TRADE',
      strike: spotPrice,
      direction: 'CALL',
      optionType: null,
      sdmScore: 0,
      riskLevel: 'EXTREME',
      oibuildup: 'neutral',
      gammaWallSupport: spotPrice,
      gammaWallResistance: spotPrice,
      entryPrice: 0,
      idealBuyRange: { low: 0, high: 0 },
      lateEntryWarning: false,
      stopLoss: 0,
      stopLossReason: 'No option chain data available',
      tp1Pct: 0, tp1: 0, tp2Pct: 0, tp2: 0, tp3Pct: 0, tp3: 0,
      trailingTarget: false,
      reasons: [`No usable option chain for ${symbol} — analysis unavailable`],
    },
    sdm: {
      total: 0,
      sentiment: 'neutral',
      confidence: 0,
      pcr: 1,
      maxPain: spotPrice,
      breakdown: { 'PCR': '1.00', 'Max Pain': spotPrice.toString(), 'CE OI': '0L', 'PE OI': '0L' },
    },
    spot: { spot: spotPrice, atmStrike: spotPrice, change: 0, changePct: 0 },
    expiry: { label: expiryDate, daysToExpiry: getStandardizedExpiry(symbol)?.days_to_expiry ?? 1, date: expiryDate },
    oiAnalysis: { totalCallOI: 0, totalPutOI: 0, pcr: 1, maxPain: spotPrice, sentiment: 'neutral' },
    gammaWalls: [],
    moneyFlow: { direction: 'neutral', smartMoneyDirection: 'neutral', callWriting: false, putWriting: false },
    greeks: { vix: 15 },
    strikes: [],
  };
}

// ─── generateTradeRecommendation (replaces sdm-recommendation entry) ─
export async function generateTradeRecommendation(
  optionChain: SDMOptionStrike[],
  spot: number,
  symbol: string,
  expiryDate: string,
  candles: Record<string, CandleData[]>,
  vix = 15,
  source = 'simulation',
  lastUpdate = new Date().toISOString(),
  overrideDirection?: 'CALL' | 'PUT',
): Promise<SDMRecommendation> {
  const primaryTF = Object.keys(candles).find((k) => k === '5m') || Object.keys(candles)[0] || '5m';
  const primaryCandles = candles[primaryTF] || [];
  const symbol2 = symbol || 'NIFTY';
  const lotSize = getLotSize(symbol2);
  const expiry = getStandardizedExpiry(symbol2);
  const daysToExpiry = expiry?.days_to_expiry ?? 1;
  const isExpiryDay = daysToExpiry <= 1;
  const atmStrikeData = chain_atm(optionChain, spot);
  const req = buildRequest(optionChain.filter((s) => s.ce || s.pe), spot, symbol2, expiryDate, primaryCandles);

  let direction: 'CALL' | 'PUT' | 'WAIT' = 'WAIT';
  let strike = atmStrikeData?.strike ?? spot;
  let type: 'CE' | 'PE' | null = null;
  let entry = 0, sl = 0, tp1 = 0, tp2 = 0, tp3 = 0, confidence = 0, rr = 0;
  let reasons: string[] = [];

  try {
    const engine = evaluateInstitutionalCandidate({ ...req, forceType: overrideDirection === 'PUT' ? 'PE' : overrideDirection === 'CALL' ? 'CE' : undefined } as any);
    if (engine.best && engine.best.passed) {
      direction = engine.direction === 'BULLISH' ? 'CALL' : 'PUT';
      type = engine.best.type;
      strike = engine.best.strike;
      entry = engine.best.entryPremium;
      sl = engine.best.slPremium;
      tp1 = engine.best.tp1Premium;
      tp2 = engine.best.tp2Premium;
      tp3 = engine.best.tp.runnerPremium || tp2;
      confidence = engine.best.confidence.score;
      rr = engine.best.rr;
      reasons = engine.best.validation.failures.length
        ? engine.best.validation.failures
        : [`Engine ${direction} ${type} @ ${strike}`];
    } else {
      reasons = engine.best?.validation.failures ?? ['Engine produced no candidate'];
    }
  } catch (e: any) {
    reasons = [`Engine error: ${e?.message || e}`];
  }

  const score = Math.round(confidence);
  const grade: any =
    score >= 75 ? 'A+' : score >= 65 ? 'A' : score >= 55 ? 'B+' : score >= 45 ? 'B' : 'C';

  return {
    direction,
    strike,
    strikeType: 'ATM' as any,
    entry,
    tp1, tp2, tp3, sl,
    confidence: Math.round(confidence),
    riskReward: Math.round(rr * 10) / 10,
    isExpiryDay,
    daysToExpiry,
    currentWindow: 'DAY' as any,
    windowTimeRemaining: '',
    tradesTakenToday: 0,
    tradesRemaining: 0,
    mode: isExpiryDay ? 'SCALPER' as any : 'SWING' as any,
    sellerSLZone: {} as any,
    gammaThetaData: {} as any,
    marketContext: {
      pcr: req.chain.length ? pcrOf(req.chain) : 1,
      vix,
      maxPain: 0,
      spot,
    } as any,
    watchList: [] as any,
    whyThisTrade: [] as any,
    sdmScores: {} as any,
    reason: reasons.join(' · '),
    timeSensitiveNote: '',
    smartEntry: {} as any,
    smartExit: {} as any,
    premiumFairValue: {} as any,
    probabilities: {} as any,
    tradeGrade: grade,
    dataHealth: {} as any,
    positionSizing: {} as any,
    marketRegime: {} as any,
    holdingTimeEstimate: '',
    expectedMove: 0,
    consensus: undefined as any,
    qualityScore: undefined as any,
    smartEntryResult: undefined as any,
    smartExitResult: undefined as any,
    marketStructure: undefined as any,
    session: undefined as any,
  };
}

function chain_atm(chain: SDMOptionStrike[], spot: number): SDMOptionStrike | undefined {
  const valid = chain.filter((s) => s.ce || s.pe);
  if (!valid.length) return undefined;
  return valid.reduce((b, s) =>
    Math.abs(s.strike - spot) < Math.abs(b.strike - spot) ? s : b
  );
}

function pcrOf(chain: any[]): number {
  let ce = 0, pe = 0;
  for (const s of chain) { ce += s.ce?.oi || 0; pe += s.pe?.oi || 0; }
  return pe > 0 ? ce / pe : 1;
}

// Preserved from sdm-recommendation.ts (SDMBot uses issues/warnings/isValid)
export interface ValidationResult {
  isValid: boolean;
  issues: string[];
  warnings: string[];
  dataQuality: number;
}

export function validateOptionChain(
  optionChain: SDMOptionStrike[],
  spotPrice: number,
  _symbol: string,
): ValidationResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  if (!optionChain || optionChain.length === 0) {
    issues.push('Option chain is empty');
    return { isValid: false, issues, warnings, dataQuality: 0 };
  }
  if (spotPrice <= 0) {
    issues.push(`Invalid spot price: ${spotPrice}`);
    return { isValid: false, issues, warnings, dataQuality: 0 };
  }
  const valid = optionChain.filter((s) => s.ce || s.pe);
  const withLtp = valid.filter((s) => (s.ce?.ltp || 0) > 0 || (s.pe?.ltp || 0) > 0).length;
  const quality = valid.length ? Math.round((withLtp / valid.length) * 100) : 0;
  if (quality < 50) warnings.push(`Only ${quality}% of strikes have price data`);
  if (valid.length < 5) warnings.push('Sparse option chain');
  return { isValid: valid.length > 0 && spotPrice > 0, issues, warnings, dataQuality: quality };
}
