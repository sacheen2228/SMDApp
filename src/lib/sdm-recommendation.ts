// SDM Recommendation Engine V2
// Orchestrates all V2 analytics modules into a single trade recommendation.

import type {
  SDMOptionStrike,
  SDMRecommendation,
  SDMScores,
  SellerSLZone,
  GammaThetaData,
  MarketContext,
  WatchListItem,
  WhyThisTradeItem,
  ExpiryWindow,
  DayMode,
  TradeDirection,
  PremiumFairValue,
  LiveProbability,
  DataHealth,
  PositionSizing,
  SmartEntryAction,
  SmartExitAction,
  TradeGrade,
  MarketRegime,
  CandleData,
  GEXResult,
  MarketStructure,
  ConsensusResult,
  VolumeAnalysis,
  OIAnalysis,
  SellerSLResult,
  SmartEntryResult,
  SmartExitResult,
  QualityScore,
  QualityScoreInput,
  RiskState,
} from '@/types/sdm';
import { calculateGEX } from './gex-engine';
import { analyzeMarketStructure } from './market-structure';
import { analyzeMultiTimeframe } from './multi-timeframe';
import { analyzeVolume } from './volume-analysis';
import { analyzeOptionChain } from './sdm-oianalysis';
import { computeQualityScore } from './sdm-scores';
import { findSellerSLLevels } from './sdm-sellersl';
import { determineSmartEntry } from './smart-entry';
import { evaluateExit } from './smart-exit';
import { evaluateDataHealth, type DataHealthReport } from './data-health';
import { validateTrade } from './validation-gate';
import { runInstitutionalPositioning, getInstitutionalFilter } from './institutional-positioning-engine';
import type { InstitutionalFilter } from './institutional-positioning-engine';
import {
  getCurrentSession,
  adjustConfidenceForSession,
  isTradeAllowed,
  getConfidenceThreshold,
  getPositionSizeMultiplier,
  type SessionInfo,
} from './market-session';
import { getLotSizeStrict } from './symbol-config';
import { isExpiryToday, parseExpiryDateLoose } from './greeks';
import { toIsoExpiry } from './expiry-date';
import { scoreBuyerConfluence, type ConfluenceInput, type ConfluenceResult } from './buyer-confluence-engine';
// THE house plan + the ONE sizing model (2026-10-20):
//   option-plan.ts  → the stop is a RUPEE risk (20% of the amount DEPLOYED) and the
//                     targets are 2R / 3R / 4R of it.
//   agent-brain-gate.ts → GATE_CONFIG (capital ₹25,000, ₹20,000 deployed per trade,
//                     20% of the deployed amount at risk) + positionSize().
// The old code here hardcoded "capital ₹1,00,000 × 1% risk" and a ±15% stop with a
// 1:1 R:R — it produced 0 lots on every NIFTY contract and taught a dead rule.
import { buildOptionPlan, PLAN_CONFIG, type OptionPlan } from './option-plan';
import { GATE_CONFIG, positionSize } from './agent-brain-gate';
import { RISK_LIMITS } from './risk-management';

// ─── Constants ────────────────────────────────────────────────────
// Lot sizes now come from src/lib/symbol-config.ts (single source of
// truth) — see getLotSize() import above, local LOT_SIZES map
// removed to prevent drift from the canonical values.

const DEFAULT_RISK_STATE: RiskState = {
  dailyPnL: 0,
  weeklyPnL: 0,
  monthlyPnL: 0,
  openPositions: 0,
  canTrade: true,
  // The caps are the house caps (₹8,000 / ₹16,000 / ₹25,000 — see RISK_LIMITS):
  // two stops ends the day, the MONTHLY cap is the account itself (never more).
  maxDailyLoss: RISK_LIMITS.maxDailyLoss,
  maxWeeklyLoss: RISK_LIMITS.maxWeeklyLoss,
  maxMonthlyLoss: RISK_LIMITS.maxMonthlyLoss,
  maxPositionSize: 10,
  maxConcurrentTrades: RISK_LIMITS.maxConcurrentTrades,
};

// ─── Helpers ──────────────────────────────────────────────────────

