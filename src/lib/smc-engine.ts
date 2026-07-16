// Institutional Smart Money Engine V2 — SMC India Edition
// Enhanced for Indian Index Options (NIFTY, BANKNIFTY, FINNIFTY, SENSEX)
// Reuses every existing module — market-structure, canonical (FVG/OB), greeks,
// signal-engine (ATR), ml-engine (VWAP), sdm-oianalysis, volume-analysis.
// No new databases, APIs, or architecture.

import { calculateGreeks } from "@/lib/greeks";
import { calculateATR } from "@/lib/orca-strategy";
import { calculateVWAP, calculateEMA, calculateADX } from "@/lib/ml-engine";
import { analyzeOptionChain, classifyOIPattern } from "@/lib/sdm-oianalysis";
import {
  detectSwingPoints,
  detectStructureEvents,
  analyzeMarketStructure,
} from "@/lib/market-structure";
import { detectFVG, detectOrderBlocks } from "@/lib/market/canonical";
import { computeVolumeProfile, findPOC } from "@/lib/volume-analysis";
import { getStandardizedExpiry } from "@/lib/expiry-calculator";
import type { SDMOptionStrike, CandleData, VolumeProfileLevel } from "@/types/sdm";
import type { VolumeProfileLevel } from "@/lib/volume-analysis";

export type Direction = "BULLISH" | "BEARISH" | "NEUTRAL";
export type ConfidenceLabel = "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW";
export type QualityGrade = "A+" | "A" | "B" | "C" | "D";

export interface SMCInput {
  symbol: string;
  spot: number;
  optionChain: SDMOptionStrike[];
  candles?: CandleData[];
  vix?: number;
  capital?: number;
  riskPercent?: number;
  lotSize?: number;
  maxPositionSize?: number;
  historicalWinRate?: number;
  historicalRR?: number;
  pcrHistory?: number[];
  giftNiftyBias?: Direction;
  giftNiftyGap?: number;
  candles5m?: CandleData[];
  candles15m?: CandleData[];
  candles1h?: CandleData[];
}

export interface SMCPositionSize {
  lots: number;
  quantity: number;
  capitalUsed: number;
  maxLoss: number;
  maxGain: number;
  riskPercent: number;
}

export interface SMCCandidate {
  strike: number;
  type: "CE" | "PE";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3?: number;
  rr: number;
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  qualityGrade: QualityGrade;
  qualityScore: number;
  positionSize: SMCPositionSize;
  reasons: string[];
  rejectedFilters: string[];
}

export interface SMCMarketStructure {
  trend: Direction;
  bos: boolean;
  choch: boolean;
  liquiditySweep: boolean;
  orderBlocks: { price: number; direction: Direction }[];
  fvgs: { price: number; direction: Direction }[];
  swingHigh: number;
  swingLow: number;
  supportLevels: number[];
  resistanceLevels: number[];
}

export interface SMCAnalysis {
  atr: number;
  vwap: number;
  pcr: number;
  maxPain: number;
  volumeScore: number;
  oiScore: number;
  greeksScore: number;
  vwapScore: number;
  pcrScore: number;
  vixScore: number;
  structureScore: number;
  liquidityScore: number;
  orderBlockScore: number;
  fvgScore: number;
  historicalScore: number;
  confidence: number;
  minConfidence: number;
  regime: string;
  daysToExpiry: number;
  trendScore: number;
  oiSignal: string;
  vixRegime: string;
  pcrTrend: string;
  volumePoc: number;
}

export interface SMCOutput {
  candidates: SMCCandidate[];
  marketStructure: SMCMarketStructure;
  analysis: SMCAnalysis;
  rejected: boolean;
  rejectionReasons: string[];
}

// ─── Helpers ────────────────────────────────────────────────────

export function confidenceLabel(score: number): ConfidenceLabel {
  if (score >= 90) return "VERY_HIGH";
  if (score >= 75) return "HIGH";
  if (score >= 60) return "MEDIUM";
  return "LOW";
}

export function qualityGrade(confidence: number, rr: number): QualityGrade {
  if (confidence >= 95) return "A+";
  if (confidence >= 90) return "A";
  if (confidence >= 80) return "B";
  if (confidence >= 70) return "C";
  return "D";
}

function qualityScore(grade: QualityGrade): number {
  switch (grade) {
    case "A+": return 95;
    case "A": return 85;
    case "B": return 75;
    case "C": return 65;
    case "D": return 40;
  }
}

function lotSizeFor(symbol: string): number {
  const map: Record<string, number> = {
    NIFTY: 65, BANKNIFTY: 25, FINNIFTY: 40, MIDCPNIFTY: 75, SENSEX: 10, BANKEX: 15,
  };
  return map[symbol] || 75;
}

// ─── Dynamic Confidence Threshold ──────────────────────────────

function computeMinConfidence(
  ms: SMCMarketStructure,
  vix?: number,
  daysToExpiry?: number
): number {
  if (vix != null && vix > 30) return 80;
  if (ms.trend === "NEUTRAL" || (!ms.bos && !ms.choch)) return 80;
  if (daysToExpiry != null && daysToExpiry >= 7) return 75;
  if (ms.bos && ms.choch) return 70;
  if (daysToExpiry != null && daysToExpiry <= 1) return 70;
  if (vix != null && vix < 12) return 70;
  return 75;
}

// ─── Market Structure Analysis ──────────────────────────────────

