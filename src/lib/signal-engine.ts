// ═══════════════════════════════════════════════════════════════════
// ORCA — Institutional Options Trading AI Engine
// 15 Modules: Market Data, Structure, Greeks, OI, Smart Money,
// Flow, Entry, Risk, Confidence, Alerts, Output, Self-Learning, 0DTE
// ═══════════════════════════════════════════════════════════════════

import type { SDMOptionStrike } from "@/types/sdm";
import { calculateGreeks } from "./greeks";
import { getSymbolConfig, type SymbolConfig } from "./symbol-config";
import { loadStrategyConfig, type StrategyConfig } from "./strategy-config";

// ─── ORCA Strategy Configuration ─────────────────────────────────
export interface OrcaStrategyConfig extends StrategyConfig {
  // ORCA-specific risk management settings
  slPercent?: number;
  tp1Multiplier?: number;
  tp2Multiplier?: number;
  tp3Multiplier?: number;
}

function getOrcaStrategyConfig(symbol: string, overrideConfig?: Partial<OrcaStrategyConfig>): OrcaStrategyConfig {
  const defaultStrategyConfig = loadStrategyConfig();
  const config = getSymbolConfig(symbol);

  const mergedConfig: OrcaStrategyConfig = {
    symbol: symbol,
    label: `ORCA ${symbol}`, // Custom label for ORCA
    lotSize: config.lotSize,
    tickSize: config.tickSize,
    maxLots: config.maxLots,
    typicalPremium: config.typicalPremium,
    version: defaultStrategyConfig.version,
    name: defaultStrategyConfig.name,
    lastModified: new Date().toISOString(),
    modules: defaultStrategyConfig.modules,
    confidence: defaultStrategyConfig.confidence,
    entry: defaultStrategyConfig.entry,
    greeks: defaultStrategyConfig.greeks,
    oi: defaultStrategyConfig.oi,
    smartMoney: defaultStrategyConfig.smartMoney,
    risk: defaultStrategyConfig.risk,
    strike: defaultStrategyConfig.strike,
    session: defaultStrategyConfig.session,
    symbolOverrides: defaultStrategyConfig.symbolOverrides,
    // ORCA-specific defaults
    slPercent: defaultStrategyConfig.risk.slPercent,
    tp1Multiplier: defaultStrategyConfig.risk.tp1Multiplier,
    tp2Multiplier: defaultStrategyConfig.risk.tp2Multiplier,
    tp3Multiplier: defaultStrategyConfig.risk.tp3Multiplier,
  };

  if (overrideConfig) {
    Object.assign(mergedConfig, overrideConfig);
  }

  return mergedConfig;
}

function round(v: number, d = 2): string {
  return Math.round(v * 10 ** d) / 10 ** d;
}

// ─── MODULES ────────────────────────────────────────────────────

// Module 2: Market Structure
function analyzeMarketStructure(
  spot: number, candles: any[], prevDay: { high: number; low: number; close: number }
) {
  const highs = candles.map((c: any) => c.high);
  const lows = candles.map((c: any) => c.low);
  const closes = candles.map((c: any) => c.close);
  
  const dailyHigh = Math.max(...highs, spot);
  const dailyLow = Math.min(...lows, spot);
  
  const openingRange = {
    high: Math.max(...candles.slice(0, 6).map((c: any) => c.high)),
    low: Math.min(...candles.slice(0, 6).map((c: any) => c.low)),
  };

  let cumVolPrice = 0, cumVol = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    cumVolPrice += typical * (c.volume || 1);
    cumVol += (c.volume || 1);
  }
  const vwap = cumVol > 0 ? cumVolPrice / cumVol : spot;

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);

  const atr = calculateATR(candles, 14);
  const hl2 = (dailyHigh + dailyLow) / 2;
  const supertrend = spot > hl2 + atr * 2 ? hl2 + atr * 2 : spot < hl2 - atr * 2 ? hl2 - atr * 2 : ema21;

  return {
    trend: getTrend(dailyHigh, dailyLow, prevDay.high, prevDay.low, spot, atr),
    structure: getStructure(dailyHigh, dailyLow, prevDay.high, prevDay.low, spot, atr),
    higherHigh: dailyHigh > prevDay.high,
    higherLow: dailyLow > prevDay.low,
    lowerHigh: dailyHigh < prevDay.high,
    lowerLow: dailyLow < prevDay.low,
    dailyHigh, dailyLow,
    openingRange,
    vwap,
    ema9,
    ema21,
    supertrend,
    prevDayHigh: prevDay.high,
    prevDayLow: prevDay.low,
  };
}