function clamp(v: number, lo: number = 0, hi: number = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

function findATMStrike(chain: SDMOptionStrike[], spot: number): SDMOptionStrike | null {
  if (chain.length === 0) return null;
  return chain.reduce((best, s) =>
    Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best
  );
}

function getISTMinutes(): number {
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function computeATR(candles: CandleData[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  if (trs.length < period) return trs.reduce((a, b) => a + b, 0) / trs.length;
  const firstPeriod = trs.slice(0, period);
  let atr = firstPeriod.reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// getLotSize() now imported from '@/lib/symbol-config' (see imports above)

function computeDaysToExpiry(expiryDate: string): number {
  const today = new Date();
  const expiry = parseExpiryDateLoose(expiryDate, today) ?? new Date(expiryDate);
  return Math.max(1, Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)));
}

function computeExpiryWindow(
  isExpiryDay: boolean,
  timeInMinutes: number
): ExpiryWindow {
  if (!isExpiryDay) return 'normal';
  if (timeInMinutes >= 570 && timeInMinutes <= 630) return 'gamma';
  if (timeInMinutes > 630 && timeInMinutes <= 810) return 'theta';
  if (timeInMinutes > 840 && timeInMinutes <= 930) return 'danger';
  return 'normal';
}

// ─── Simplified Inline: Premium Fair Value ────────────────────────

function computePremiumFairValue(
  optionChain: SDMOptionStrike[],
  spot: number,
  entry: number,
  tradeDirection: 'CALL' | 'PUT'
): PremiumFairValue {
  const atm = findATMStrike(optionChain, spot);
  if (!atm || entry <= 0) {
    return {
      marketPrice: entry,
      theoreticalPrice: entry,
      difference: 0,
      differencePercent: 0,
      status: 'fair',
      reason: 'No ATM data or zero entry',
    };
  }

  const leg = tradeDirection === 'CALL' ? atm.ce : atm.pe;
  if (!leg) {
    return {
      marketPrice: entry,
      theoreticalPrice: entry,
      difference: 0,
      differencePercent: 0,
      status: 'fair',
      reason: 'Leg data missing',
    };
  }

  // Black-Scholes ATM fair value approximation:
  // ATM premium ≈ 0.4 × spot × σ × √(T/365)
  // Estimate √T from the ATM straddle width (which equals 2 × ATM premium)
  const straddle = (atm.ce?.ltp || 0) + (atm.pe?.ltp || 0);
  const ivDec = leg.iv > 0 ? (leg.iv > 1 ? leg.iv / 100 : leg.iv) : 0.15;
  let sqrtT = 0.2;
  if (straddle > 0 && ivDec > 0 && spot > 0) {
    sqrtT = Math.min(straddle / (0.8 * spot * ivDec), 1);
  }
  const atmFairPremium = Math.round(0.4 * spot * ivDec * sqrtT * 100) / 100;
  // Scale the ATM fair value to the selected strike using premium ratio
  const atmEntry = tradeDirection === 'CALL' ? (atm.ce?.ltp || entry) : (atm.pe?.ltp || entry);
  const theoreticalPrice = atmEntry > 0 && atmFairPremium > 0
    ? Math.round(atmFairPremium * (entry / atmEntry) * 100) / 100
    : entry;
  const difference = entry - theoreticalPrice;
  const differencePercent = entry > 0 ? (difference / entry) * 100 : 0;

  let status: PremiumFairValue['status'] = 'fair';
  if (differencePercent > 5) status = 'overpriced';
  else if (differencePercent < -5) status = 'undervalued';

  return {
    marketPrice: entry,
    theoreticalPrice: Math.round(theoreticalPrice * 100) / 100,
    difference: Math.round(difference * 100) / 100,
    differencePercent: Math.round(differencePercent * 10) / 10,
    status,
    reason: `${tradeDirection} premium ${entry.toFixed(1)} vs theoretical ${theoreticalPrice.toFixed(1)} (${differencePercent > 0 ? '+' : ''}${differencePercent.toFixed(1)}%)`,
  };
}

// ─── Live Probabilities ───────────────────────────────────────────
// Uses first-passage time (gambler's ruin) for TP/SL probabilities,
// with VIX drift adjustment for directional bias.
// P(TP hit before SL) = SL_dist / (TP_dist + SL_dist) in driftless case.
// With drift: adjusted using expected daily directional move.

function computeLiveProbabilities(
  entry: number,
  tp1: number,
  tp2: number,
  tp3: number,
  sl: number,
  spot: number,
  strike: number,
  vix: number,
  daysToExpiry: number,
  tradeDirection: 'CALL' | 'PUT'
): LiveProbability {
  if (entry <= 0) {
    return { tp1: 0, tp2: 0, tp3: 0, sl: 0, expiryITM: 0, expiryOTM: 0 };
  }

  const dailyVol = spot * (vix / 100) / Math.sqrt(252);
  const tp1Dist = Math.max(0.01, Math.abs(tp1 - entry));
  const tp2Dist = Math.max(0.01, Math.abs(tp2 - entry));
  const tp3Dist = Math.max(0.01, Math.abs(tp3 - entry));
  const slDist = Math.max(0.01, Math.abs(entry - sl));

  // Gambler's ruin: P(TP hit before SL) = SL_dist / (TP_dist + SL_dist)
  // Correct for driftless random walk (unbiased estimate)
  const baseProb = (d: number) => slDist / (d + slDist);

  // Adjust for VIX-implied drift: higher VIX → more directional days → higher TP prob
  // when trade is with VIX regime (calls in rising vol, puts in falling)
  const vixLevel = vix / 100;
  const driftFactor = vixLevel > 0.25 ? 1.15 : vixLevel > 0.20 ? 1.08 : vixLevel > 0.12 ? 1.0 : 0.92;

  const pTp1 = baseProb(tp1Dist) * driftFactor;
  const pTp2 = baseProb(tp2Dist) * driftFactor;
  const pTp3 = baseProb(tp3Dist) * driftFactor;
  const pSl = 1 - baseProb(tp1Dist) * driftFactor;

  // Expiry ITM: probability option expires in-the-money using distance in vol units
  const expiryMoves = daysToExpiry * dailyVol;
  const itmZ = expiryMoves > 0 ? Math.abs(spot - strike) / (spot * expiryMoves) : 2;
  const expiryITM = expiryMoves > 0
    ? Math.round(clamp((1 - Math.min(itmZ / 3, 1)) * 100, 10, 90))
    : 50;

  return {
    tp1: Math.round(clamp(Math.round(pTp1 * 100), 1, 95)),
    tp2: Math.round(clamp(Math.round(pTp2 * 100), 1, 95)),
    tp3: Math.round(clamp(Math.round(pTp3 * 100), 1, 95)),
    sl: Math.round(clamp(Math.round(pSl * 100), 1, 95)),
    expiryITM,
    expiryOTM: 100 - expiryITM,
  };
}

// ─── Data Health Bridge ───────────────────────────────────────────

function buildDataHealthReport(
  optionChain: SDMOptionStrike[],
  spot: number,
  lastUpdate: string,
  source: string
): DataHealthReport {
  const lastUpdateMs = new Date(lastUpdate).getTime();
  const atm = findATMStrike(optionChain, spot);
  // Only count strikes within ±5% of spot as missing if LTP=0 — deep OTM strikes naturally have LTP=0
  const rangeThreshold = spot * 0.05;
  const strikesWithMissing = optionChain.filter(
    (s) => {
      const nearATM = Math.abs(s.strike - spot) <= rangeThreshold;
      if (!nearATM) return false; // deep OTM — skip
      return !s.ce || !s.pe || (s.ce.ltp === 0 && s.pe.ltp === 0);
    }
  ).length;
  const nearATMCount = optionChain.filter(
    (s) => Math.abs(s.strike - spot) <= rangeThreshold
  ).length;

  return evaluateDataHealth({
    latencyMs: source === 'simulation' ? 0 : 200,
    lastUpdateMs: isNaN(lastUpdateMs) ? Date.now() : lastUpdateMs,
    totalStrikes: nearATMCount || optionChain.length,
    strikesWithMissingData: strikesWithMissing,
    atmHasGreeks: atm ? (atm.ce?.delta !== undefined && atm.pe?.delta !== undefined) : false,
    source,
  });
}

// ─── Direction Consensus ──────────────────────────────────────────

function determineDirection(
  consensus: ConsensusResult,
  oiAnalysis: OIAnalysis,
  gexResult: GEXResult,
  marketStructure: MarketStructure,
  spot: number,
  institutionalFilter?: { passed: boolean; action: string; reason: string; confidence: number }
): { direction: 'CALL' | 'PUT' | 'NEUTRAL'; confidence: number; reasons: string[] } {
  let callVotes = 0;
  let putVotes = 0;
  const reasons: string[] = [];

  // Multi-TF consensus (weight: 0.30)
  if (consensus.status === 'OK') {
    if (consensus.consensus > 0.15) {
      callVotes += 0.30;
      reasons.push(`Multi-TF bias ${consensus.overallBias} (${consensus.bullishCount}B/${consensus.bearishCount}Br)`);
    } else if (consensus.consensus < -0.15) {
      putVotes += 0.30;
      reasons.push(`Multi-TF bias ${consensus.overallBias} (${consensus.bearishCount}Br/${consensus.bullishCount}B)`);
    } else {
      reasons.push(`Multi-TF neutral (${consensus.consensus.toFixed(2)})`);
    }
  }

  // OI bias (weight: 0.20)
  if (oiAnalysis.status === 'OK') {
    const pcrOI = oiAnalysis.pcrOI;
    if (pcrOI > 1.2) {
      callVotes += 0.20;
      reasons.push(`PCR-OI ${pcrOI.toFixed(2)} bullish (put writing dominates)`);
    } else if (pcrOI < 0.8) {
      putVotes += 0.20;
      reasons.push(`PCR-OI ${pcrOI.toFixed(2)} bearish (call writing dominates)`);
    } else {
      reasons.push(`PCR-OI ${pcrOI.toFixed(2)} neutral`);
    }
  }

  // GEX regime (weight: 0.20)
  if (gexResult.status === 'OK') {
    if (gexResult.dealerBias === 'BULLISH') {
      callVotes += 0.20;
      reasons.push(`Dealer bias BULLISH (GEX ${gexResult.totalGEX.toFixed(0)})`);
    } else if (gexResult.dealerBias === 'BEARISH') {
      putVotes += 0.20;
      reasons.push(`Dealer bias BEARISH (GEX ${gexResult.totalGEX.toFixed(0)})`);
    } else {
      reasons.push(`Dealer bias NEUTRAL (GEX ${gexResult.totalGEX.toFixed(0)})`);
    }
  }

  // Market structure (weight: 0.15)
  if (marketStructure.status === 'OK') {
    if (marketStructure.trend === 'UPTREND') {
      callVotes += 0.15;
      reasons.push(`Structure UPTREND (last swing high ${marketStructure.lastSwingHigh.toFixed(0)})`);
    } else if (marketStructure.trend === 'DOWNTREND') {
      putVotes += 0.15;
      reasons.push(`Structure DOWNTREND (last swing low ${marketStructure.lastSwingLow.toFixed(0)})`);
    } else {
      reasons.push('Structure RANGING');
    }
  }

  // Institutional positioning (weight: 0.15) — NEW
  if (institutionalFilter && institutionalFilter.confidence >= 40) {
    if (institutionalFilter.action === 'proceed') {
      // Vote aligns with the institutional filter's passed direction
      // The direction is inferred from the confidence (if > 50 → bullish, < 50 → bearish)
      if (institutionalFilter.confidence >= 55) {
        callVotes += 0.15;
        reasons.push(`Institutional filter PASS (conf ${institutionalFilter.confidence})`);
      } else if (institutionalFilter.confidence <= 45) {
        putVotes += 0.15;
        reasons.push(`Institutional filter PASS with bearish lean (conf ${institutionalFilter.confidence})`);
      } else {
        reasons.push(`Institutional filter neutral (conf ${institutionalFilter.confidence})`);
      }
    } else if (institutionalFilter.action === 'reject') {
      putVotes += 0.15;
      reasons.push(`⚠ Institutional REJECT: ${institutionalFilter.reason}`);
    } else if (institutionalFilter.action === 'caution') {
      reasons.push(`Institutional caution: ${institutionalFilter.reason}`);
    }
  }

  const diff = callVotes - putVotes;
  let direction: 'CALL' | 'PUT' | 'NEUTRAL';
  if (diff > 0.15) direction = 'CALL';
  else if (diff < -0.15) direction = 'PUT';
  else direction = 'NEUTRAL';

  const confidence = Math.round(Math.abs(diff) * 100);

  return { direction, confidence, reasons };
}

// ─── Strike Selection ─────────────────────────────────────────────

function selectStrike(
  optionChain: SDMOptionStrike[],
  spot: number,
  direction: 'CALL' | 'PUT',
  atr: number,
  entry: number,
  sl: number,
  isExpiryDay: boolean,
  currentWindow: ExpiryWindow,
  qualityGrade: TradeGrade
): { strike: number; strikeType: 'ATM' | 'ITM' | 'OTM' } {
  const atm = findATMStrike(optionChain, spot);
  if (!atm) return { strike: spot, strikeType: 'ATM' };

  const isCall = direction === 'CALL';

  // Default: ATM
  let selectedStrike = atm.strike;
  let strikeType: 'ATM' | 'ITM' | 'OTM' = 'ATM';

  // Expiry theta window: prefer OTM for higher R:R on selling
  if (isExpiryDay && currentWindow === 'theta') {
    const otmStrikes = optionChain
      .filter((s) => isCall ? s.strike > atm.strike : s.strike < atm.strike)
      .sort((a, b) => isCall ? a.strike - b.strike : b.strike - a.strike);
    if (otmStrikes.length >= 2) {
      selectedStrike = otmStrikes[1].strike;
      strikeType = 'OTM';
    }
  }
  // High grade (A/A+): prefer ITM for delta capture
  else if ((qualityGrade === 'A+' || qualityGrade === 'A') && !isExpiryDay) {
    const itmStrikes = optionChain
      .filter((s) => isCall ? s.strike < atm.strike : s.strike > atm.strike)
      .sort((a, b) => isCall ? b.strike - a.strike : a.strike - b.strike);
    if (itmStrikes.length > 0) {
      selectedStrike = itmStrikes[0].strike;
      strikeType = 'ITM';
    }
  }

  // Check OTM R:R advantage: if OTM strike gives better R:R with acceptable premium
  if (strikeType === 'ATM' && atr > 0) {
    const otmCandidates = optionChain
      .filter((s) => isCall ? s.strike > atm.strike && s.strike <= atm.strike + atr * 2
                            : s.strike < atm.strike && s.strike >= atm.strike - atr * 2)
      .sort((a, b) => isCall ? a.strike - b.strike : b.strike - a.strike);

    for (const otm of otmCandidates) {
      const otmLeg = isCall ? otm.ce : otm.pe;
      if (!otmLeg || otmLeg.ltp <= 0) continue;
      const otmEntry = otmLeg.ltp;
      // The house geometry: a rupee-risk stop (20% of the premium) and the 2R target.
      const otmRR = houseRR(otmEntry, isCall);
      const atmLeg = isCall ? atm.ce : atm.pe;
      const atmEntry = atmLeg?.ltp || 0;
      const atmRR = houseRR(atmEntry, isCall);

      if (otmRR > atmRR * 1.3 && otmEntry > 5) {
        selectedStrike = otm.strike;
        strikeType = 'OTM';
        break;
      }
    }
  }

  return { strike: selectedStrike, strikeType };
}

// ─── Entry / SL / Targets — THE HOUSE PLAN ────────────────────────
//
/** The R:R of the house plan for one premium (TP1 = 2R of the rupee-risk stop). */
export function houseRR(entry: number, isCall: boolean): number {
  if (!(entry > 0)) return 0;
  const stopPct = PLAN_CONFIG.riskPctOfDeployed;
  const riskPoints = Math.min(
    entry * PLAN_CONFIG.maxStopPctOfPremium,
    Math.max(entry * stopPct, PLAN_CONFIG.minStopTicks * PLAN_CONFIG.tickSize),
  );
  if (riskPoints >= entry) return 0;
  if (PLAN_CONFIG.targetMultipliers[0] * riskPoints >= entry) return 0; // no reachable target
  return PLAN_CONFIG.targetMultipliers[0];
}
//
// ONE plan builder (src/lib/option-plan.ts): the stop is a RUPEE risk (20% of the
// amount DEPLOYED) and the targets are 2R / 3R / 4R of it.
//
// The old levels here were a private model: an ATR stop capped at 25% of the premium
// with TP1/TP2/TP3 at 1.5R / 2.5R / 4R. Two R ladders in one app is how the ledger
// ended up with a 21-24% win rate on a 1:1 plan and 64% on a 1:3.2 plan.

export interface HouseLevels {
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  plan: OptionPlan | null;
  /** why there is no trade (the plan could not be built) */
  error: string;
}

/**
 * The house plan for one option leg.
 * `lotSize` is the REAL contract lot when it is known; 1 (per-unit math) otherwise —
 * the geometry (a % of the premium) is identical either way, only the ₹ amounts
 * need the real lot.
 */
export function buildHouseLevels(input: {
  entry: number;
  isCall: boolean;
  symbol: string;
  lotSize: number;
  deployedAmount?: number;
}): HouseLevels {
  const empty: HouseLevels = { sl: 0, tp1: 0, tp2: 0, tp3: 0, plan: null, error: "" };
  const entry = Number(input.entry);
  if (!(entry > 0)) {
    return { ...empty, error: "no premium for the selected leg" };
  }
  const plan = buildOptionPlan({
    symbol: input.symbol,
    optionType: input.isCall ? "CE" : "PE",
    entryPremium: entry,
    lotSize: input.lotSize > 0 ? input.lotSize : 1,
    deployedAmount: input.deployedAmount ?? Math.min(GATE_CONFIG.tradeBudget, GATE_CONFIG.capital),
  });
  if (!plan) {
    return {
      ...empty,
      error: `no valid option plan for ₹${entry.toFixed(2)} — the stop or the targets do not fit inside the premium`,
    };
  }
  const [tp1, tp2, tp3] = [plan.targets[0] ?? 0, plan.targets[1] ?? plan.targets[0] ?? 0, plan.targets[2] ?? plan.targets[1] ?? plan.targets[0] ?? 0];
  return { sl: plan.stopLoss, tp1, tp2, tp3, plan, error: "" };
}

// ─── SDMScores Bridge (maps V2 module outputs to legacy shape) ────

function buildSDMScores(
  gexResult: GEXResult,
  marketStructure: MarketStructure,
  consensus: ConsensusResult,
  volumeAnalysis: VolumeAnalysis,
  oiAnalysis: OIAnalysis,
  sellerSLResult: SellerSLResult,
  optionChain: SDMOptionStrike[],
  spot: number
): SDMScores {
  const atm = findATMStrike(optionChain, spot);
  const ceLeg = atm?.ce;
  const peLeg = atm?.pe;

  return {
    sellerStopLoss: sellerSLResult.levels.length > 0
      ? Math.round(sellerSLResult.levels.reduce((sum, l) => sum + l.score, 0) / sellerSLResult.levels.length)
      : 50,
    expiryGammaTheta: gexResult.status === 'OK' ? clamp(Math.abs(gexResult.totalGEX) / 1000, 0, 100) : 50,
    pcr: oiAnalysis.status === 'OK' ? clamp(oiAnalysis.pcrOI * 50, 0, 100) : 50,
    oiConcentration: ceLeg && peLeg ? clamp(((ceLeg.oi + peLeg.oi) / 2000) * 100, 0, 100) : 50,
    oiChange: oiAnalysis.status === 'OK'
      ? clamp(oiAnalysis.freshWriting.length * 20, 0, 100)
      : 50,
    delta: ceLeg ? clamp(Math.abs(ceLeg.delta) * 100, 0, 100) : 50,
    iv: ceLeg ? clamp(ceLeg.iv, 0, 100) : 50,
    volume: volumeAnalysis.status === 'OK'
      ? clamp((volumeAnalysis.totalVolume / Math.max(volumeAnalysis.avgVolume, 1)) * 20, 0, 100)
      : 50,
    maxPain: oiAnalysis.status === 'OK'
      ? clamp(100 - Math.abs(oiAnalysis.maxPain - spot) / spot * 1000, 0, 100)
      : 50,
    liquidity: volumeAnalysis.status === 'OK'
      ? clamp(volumeAnalysis.avgVolume > 0 ? 70 : 40, 0, 100)
      : 50,
  };
}

// ─── Seller SL Zone Bridge ────────────────────────────────────────

function buildSellerSLZone(
  sellerSLResult: SellerSLResult,
  optionChain: SDMOptionStrike[],
  spot: number
): SellerSLZone {
  const nearestCESL = sellerSLResult.nearestCESL;
  const nearestPESL = sellerSLResult.nearestPESL;

  const ceSLLevel = nearestCESL?.level ?? 0;
  const peSLLevel = nearestPESL?.level ?? 0;

  const ceRow = optionChain.find((s) => s.strike === ceSLLevel);
  const peRow = optionChain.find((s) => s.strike === peSLLevel);

  const nearestSL: 'CE' | 'PE' =
    nearestCESL && nearestPESL
      ? nearestCESL.distanceFromSpot <= nearestPESL.distanceFromSpot ? 'CE' : 'PE'
      : nearestCESL ? 'CE' : 'PE';

  const distToSL = nearestSL === 'CE'
    ? (nearestCESL?.distanceFromSpot ?? 0)
    : (nearestPESL?.distanceFromSpot ?? 0);

  const sellerExhaustion = sellerSLResult.levels.some(
    (l) => l.stopHuntZone && l.status === 'ACTIVE'
  );

  return {
    ceSellerSL: ceSLLevel,
    peSellerSL: peSLLevel,
    ceSellerOI: ceRow?.ce?.oi ?? 0,
    peSellerOI: peRow?.pe?.oi ?? 0,
    nearestSL,
    distanceToSL: distToSL,
    sellerExhaustion,
  };
}

// ─── GammaThetaData Bridge ────────────────────────────────────────

function buildGammaThetaData(
  gexResult: GEXResult,
  optionChain: SDMOptionStrike[],
  spot: number,
  vix: number
): GammaThetaData {
  const atm = findATMStrike(optionChain, spot);
  const gammaBlastDetected = gexResult.status === 'OK' && vix < 12 &&
    gexResult.gammaWalls.length >= 2;

  return {
    gammaExposure: gexResult.totalGEX,
    thetaDecayRate: atm?.ce?.theta ? Math.abs(atm.ce.theta) : 0,
    premiumDecayPercent: 0,
    ivSkew: atm?.ce && atm?.pe ? Math.abs(atm.ce.iv - atm.pe.iv) : 0,
    gammaBlastDetected,
    gammaBlastSignals: {
      lowVix: vix < 12,
      flatThenBreakout: false,
      volumeSpike: false,
      ivSpike: vix > 25,
      extremePCR: false,
    },
    vixLevel: vix,
  };
}

// ─── Watchlist Builder ────────────────────────────────────────────

function buildWatchList(
  optionChain: SDMOptionStrike[],
  spot: number,
  confidence: number,
  isExpiryDay: boolean,
  currentWindow: ExpiryWindow
): WatchListItem[] {
  const watchList: WatchListItem[] = [];

  const shouldPopulate = isExpiryDay
    ? confidence < 65
    : confidence >= 40 && confidence <= 60;

  if (!shouldPopulate) return watchList;

  const topCE = optionChain
    .filter((s) => s.ce)
    .sort((a, b) => (b.ce?.oi ?? 0) - (a.ce?.oi ?? 0))
    .slice(0, 3);

  for (const s of topCE) {
    if (s.ce) {
      watchList.push({
        type: 'CE_SELLER_TRAP',
        strike: s.strike,
        oi: s.ce.oi,
        distance: Math.abs(s.strike - spot) / spot * 100,
        description: `CE Sellers @ ${s.strike} — ${(s.ce.oi / 100000).toFixed(1)}L OI`,
      });
    }
  }

  const topPE = optionChain
    .filter((s) => s.pe)
    .sort((a, b) => (b.pe?.oi ?? 0) - (a.pe?.oi ?? 0))
    .slice(0, 3);

  for (const s of topPE) {
    if (s.pe) {
      watchList.push({
        type: 'PE_SELLER_TRAP',
        strike: s.strike,
        oi: s.pe.oi,
        distance: Math.abs(s.strike - spot) / spot * 100,
        description: `PE Sellers @ ${s.strike} — ${(s.pe.oi / 100000).toFixed(1)}L OI`,
      });
    }
  }

  if (topPE[0]?.pe) {
    watchList.push({
      type: 'OI_SUPPORT',
      strike: topPE[0].strike,
      oi: topPE[0].pe.oi,
      distance: Math.abs(topPE[0].strike - spot) / spot * 100,
      description: `Strongest PE support @ ${topPE[0].strike}`,
    });
  }
  if (topCE[0]?.ce) {
    watchList.push({
      type: 'OI_RESISTANCE',
      strike: topCE[0].strike,
      oi: topCE[0].ce.oi,
      distance: Math.abs(topCE[0].strike - spot) / spot * 100,
      description: `Strongest CE resistance @ ${topCE[0].strike}`,
    });
  }

  watchList.sort((a, b) => a.distance - b.distance);
  return watchList;
}

// ─── Why This Trade Builder ───────────────────────────────────────

function buildWhyThisTrade(
  qualityScore: QualityScore,
  consensus: ConsensusResult,
  gexResult: GEXResult,
  sellerSLResult: SellerSLResult,
  smartEntry: SmartEntryResult,
  direction: 'CALL' | 'PUT'
): WhyThisTradeItem[] {
  const items: WhyThisTradeItem[] = [];

  // Top quality factors
  const sortedFactors = [...qualityScore.factors].sort((a, b) => b.score - a.score);
  for (const f of sortedFactors.slice(0, 4)) {
    items.push({
      signal: `${f.name} (${f.score}): ${f.detail}`,
      type: f.score >= 65 ? 'positive' : f.score >= 45 ? 'warning' : 'negative',
    });
  }

  // Consensus alignment
  if (consensus.status === 'OK') {
    const aligned = (direction === 'CALL' && consensus.consensus > 0) ||
                    (direction === 'PUT' && consensus.consensus < 0);
    items.push({
      signal: `Multi-TF consensus ${consensus.overallBias} — ${aligned ? 'aligned with' : 'against'} ${direction}`,
      type: aligned ? 'positive' : 'negative',
    });
  }

  // GEX regime
  if (gexResult.status === 'OK') {
    const favorable = (direction === 'CALL' && gexResult.dealerRegime === 'LONG_GAMMA') ||
                      (direction === 'PUT' && gexResult.dealerRegime === 'SHORT_GAMMA');
    items.push({
      signal: `GEX regime ${gexResult.dealerRegime} — ${favorable ? 'favorable' : 'adverse'} for ${direction}`,
      type: favorable ? 'positive' : 'negative',
    });
  }

  // Smart entry
  if (smartEntry.status === 'OK') {
    items.push({
      signal: `Entry timing: ${smartEntry.action} — ${smartEntry.reason}`,
      type: smartEntry.action === 'ENTER_NOW' ? 'positive' : 'warning',
    });
  }

  return items;
}

// ─── Holding Time Estimate ────────────────────────────────────────

function estimateHoldingTime(
  isExpiryDay: boolean,
  currentWindow: ExpiryWindow,
  smartEntry: SmartEntryAction
): string {
  if (isExpiryDay) {
    if (currentWindow === 'gamma') return '30-60 minutes';
    if (currentWindow === 'theta') return '1-2 hours';
    if (currentWindow === 'danger') return '15-30 minutes';
  }
  if (smartEntry === 'ENTER_NOW') return '2-4 hours';
  if (smartEntry === 'WAIT_PULLBACK') return 'Wait + 1-2 hours';
  return '2-4 hours';
}

// ─── Time Sensitive Note ──────────────────────────────────────────

function getTimeSensitiveNote(
  isExpiryDay: boolean,
  currentWindow: ExpiryWindow,
  smartEntry: SmartEntryAction
): string {
  if (smartEntry !== 'ENTER_NOW') {
    return `Entry pending: ${smartEntry}`;
  }
  if (isExpiryDay) {
    if (currentWindow === 'gamma') return 'Exit before 10:30 AM — theta accelerates';
    if (currentWindow === 'theta') return 'Selling only — theta destroys buyers';
    if (currentWindow === 'danger') return 'Exit by 3:15 PM — spreads widen';
  }
  return 'Hold 2-4 hours or until TP/SL';
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT — generateTradeRecommendation
// ═══════════════════════════════════════════════════════════════════

/**
 * A VIX we can actually use.
 *
 * 0 / NaN / null / undefined = UNKNOWN. The old code substituted 15
 * (`vix || 15`), so a missing India VIX was scored as a CALM market: the
 * buyer-confluence gate read the "CALM" regime (sizeMultiplier 1.0) and the
 * expected move was a fabricated 15%-of-spot number. A missing feed must make
 * the engine STRICTER, not more permissive.
 */
function knownVix(vix: number | null | undefined): number | null {
  const v = Number(vix);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export async function generateTradeRecommendation(
  optionChain: SDMOptionStrike[],
  spot: number,
  symbol: string,
  expiryDate: string,
  candles: Record<string, CandleData[]>,
  vix: number | null | undefined,
  source: string,
  lastUpdate: string,
  overrideDirection?: 'CALL' | 'PUT',
  institutionalFilterIn?: InstitutionalFilter
): Promise<SDMRecommendation> {
  // The REAL contract lot — null when the symbol is not in the NSE F&O lot
  // table. A ₹ risk/position size cannot be computed without it (and never
  // with a guessed NIFTY-sized lot).
  const lot = getLotSizeStrict(symbol);
  const lotSize = lot ?? 1; // the honest per-unit amount
  // The VIX is either REAL or UNKNOWN — never defaulted to 15.
  const vixNum = knownVix(vix);
  const daysToExpiry = computeDaysToExpiry(expiryDate);
  const isExpiryDay = isExpiryToday(expiryDate, new Date());
  const mode: DayMode = isExpiryDay ? 'SCALPER' : 'SWING';
  const currentTime = new Date();
  const timeInMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
  const currentWindow = computeExpiryWindow(isExpiryDay, timeInMinutes);

  // ── Step 1: Data Health Check ──────────────────────────────────
  const healthReport = buildDataHealthReport(optionChain, spot, lastUpdate, source);

  if (healthReport.status === 'OFFLINE') {
    return buildWAITRecommendation(
      spot, symbol, expiryDate, daysToExpiry, isExpiryDay, mode,
      currentWindow, timeInMinutes, currentTime, vixNum ?? null, source, lastUpdate,
      lot, healthReport,
      'Data health OFFLINE — cannot generate trade recommendation'
    );
  }

  // ── Step 2: Run All Analytics ──────────────────────────────────
  const primaryTF = Object.keys(candles).find((k) => k === '5m') || Object.keys(candles)[0] || '5m';
  const primaryCandles = candles[primaryTF] || [];

  const gexResult = calculateGEX(optionChain, spot);
  const marketStructure = analyzeMarketStructure(primaryCandles);
  const consensus = analyzeMultiTimeframe(candles);
  const volumeAnalysis = analyzeVolume(primaryCandles);
  const oiAnalysis = analyzeOptionChain(optionChain, spot);
  const atr = computeATR(primaryCandles, 14);

  // ── Institutional Positioning Check ───────────────────────────
  // Caller-supplied filter (from reconciled AgentContext.institutional slice) wins;
  // otherwise compute via the engine's own cache — same underlying data either way.
  let institutionalFilter = institutionalFilterIn ?? { passed: true, action: 'caution' as const, reason: '', confidence: 50 };
  if (!institutionalFilterIn) {
    try {
      const instData = await runInstitutionalPositioning();
      institutionalFilter = getInstitutionalFilter(instData);
    } catch { /* non-fatal */ }
  }

  // ── Step 3: Validation Gate ────────────────────────────────────
  // Run quality score first (needed for validation)
  const tempDirection: 'CALL' | 'PUT' = overrideDirection || 'CALL';
  const atmStrikeData = findATMStrike(optionChain, spot);
  const tempEntry = overrideDirection === 'PUT'
    ? (atmStrikeData?.pe?.ltp || atmStrikeData?.ce?.ltp || 0)
    : (atmStrikeData?.ce?.ltp || atmStrikeData?.pe?.ltp || 0);
  // The house plan (rupee-risk stop, 2R/3R/4R targets) — never the old ±15% 1:1.
  const tempLevels = buildHouseLevels({
    entry: tempEntry,
    isCall: tempDirection === 'CALL',
    symbol,
    lotSize: lot ?? 1,
  });
  const tempSL = tempLevels.sl;
  const tempTP1 = tempLevels.tp1;

  const qualityInput = {
    spot,
    candles,
    optionChain,
    gexResult,
    marketStructure,
    consensus,
    volumeAnalysis,
    oiAnalysis,
    // 0 = the VIX is UNKNOWN. The volatility factor then reads
    // "VIX 0.0 — too low" (a CONSERVATIVE 40, never a permissive calm-market
    // bonus) and the recommendation is forced to WAIT further down.
    vix: vixNum ?? 0,
    currentWindow,
    tradeDirection: tempDirection,
    entryPrice: tempEntry,
    stopLoss: tempSL,
    target1: tempTP1,
  };
  const preliminaryScore = computeQualityScore(qualityInput);

  const validationInput = {
    healthReport,
    qualityGrade: preliminaryScore.grade,
    qualityScore: preliminaryScore.overall,
    optionChain,
    selectedStrike: findATMStrike(optionChain, spot)?.strike ?? spot,
    entryPrice: tempEntry,
    spot,
    riskState: DEFAULT_RISK_STATE,
    direction: tempDirection,
    // NEW: High-probability filters
    mtfResult: consensus?.multiTimeframe || null,
    newsSentiment: consensus?.newsSentiment || null,
  };
  const validation = validateTrade(validationInput);

  if (!validation.passed) {
    const action = validation.action;
    return buildWAITRecommendation(
      spot, symbol, expiryDate, daysToExpiry, isExpiryDay, mode,
      currentWindow, timeInMinutes, currentTime, vixNum ?? null, source, lastUpdate,
      lot, healthReport,
      validation.reason,
      action === 'NO_TRADE' ? 'NO_TRADE' : undefined,
      undefined, undefined, gexResult, marketStructure, consensus,
      volumeAnalysis, oiAnalysis, atr
    );
  }

  // ── Step 4: Quality Score ──────────────────────────────────────
  // Determine preliminary direction for quality scoring
  const dirResult = determineDirection(consensus, oiAnalysis, gexResult, marketStructure, spot, institutionalFilter);
  // Use the first non-NEUTRAL direction from consensus for preliminary strike selection.
  // If all are NEUTRAL, default to CALL (preliminary only — final direction overrides below).
  const consensusDir = dirResult.direction === 'NEUTRAL' ? 'CALL' : dirResult.direction;
  const preliminaryDirection: 'CALL' | 'PUT' = overrideDirection || consensusDir;

  const sellerSLResult = findSellerSLLevels(optionChain, spot, gexResult, marketStructure, volumeAnalysis, oiAnalysis);
  const { strike: selectedStrike, strikeType } = selectStrike(
    optionChain, spot, preliminaryDirection, atr, 0, 0,
    isExpiryDay, currentWindow, preliminaryScore.grade
  );
  const selectedData = optionChain.find((s) => s.strike === selectedStrike);
  const isCallDir = preliminaryDirection === 'CALL';
  const entryPrice = isCallDir ? (selectedData?.ce?.ltp || 0) : (selectedData?.pe?.ltp || 0);
  const tradeLevels = buildHouseLevels({
    entry: entryPrice,
    isCall: isCallDir,
    symbol,
    lotSize: lot ?? 1,
  });

  const fullQualityInput: QualityScoreInput = {
    spot,
    candles,
    optionChain,
    gexResult,
    marketStructure,
    consensus,
    volumeAnalysis,
    oiAnalysis,
    // 0 = the VIX is UNKNOWN (never a fabricated 15).
    vix: vixNum ?? 0,
    currentWindow,
    tradeDirection: preliminaryDirection,
    entryPrice,
    stopLoss: tradeLevels.sl,
    target1: tradeLevels.tp1,
  };
  const qualityScore = computeQualityScore(fullQualityInput);

  // FAIL CLOSED: no house plan → no trade. The old code fell back to a ±15%
  // stop with a 1:1 target (R:R 1:1 needs >50% win-rate before costs).
  if (tradeLevels.error) {
    return buildWAITRecommendation(
      spot, symbol, expiryDate, daysToExpiry, isExpiryDay, mode,
      currentWindow, timeInMinutes, currentTime, vixNum ?? null, source, lastUpdate,
      lot, healthReport,
      tradeLevels.error,
      'NO_TRADE',
      qualityScore, sellerSLResult, gexResult, marketStructure, consensus,
      volumeAnalysis, oiAnalysis, atr
    );
  }

  if (qualityScore.overall < 50) {
    return buildWAITRecommendation(
      spot, symbol, expiryDate, daysToExpiry, isExpiryDay, mode,
      currentWindow, timeInMinutes, currentTime, vixNum ?? null, source, lastUpdate,
      lot, healthReport,
      `Quality score ${qualityScore.overall} (grade ${qualityScore.grade}) below 50 threshold`,
      undefined,
      qualityScore, sellerSLResult, gexResult, marketStructure, consensus,
      volumeAnalysis, oiAnalysis, atr
    );
  }

  // ── Step 5: Determine Direction ────────────────────────────────
  let direction: TradeDirection;
  if (overrideDirection) {
    direction = overrideDirection;
  } else if (dirResult.direction === 'NEUTRAL' || dirResult.confidence < 15) {
    direction = 'WAIT';
  } else {
    direction = isCallDir ? 'CALL' : 'PUT';
  }

  // OPTION BUYING ONLY: Never recommend selling
  // If theta window suggests selling, convert to WAIT instead
  if (!overrideDirection && isExpiryDay && currentWindow === 'theta' && direction !== 'WAIT') {
    direction = 'WAIT';
  }

  // ── Step 6: Seller SL Analysis ─────────────────────────────────
  // Already computed above

  // ── Step 7: Strike Selection (re-run with final direction) ─────
  const finalIsCall = direction === 'CALL';
  const finalStrikeResult = selectStrike(
    optionChain, spot, finalIsCall ? 'CALL' : 'PUT', atr, entryPrice, tradeLevels.sl,
    isExpiryDay, currentWindow, qualityScore.grade
  );

  const finalSelectedStrike = finalStrikeResult.strike;
  const finalStrikeType = finalStrikeResult.strikeType;
  const finalSelectedData = optionChain.find((s) => s.strike === finalSelectedStrike);
  const finalEntry = finalIsCall
    ? (finalSelectedData?.ce?.ltp || 0)
    : (finalSelectedData?.pe?.ltp || 0);

  // ── Step 8: Entry / SL / Targets ───────────────────────────────
  const finalLevels = buildHouseLevels({
    entry: finalEntry,
    isCall: finalIsCall,
    symbol,
    lotSize: lot ?? 1,
  });

  // FAIL CLOSED: the final leg has no house plan → no trade (never a ±15% fallback).
  if (finalLevels.error) {
    return buildWAITRecommendation(
      spot, symbol, expiryDate, daysToExpiry, isExpiryDay, mode,
      currentWindow, timeInMinutes, currentTime, vixNum ?? null, source, lastUpdate,
      lot, healthReport,
      finalLevels.error,
      'NO_TRADE',
      qualityScore, sellerSLResult, gexResult, marketStructure, consensus,
      volumeAnalysis, oiAnalysis, atr
    );
  }

  // ── Step 9: Smart Entry ────────────────────────────────────────
  let smartEntryResult: SmartEntryResult;
  if (direction === 'WAIT') {
    smartEntryResult = {
      action: 'WAIT_VOLUME_CONFIRMATION',
      reason: 'Direction is WAIT — no entry signal',
      currentPrice: spot,
      referenceLevel: spot,
      atr,
      distanceFromLevel: 0,
      volumeRatio: 1,
      status: 'OK',
    };
  } else {
    smartEntryResult = determineSmartEntry(
      spot, finalIsCall ? 'CALL' : 'PUT', finalEntry,
      primaryCandles, marketStructure, volumeAnalysis, optionChain
    );
  }

  // ── Step 10: Smart Exit ────────────────────────────────────────
  const smartExitResult: SmartExitResult = {
    action: 'HOLD',
    reason: 'No position open — exit evaluation for new entry',
    unrealizedPnLPercent: 0,
    targetHit: 0,
    gexRegimeFlipped: false,
    structureReversal: false,
    status: gexResult.status === 'OK' && marketStructure.status === 'OK' ? 'OK' : 'DEGRADED',
  };

  // ── Step 11: Position Sizing — THE PER-TRADE MODEL ─────────────
  //   deployed  = the ₹ committed to THIS trade   (≤ ₹20,000)
  //   risk      = 20% of the amount DEPLOYED      (₹10,000 deployed → ₹2,000)
  //   lots      = min(risk-limited, affordable from the deployment cap)
  //
  // The old block sized on "₹1,00,000 × 1%" and a "5% of capital" notional cap:
  // both made every NIFTY contract 0 lots (₹1,000 risk vs a ₹1,656 risk/lot),
  // so the dashboard said "0 lots" on every single recommendation.
  const session = getCurrentSession();
  const capital = GATE_CONFIG.capital;                  // ₹25,000 — the real account
  const baseBudget = Math.min(GATE_CONFIG.tradeBudget, capital); // ₹20,000 deployed

  // A 0 multiplier means "this session does not allow new positions" — that is a
  // TIMING gate (isTradeAllowed below), not a size. The model size stays visible.
  const sessionMultiplier = getPositionSizeMultiplier(session) || 1;

  // Vega-aware reduction: when VIX > 20 (elevated IV), commit less money because
  // options are expensive and the IV-crush risk is higher.
  // An UNKNOWN VIX (no feed) is NOT "VIX 0" — it gets no vega adjustment.
  const vegaFactor = (vixNum !== null && vixNum > 20)
    ? Math.max(1 - (Math.min(vixNum / 14, 3) - 1) * 0.4, 0.4)
    : 1;
  const deployedBudget = Math.floor(baseBudget * sessionMultiplier * vegaFactor);

  // The ₹ sizing needs the REAL lot. With an unknown lot size there is NO
  // ₹ risk and NO position size (a per-unit number would be a fiction).
  const ps = lot !== null
    ? positionSize({ capital, entry: finalEntry, sl: finalLevels.sl, lotSize: lot })
    : null;
  const riskPerLot = ps && ps.riskPerLot > 0 ? ps.riskPerLot : 0;
  // The deployment cap is the budget (₹20,000), NOT a % of the account.
  const affordableLots = lot !== null && finalEntry > 0
    ? Math.floor(deployedBudget / (finalEntry * lot))
    : 0;
  const clampedLots = ps ? Math.max(0, Math.min(ps.lots, affordableLots)) : 0;

  const positionSizing: PositionSizing = {
    lots: clampedLots,
    quantity: clampedLots * lotSize,
    // the REAL rupee risk: the premium committed × 20%, capped by the stop distance
    riskAmount: clampedLots * riskPerLot,
    positionValue: finalEntry * clampedLots * lotSize,
    maxLoss: clampedLots * riskPerLot,
  };

  // ── Step 12: Build Recommendation ──────────────────────────────

  // Confidence: weighted blend of quality score and direction consensus
  // When candle data is unavailable, weight quality score more heavily since
  // direction confidence is low due to DEGRADED multi-TF/structure/volume
  const hasCandles = primaryCandles.length > 0;
  const dirConfidence = dirResult.confidence;
  const confidence = hasCandles
    ? Math.round(qualityScore.overall * 0.6 + dirConfidence * 0.4)
    : Math.round(qualityScore.overall * 0.8 + dirConfidence * 0.2);
  const clampedConfidence = clamp(confidence, 0, 100);

  // Apply confidence thresholds (session-adjusted)
  const sessionConfidence = adjustConfidenceForSession(clampedConfidence, session);
  const threshold = getConfidenceThreshold(session);

  // OI-derived context (PCR + max pain) — computed BEFORE the buyer-confluence
  // gate below reads them (they were previously declared ~50 lines later,
  // crashing every CALL/PUT path with a TDZ ReferenceError).
  const totalCEOI = optionChain.reduce((sum, s) => sum + (s.ce?.oi ?? 0), 0);
  const totalPEOI = optionChain.reduce((sum, s) => sum + (s.pe?.oi ?? 0), 0);
  const pcr = totalCEOI > 0 && totalPEOI > 0 ? Math.round((totalPEOI / totalCEOI) * 100) / 100 : null;
  const maxPain = oiAnalysis.status === 'OK' ? oiAnalysis.maxPain : spot;
  // Set when the VIX feed was unavailable — the recommendation is a WAIT and
  // says why (never a "calm market" trade).
  let vixUnavailable = false;

  if (direction !== 'WAIT') {
    // ── Unknown VIX → fail closed (a DATA gate, checked first) ─────
    // The buyer-confluence gate scores the VIX regime (COMPLACENT / CALM /
    // NORMAL / ELEVATED / FEAR) and the expected move needs it too. With no
    // VIX there is no volatility read at all, so no trade is proposed —
    // and the reason says so instead of blaming the session.
    if (vixNum === null) {
      direction = 'WAIT';
      vixUnavailable = true;
    } else {
    // Session check: is trading allowed right now?
    const tradeCheck = isTradeAllowed(direction === 'CALL' ? 'CALL' : 'PUT', session);
    if (!tradeCheck.allowed) {
      direction = 'WAIT';
    }
    // Apply session-adjusted threshold
    else if (sessionConfidence < threshold) {
      direction = 'WAIT';
    }
    // ── Buyer Confluence Gate (Section 7) ──
    else if (direction === 'CALL' || direction === 'PUT') {
      const now = new Date();
      const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
      const confluenceInput: ConfluenceInput = {
        fiiNet: 0, diiNet: 0, fiiFutLongRatio: 0.5, fiiNet5dAvg: 0,
        pcr: pcr, maxPain: maxPain, spotPrice: spot,
        ceOIBuildup: false, peOIBuildup: false, oiPattern: 'NEUTRAL',
        ivRank: 50,
        // The ATM IV the chain actually carries. 0 = the chain published no
        // ATM IV (UNKNOWN) — the old `|| 15` invented a "normal" 15% IV.
        atmIV: Math.max(atmStrikeData?.ce?.iv ?? 0, atmStrikeData?.pe?.iv ?? 0),
        ivTrend: 'STABLE',
        atmStraddlePrice: 0, expectedMove: 0,
        gammaFlipLevel: 0, dealerGexRegime: 'LONG_GAMMA',
        indiaVix: vixNum ?? 0, adx: 25, niftyTrend: 'NEUTRAL', bankNiftyTrend: 'NEUTRAL',
        currentHour: ist.getHours(), currentMinute: ist.getMinutes(),
        isExpiryDay: session?.isExpiryDay || false,
        daysToExpiry: session?.daysToExpiry || 7,
        dayOfWeek: ist.getDay(),
        rsi: 50, adxTechnical: 25, ema20Above50: true, higherHighs: true,
        gapPercent: 0,
        direction: direction === 'CALL' ? 'CE' : 'PE',
      };
      const confluence: ConfluenceResult = scoreBuyerConfluence(confluenceInput);
      // Block if confluence says NO_TRADE (score below threshold) OR hardBlocks exist
      if (confluence.action === 'NO_TRADE' || confluence.hardBlocks.length > 0) {
        direction = 'WAIT';
      }
    }
    }
  }

  // Risk:Reward
  const riskReward = finalEntry > finalLevels.sl && finalEntry > 0
    ? Math.round((finalLevels.tp2 - finalEntry) / (finalEntry - finalLevels.sl) * 10) / 10
    : 0;

  // Premium fair value
  const premiumFairValue = computePremiumFairValue(
    optionChain, spot, finalEntry,
    finalIsCall ? 'CALL' : 'PUT'
  );

  // Probabilities
  const probabilities = computeLiveProbabilities(
    finalEntry, finalLevels.tp1, finalLevels.tp2, finalLevels.tp3,
    finalLevels.sl, spot, finalSelectedStrike, vixNum ?? 0, daysToExpiry,
    finalIsCall ? 'CALL' : 'PUT'
  );

  // Data health → DataHealth type
  const dataHealth: DataHealth = {
    score: healthReport.score,
    latency: healthReport.latencyMs,
    lastUpdate,
    status: healthReport.score >= 80 ? 'LIVE' : healthReport.score >= 50 ? 'STALE' : 'OFFLINE',
    source,
    missingFields: healthReport.issues,
  };

  // Market context (pcr + maxPain hoisted above the confluence gate)
  const marketContext: MarketContext = {
    spot,
    change: 0,
    changePercent: 0,
    pcr,
    maxPain,
    // 0 = UNKNOWN (the VIX feed was unavailable) — never a fabricated 15.
    vix: vixNum ?? 0,
    vixAvailable: vixNum !== null,
    trend: marketStructure.trend === 'UPTREND' ? 'bullish'
          : marketStructure.trend === 'DOWNTREND' ? 'bearish' : 'sideways',
    regime: qualityScore.overall >= 70 ? 'trending' : 'ranging',
    atr,
  };

  // Watchlist
  const watchList = buildWatchList(optionChain, spot, clampedConfidence, isExpiryDay, currentWindow);

  // WhyThisTrade
  const whyThisTrade = buildWhyThisTrade(qualityScore, consensus, gexResult, sellerSLResult, smartEntryResult, finalIsCall ? 'CALL' : 'PUT');

  // SDM Scores
  const sdmScores = buildSDMScores(gexResult, marketStructure, consensus, volumeAnalysis, oiAnalysis, sellerSLResult, optionChain, spot);

  // Seller SL Zone
  const sellerSLZone = buildSellerSLZone(sellerSLResult, optionChain, spot);

  // Gamma Theta Data
  const gammaThetaData = buildGammaThetaData(gexResult, optionChain, spot, vixNum ?? 0);

  // Trade grade
  const tradeGrade = qualityScore.grade;

  // Expected move — UNKNOWN without a real VIX (never a 15%-VIX guess).
  const expectedMove = vixNum !== null
    ? spot * (vixNum / 100) * Math.sqrt(daysToExpiry / 365)
    : 0;
  const expectedMoveAvailable = vixNum !== null;

  // Holding time
  const holdingTimeEstimate = estimateHoldingTime(isExpiryDay, currentWindow, smartEntryResult.action);

  // Time sensitive note
  const timeSensitiveNote = getTimeSensitiveNote(isExpiryDay, currentWindow, smartEntryResult.action);

  // Window time remaining
  let windowTimeRemaining = 'N/A';
  if (isExpiryDay) {
    if (currentWindow === 'gamma') {
      windowTimeRemaining = `${Math.max(0, 630 - timeInMinutes)} min remaining`;
    } else if (currentWindow === 'theta') {
      windowTimeRemaining = `${Math.max(0, 810 - timeInMinutes)} min remaining`;
    } else if (currentWindow === 'danger') {
      windowTimeRemaining = `${Math.max(0, 930 - timeInMinutes)} min remaining`;
    }
  }

  // Trades remaining
  const maxTrades = isExpiryDay ? 4 : Infinity;

  // Reason
  const reason = vixUnavailable
    ? 'VIX unavailable — no volatility read, so no trade is proposed (expected move unknown)'
    : (dirResult.reasons.slice(0, 2).join('; ') || `Quality ${qualityScore.overall} (${qualityScore.grade})`);

  // Smart entry/exit actions
  const smartEntry: SmartEntryAction = direction === 'WAIT' ? 'WAIT_VOLUME_CONFIRMATION' : smartEntryResult.action;
  const smartExit: SmartExitAction = direction === 'WAIT' ? 'EXIT' : smartExitResult.action;

  // Market regime
  const marketRegime: MarketRegime = qualityScore.overall >= 75 ? 'trending'
    : qualityScore.overall >= 55 ? 'ranging' : 'mean_reversion';

  // ─── MTF Indicator Confirmation Layer ────────────────────────────
  let mtfResult: any = undefined;
  try {
    const { computeMTFIndicators } = await import('./mtf-indicator-engine');
    const { generateMTFSignal } = await import('./mtf-signal-engine');
    const { DEFAULT_INDICATOR_PARAMS } = await import('./mtf-config');

    // Build candles by TF: use whatever was passed in
    const candlesByTF: Record<string, CandleData[]> = {};
    if (candles['15m']?.length) candlesByTF['15m'] = candles['15m'];
    if (candles['5m']?.length) candlesByTF['5m'] = candles['5m'];
    // Entry TF = 5M (closest to 3M available)
    if (candles['5m']?.length) candlesByTF['3m'] = candles['5m'];

    if (Object.keys(candlesByTF).length > 0) {
      const indicators = computeMTFIndicators(candlesByTF, DEFAULT_INDICATOR_PARAMS, 20);
      const mtfSignal = generateMTFSignal(indicators.timeframes);
      mtfResult = {
        action: mtfSignal.action,
        compositeScore: mtfSignal.compositeScore,
        confidence: mtfSignal.confidence,
        direction: mtfSignal.direction,
        entry: mtfSignal.entry,
        reasons: mtfSignal.reasons,
        trend: mtfSignal.trend,
      };
    }
  } catch { /* non-fatal — MTF is additive */ }

  return {
    direction,
    optionType: finalIsCall ? "CE" : "PE",
    // REAL contract expiry (ISO). The display label is derived separately;
    // the veto/gate/claim must never receive "Expiry Today" / "2d to expiry".
    expiryDate: toIsoExpiry(expiryDate) ?? expiryDate,
    strike: finalSelectedStrike,
    strikeType: finalStrikeType,
    entry: finalEntry,
    tp1: finalLevels.tp1,
    tp2: finalLevels.tp2,
    tp3: finalLevels.tp3,
    sl: finalLevels.sl,
    confidence: clampedConfidence,
    riskReward,
    isExpiryDay,
    daysToExpiry,
    currentWindow,
    windowTimeRemaining,
    tradesTakenToday: 0,
    tradesRemaining: isExpiryDay ? maxTrades : 999,
    mode,
    sellerSLZone,
    gammaThetaData,
    marketContext,
    watchList,
    whyThisTrade,
    sdmScores,
    reason,
    timeSensitiveNote,
    smartEntry,
    smartExit,
    premiumFairValue,
    probabilities,
    tradeGrade,
    dataHealth,
    positionSizing,
    marketRegime,
    holdingTimeEstimate,
    expectedMove,
    expectedMoveAvailable,
    lotSize,
    lotSizeKnown: lot !== null,
    consensus,
    qualityScore,
    session: {
      label: session.label,
      description: session.description,
      confidenceMultiplier: session.confidenceMultiplier,
      notes: session.notes,
    },
    mtf: mtfResult,
  };
}

// ─── WAIT Recommendation Builder ──────────────────────────────────

function buildWAITRecommendation(
  spot: number,
  symbol: string,
  expiryDate: string,
  daysToExpiry: number,
  isExpiryDay: boolean,
  mode: DayMode,
  currentWindow: ExpiryWindow,
  timeInMinutes: number,
  currentTime: Date,
  vix: number | null,
  source: string,
  lastUpdate: string,
  lotSize: number | null,
  healthReport: DataHealthReport,
  reason: string,
  forceDirection?: 'NO_TRADE',
  qualityScore?: QualityScore,
  sellerSLResult?: SellerSLResult,
  gexResult?: GEXResult,
  marketStructure?: MarketStructure,
  consensus?: ConsensusResult,
  volumeAnalysis?: VolumeAnalysis,
  oiAnalysis?: OIAnalysis,
  atr?: number
): SDMRecommendation {
  const direction: TradeDirection = forceDirection === 'NO_TRADE' ? 'WAIT' : (forceDirection || 'WAIT');

  const dataHealth: DataHealth = {
    score: healthReport.score,
    latency: healthReport.latencyMs,
    lastUpdate,
    status: healthReport.score >= 80 ? 'LIVE' : healthReport.score >= 50 ? 'STALE' : 'OFFLINE',
    source,
    missingFields: healthReport.issues,
  };

  const emptySellerSL: SellerSLZone = {
    ceSellerSL: 0, peSellerSL: 0, ceSellerOI: 0, peSellerOI: 0,
    nearestSL: 'CE', distanceToSL: 0, sellerExhaustion: false,
  };

  const vixNum = knownVix(vix);
  const lotSizeNum = lotSize ?? 1; // the honest per-unit amount
  const emptyGammaTheta: GammaThetaData = {
    gammaExposure: 0, thetaDecayRate: 0, premiumDecayPercent: 0, ivSkew: 0,
    gammaBlastDetected: false,
    gammaBlastSignals: { lowVix: false, flatThenBreakout: false, volumeSpike: false, ivSpike: false, extremePCR: false },
    vixLevel: vixNum ?? 0,
  };

  const emptyMarketContext: MarketContext = {
    spot, change: 0, changePercent: 0,
    pcr: oiAnalysis?.pcrOI || oiAnalysis?.pcrVolume || 0,
    maxPain: oiAnalysis?.maxPain || spot,
    // 0 = UNKNOWN (no VIX feed) — never a fabricated 15.
    vix: vixNum ?? 0,
    vixAvailable: vixNum !== null,
    trend: 'sideways', regime: 'trending',
  };

  const emptyScores: SDMScores = {
    sellerStopLoss: 0, expiryGammaTheta: 0,
    pcr: oiAnalysis ? clamp(oiAnalysis.pcrOI * 50, 0, 100) : 0,
    oiConcentration: 0,
    oiChange: 0, delta: 0, iv: 0, volume: 0, maxPain: 0, liquidity: 0,
  };

  const windowTimeRemaining = isExpiryDay
    ? currentWindow === 'gamma' ? `${Math.max(0, 630 - timeInMinutes)} min remaining`
    : currentWindow === 'theta' ? `${Math.max(0, 810 - timeInMinutes)} min remaining`
    : currentWindow === 'danger' ? `${Math.max(0, 930 - timeInMinutes)} min remaining`
    : 'N/A'
    : 'N/A';

  return {
    direction,
    strike: spot,
    strikeType: 'ATM',
    entry: 0,
    tp1: 0,
    tp2: 0,
    tp3: 0,
    sl: 0,
    confidence: 0,
    riskReward: 0,
    isExpiryDay,
    daysToExpiry,
    currentWindow,
    windowTimeRemaining,
    tradesTakenToday: 0,
    tradesRemaining: 0,
    mode,
    sellerSLZone: emptySellerSL,
    gammaThetaData: emptyGammaTheta,
    marketContext: emptyMarketContext,
    watchList: [],
    whyThisTrade: [{ signal: reason, type: 'negative' }],
    sdmScores: emptyScores,
    reason,
    timeSensitiveNote: 'Fix data issues before trading',
    smartEntry: 'WAIT_VOLUME_CONFIRMATION',
    smartExit: 'EXIT',
    premiumFairValue: { marketPrice: 0, theoreticalPrice: 0, difference: 0, differencePercent: 0, status: 'fair', reason: 'No data' },
    probabilities: { tp1: 0, tp2: 0, tp3: 0, sl: 0, expiryITM: 0, expiryOTM: 0 },
    tradeGrade: qualityScore?.grade ?? 'D',
    dataHealth,
    positionSizing: { lots: 0, quantity: 0, riskAmount: 0, positionValue: 0, maxLoss: 0 },
    marketRegime: 'trending',
    holdingTimeEstimate: 'N/A',
    lotSize: lotSizeNum,
    lotSizeKnown: lotSize !== null,
    // UNKNOWN without a real VIX (never a 15%-VIX guess).
    expectedMove: vixNum !== null
      ? spot * (vixNum / 100) * Math.sqrt(daysToExpiry / 365)
      : 0,
    expectedMoveAvailable: vixNum !== null,
    consensus: undefined,
    qualityScore,
  };
}

// ═══════════════════════════════════════════════════════════════════
// BACKWARD COMPATIBILITY — generateRecommendation wrapper
// ═══════════════════════════════════════════════════════════════════

export function generateRecommendation(
  optionChain: SDMOptionStrike[],
  spotPrice: number,
  symbol: string,
  expiryDate: string,
  currentTime: Date,
  vix?: number,
  tradesTakenToday: number = 0,
  lastUpdate?: string,
  source: string = 'simulation'
): SDMRecommendation {
  // Legacy callers pass candles as empty — synthesize from the data we have
  // The new engine will use analyzeMarketStructure with primaryCandles
  const candles: Record<string, CandleData[]> = {};

  // Use synchronous path: call the async function but handle it synchronously
  // Since all V2 modules are synchronous, this is safe
  let result: SDMRecommendation | null = null;

  // We run the async function — in practice it completes synchronously
  // because all V2 modules are synchronous
  // The VIX is passed through AS IS — a missing VIX stays missing (the
  // engine then reports the expected move as UNKNOWN and proposes no trade).
  // The old `vix ?? 15` turned a missing feed into a calm-market trade.
  generateTradeRecommendation(
    optionChain, spotPrice, symbol, expiryDate,
    candles, vix, source,
    lastUpdate || new Date().toISOString()
  ).then((r) => { result = r; });

  // Since generateTradeRecommendation uses only sync V2 modules, it resolves immediately
  // However, to be safe for the legacy interface, we return a synchronous result
  // by running the same logic inline

  // Fallback: if the async call didn't resolve yet, compute synchronously
  if (result) return result;

  // Synchronous fallback — same logic as generateTradeRecommendation
  return generateRecommendationSync(
    optionChain, spotPrice, symbol, expiryDate,
    currentTime, vix ?? null, tradesTakenToday, lastUpdate, source
  );
}

// ─── Synchronous Fallback (same logic, no async) ──────────────────

function generateRecommendationSync(
  optionChain: SDMOptionStrike[],
  spot: number,
  symbol: string,
  expiryDate: string,
  currentTime: Date,
  vix: number | null,
  tradesTakenToday: number,
  lastUpdate: string | undefined,
  source: string
): SDMRecommendation {
  // The REAL contract lot — null when it is not known (never a guess).
  const lot = getLotSizeStrict(symbol);
  const lotSize = lot ?? 1; // the honest per-unit amount
  const vixNum = knownVix(vix);
  const daysToExpiry = computeDaysToExpiry(expiryDate);
  const isExpiryDay = isExpiryToday(expiryDate, currentTime instanceof Date ? currentTime : new Date());
  const mode: DayMode = isExpiryDay ? 'SCALPER' : 'SWING';
  const timeInMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
  const currentWindow = computeExpiryWindow(isExpiryDay, timeInMinutes);
  const lastUpdateStr = lastUpdate || new Date().toISOString();

  const healthReport = buildDataHealthReport(optionChain, spot, lastUpdateStr, source);

  if (healthReport.status === 'OFFLINE') {
    return buildWAITRecommendation(
      spot, symbol, expiryDate, daysToExpiry, isExpiryDay, mode,
      currentWindow, timeInMinutes, currentTime, vix, source, lastUpdateStr,
      lot, healthReport, 'Data health OFFLINE'
    );
  }

  // Use option chain data as primary candles proxy (legacy callers don't provide candles)
  // Build minimal candle data from option chain for structure analysis
  const syntheticCandles: CandleData[] = optionChain.slice(0, 30).map((s, i) => ({
    time: Date.now() - (30 - i) * 60000,
    open: s.ce?.ltp || s.pe?.ltp || 0,
    high: (s.ce?.ltp || 0) * 1.02,
    low: (s.ce?.ltp || 0) * 0.98,
    close: s.ce?.ltp || s.pe?.ltp || 0,
    volume: (s.ce?.volume ?? 0) + (s.pe?.volume ?? 0),
  })).filter((c) => c.close > 0);

  const candles: Record<string, CandleData[]> = { '5m': syntheticCandles };

  const primaryCandles = syntheticCandles;
  const gexResult = calculateGEX(optionChain, spot);
  // Structure, volume, and ATR from synthetic candles are unreliable —
  // use neutral defaults when real candles aren't available.
  const marketStructure = syntheticCandles.length > 5
    ? { ...analyzeMarketStructure(primaryCandles), confidence: Math.min(analyzeMarketStructure(primaryCandles).confidence || 0, 30) }
    : { trend: 'NEUTRAL' as const, bias: 'NEUTRAL' as const, structure: 'RANGE' as const, confidence: 0, support: spot * 0.99, resistance: spot * 1.01, swingHighs: [], swingLows: [] };
  const consensus = { direction: 'NEUTRAL' as const, confidence: 0, timeframeSummary: [] };
  const volumeAnalysis = { status: 'LOW_DATA' as const, totalVolume: 0, avgVolume: 0, volumeRatio: 0, vwap: spot, absorption: false, exhaustion: false, unusualActivity: [] };
  const oiAnalysis = analyzeOptionChain(optionChain, spot);
  const atr = spot * 0.005; // Default 0.5% ATR when no real candles

  // Direction
  const dirResult = determineDirection(consensus, oiAnalysis, gexResult, marketStructure, spot, institutionalFilter);
  const isCallDir = dirResult.direction !== 'PUT';

  let direction: TradeDirection;
  if (dirResult.direction === 'NEUTRAL' || dirResult.confidence < 15) {
    direction = 'WAIT';
  } else {
    direction = isCallDir ? 'CALL' : 'PUT';
  }
  if (isExpiryDay && currentWindow === 'theta' && direction !== 'WAIT') {
    direction = 'WAIT';
  }

  // Seller SL
  const sellerSLResult = findSellerSLLevels(optionChain, spot, gexResult, marketStructure, volumeAnalysis, oiAnalysis);

  // Quality score
  const tempIsCall = direction === 'CALL' || direction === 'SELL_CALL';
  const tempStrike = findATMStrike(optionChain, spot);
  const tempEntry = tempIsCall ? (tempStrike?.ce?.ltp || 0) : (tempStrike?.pe?.ltp || 0);
  // The house plan (rupee-risk stop, 2R/3R/4R targets) — never the old ±15% 1:1.
  const tempLevels = buildHouseLevels({
    entry: tempEntry,
    isCall: tempIsCall,
    symbol,
    lotSize: lot ?? 1,
  });
  const tempSL = tempLevels.sl;
  const tempTP1 = tempLevels.tp1;

  const qualityInput: QualityScoreInput = {
    // 0 = the VIX is UNKNOWN (never a fabricated 15) — the volatility factor
    // then reads conservatively instead of scoring a "calm market".
    spot, candles, optionChain, gexResult, marketStructure, consensus,
    volumeAnalysis, oiAnalysis, vix: vixNum ?? 0, currentWindow,
    tradeDirection: tempIsCall ? 'CALL' : 'PUT',
    entryPrice: tempEntry, stopLoss: tempSL, target1: tempTP1,
  };
  const qualityScore = computeQualityScore(qualityInput);

  if (qualityScore.overall < 50) {
    return buildWAITRecommendation(
      spot, symbol, expiryDate, daysToExpiry, isExpiryDay, mode,
      currentWindow, timeInMinutes, currentTime, vix, source, lastUpdateStr,
      lot, healthReport,
      `Quality score ${qualityScore.overall} (grade ${qualityScore.grade}) below 50`,
      undefined, qualityScore, sellerSLResult, gexResult, marketStructure,
      consensus, volumeAnalysis, oiAnalysis, atr
    );
  }

  // Strike selection
  const finalIsCall = tempIsCall;
  const strikeResult = selectStrike(
    optionChain, spot, finalIsCall ? 'CALL' : 'PUT', atr, tempEntry, tempSL,
    isExpiryDay, currentWindow, qualityScore.grade
  );
  const finalStrike = strikeResult.strike;
  const finalStrikeType = strikeResult.strikeType;
  const finalData = optionChain.find((s) => s.strike === finalStrike);
  const finalEntry = finalIsCall ? (finalData?.ce?.ltp || 0) : (finalData?.pe?.ltp || 0);

  const finalLevels = buildHouseLevels({
    entry: finalEntry,
    isCall: finalIsCall,
    symbol,
    lotSize: lot ?? 1,
  });

  // FAIL CLOSED: no house plan → no trade (never a ±15% / 1:1 fallback).
  if (finalLevels.error) {
    return buildWAITRecommendation(
      spot, symbol, expiryDate, daysToExpiry, isExpiryDay, mode,
      currentWindow, timeInMinutes, currentTime, vix, source, lastUpdateStr,
      lot, healthReport,
      finalLevels.error,
      'NO_TRADE',
      qualityScore, sellerSLResult, gexResult, undefined,
      undefined, undefined, oiAnalysis, atr
    );
  }

  // Confidence
  const confidence = clamp(Math.round(qualityScore.overall * 0.6 + dirResult.confidence * 0.4), 0, 100);

  if (direction !== 'WAIT') {
    if (isExpiryDay && currentWindow === 'danger' && confidence < 68) direction = 'WAIT';
    else if (isExpiryDay && confidence < 60) direction = 'WAIT';
    else if (!isExpiryDay && confidence < 55) direction = 'WAIT';
  }

  // Smart entry
  let smartEntryResult: SmartEntryResult;
  if (direction === 'WAIT') {
    smartEntryResult = {
      action: 'WAIT_VOLUME_CONFIRMATION', reason: 'Direction is WAIT',
      currentPrice: spot, referenceLevel: spot, atr, distanceFromLevel: 0,
      volumeRatio: 1, status: 'OK',
    };
  } else {
    smartEntryResult = determineSmartEntry(
      spot, finalIsCall ? 'CALL' : 'PUT', finalEntry,
      primaryCandles, marketStructure, volumeAnalysis, optionChain
    );
  }

  // Position sizing — THE PER-TRADE MODEL (₹20,000 deployed, 20% of it at risk)
  const capital = GATE_CONFIG.capital;                     // ₹25,000 — the real account
  const baseBudget = Math.min(GATE_CONFIG.tradeBudget, capital);
  const sessionMultiplier = getPositionSizeMultiplier(getCurrentSession()) || 1;
  const vegaFactor = (vixNum !== null && vixNum > 20)
    ? Math.max(1 - (Math.min(vixNum / 14, 3) - 1) * 0.4, 0.4)
    : 1;
  const deployedBudget = Math.floor(baseBudget * sessionMultiplier * vegaFactor);

  // No ₹ sizing without the REAL lot (an unknown lot ⇒ no ₹ amount).
  const ps = lot !== null
    ? positionSize({ capital, entry: finalEntry, sl: finalLevels.sl, lotSize: lot })
    : null;
  const riskPerLot = ps && ps.riskPerLot > 0 ? ps.riskPerLot : 0;
  const affordableLots = lot !== null && finalEntry > 0
    ? Math.floor(deployedBudget / (finalEntry * lot))
    : 0;
  const clampedLots = ps ? Math.max(0, Math.min(ps.lots, affordableLots)) : 0;

  const positionSizing: PositionSizing = {
    lots: clampedLots,
    quantity: clampedLots * lotSize,
    riskAmount: clampedLots * riskPerLot,
    positionValue: finalEntry * clampedLots * lotSize,
    maxLoss: clampedLots * riskPerLot,
  };

  const riskReward = finalEntry > finalLevels.sl && finalEntry > 0
    ? Math.round((finalLevels.tp2 - finalEntry) / (finalEntry - finalLevels.sl) * 10) / 10
    : 0;

  const premiumFairValue = computePremiumFairValue(optionChain, spot, finalEntry, finalIsCall ? 'CALL' : 'PUT');
  const probabilities = computeLiveProbabilities(
    finalEntry, finalLevels.tp1, finalLevels.tp2, finalLevels.tp3,
    finalLevels.sl, spot, finalStrike, vixNum ?? 0, daysToExpiry, finalIsCall ? 'CALL' : 'PUT'
  );

  const dataHealth: DataHealth = {
    score: healthReport.score, latency: healthReport.latencyMs,
    lastUpdate: lastUpdateStr,
    status: healthReport.score >= 80 ? 'LIVE' : healthReport.score >= 50 ? 'STALE' : 'OFFLINE',
    source, missingFields: healthReport.issues,
  };

  const totalCEOI = optionChain.reduce((sum, s) => sum + (s.ce?.oi ?? 0), 0);
  const totalPEOI = optionChain.reduce((sum, s) => sum + (s.pe?.oi ?? 0), 0);
  const pcr = totalCEOI > 0 && totalPEOI > 0 ? Math.round((totalPEOI / totalCEOI) * 100) / 100 : null;
  const maxPain = oiAnalysis.status === 'OK' ? oiAnalysis.maxPain : spot;

  const marketContext: MarketContext = {
    spot, change: 0, changePercent: 0, pcr, maxPain,
    // 0 = UNKNOWN (no VIX feed) — never a fabricated 15.
    vix: vixNum ?? 0,
    vixAvailable: vixNum !== null,
    trend: marketStructure.trend === 'UPTREND' ? 'bullish'
          : marketStructure.trend === 'DOWNTREND' ? 'bearish' : 'sideways',
    regime: qualityScore.overall >= 70 ? 'trending' : 'ranging',
    atr,
  };

  const watchList = buildWatchList(optionChain, spot, confidence, isExpiryDay, currentWindow);
  const whyThisTrade = buildWhyThisTrade(qualityScore, consensus, gexResult, sellerSLResult, smartEntryResult, finalIsCall ? 'CALL' : 'PUT');
  const sdmScores = buildSDMScores(gexResult, marketStructure, consensus, volumeAnalysis, oiAnalysis, sellerSLResult, optionChain, spot);
  const sellerSLZone = buildSellerSLZone(sellerSLResult, optionChain, spot);
  const gammaThetaData = buildGammaThetaData(gexResult, optionChain, spot, vixNum ?? 0);

  // UNKNOWN without a real VIX (never a 15%-VIX guess).
  const expectedMove = vixNum !== null
    ? spot * (vixNum / 100) * Math.sqrt(daysToExpiry / 365)
    : 0;
  const expectedMoveAvailable = vixNum !== null;
  const holdingTimeEstimate = estimateHoldingTime(isExpiryDay, currentWindow, smartEntryResult.action);
  const timeSensitiveNote = getTimeSensitiveNote(isExpiryDay, currentWindow, smartEntryResult.action);

  let windowTimeRemaining = 'N/A';
  if (isExpiryDay) {
    if (currentWindow === 'gamma') windowTimeRemaining = `${Math.max(0, 630 - timeInMinutes)} min remaining`;
    else if (currentWindow === 'theta') windowTimeRemaining = `${Math.max(0, 810 - timeInMinutes)} min remaining`;
    else if (currentWindow === 'danger') windowTimeRemaining = `${Math.max(0, 930 - timeInMinutes)} min remaining`;
  }

  const maxTrades = isExpiryDay ? 4 : Infinity;
  const reason = dirResult.reasons.slice(0, 2).join('; ') || `Quality ${qualityScore.overall} (${qualityScore.grade})`;
  const smartEntry: SmartEntryAction = direction === 'WAIT' ? 'WAIT_VOLUME_CONFIRMATION' : smartEntryResult.action;
  const smartExit: SmartExitAction = direction === 'WAIT' ? 'EXIT' : 'HOLD';
  const marketRegime: MarketRegime = qualityScore.overall >= 75 ? 'trending'
    : qualityScore.overall >= 55 ? 'ranging' : 'mean_reversion';
  const tradeGrade = qualityScore.grade;

  return {
    direction,
    strike: finalStrike,
    strikeType: finalStrikeType,
    entry: finalEntry,
    tp1: finalLevels.tp1,
    tp2: finalLevels.tp2,
    tp3: finalLevels.tp3,
    sl: finalLevels.sl,
    confidence,
    riskReward,
    isExpiryDay,
    daysToExpiry,
    currentWindow,
    windowTimeRemaining,
    tradesTakenToday,
    tradesRemaining: isExpiryDay ? Math.max(0, maxTrades - tradesTakenToday) : 999,
    mode,
    sellerSLZone,
    gammaThetaData,
    marketContext,
    watchList,
    whyThisTrade,
    sdmScores,
    reason,
    timeSensitiveNote,
    smartEntry,
    smartExit,
    premiumFairValue,
    probabilities,
    tradeGrade,
    dataHealth,
    positionSizing,
    marketRegime,
    holdingTimeEstimate,
    expectedMove,
    expectedMoveAvailable,
    lotSize,
    lotSizeKnown: lot !== null,
    consensus,
    qualityScore,
  };
}

// ─── Keep: validateOptionChain ────────────────────────────────────

export function validateOptionChain(
  optionChain: SDMOptionStrike[],
  spotPrice: number,
  symbol: string
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
  if (optionChain.length < 10) {
    warnings.push(`Only ${optionChain.length} strikes available (need 10+)`);
  }

  const atm = findATMStrike(optionChain, spotPrice);
  if (!atm?.ce) warnings.push('No CE data at ATM strike');
  if (!atm?.pe) warnings.push('No PE data at ATM strike');
  if (atm?.ce && atm.ce.ltp === 0) warnings.push('CE LTP is zero at ATM');
  if (atm?.pe && atm.pe.ltp === 0) warnings.push('PE LTP is zero at ATM');
  if (atm?.ce && atm.ce.oi === 0) warnings.push('CE OI is zero at ATM');
  if (atm?.pe && atm.pe.oi === 0) warnings.push('PE OI is zero at ATM');

  let totalCEOI = 0;
  let totalPEOI = 0;
  let strikesWithZeroOI = 0;
  for (const s of optionChain) {
    if (s.ce) totalCEOI += s.ce.oi;
    if (s.pe) totalPEOI += s.pe.oi;
    if (s.ce && s.ce.oi === 0 && s.pe && s.pe.oi === 0) strikesWithZeroOI++;
  }
  if (strikesWithZeroOI > optionChain.length * 0.5) {
    warnings.push(`${strikesWithZeroOI}/${optionChain.length} strikes have zero OI`);
  }
  if (totalCEOI === 0 && totalPEOI === 0) {
    issues.push('Total OI is zero — data may be stale');
  }

  for (const s of optionChain) {
    if (s.ce && s.ce.iv > 200) warnings.push(`CE IV > 200% at ${s.strike}`);
    if (s.pe && s.pe.iv > 200) warnings.push(`PE IV > 200% at ${s.strike}`);
    if (s.ce && s.ce.ltp > spotPrice) warnings.push(`CE premium > spot at ${s.strike}`);
  }

  let dataQuality = 100;
  dataQuality -= issues.length * 30;
  dataQuality -= warnings.length * 5;
  dataQuality = Math.max(0, Math.min(100, dataQuality));

  return { isValid: issues.length === 0, issues, warnings, dataQuality };
}

export interface ValidationResult {
  isValid: boolean;
  issues: string[];
  warnings: string[];
  dataQuality: number;
}

// ─── Keep: createEmptyRecommendation ──────────────────────────────

export function createEmptyRecommendation(
  spotPrice: number,
  symbol: string,
  expiryDate: string,
  currentTime: Date,
  validation: ValidationResult
): SDMRecommendation {
  const daysToExpiry = computeDaysToExpiry(expiryDate);

  return {
    direction: 'WAIT',
    strike: spotPrice,
    strikeType: 'ATM',
    entry: 0,
    tp1: 0,
    tp2: 0,
    tp3: 0,
    sl: 0,
    confidence: 0,
    riskReward: 0,
    isExpiryDay: false,
    daysToExpiry,
    currentWindow: 'normal',
    windowTimeRemaining: 'N/A',
    tradesTakenToday: 0,
    tradesRemaining: 0,
    mode: 'SWING',
    sellerSLZone: {
      ceSellerSL: 0, peSellerSL: 0, ceSellerOI: 0, peSellerOI: 0,
      nearestSL: 'CE', distanceToSL: 0, sellerExhaustion: false,
    },
    gammaThetaData: {
      gammaExposure: 0, thetaDecayRate: 0, premiumDecayPercent: 0, ivSkew: 0,
      gammaBlastDetected: false,
      gammaBlastSignals: { lowVix: false, flatThenBreakout: false, volumeSpike: false, ivSpike: false, extremePCR: false },
      vixLevel: 0,
    },
    marketContext: {
      spot: spotPrice, change: 0, changePercent: 0, pcr: 0, maxPain: spotPrice,
      vix: 0, trend: 'sideways', regime: 'trending',
    },
    watchList: [],
    whyThisTrade: [
      ...validation.issues.map((issue) => ({
        signal: issue, type: 'negative' as const,
      })),
      ...validation.warnings.map((w) => ({
        signal: w, type: 'warning' as const,
      })),
    ],
    sdmScores: {
      sellerStopLoss: 0, expiryGammaTheta: 0, pcr: 0, oiConcentration: 0,
      oiChange: 0, delta: 0, iv: 0, volume: 0, maxPain: 0, liquidity: 0,
    },
    reason: `Data validation failed: ${validation.issues.join('; ')}`,
    timeSensitiveNote: 'Fix data issues before trading',
    smartEntry: 'WAIT_VOLUME_CONFIRMATION',
    smartExit: 'EXIT',
    premiumFairValue: { marketPrice: 0, theoreticalPrice: 0, difference: 0, differencePercent: 0, status: 'fair', reason: 'No data' },
    probabilities: { tp1: 0, tp2: 0, tp3: 0, sl: 0, expiryITM: 0, expiryOTM: 0 },
    tradeGrade: 'D',
    dataHealth: {
      score: validation.dataQuality, latency: 0,
      lastUpdate: new Date().toISOString(),
      status: validation.dataQuality >= 80 ? 'LIVE' : validation.dataQuality >= 50 ? 'STALE' : 'OFFLINE',
      source: 'validation', missingFields: validation.issues,
    },
    positionSizing: { lots: 0, quantity: 0, riskAmount: 0, positionValue: 0, maxLoss: 0 },
    marketRegime: 'trending',
    holdingTimeEstimate: 'N/A',
    expectedMove: 0,
  };
}