function analyzeStructure(candles: CandleData[]): SMCMarketStructure {
  const empty: SMCMarketStructure = {
    trend: "NEUTRAL", bos: false, choch: false, liquiditySweep: false,
    orderBlocks: [], fvgs: [], swingHigh: 0, swingLow: 0,
    supportLevels: [], resistanceLevels: [],
  };
  if (!candles || candles.length < 5) return empty;

  const swingPoints = detectSwingPoints(candles);
  const events = detectStructureEvents(candles, swingPoints);
  const fvgs = detectFVG(candles as any);
  const obs = detectOrderBlocks(candles as any);

  const highs = swingPoints.filter(s => s.type === "HIGH");
  const lows = swingPoints.filter(s => s.type === "LOW");
  const last = candles[candles.length - 1];

  const bos = events.some(e => e.type === "BOS");
  const choch = events.some(e => e.type === "CHoCH");
  const liquiditySweep = events.some(e => e.type === "LIQUIDITY_SWEEP" || e.type === "LIQUIDITY_GRAB");

  let trend: Direction = "NEUTRAL";
  if (highs.length >= 2 && lows.length >= 2) {
    const rh = highs[highs.length - 1];
    const rl = lows[lows.length - 1];
    const ph = highs.length >= 2 ? highs[highs.length - 2] : null;
    const pl = lows.length >= 2 ? lows[lows.length - 2] : null;
    if (ph && pl) {
      const hh = rh.price > ph.price;
      const hl = rl.price > pl.price;
      if (hh && hl) trend = "BULLISH";
      else if (!hh && !hl) trend = "BEARISH";
    }
  }
  if (trend === "NEUTRAL" && last.close > last.open) trend = "BULLISH";
  else if (trend === "NEUTRAL") trend = "BEARISH";

  const swingHigh = highs.length > 0 ? highs[highs.length - 1].price : 0;
  const swingLow = lows.length > 0 ? lows[lows.length - 1].price : 0;
  const price = last.close;
  const supportLevels = lows.filter(s => s.price < price).map(s => s.price).sort((a, b) => b - a);
  const resistanceLevels = highs.filter(s => s.price > price).map(s => s.price).sort((a, b) => a - b);

  return {
    trend, bos, choch, liquiditySweep,
    orderBlocks: obs.map(o => ({ price: o.price ?? 0, direction: o.direction as Direction })),
    fvgs: fvgs.map(f => ({ price: f.price ?? 0, direction: f.direction as Direction })),
    swingHigh, swingLow, supportLevels, resistanceLevels,
  };
}

// ─── Phase 2: Trend Engine ────────────────────────────────────

function trendEngine(candles: CandleData[]): { score: number; emaBullish: boolean; adx: number } {
  if (!candles || candles.length < 20) {
    return { score: 50, emaBullish: false, adx: 0 };
  }
  const closes = candles.map(c => c.close);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, Math.min(50, closes.length));
  const ema200 = calculateEMA(closes, Math.min(200, closes.length));
  const adx = calculateADX(candles as any, 14);
  const last = closes[closes.length - 1];
  const e20 = ema20[ema20.length - 1];
  const e50 = ema50.length > 0 ? ema50[ema50.length - 1] : 0;
  const e200 = ema200.length > 0 ? ema200[ema200.length - 1] : 0;

  const emaBullish = e20 > e50 && (e50 <= 0 || e50 > e200);
  const adxStrong = adx > 20;
  let score = 50;
  if (emaBullish && adxStrong) score = 90;
  else if (emaBullish) score = 70;
  else if (!emaBullish && adxStrong) score = 60;
  else if (!emaBullish && last > e20) score = 55;
  return { score: Math.min(100, Math.max(0, score)), emaBullish, adx };
}

// ─── Phase 2: OI Intelligence ──────────────────────────────────

function oiIntelligence(optionChain: SDMOptionStrike[], spot: number, direction: Direction): { signal: string; score: number } {
  try {
    const near = optionChain.filter(s => s.strike && Math.abs(s.strike - spot) / spot < 0.03);
    const patterns = near.map(classifyOIPattern);
    let buildup = 0, unwinding = 0, covering = 0;
    for (const p of patterns) {
      if (direction === "BULLISH") {
        if (p.callPattern === "LONG_BUILDUP") buildup++;
        if (p.callPattern === "LONG_UNWINDING") unwinding++;
        if (p.callPattern === "SHORT_COVERING") covering++;
      } else {
        if (p.putPattern === "LONG_BUILDUP") buildup++;
        if (p.putPattern === "LONG_UNWINDING") unwinding++;
        if (p.putPattern === "SHORT_COVERING") covering++;
      }
    }
    if (buildup > unwinding && buildup > covering) return { signal: "BUILDUP", score: 90 };
    if (covering > unwinding) return { signal: "COVERING", score: 75 };
    if (unwinding > buildup) return { signal: "UNWINDING", score: 30 };
    return { signal: "NEUTRAL", score: 50 };
  } catch {
    return { signal: "NEUTRAL", score: 50 };
  }
}

// ─── Phase 2: VIX Regime ───────────────────────────────────────