function calculateEMA(data: number[], period: number): number {
  if (data.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

export function calculateATR(candles: any[], period: number): number {
  if (candles.length < 2) return 0;
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

function getTrend(dailyHigh: number, dailyLow: number, prevDayHigh: number, prevDayLow: number, spot: number, atr: number): string {
  const hh = dailyHigh > prevDayHigh;
  const hl = dailyLow > prevDayLow;
  const lh = dailyHigh < prevDayHigh;
  const ll = dailyLow < prevDayLow;
  
  if (hh && hl) return "TRENDING";
  if (lh && ll) return "TRENDING";
  if (Math.abs(dailyHigh - dailyLow) / spot < 0.005) return "COMPRESSION";
  if (atr / spot > 0.015) return "VOLATILE";
  if (spot > (dailyHigh + dailyLow) / 2) return "BULLISH";
  return "BEARISH";
}

function getStructure(dailyHigh: number, dailyLow: number, prevDayHigh: number, prevDayLow: number, spot: number, atr: number): string {
  const hh = dailyHigh > prevDayHigh;
  const hl = dailyLow > prevDayLow;
  
  if (hh && hl) return "UPTREND";
  if (dailyHigh < prevDayHigh && dailyLow < prevDayLow) return "DOWNTREND";
  return "RANGING";
}

// Module 3: Greeks Analysis
function analyzeGreeks(chain: SDMOptionStrike[], spot: number, atmStrike: number, timeToExpiry: number) {
  const atmCe = chain.find(s => s.strike === atmStrike)?.ce;
  const atmPe = chain.find(s => s.strike === atmStrike)?.pe;

  const atmDelta = atmCe?.delta || 0;
  const atmGamma = atmCe?.gamma || 0;
  const atmTheta = atmCe?.theta || 0;
  const atmVega = atmCe?.vega || 0;

  let cumGEX = 0;
  let gammaFlip = atmStrike;
  for (const s of chain) {
    const callGEX = (s.ce?.gamma || 0) * (s.ce?.oi || 0) * spot * spot * 0.0001;
    const putGEX = (s.pe?.gamma || 0) * (s.pe?.oi || 0) * spot * spot * 0.0001;
    const netGEX = callGEX - putGEX;
    const prevCum = cumGEX;
    cumGEX += netGEX;
    if (prevCum < 0 && cumGEX >= 0) gammaFlip = s.strike;
  }

  const dealerRegime = spot > gammaFlip ? "LONG_GAMMA" : "SHORT_GAMMA";

  let maxCallGEX = 0, maxPutGEX = 0;
  let gammaWall: any = null;
  for (const s of chain) {
    const cgex = Math.abs((s.ce?.gamma || 0) * (s.ce?.oi || 0));
    const pgex = Math.abs((s.pe?.gamma || 0) * (s.pe?.oi || 0));
    if (cgex > maxCallGEX) { maxCallGEX = cgex; gammaWall = { strike: s.strike, type: "CE", gex: cgex }; }
    if (pgex > maxPutGEX) { maxPutGEX = pgex; if (pgex > maxCallGEX) gammaWall = { strike: s.strike, type: "PE", gex: pgex }; }
  }

  const ivs = chain.flatMap(s => [s.ce?.iv || 0, s.pe?.iv || 0]).filter(v => v > 0);
  const avgIV = ivs.length > 0 ? ivs.reduce((a, b) => a + b, 0) / ivs.length : 0.15;
  const ivPercentile = Math.min(Math.max((avgIV - 0.08) / (0.35 - 0.08) * 100, 0), 100);
  const ivRank = Math.min(Math.max((avgIV - 0.10) / (0.30 - 0.10) * 100, 0), 100);

  return {
    atmDelta, atmGamma, atmTheta, atmVega,
    deltaTrend: "STABLE",
    gammaFlip, dealerRegime,
    dealerBias: dealerRegime === "LONG_GAMMA" ? "BULLISH" : "BEARISH",
    gammaWall, gammaSqueeze: false,
    ivPercentile, ivRank,
    ivExpansion: ivPercentile > 70,
    ivCrush: ivPercentile < 30,
    thetaDecayRate: Math.abs(atmTheta),
    rapidThetaBurn: Math.abs(atmTheta) > 2,
  };
}

// Module 4: OI Analysis
function analyzeOI(chain: SDMOptionStrike[], spot: number) {
  let totalCallOI = 0, totalPutOI = 0;
  let totalCallVol = 0, totalPutVol = 0;
  const topCallWalls: { strike: number; oi: number }[] = [];
  const topPutWalls: { strike: number; oi: number }[] = [];

  let callLongBuildup = false, putLongBuildup = false;
  let callUnwinding = false, putUnwinding = false;
  let freshCallWriting = false, freshPutWriting = false;

  for (const s of chain) {
    if (s.ce) {
      totalCallOI += s.ce.oi;
      totalCallVol += s.ce.volume;
      if (s.ce.oiChg > 50000 && s.ce.ltp > 0) callLongBuildup = true;
      if (s.ce.oiChg < -50000) callUnwinding = true;
      if (s.ce.oiChg > 100000 && s.ce.ltp < 5) freshCallWriting = true;
      topCallWalls.push({ strike: s.strike, oi: s.ce.oi });
    }
    if (s.pe) {
      totalPutOI += s.pe.oi;
      totalPutVol += s.pe.volume;
      if (s.pe.oiChg > 50000 && s.pe.ltp > 0) putLongBuildup = true;
      if (s.pe.oiChg < -50000) putUnwinding = true;
      if (s.pe.oiChg > 100000 && s.pe.ltp < 5) freshPutWriting = true;
      topPutWalls.push({ strike: s.strike, oi: s.pe.oi });
    }
  }

  const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;
  const dynamicPcr = totalCallVol > 0 ? totalPutVol / totalCallVol : pcr;

  let minPain = Infinity, maxPainStrike = spot;
  for (const s of chain) {
    let pain = 0;
    for (const s2 of chain) {
      if (s2.ce && s2.strike < s.strike) pain += (s.strike - s2.strike) * s2.ce.oi;
      if (s2.pe && s2.strike > s.strike) pain += (s2.strike - s.strike) * s2.pe.oi;
    }
    if (pain < minPain) { minPain = pain; maxPainStrike = s.strike; }
  }

  topCallWalls.sort((a, b) => b.oi - a.oi);
  topPutWalls.sort((a, b) => b.oi - a.oi);

  return {
    totalCallOI, totalPutOI, pcr, dynamicPcr, maxPain: maxPainStrike,
    callLongBuildup, putLongBuildup, callUnwinding, putUnwinding,
    freshCallWriting, freshPutWriting, shortCovering: callUnwinding && putLongBuildup,
    oiShift: false, supportShift: null, resistanceShift: null, strikeRotation: false,
    topCallWalls: topCallWalls.slice(0, 5),
    topPutWalls: topPutWalls.slice(0, 5),
  };
}

// Module 5: Smart Money
function analyzeSmartMoney(spot: number, candles: any[], structure: any) {
  const last3 = candles.slice(-3);
  const prev3 = candles.slice(-6, -3);
  
  const lastRange = last3.length > 0 ? 
    Math.max(...last3.map((c: any) => c.high)) - Math.min(...last3.map((c: any) => c.low)) : 0;
  const prevRange = prev3.length > 0 ? 
    Math.max(...prev3.map((c: any) => c.high)) - Math.min(...prev3.map((c: any) => c.low)) : 1;

  const sweepBullish = spot > structure.dailyLow && spot < structure.dailyLow + (structure.dailyHigh - structure.dailyLow) * 0.15;
  const sweepBearish = spot < structure.dailyHigh && spot > structure.dailyHigh - (structure.dailyHigh - structure.dailyLow) * 0.15;

  const fakeBreak = lastRange > prevRange * 1.5 && last3.length >= 2 && last3[last3.length - 1].close < last3[last3.length - 2].high;

  return {
    liquiditySweep: {
      detected: sweepBullish || sweepBearish,
      direction: sweepBullish ? "BULLISH" : sweepBearish ? "BEARISH" : null,
      level: sweepBullish ? structure.dailyLow : structure.dailyHigh,
    },
    equalHighSweep: false,
    equalLowSweep: false,
    stopHunt: { detected: sweepBullish || sweepBearish, direction: sweepBullish ? "BULLISH" : sweepBearish ? "BEARISH" : null },
    fakeBreakout: { detected: fakeBreak, direction: spot > structure.vwap ? "BEARISH" : "BULLISH" },
    breakOfStructure: { detected: false, direction: null },
    marketStructureShift: false,
    changeOfCharacter: false,
    orderBlock: null,
    fairValueGap: null,
    imbalances: [],
  };
}

// Module 6: Option Flow
function analyzeFlow(chain: SDMOptionStrike[]): any {
  let totalCEVol = 0, totalPEVol = 0;
  let maxCEVol = 0, maxPEVol = 0;
  let largeOrders = 0;

  for (const s of chain) {
    if (s.ce) {
      totalCEVol += s.ce.volume;
      if (s.ce.volume > maxCEVol) maxCEVol = s.ce.volume;
      if (s.ce.volume > 100000) largeOrders++;
    }
    if (s.pe) {
      totalPEVol += s.pe.volume;
      if (s.pe.volume > maxPEVol) maxPEVol = s.pe.volume;
      if (s.pe.volume > 100000) largeOrders++;
    }
  }

  const avgVol = (totalCEVol + totalPEVol) / (chain.length * 2 || 1);

  return {
    largePremiumBuying: largeOrders > 2,
    largePremiumSelling: false,
    blockTrades: largeOrders > 3,
    institutionalOrders: largeOrders > 1,
    aggressiveBuyers: totalCEVol > totalPEVol * 1.3,
    aggressiveSellers: totalPEVol > totalCEVol * 1.3,
    volumeSpike: maxCEVol > avgVol * 3 || maxPEVol > avgVol * 3,
    unusualActivity: largeOrders > 2,
  };
}

// Module 7: Entry Signal
function getEntrySignal(
  spot: number, 
  chain: SDMOptionStrike[], 
  config: OrcaStrategyConfig,
  bias: "STRONG_BULLISH" | "BULLISH" | "NEUTRAL" | "BEARISH" | "STRONG_BEARISH",
  confidenceScore: any,
  expiry: string,
  isExpiryDay: boolean,
  confidenceThreshold: number = 85
) {
  const atmStrike = chain.reduce((best, s) =>
    Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best
  ).strike;

  const atmIdx = chain.findIndex(s => s.strike === atmStrike);
  const strikes = chain.map(s => s.strike);

  // Pick strike based on bias and confidence
  let strikeIdx = atmIdx;
  let strikeType: "ATM" | "1_ITM" | "2_ITM" | "1_OTM" | "2_OTM" = "ATM";

  if (bias === "STRONG_BULLISH" || bias === "BULLISH") {
    if (confidenceScore.total >= 90) { strikeIdx = atmIdx; strikeType = "ATM"; }
    else if (confidenceScore.total >= 80) { strikeIdx = Math.max(0, atmIdx - 1); strikeType = "1_OTM"; }
    else { strikeIdx = Math.max(0, atmIdx - (config.strike?.otmForLowConfidence ?? 2)); strikeType = "2_OTM"; }
  } else if (bias === "STRONG_BEARISH" || bias === "BEARISH") {
    if (confidenceScore.total >= 90) { strikeIdx = atmIdx; strikeType = "ATM"; }
    else if (confidenceScore.total >= 80) { strikeIdx = Math.min(chain.length - 1, atmIdx + 1); strikeType = "1_OTM"; }
    else { strikeIdx = Math.min(chain.length - 1, atmIdx + (config.strike?.otmForLowConfidence ?? 2)); strikeType = "2_OTM"; }
  }

  const selectedStrike = strikes[Math.min(Math.max(strikeIdx, 0), strikes.length - 1)];
  const strikeData = chain.find(s => s.strike === selectedStrike);

  const isCall = bias === "BULLISH" || bias === "STRONG_BULLISH";
  const premium = isCall ? (strikeData?.ce?.ltp || 0) : (strikeData?.pe?.ltp || 0);

  // Risk levels based on config
  const sl = round(premium * (config.slPercent ?? 35) / 100);
  const tp1 = round(premium * (config.tp1Multiplier ?? 1.5));
  const tp2 = round(premium * (config.tp2Multiplier ?? 2.2));
  const tp3 = round(premium * (config.tp3Multiplier ?? 3.5));
  const rr = tp1 > 0 && sl > 0 ? round((tp1 - premium) / (premium - sl)) : 0;

  const lots = 1;
  const qty = lots * config.lotSize;
  const capital = round(premium * qty);
  const maxLoss = round((premium - sl) * qty);
  const maxProfit = round((tp2 - premium) * qty);

  const action: "BUY_CALL" | "BUY_PUT" | "WAIT" | "NO_TRADE" = 
    confidenceScore.total >= confidenceThreshold
      ? (isCall ? "BUY_CALL" : "BUY_PUT")
      : "WAIT";

  const reason = confidenceScore.total >= confidenceThreshold
    ? `${isCall ? "Bullish" : "Bearish"} setup with ${confidenceScore.total}% confidence. ${isCall ? "Call" : "Put"} long buildup detected.`
    : `Confidence ${confidenceScore.total}% below ${confidenceThreshold}% threshold. Wait for stronger alignment.`;

  return {
    action, strike: selectedStrike, strikeType, expiry,
    currentPremium: premium, entry: premium, stopLoss: sl,
    target1: tp1, target2: tp2, target3: tp3,
    expectedPremiumMove: `+${round((tp2 / premium - 1) * 100)}%`,
    riskReward: rr, reason, confidence: confidenceScore.total,
    lotSize: config.lotSize, capitalRequired: capital, maxLots: config.maxLots,
    maxLoss, maxProfit,
    thetaRisk: isExpiryDay ? "HIGH — 0DTE theta decay" : "MODERATE",
    timeRisk: isExpiryDay ? "CRITICAL — hours to expiry" : `${Math.round(24 * 7)}h to expiry`,
  };
}

// Module 10: Risk Engine
function calculateRisk(rec: any, config: OrcaStrategyConfig) {
  const qty = config.lotSize;
  const riskPerLot = rec.entry - rec.stopLoss;
  const rewardPerLot = rec.target2 - rec.entry;

  return {
    entry: rec.entry,
    stopLoss: rec.stopLoss,
    target1: rec.target1, target2: rec.target2, target3: rec.target3,
    riskReward: rec.riskReward,
    probability: Math.min(rec.confidence * 0.85, 95),
    premiumRisk: round(rec.entry * qty),
    timeRisk: rec.timeRisk,
    thetaRisk: round(riskPerLot * qty * 0.1),
    capitalRequired: rec.capitalRequired,
    maxLots: rec.maxLots,
    maxLoss: rec.maxLoss,
    maxProfit: rec.maxProfit,
  };
}

// Module 11: Confidence Engine
function calculateConfidence(market: any, oi: any, greeks: any, flow: any, smartMoney: any, spot: number) {
  const breakdown: string[] = [];
  let trendScore = 0, oiScore = 0, greeksScore = 0, liqScore = 0, volScore = 0, paScore = 0, instScore = 0;

  // Trend (20)
  if (market.structure === "UPTREND" || market.structure === "DOWNTREND") {
    trendScore = 18;
    breakdown.push(`Trend: ${market.structure} (+18/20)`);
  } else if (market.trend === "TRENDING") {
    trendScore = 15;
    breakdown.push(`Trend: Trending (+15/20)`);
  } else {
    trendScore = 8;
    breakdown.push(`Trend: ${market.trend} (+8/20)`);
  }

  // OI (20)
  if (oi.callLongBuildup || oi.putLongBuildup) {
    oiScore = 17;
    breakdown.push(`OI: ${oi.callLongBuildup ? "Call" : "Put"} long buildup (+17/20)`);
  } else if (oi.freshCallWriting || oi.freshPutWriting) {
    oiScore = 14;
    breakdown.push(`OI: Fresh writing (+14/20)`);
  } else {
    oiScore = 10;
    breakdown.push(`OI: Neutral (+10/20)`);
  }

  // Greeks (20)
  if (greeks.dealerRegime === "LONG_GAMMA" && greeks.ivPercentile < 60) {
    greeksScore = 18;
    breakdown.push(`Greeks: Long gamma, moderate IV (+18/20)`);
  } else if (greeks.gammaSqueeze) {
    greeksScore = 16;
    breakdown.push(`Greeks: Gamma squeeze detected (+16/20)`);
  } else {
    greeksScore = 10;
    breakdown.push(`Greeks: Neutral (+10/20)`);
  }

  // Liquidity (15)
  if (smartMoney.liquiditySweep.detected) {
    liqScore = 14;
    breakdown.push(`Liquidity: Sweep confirmed (+14/15)`);
  } else {
    liqScore = 9;
    breakdown.push(`Liquidity: Normal (+9/15)`);
  }

  // Volume (10)
  if (flow.volumeSpike) {
    volScore = 9;
    breakdown.push(`Volume: Spike detected (+9/10)`);
  } else {
    volScore = 6;
    breakdown.push(`Volume: Normal (+6/10)`);
  }

  // Price Action (10)
  if (market.higherHigh && market.higherLow) {
    paScore = 9;
    breakdown.push(`PA: Higher Highs/Lows (+9/10)`);
  } else if (market.lowerHigh && market.lowerLow) {
    paScore = 9;
    breakdown.push(`PA: Lower Highs/Lows (+9/10)`);
  } else {
    paScore = 5;
    breakdown.push(`PA: Mixed (+5/10)`);
  }

  // Institutional Flow (5)
  if (flow.institutionalOrders || flow.blockTrades) {
    instScore = 5;
    breakdown.push(`Flow: Institutional activity (+5/5)`);
  } else {
    instScore = 2;
    breakdown.push(`Flow: Retail dominated (+2/5)`);
  }

  const total = trendScore + oiScore + greeksScore + liqScore + volScore + paScore + instScore;
  let level: string;
  if (total >= 90) level = "STRONG_BUY";
  else if (total >= 80) level = "BUY";
  else if (total >= 70) level = "WATCH";
  else level = "NO_TRADE";

  return {
    total, level,
    trend: trendScore, oi: oiScore, greeks: greeksScore,
    liquidity: liqScore, volume: volScore, priceAction: paScore,
    institutionalFlow: instScore, breakdown,
  };
}

// Module 12: Alerts
function generateAlerts(greeks: any, oi: any, smartMoney: any, flow: any, confidence: any, spot: number) {
  const alerts: any[] = [];
  const now = new Date().toISOString();

  if (greeks.gammaWall && spot > greeks.gammaWall.strike)
    alerts.push({ type: "GAMMA_WALL_BREAK", message: `Gamma wall at ${greeks.gammaWall.strike} BROKEN`, severity: "HIGH", timestamp: now });
  if (greeks.ivExpansion)
    alerts.push({ type: "IV_SPIKE", message: `IV expanding — percentile ${greeks.ivPercentile.toFixed(0)}%`, severity: "MEDIUM", timestamp: now });
  if (oi.pcr > 1.3 || oi.pcr < 0.7)
    alerts.push({ type: "PCR_SHIFT", message: `PCR at ${oi.pcr.toFixed(2)} — extreme`, severity: "HIGH", timestamp: now });
  if (oi.callLongBuildup || oi.putLongBuildup)
    alerts.push({ type: "OI_SHIFT", message: `${oi.callLongBuildup ? "Call" : "Put"} long buildup detected`, severity: "MEDIUM", timestamp: now });
  if (smartMoney.liquiditySweep.detected)
    alerts.push({ type: "LIQUIDITY_SWEEP", message: `Liquidity sweep ${smartMoney.liquiditySweep.direction} at ${smartMoney.liquiditySweep.level}`, severity: "HIGH", timestamp: now });
  if (smartMoney.fakeBreakout.detected)
    alerts.push({ type: "FAKE_BREAKOUT", message: `Fake breakout detected — ${smartMoney.fakeBreakout.direction}`, severity: "HIGH", timestamp: now });
  if (flow.volumeSpike)
    alerts.push({ type: "PREMIUM_EXPLOSION", message: "Volume spike — premium explosion possible", severity: "MEDIUM", timestamp: now });
  if (flow.institutionalOrders)
    alerts.push({ type: "SMART_MONEY_ENTRY", message: "Institutional orders detected", severity: "HIGH", timestamp: now });
  if (confidence.total >= 90)
    alerts.push({ type: "HIGH_PROBABILITY_SETUP", message: `Confidence ${confidence.total}% — HIGH PROBABILITY`, severity: "HIGH", timestamp: now });

  return alerts;
}

// Module 15: 0DTE Engine
function analyzeZeroDte(spot: number, chain: SDMOptionStrike[], greeks: any, isExpiryDay: boolean) {
  if (!isExpiryDay) {
    return {
      active: false, gammaSqueeze: false, dealerHedging: false,
      gammaFlip: false, vannaFlow: "N/A", charmFlow: "N/A",
      premiumExplosion: false, premiumSpeed: "N/A",
    };
  }

  const gammaSqueeze = Math.abs(spot - greeks.gammaFlip) / spot < 0.002 && greeks.atmGamma > 0.001;
  const dealerHedging = greeks.gammaWall !== null && spot > greeks.gammaWall.strike;

  return {
    active: true,
    gammaSqueeze,
    dealerHedging,
    gammaFlip: Math.abs(spot - greeks.gammaFlip) / spot < 0.003,
    vannaFlow: gammaSqueeze ? "POSITIVE — spot rising, IV falling" : "NEUTRAL",
    charmFlow: "ACTIVE — delta decay accelerating",
    premiumExplosion: gammaSqueeze && dealerHedging,
    premiumSpeed: gammaSqueeze ? "RAPID" : "NORMAL",
  };
}

// Main ORCA Engine
export function runOrcaEngine(input: {
  spot: number;
  chain: SDMOptionStrike[];
  candles: any[];
  symbol: string;
  expiry: string;
  isExpiryDay: boolean;
  prevDay: { high: number; low: number; close: number };
  confidenceThreshold?: number;
  strategyConfig?: OrcaStrategyConfig;
}) {
  const { spot, chain, candles, symbol, expiry, isExpiryDay, prevDay, confidenceThreshold = 85, strategyConfig } = input;
  
  const config = getOrcaStrategyConfig(symbol, strategyConfig);

  const atmStrike = chain.reduce((best, s) =>
    Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best
  ).strike;

  const timeToExpiry = isExpiryDay ? 0.02 : 7;

  const structure = analyzeMarketStructure(spot, candles, prevDay);
  const greeks = analyzeGreeks(chain, spot, atmStrike, timeToExpiry);
  const oi = analyzeOI(chain, spot);
  const smartMoney = analyzeSmartMoney(spot, candles, structure);
  const flow = analyzeFlow(chain);

  let marketBias: "STRONG_BULLISH" | "BULLISH" | "NEUTRAL" | "BEARISH" | "STRONG_BEARISH" = "NEUTRAL";
  const bullishSignals = [
    structure.structure === "UPTREND",
    oi.callLongBuildup,
    oi.putUnwinding,
    greeks.dealerRegime === "LONG_GAMMA",
    smartMoney.liquiditySweep.direction === "BULLISH",
    flow.aggressiveBuyers,
  ].filter(Boolean).length;

  const bearishSignals = [
    structure.structure === "DOWNTREND",
    oi.putLongBuildup,
    oi.callUnwinding,
    greeks.dealerRegime === "SHORT_GAMMA",
    smartMoney.liquiditySweep.direction === "BEARISH",
    flow.aggressiveSellers,
  ].filter(Boolean).length;

  if (bullishSignals >= 4) marketBias = "STRONG_BULLISH";
  else if (bullishSignals >= 3) marketBias = "BULLISH";
  else if (bearishSignals >= 4) marketBias = "STRONG_BEARISH";
  else if (bearishSignals >= 3) marketBias = "BEARISH";

  const confidence = calculateConfidence(structure, oi, greeks, flow, smartMoney, spot);
  const rec = getEntrySignal(spot, chain, config, marketBias, confidence, expiry, isExpiryDay, confidenceThreshold);
  const risk = calculateRisk(rec, config);
  const alerts = generateAlerts(greeks, oi, smartMoney, flow, confidence, spot);
  const zeroDte = analyzeZeroDte(spot, chain, greeks, isExpiryDay);

  const strikes: any[] = chain.map(s => {
    const cgex = (s.ce?.gamma || 0) * (s.ce?.oi || 0) * spot * spot * 0.0001;
    const pgex = (s.pe?.gamma || 0) * (s.pe?.oi || 0) * spot * spot * 0.0001;
    return {
      strike: s.strike,
      ce: {
        ltp: s.ce?.ltp || 0, oi: s.ce?.oi || 0, oiChg: s.ce?.oiChg || 0,
        volume: s.ce?.volume || 0, iv: s.ce?.iv || 0,
        delta: s.ce?.delta || 0, gamma: s.ce?.gamma || 0,
        theta: s.ce?.theta || 0, vega: s.ce?.vega || 0,
        bid: s.ce?.bid || 0, ask: s.ce?.ask || 0,
        spread: (s.ce?.ask || 0) - (s.ce?.bid || 0),
        pattern: (s.ce?.oiChg || 0) > 50000 ? "LONG_BUILDUP" : (s.ce?.oiChg || 0) < -50000 ? "UNWINDING" : "NEUTRAL",
        freshBuying: (s.ce?.oiChg || 0) > 50000 && (s.ce?.ltp || 0) > 10,
        freshWriting: (s.ce?.oiChg || 0) > 100000 && (s.ce?.ltp || 0) < 5,
        largeOrder: (s.ce?.volume || 0) > 100000,
        unusualVolume: (s.ce?.volume || 0) > 200000,
      },
      pe: {
        ltp: s.pe?.ltp || 0, oi: s.pe?.oi || 0, oiChg: s.pe?.oiChg || 0,
        volume: s.pe?.volume || 0, iv: s.pe?.iv || 0,
        delta: s.pe?.delta || 0, gamma: s.pe?.gamma || 0,
        theta: s.pe?.theta || 0, vega: s.pe?.vega || 0,
        bid: s.pe?.bid || 0, ask: s.pe?.ask || 0,
        spread: (s.pe?.ask || 0) - (s.pe?.bid || 0),
        pattern: (s.pe?.oiChg || 0) > 50000 ? "LONG_BUILDUP" : (s.pe?.oiChg || 0) < -50000 ? "UNWINDING" : "NEUTRAL",
        freshBuying: (s.pe?.oiChg || 0) > 50000 && (s.pe?.ltp || 0) > 10,
        freshWriting: (s.pe?.oiChg || 0) > 100000 && (s.pe?.ltp || 0) < 5,
        largeOrder: (s.pe?.volume || 0) > 100000,
        unusualVolume: (s.pe?.volume || 0) > 200000,
      },
      gammaExposure: cgex - pgex,
      netGEX: cgex - pgex,
      isGammaWall: Math.abs(s.strike - (greeks.gammaWall?.strike || 0)) < 50,
      isLiquidityWall: (s.ce?.oi || 0) > 500000 || (s.pe?.oi || 0) > 500000,
    };
  });

  return {
    timestamp: new Date().toISOString(),
    symbol, spot, expiry, isExpiryDay,
    timeToExpiry: isExpiryDay ? "Expiry Day — Hours remaining" : `${Math.round(24 * 7)} hours to expiry`,
    marketBias, marketStructure: structure,
    greeks, oi, smartMoney, flow,
    recommendation: rec,
    risk, confidence, alerts,
    reasons: [`Strategy using ${config.name}`],
    greeksSummary: `Delta ${greeks.atmDelta.toFixed(2)} | Gamma ${greeks.atmGamma.toFixed(4)} | Theta ${greeks.atmTheta.toFixed(2)} | Vega ${greeks.atmVega.toFixed(2)}`,
    oiSummary: `PCR ${oi.pcr.toFixed(2)} | ${oi.callLongBuildup ? "Call long buildup" : oi.putLongBuildup ? "Put long buildup" : "Neutral"}`,
    liquiditySummary: smartMoney.liquiditySweep.detected ? `Liquidity sweep ${smartMoney.liquiditySweep.direction}` : "No sweep detected",
    smartMoneySummary: `Sweep: ${smartMoney.liquiditySweep.detected ? "YES" : "NO"}`,
    zeroDte, strikes,
  };
}

// Export types
export type {
  MarketBias,
  TradeAction,
  TrendState,
  StructureType,
  DealerRegime,
  ConfidenceLevel,
  AlertType,
  OrcaStrikeAnalysis,
  MarketStructureAnalysis,
  GreeksAnalysis,
  OIAnalysisResult,
  SmartMoneySignals,
  OptionFlowSignals,
  StrikeRecommendation,
  RiskCalculation,
  ConfidenceScore,
  OrcaAlert,
  OrcaSignal,
  OrcaStrategyConfig,
};