function vixRegimeClassify(vix?: number): { regime: string; multiplier: number } {
  if (vix == null || vix <= 0) return { regime: "NORMAL", multiplier: 1.0 };
  if (vix > 30) return { regime: "EXTREME", multiplier: 2.2 };
  if (vix > 25) return { regime: "HIGH", multiplier: 1.5 };
  if (vix < 12) return { regime: "LOW", multiplier: 0.8 };
  if (vix < 15) return { regime: "MODERATE", multiplier: 0.9 };
  return { regime: "NORMAL", multiplier: 1.0 };
}

// ─── Phase 2: PCR Trend ────────────────────────────────────────

function pcrTrendAnalysis(pcr: number, pcrHistory?: number[]): string {
  if (!pcrHistory || pcrHistory.length < 3) {
    if (pcr > 1.2) return "BULLISH";
    if (pcr < 0.8) return "BEARISH";
    return "NEUTRAL";
  }
  const recent = pcrHistory.slice(-5);
  const rising = recent[recent.length - 1] > recent[0];
  const acceleration = recent.length >= 3 && (recent[recent.length - 1] - recent[recent.length - 2]) >
    (recent[recent.length - 2] - recent[recent.length - 3]);
  if (rising && acceleration && pcr > 1) return "STRONGLY_BULLISH";
  if (rising) return "BULLISH";
  if (!rising && acceleration && pcr < 1) return "STRONGLY_BEARISH";
  if (!rising) return "BEARISH";
  return "NEUTRAL";
}

// ─── Phase 2: Volume Profile Check ─────────────────────────────

function volumeProfileCheck(candles: CandleData[], spot: number): { poc: number; rejectLVN: boolean } {
  if (!candles || candles.length < 20) return { poc: 0, rejectLVN: false };
  try {
    const profile = computeVolumeProfile(candles, 20);
    const poc = findPOC(profile);
    const sorted = [...profile].sort((a, b) => a.volume - b.volume);
    const lvn = sorted.length > 2 ? sorted[0].price : 0;
    const nearLVN = lvn > 0 && Math.abs(spot - lvn) / spot < 0.005;
    return { poc, rejectLVN: nearLVN };
  } catch {
    return { poc: 0, rejectLVN: false };
  }
}

// ─── Factor Scoring (each 0-100) ────────────────────────────────

function scoreStructure(ms: SMCMarketStructure): number {
  let s = 0;
  if (ms.trend !== "NEUTRAL") s += 20;
  if (ms.bos) s += 20;
  if (ms.choch) s += 20;
  if (ms.swingHigh > 0 && ms.swingLow > 0) s += 20;
  if (ms.supportLevels.length > 0 || ms.resistanceLevels.length > 0) s += 20;
  return Math.min(100, s);
}

function scoreLiquidity(
  ms: SMCMarketStructure,
  chain?: SDMOptionStrike[],
  spot?: number,
  candles?: CandleData[]
): number {
  // 1. Liquidity Sweep (highest)
  if (ms.liquiditySweep) {
    let s = 50;
    if (ms.trend !== "NEUTRAL") s += 25;
    if (ms.bos || ms.choch) s += 25;
    return Math.min(100, s);
  }

  // 2. S/R level touches
  const srCount = ms.supportLevels.length + ms.resistanceLevels.length;
  if (srCount >= 3) return 40;
  if (srCount >= 2) return 30;
  if (srCount >= 1) return 20;

  // 3. Volume spike
  if (candles && candles.length >= 14) {
    const recent = candles.slice(-14);
    const avgVol = recent.reduce((a, c) => a + c.volume, 0) / recent.length;
    const lastVol = candles[candles.length - 1].volume;
    if (lastVol > avgVol * 1.5) return 30;
    if (lastVol > avgVol * 1.2) return 20;
  }

  // 4. OI buildup (near-ATM)
  if (chain && spot && spot > 0) {
    const near = chain.filter(s => s.strike && Math.abs(s.strike - spot) / spot < 0.03);
    const totalBuildup = near.reduce((sum, s) => {
      if (s.ce && s.ce.oiChg > 0) sum += s.ce.oiChg;
      if (s.pe && s.pe.oiChg > 0) sum += s.pe.oiChg;
      return sum;
    }, 0);
    if (totalBuildup > 200_000) return 25;
    if (totalBuildup > 50_000) return 15;
  }

  return 10;
}

function scoreOrderBlocks(ms: SMCMarketStructure, direction: Direction): number {
  if (ms.orderBlocks.length === 0) return 0;
  const aligned = ms.orderBlocks.filter(ob => ob.direction === direction).length;
  if (aligned === 0) return 20; // blocks exist but not aligned
  const pct = aligned / ms.orderBlocks.length;
  return Math.min(100, Math.round(pct * 80 + 20));
}

function scoreFVG(ms: SMCMarketStructure, direction: Direction): number {
  if (ms.fvgs.length === 0) return 0;
  const aligned = ms.fvgs.filter(f => f.direction === direction).length;
  if (aligned === 0) return 10;
  const pct = aligned / ms.fvgs.length;
  return Math.min(100, Math.round(pct * 80 + 10));
}

function scoreVolume(chain: SDMOptionStrike[], candles?: CandleData[]): number {
  let s = 0;
  // Option volume check (50% of score)
  const totalVol = chain.reduce((sum, s) => {
    if (s.ce) sum += s.ce.volume;
    if (s.pe) sum += s.pe.volume;
    return sum;
  }, 0);
  if (totalVol > 1_000_000) s += 25;
  else if (totalVol > 500_000) s += 15;
  else if (totalVol > 100_000) s += 10;
  else s += 5;

  // Underlying volume (50% of score)
  if (candles && candles.length >= 14) {
    const recent = candles.slice(-14);
    const avgVol = recent.reduce((a, c) => a + c.volume, 0) / recent.length;
    const lastVol = candles[candles.length - 1].volume;
    if (lastVol > avgVol * 1.5) s += 50;
    else if (lastVol > avgVol) s += 35;
    else if (lastVol > avgVol * 0.7) s += 20;
    else s += 10;
  } else {
    s += 25; // neutral when no candle data
  }
  return Math.min(100, s);
}

function scoreOI(
  chain: SDMOptionStrike[],
  spot: number,
  direction: Direction
): number {
  let s = 0;
  const nearStrikes = chain.filter(
    s => s.strike && Math.abs(s.strike - spot) / spot < 0.04
  );
  if (nearStrikes.length === 0) return 20;

  // OI buildup in the direction of our trade
  const isBullish = direction === "BULLISH";
  let totalBuildup = 0;
  for (const st of nearStrikes) {
    if (isBullish && st.ce && st.ce.oiChg > 0) {
      totalBuildup += st.ce.oiChg;
    }
    if (!isBullish && st.pe && st.pe.oiChg > 0) {
      totalBuildup += st.pe.oiChg;
    }
  }
  if (totalBuildup > 500_000) s += 40;
  else if (totalBuildup > 200_000) s += 30;
  else if (totalBuildup > 50_000) s += 20;
  else if (totalBuildup > 10_000) s += 10;
  else s += 5;

  // OI concentration
  const totalOI = chain.reduce((sum, st) => {
    if (st.ce) sum += st.ce.oi;
    if (st.pe) sum += st.pe.oi;
    return sum;
  }, 0);
  if (totalOI > 10_000_000) s += 30;
  else if (totalOI > 5_000_000) s += 20;
  else if (totalOI > 1_000_000) s += 15;
  else s += 10;

  // OI change ratio
  let ceOiChgTotal = 0;
  let peOiChgTotal = 0;
  for (const st of nearStrikes) {
    if (st.ce) ceOiChgTotal += Math.abs(st.ce.oiChg);
    if (st.pe) peOiChgTotal += Math.abs(st.pe.oiChg);
  }
  if (isBullish && ceOiChgTotal > peOiChgTotal) s += 30;
  else if (!isBullish && peOiChgTotal > ceOiChgTotal) s += 30;
  else s += 10;

  return Math.min(100, s);
}

function scoreGreeks(
  strike: number,
  spot: number,
  type: "CE" | "PE",
  daysToExpiry: number,
  iv: number
): number {
  const tte = Math.max(1 / 365, daysToExpiry / 365);
  const g = calculateGreeks(spot, strike, tte, iv, type === "CE");
  if (!g) return 50;

  let s = 0;
  const absDelta = Math.abs(g.delta);
  // Delta 0.20-0.60 for directional trades
  if (absDelta >= 0.20 && absDelta <= 0.60) s += 40;
  else if (absDelta >= 0.15 && absDelta <= 0.70) s += 25;
  else if (absDelta >= 0.10 && absDelta <= 0.80) s += 15;
  else s += 5;

  // Gamma not too high (avoid gamma risk)
  if (g.gamma > 0 && g.gamma < 0.05) s += 20;
  else if (g.gamma < 0.1) s += 15;
  else if (g.gamma < 0.2) s += 10;
  else s += 5;

  // Theta decay tolerable
  if (g.theta < 0) {
    const thetaAbs = Math.abs(g.theta);
    if (thetaAbs < 0.5) s += 20;
    else if (thetaAbs < 1) s += 15;
    else if (thetaAbs < 2) s += 10;
    else s += 5;
  } else {
    s += 20; // positive theta (selling premium)
  }

  // Vega not extreme
  if (g.vega < 0.5) s += 20;
  else if (g.vega < 1) s += 15;
  else s += 5;

  return Math.min(100, s);
}

function scoreVWAP(
  spot: number,
  candles?: CandleData[],
  cachedVwap?: number
): number {
  const vwap = cachedVwap ?? (candles && candles.length > 0 ? calculateVWAP(candles as any) : 0);
  if (!vwap || vwap === 0) return 50;

  const distPct = Math.abs(spot - vwap) / vwap;
  if (distPct < 0.005) return 100;
  if (distPct < 0.01) return 80;
  if (distPct < 0.02) return 60;
  if (distPct < 0.03) return 40;
  return 20;
}

function scorePCR(pcr: number, direction: Direction): number {
  if (pcr <= 0) return 50;
  const isBullish = direction === "BULLISH";
  // Bullish: PCR > 1 (puts > calls = fear = potential bounce)
  // Bearish: PCR < 1 (calls > puts = complacency = potential drop)
  if (isBullish && pcr > 1.2) return 90;
  if (isBullish && pcr > 1) return 70;
  if (isBullish && pcr > 0.8) return 50;
  if (isBullish && pcr > 0.5) return 30;
  if (!isBullish && pcr < 0.5) return 90;
  if (!isBullish && pcr < 0.8) return 70;
  if (!isBullish && pcr < 1) return 50;
  if (!isBullish && pcr < 1.2) return 30;
  return 20;
}

function scoreVIX(vix?: number): number {
  if (vix == null || vix <= 0) return 50;
  // Ideal: 12-20 (normal volatility)
  if (vix >= 12 && vix <= 20) return 100;
  if (vix >= 10 && vix <= 25) return 80;
  if (vix >= 8 && vix <= 30) return 60;
  if (vix >= 5 && vix <= 35) return 40;
  return 20;
}

function scoreHistorical(winRate?: number): number {
  if (winRate == null || winRate <= 0) return 0;
  return Math.min(100, Math.round(winRate * 100));
}

// ─── Institutional Filters ──────────────────────────────────────

interface FilterResult {
  passed: boolean;
  reasons: string[];
}

function applyFilters(
  strike: number,
  type: "CE" | "PE",
  entry: number,
  sl: number,
  tp1: number,
  rr: number,
  confidence: number,
  ms: SMCMarketStructure,
  atr: number,
  spot: number,
  vix?: number,
  maxPain?: number,
  chain?: SDMOptionStrike[],
  daysToExpiry?: number
): FilterResult {
  const rejected: string[] = [];

  const minConf = computeMinConfidence(ms, vix, daysToExpiry);

  if (rr < 2) rejected.push(`R:R ${rr.toFixed(1)} < 2.0`);

  if (confidence < minConf) rejected.push(`Confidence ${confidence} < ${minConf}`);

  if (!ms.bos && !ms.choch) rejected.push("No BOS or CHoCH detected");

  if (atr > 0 && spot > 0) {
    const atrPct = atr / spot;
    if (atrPct < 0.002) rejected.push(`ATR ${(atrPct * 100).toFixed(2)}% too low`);
    if (atrPct > 0.05) rejected.push(`ATR ${(atrPct * 100).toFixed(2)}% too high`);
  }

  if (vix != null && vix > 0) {
    if (vix > 30) rejected.push(`VIX ${vix} > 30 — extreme volatility`);
    if (vix < 10) rejected.push(`VIX ${vix} < 10 — low volatility may trap`);
  }

  if (maxPain && maxPain > 0) {
    const distToPain = Math.abs(strike - maxPain) / maxPain;
    if (daysToExpiry != null && daysToExpiry <= 1) {
      const painAgainstCE = type === "CE" && strike > maxPain;
      const painAgainstPE = type === "PE" && strike < maxPain;
      if ((painAgainstCE || painAgainstPE) && distToPain < 0.003) {
        rejected.push(`Trade against max pain direction (${(distToPain * 100).toFixed(1)}%)`);
      }
    }
  }

  // Call side checks
  if (type === "CE") {
    if (ms.trend === "BEARISH") rejected.push("Buying calls in downtrend");
    const otmPct = (strike - spot) / spot;
    if (otmPct > 0.04) rejected.push(`CE ${(otmPct * 100).toFixed(1)}% OTM — too far`);
  }

  // Put side checks
  if (type === "PE") {
    if (ms.trend === "BULLISH") rejected.push("Buying puts in uptrend");
    const otmPct = (spot - strike) / spot;
    if (otmPct > 0.04) rejected.push(`PE ${(otmPct * 100).toFixed(1)}% OTM — too far`);
  }

  // Greeks-based rejections (low delta, high theta, weak gamma)
  const g = (() => {
    try {
      const tte = Math.max(1 / 365, (daysToExpiry ?? 14) / 365);
      return calculateGreeks(spot, strike, tte, 0.15, type === "CE");
    } catch { return null; }
  })();
  if (g) {
    if (Math.abs(g.delta) < 0.10) rejected.push(`Delta ${g.delta.toFixed(3)} too low — deep OTM`);
    if (g.theta < 0 && Math.abs(g.theta) > entry * 0.4) rejected.push(`Theta ${g.theta.toFixed(1)} > 40% of premium`);
    if (g.gamma > 0.1) rejected.push(`Gamma ${g.gamma.toFixed(4)} too high`);
  }

  // Order block OR FVG (relaxed from AND to OR)
  const hasAlignedOB = ms.orderBlocks.some(ob =>
    (type === "CE" && ob.direction === "BULLISH") ||
    (type === "PE" && ob.direction === "BEARISH")
  );
  const hasAlignedFVG = ms.fvgs.some(f =>
    (type === "CE" && f.direction === "BULLISH") ||
    (type === "PE" && f.direction === "BEARISH")
  );
  if (!hasAlignedOB && !hasAlignedFVG) {
    rejected.push("No aligned order block or FVG");
  }

  if (rejected.length === 0) {
    return { passed: true, reasons: [] };
  }
  return { passed: false, reasons: rejected };
}

// ─── SL/TP Calculation ──────────────────────────────────────────

function computeSL(
  type: "CE" | "PE",
  entry: number,
  spot: number,
  atr: number,
  ms: SMCMarketStructure,
  isOption: boolean,
  vixMultiplier = 1.0,
  regime = "TRENDING"
): number {
  const atrMult = (() => {
    if (vixMultiplier > 2) return 2.2;
    if (regime === "RANGE") return 1.0;
    if (regime === "MONTHLY_EXPIRY") return 1.6;
    if (regime === "WEEKLY_EXPIRY") return 1.3;
    return 1.8;
  })();

  if (isOption) {
    const atrBasedSL = type === "CE"
      ? entry - Math.max(atr * 0.5 * atrMult, entry * 0.10)
      : entry + Math.max(atr * 0.5 * atrMult, entry * 0.10);

    const swingSL = type === "CE"
      ? (ms.swingLow > 0 ? entry - (spot - ms.swingLow) * 0.25 : atrBasedSL)
      : (ms.swingHigh > 0 ? entry + (ms.swingHigh - spot) * 0.25 : atrBasedSL);

    const obSL = (() => {
      const ob = type === "CE"
        ? ms.orderBlocks.filter(o => o.direction === "BULLISH").pop()
        : ms.orderBlocks.filter(o => o.direction === "BEARISH").pop();
      if (!ob || ob.price <= 0) return swingSL;
      return type === "CE"
        ? Math.min(swingSL, entry - Math.abs(spot - ob.price) * 0.25)
        : Math.max(swingSL, entry + Math.abs(spot - ob.price) * 0.25);
    })();

    const minSL = entry * 0.08;
    const maxSL = Math.max(entry * 0.45, atr * atrMult * 0.8);
    return Math.round(Math.min(maxSL, Math.max(minSL, obSL)) * 100) / 100;
  }

  if (type === "CE") {
    const levels = [spot - atr * 1.5 * atrMult, ms.swingLow, spot * 0.97].filter(v => v > 0);
    return Math.max(...levels);
  }
  const levels = [spot + atr * 1.5 * atrMult, ms.swingHigh, spot * 1.03].filter(v => v > 0);
  return Math.min(...levels);
}

function computeTP(
  type: "CE" | "PE",
  entry: number,
  risk: number,
  ms: SMCMarketStructure,
  spot: number,
  isOption: boolean,
  regime = "TRENDING"
): { tp1: number; tp2: number; tp3?: number } {
  const [r1, r2, r3] = (() => {
    if (regime === "RANGE") return [2, 2.5, 3] as const;
    if (regime === "WEEKLY_EXPIRY") return [2, 3, 5] as const;
    if (regime === "MONTHLY_EXPIRY") return [2, 3, 4] as const;
    return [2, 3, 5] as const;
  })();

  const tp1 = type === "CE" ? entry + risk * r1 : entry - risk * r1;
  const tp2 = type === "CE" ? entry + risk * r2 : entry - risk * r2;

  let tp3: number | undefined;
  if (isOption) {
    tp3 = type === "CE" ? entry + risk * r3 : entry - risk * r3;
  } else {
    if (type === "CE" && ms.resistanceLevels.length > 0) {
      tp3 = ms.resistanceLevels[0];
    } else if (type === "PE" && ms.supportLevels.length > 0) {
      tp3 = ms.supportLevels[0];
    } else {
      tp3 = type === "CE" ? entry + risk * r3 : entry - risk * r3;
    }
  }

  return {
    tp1: Math.round(tp1 * 100) / 100,
    tp2: Math.round(tp2 * 100) / 100,
    tp3: tp3 != null ? Math.round(tp3 * 100) / 100 : undefined,
  };
}

// ─── Position Sizing ────────────────────────────────────────────

function computePositionSize(
  capital: number,
  riskPercent: number,
  entry: number,
  sl: number,
  lotSize: number,
  maxPositionSize: number,
  confidence = 50,
  vixMultiplier = 1.0,
  daysToExpiry = 14
): SMCPositionSize {
  const stopDistance = Math.abs(entry - sl);
  if (stopDistance <= 0 || entry <= 0) {
    return { lots: 0, quantity: 0, capitalUsed: 0, maxLoss: 0, maxGain: 0, riskPercent: 0 };
  }

  const confidenceMod = confidence >= 95 ? 1.0 : confidence >= 90 ? 0.90 : confidence >= 85 ? 0.75 : confidence >= 80 ? 0.50 : 0;
  const vixMod = vixMultiplier > 2 ? 0.50 : vixMultiplier > 1.4 ? 0.75 : vixMultiplier < 0.9 ? 1.0 : 0.85;
  const expiryMod = daysToExpiry <= 1 ? 0.75 : daysToExpiry >= 7 ? 0.90 : 1.0;
  const kellyPct = riskPercent * confidenceMod * vixMod * expiryMod;

  if (confidenceMod === 0) {
    return { lots: 0, quantity: 0, capitalUsed: 0, maxLoss: 0, maxGain: 0, riskPercent: 0 };
  }

  const capitalRisk = capital * (kellyPct / 100);
  const maxLots = maxPositionSize > 0 ? maxPositionSize : 100;
  const rawLots = Math.floor(capitalRisk / (stopDistance * lotSize));
  // Floor at 0 (not 1): if the risk budget yields <1 lot, do NOT force a
  // trade that breaches the risk cap — reject instead.
  const lots = Math.min(maxLots, Math.max(0, rawLots));
  const quantity = lots * lotSize;
  const capitalUsed = entry * quantity;
  const maxLoss = stopDistance * quantity;
  const actualRiskPct = capital > 0 ? (maxLoss / capital) * 100 : 0;

  return {
    lots,
    quantity,
    capitalUsed: Math.round(capitalUsed * 100) / 100,
    maxLoss: Math.round(maxLoss * 100) / 100,
    maxGain: Math.round(maxLoss * 2 * (confidence / 50) * 100) / 100,
    riskPercent: Math.round(actualRiskPct * 100) / 100,
  };
}

// ─── Main Entry Point ───────────────────────────────────────────

export function runSMCAnalysis(input: SMCInput): SMCOutput {
  const {
    symbol, spot, optionChain, candles, vix,
    capital = 100000, riskPercent = 2, lotSize = lotSizeFor(symbol),
    maxPositionSize = 50, historicalWinRate,
  } = input;

  const rejectionReasons: string[] = [];
  const ms = analyzeStructure(candles || []);
  const lotSz = lotSize || lotSizeFor(symbol);
  const expiry = getStandardizedExpiry(symbol);
  const daysToExpiry = expiry?.days_to_expiry ?? 14;

  // Run OI analysis
  let oiAnalysis = { pcrOI: 0.85, maxPain: 0 };
  try {
    oiAnalysis = analyzeOptionChain(optionChain, spot);
  } catch { /* use defaults */ }

  const atr = candles && candles.length >= 2
    ? calculateATR(candles as any, 14)
    : spot * 0.01;
  const pcr = oiAnalysis.pcrOI;
  const maxPain = oiAnalysis.maxPain;
  const avgIv = optionChain.length
    ? optionChain.reduce((s, st) => {
        let iv = 0;
        if (st.ce) iv += st.ce.iv;
        if (st.pe) iv += st.pe.iv;
        return s + iv;
      }, 0) / (optionChain.length * 2)
    : 0.15;

  // Cache VWAP (avoids duplicate calculation)
  const cachedVwap = candles && candles.length > 0 ? calculateVWAP(candles as any) : 0;

  // Direction from market structure
  const direction = ms.trend;

  // Phase 2: Trend Engine (EMA20/50/200 + ADX)
  const trendResult = trendEngine(candles || []);

  // Phase 2: OI Intelligence
  const oiIntel = oiIntelligence(optionChain, spot, direction);

  // Phase 2: VIX Regime
  const vixRegime = vixRegimeClassify(vix);

  // Phase 2: PCR Trend
  const pcrTrend = pcrTrendAnalysis(pcr, input.pcrHistory);

  // Phase 2: Volume Profile
  const vpResult = volumeProfileCheck(candles || [], spot);

  // Score factors
  const structureScore = scoreStructure(ms);
  const liquidityScore = scoreLiquidity(ms, optionChain, spot, candles);
  const orderBlockScore = scoreOrderBlocks(ms, direction);
  const fvgScore = scoreFVG(ms, direction);
  const volumeScore = scoreVolume(optionChain, candles);
  const oiScore = scoreOI(optionChain, spot, direction);
  const vwapScore = scoreVWAP(spot, candles, cachedVwap);
  const pcrScore = scorePCR(pcr, direction);
  const vixScoreVal = scoreVIX(vix);
  const historicalScoreVal = scoreHistorical(historicalWinRate);

  // Weights: Trend+Structure 25%, OI 15%, Volume 10%, VWAP 10%, Historical 10%, OB 10%, Liquidity 5%, FVG 5%, PCR 5%, VIX 5%, Greeks 5%
  const confidence = Math.min(100, Math.round(
    structureScore * 0.25 +
    liquidityScore * 0.05 +
    orderBlockScore * 0.10 +
    fvgScore * 0.05 +
    volumeScore * 0.10 +
    oiScore * 0.15 +
    vwapScore * 0.10 +
    pcrScore * 0.05 +
    vixScoreVal * 0.05 +
    historicalScoreVal * 0.10
  ));

  const minConf = computeMinConfidence(ms, vix, daysToExpiry);

  const regime = (() => {
    if (vix != null && vix > 30) return "HIGH_VIX";
    if (vix != null && vix < 12) return "LOW_VIX";
    if (ms.trend === "NEUTRAL" || (!ms.bos && !ms.choch)) return "RANGE";
    if (daysToExpiry <= 1) return "WEEKLY_EXPIRY";
    if (daysToExpiry >= 7) return "MONTHLY_EXPIRY";
    if (ms.bos && ms.choch) return "BREAKOUT";
    return "TRENDING";
  })();

  const analysis: SMCAnalysis = {
    atr: Math.round(atr * 100) / 100,
    vwap: Math.round(cachedVwap * 100) / 100,
    pcr: Math.round(pcr * 1000) / 1000,
    maxPain,
    volumeScore, oiScore, greeksScore: 50, vwapScore, pcrScore,
    vixScore: vixScoreVal, structureScore, liquidityScore,
    orderBlockScore, fvgScore, historicalScore: historicalScoreVal,
    confidence, minConfidence: minConf,
    regime, daysToExpiry,
    trendScore: trendResult.score,
    oiSignal: oiIntel.signal,
    vixRegime: vixRegime.regime,
    pcrTrend,
    volumePoc: vpResult.poc,
  };

  // Early rejection if basic structure missing
  if (!ms.bos && !ms.choch) {
    rejectionReasons.push("No BOS or CHoCH — insufficient structure");
  }
  if (ms.trend === "NEUTRAL") {
    rejectionReasons.push("Neutral trend — no clear direction");
  }

  // Build candidates from near-ATM strikes
  const candidates: SMCCandidate[] = [];
  const nearStrikes = optionChain
    .filter(s => s.strike && Math.abs(s.strike - spot) / spot < 0.04)
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    .slice(0, 6);

  for (const st of nearStrikes) {
    for (const type of ["CE", "PE"] as const) {
      const leg = type === "CE" ? st.ce : st.pe;
      if (!leg || leg.ltp <= 0) continue;

      const isOption = true;
      const entry = leg.ltp;
      const isTradeDirection = (type === "CE" && direction === "BULLISH") ||
                               (type === "PE" && direction === "BEARISH");

      const strikeGreeksScore = scoreGreeks(
        st.strike, spot, type, daysToExpiry,
        avgIv > 0 ? avgIv : 0.15
      );

      // Per-strike confidence with per-strike Greeks
      const perStrikeConf = Math.min(100, Math.round(
        structureScore * 0.20 +
        liquidityScore * 0.05 +
        orderBlockScore * 0.10 +
        fvgScore * 0.05 +
        volumeScore * 0.10 +
        oiScore * 0.15 +
        strikeGreeksScore * 0.05 +
        vwapScore * 0.10 +
        pcrScore * 0.05 +
        vixScoreVal * 0.05 +
        historicalScoreVal * 0.10
      ));

      // Volume profile check: reject entry into LVN
      const lvnReject = vpResult.rejectLVN;

      // ATR-based SL for option premium (regime-aware)
      const sl = computeSL(type, entry, spot, atr, ms, isOption, vixRegime.multiplier, regime);
      const risk = Math.abs(entry - sl);
      if (risk <= 0) continue;

      const { tp1, tp2, tp3 } = computeTP(type, entry, risk, ms, spot, isOption, regime);
      const rr = risk > 0 ? Math.abs((tp1 - entry)) / risk : 0;

      // Apply institutional filters (with dynamic confidence threshold)
      const filterResult = applyFilters(
        st.strike, type, entry, sl, tp1, rr, perStrikeConf,
        ms, atr, spot, vix, maxPain, optionChain, daysToExpiry
      );

      if (!filterResult.passed || lvnReject) {
        candidates.push({
          strike: st.strike,
          type,
          entry: 0,
          sl: 0,
          tp1: 0,
          tp2: 0,
          tp3: undefined,
          rr: 0,
          confidence: perStrikeConf,
          confidenceLabel: confidenceLabel(perStrikeConf),
          qualityGrade: "D",
          qualityScore: 40,
          positionSize: { lots: 0, quantity: 0, capitalUsed: 0, maxLoss: 0, maxGain: 0, riskPercent: 0 },
          reasons: [],
          rejectedFilters: [...filterResult.reasons, ...(lvnReject ? ["Entry near LVN — rejected"] : [])],
        });
        continue;
      }

      const pos = computePositionSize(capital, riskPercent, entry, sl, lotSz, maxPositionSize, perStrikeConf, vixRegime.multiplier, daysToExpiry);
      const grade = qualityGrade(perStrikeConf, rr);

      const reasons: string[] = [];
      if (ms.bos) reasons.push("BOS confirmed");
      if (ms.choch) reasons.push("CHoCH confirmed");
      if (ms.liquiditySweep) reasons.push("Liquidity sweep detected");
      if (!isTradeDirection) reasons.push("Direction opposite primary trend");
      if (ms.orderBlocks.length > 0) reasons.push(`${ms.orderBlocks.length} order block(s)`);
      if (ms.fvgs.length > 0) reasons.push(`${ms.fvgs.length} FVG(s)`);
      if (oiScore >= 50) reasons.push("OI confirmed");
      if (volumeScore >= 50) reasons.push("Volume confirmed");

      candidates.push({
        strike: st.strike,
        type,
        entry: Math.round(entry * 100) / 100,
        sl: Math.round(sl * 100) / 100,
        tp1: Math.round(tp1 * 100) / 100,
        tp2: Math.round(tp2 * 100) / 100,
        tp3: tp3 != null ? Math.round(tp3 * 100) / 100 : undefined,
        rr: Math.round(rr * 10) / 10,
        confidence: perStrikeConf,
        confidenceLabel: confidenceLabel(perStrikeConf),
        qualityGrade: grade,
        qualityScore: qualityScore(grade),
        positionSize: pos,
        reasons,
        rejectedFilters: [],
      });
    }
  }

  // Sort by confidence desc, then by R:R desc
  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.rr - a.rr;
  });

  return {
    candidates: candidates.filter(c => c.entry > 0 && c.rr >= 2),
    marketStructure: ms,
    analysis,
    rejected: rejectionReasons.length > 0 && candidates.filter(c => c.entry > 0).length === 0,
    rejectionReasons,
  };
}

/**
 * Convert a ZeroHeroTerminal ChainRow[] to SDMOptionStrike[] for the SMC engine.
 */
export function chainToSDMStrikes(chain: any[]): SDMOptionStrike[] {
  return chain.map((r: any) => ({
    strike: r.strike,
    ce: r.ce ? {
      ltp: r.ce.ltp || 0,
      oi: r.ce.oi || 0,
      oiChg: r.ce.oiChg || 0,
      volume: r.ce.vol || r.ce.volume || 0,
      iv: r.ce.iv || 0,
      delta: r.ce.delta || 0,
      theta: r.ce.theta || 0,
      gamma: r.ce.gamma || 0,
      vega: r.ce.vega || 0,
    } : null,
    pe: r.pe ? {
      ltp: r.pe.ltp || 0,
      oi: r.pe.oi || 0,
      oiChg: r.pe.oiChg || 0,
      volume: r.pe.vol || r.pe.volume || 0,
      iv: r.pe.iv || 0,
      delta: r.pe.delta || 0,
      theta: r.pe.theta || 0,
      gamma: r.pe.gamma || 0,
      vega: r.pe.vega || 0,
    } : null,
  }));
}
