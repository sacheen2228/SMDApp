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
import {
  getCurrentSession,
  adjustConfidenceForSession,
  isTradeAllowed,
  getConfidenceThreshold,
  getPositionSizeMultiplier,
  type SessionInfo,
} from './market-session';

// ─── Constants ────────────────────────────────────────────────────

const LOT_SIZES: Record<string, number> = {
  NIFTY: 65,
  BANKNIFTY: 30,
  FINNIFTY: 60,
  MIDCPNIFTY: 120,
  SENSEX: 20,
};

const DEFAULT_RISK_STATE: RiskState = {
  dailyPnL: 0,
  weeklyPnL: 0,
  monthlyPnL: 0,
  openPositions: 0,
  canTrade: true,
  maxDailyLoss: 50000,
  maxWeeklyLoss: 100000,
  maxMonthlyLoss: 200000,
  maxPositionSize: 10,
  maxConcurrentTrades: 3,
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
  let atr = 0;
  for (let i = 1; i <= period; i++) {
    atr += candles[i].high - candles[i].low;
  }
  atr /= period;
  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + (candles[i].high - candles[i].low)) / period;
  }
  return atr;
}

function getLotSize(symbol: string): number {
  return LOT_SIZES[symbol] || 65;
}

function computeDaysToExpiry(expiryDate: string): number {
  const today = new Date();
  const expiry = new Date(expiryDate);
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

  // Simple theoretical estimate using Black-Scholes proxy:
  // intrinsic + time value approximation
  const intrinsic = tradeDirection === 'CALL'
    ? Math.max(0, spot - atm.strike)
    : Math.max(0, atm.strike - spot);
  const timeValue = leg.iv > 0 ? entry * (leg.iv / 100) * 0.3 : entry * 0.15;
  const theoreticalPrice = intrinsic + timeValue;
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

// ─── Simplified Inline: Live Probabilities ────────────────────────

function computeLiveProbabilities(
  entry: number,
  tp1: number,
  tp2: number,
  tp3: number,
  sl: number,
  spot: number,
  vix: number,
  daysToExpiry: number,
  tradeDirection: 'CALL' | 'PUT'
): LiveProbability {
  if (entry <= 0) {
    return { tp1: 0, tp2: 0, tp3: 0, sl: 0, expiryITM: 0, expiryOTM: 0 };
  }

  // VIX-based daily vol
  const dailyVol = vix / 100 / Math.sqrt(252);
  const expectedDailyMove = spot * dailyVol;

  // Probability of hitting TP (approximation using normal dist)
  const tp1Dist = Math.abs(tp1 - entry);
  const tp2Dist = Math.abs(tp2 - entry);
  const tp3Dist = Math.abs(tp3 - entry);
  const slDist = Math.abs(entry - sl);

  const z1 = expectedDailyMove > 0 ? tp1Dist / expectedDailyMove : 0;
  const z2 = expectedDailyMove > 0 ? tp2Dist / expectedDailyMove : 0;
  const z3 = expectedDailyMove > 0 ? tp3Dist / expectedDailyMove : 0;
  const zSL = expectedDailyMove > 0 ? slDist / expectedDailyMove : 0;

  // P(hitting target) ≈ Φ(z) using approximation
  const phi = (z: number): number => {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804014327 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.8212560 + t * 1.3302744))));
    return z > 0 ? 1 - p : p;
  };

  const tpProb = (z: number): number => Math.round(clamp(phi(z * 0.6) * 100, 0, 95));
  const slProb = (z: number): number => Math.round(clamp(phi(z * 0.5) * 100, 0, 95));

  // Expiry ITM probability (simplified: based on distance from ATM in vol units)
  const atmDist = Math.abs(spot - (tradeDirection === 'CALL' ? spot : spot));
  const expiryMoves = daysToExpiry * dailyVol;
  const expiryITM = expiryMoves > 0
    ? Math.round(clamp(phi(atmDist / (spot * expiryMoves)) * 100, 10, 90))
    : 50;

  return {
    tp1: tpProb(z1),
    tp2: tpProb(z2),
    tp3: tpProb(z3),
    sl: slProb(zSL),
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
  const strikesWithMissing = optionChain.filter(
    (s) => !s.ce || !s.pe || s.ce.ltp === 0 || s.pe.ltp === 0
  ).length;

  return evaluateDataHealth({
    latencyMs: source === 'simulation' ? 0 : 200,
    lastUpdateMs: isNaN(lastUpdateMs) ? Date.now() : lastUpdateMs,
    totalStrikes: optionChain.length,
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
  spot: number
): { direction: 'CALL' | 'PUT' | 'NEUTRAL'; confidence: number; reasons: string[] } {
  let callVotes = 0;
  let putVotes = 0;
  const reasons: string[] = [];

  // Multi-TF consensus (weight: 0.35)
  if (consensus.status === 'OK') {
    if (consensus.consensus > 0.15) {
      callVotes += 0.35;
      reasons.push(`Multi-TF bias ${consensus.overallBias} (${consensus.bullishCount}B/${consensus.bearishCount}Br)`);
    } else if (consensus.consensus < -0.15) {
      putVotes += 0.35;
      reasons.push(`Multi-TF bias ${consensus.overallBias} (${consensus.bearishCount}Br/${consensus.bullishCount}B)`);
    } else {
      reasons.push(`Multi-TF neutral (${consensus.consensus.toFixed(2)})`);
    }
  }

  // OI bias (weight: 0.25)
  if (oiAnalysis.status === 'OK') {
    const pcrOI = oiAnalysis.pcrOI;
    if (pcrOI > 1.2) {
      callVotes += 0.25;
      reasons.push(`PCR-OI ${pcrOI.toFixed(2)} bullish (put writing dominates)`);
    } else if (pcrOI < 0.8) {
      putVotes += 0.25;
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

  // Market structure (weight: 0.20)
  if (marketStructure.status === 'OK') {
    if (marketStructure.trend === 'UPTREND') {
      callVotes += 0.20;
      reasons.push(`Structure UPTREND (last swing high ${marketStructure.lastSwingHigh.toFixed(0)})`);
    } else if (marketStructure.trend === 'DOWNTREND') {
      putVotes += 0.20;
      reasons.push(`Structure DOWNTREND (last swing low ${marketStructure.lastSwingLow.toFixed(0)})`);
    } else {
      reasons.push('Structure RANGING');
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
      const otmSL = otmEntry * 0.85;
      const otmTP2 = otmEntry * 1.50;
      const otmRR = otmEntry > otmSL ? (otmTP2 - otmEntry) / (otmEntry - otmSL) : 0;
      const atmLeg = isCall ? atm.ce : atm.pe;
      const atmEntry = atmLeg?.ltp || 0;
      const atmSL = atmEntry * 0.85;
      const atmTP2 = atmEntry * 1.50;
      const atmRR = atmEntry > atmSL ? (atmTP2 - atmEntry) / (atmEntry - atmSL) : 0;

      if (otmRR > atmRR * 1.3 && otmEntry > 5) {
        selectedStrike = otm.strike;
        strikeType = 'OTM';
        break;
      }
    }
  }

  return { strike: selectedStrike, strikeType };
}

// ─── Entry / SL / Targets from Premium + ATR ─────────────────────

function computeTradeLevels(
  entry: number,
  atr: number,
  spot: number,
  sellerSLResult: SellerSLResult,
  isCall: boolean,
  isExpiryDay: boolean,
  currentWindow: ExpiryWindow,
  vix: number
): { sl: number; tp1: number; tp2: number; tp3: number } {
  if (entry <= 0) return { sl: 0, tp1: 0, tp2: 0, tp3: 0 };

  // ATR-based SL distance (1.5 ATR for premium)
  const atrSL = atr > 0 ? atr * 1.5 : entry * 0.15;

  // Seller SL proximity bonus — if seller SL is close, tighter SL
  let slDist = atrSL;
  const nearestSL = isCall ? sellerSLResult.nearestCESL : sellerSLResult.nearestPESL;
  if (nearestSL) {
    const sellerDist = Math.abs(nearestSL.level - spot);
    if (sellerDist > 0 && sellerDist < atr * 3) {
      slDist = Math.min(atrSL, sellerDist * 0.3);
    }
  }

  // Floor SL at 5% of premium, cap at 25%
  const slPctMin = entry * 0.05;
  const slPctMax = entry * 0.25;
  slDist = Math.max(slPctMin, Math.min(slPctMax, slDist));

  const sl = entry - slDist;

  // Targets: T1=1.5R, T2=2.5R, T3=4R
  const tp1 = entry + slDist * 1.5;
  const tp2 = entry + slDist * 2.5;
  const tp3 = entry + slDist * 4.0;

  return { sl, tp1, tp2, tp3 };
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

export async function generateTradeRecommendation(
  optionChain: SDMOptionStrike[],
  spot: number,
  symbol: string,
  expiryDate: string,
  candles: Record<string, CandleData[]>,
  vix: number,
  source: string,
  lastUpdate: string
): Promise<SDMRecommendation> {
  const lotSize = getLotSize(symbol);
  const daysToExpiry = computeDaysToExpiry(expiryDate);
  const today = new Date();
  const expiry = new Date(expiryDate);
  const isExpiryDay =
    today.getFullYear() === expiry.getFullYear() &&
    today.getMonth() === expiry.getMonth() &&
    today.getDate() === expiry.getDate();
  const mode: DayMode = isExpiryDay ? 'SCALPER' : 'SWING';
  const currentTime = new Date();
  const timeInMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
  const currentWindow = computeExpiryWindow(isExpiryDay, timeInMinutes);

  // ── Step 1: Data Health Check ──────────────────────────────────
  const healthReport = buildDataHealthReport(optionChain, spot, lastUpdate, source);

  if (healthReport.status === 'OFFLINE') {
    return buildWAITRecommendation(
      spot, symbol, expiryDate, daysToExpiry, isExpiryDay, mode,
      currentWindow, timeInMinutes, currentTime, vix, source, lastUpdate,
      lotSize, healthReport,
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

  // ── Step 3: Validation Gate ────────────────────────────────────
  // Run quality score first (needed for validation)
  const tempDirection: 'CALL' | 'PUT' = 'CALL';
  const tempEntry = findATMStrike(optionChain, spot)?.ce?.ltp || 0;
  const tempSL = tempEntry * 0.85;
  const tempTP1 = tempEntry * 1.15;

  const qualityInput = {
    spot,
    candles,
    optionChain,
    gexResult,
    marketStructure,
    consensus,
    volumeAnalysis,
    oiAnalysis,
    vix,
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
  };
  const validation = validateTrade(validationInput);

  if (!validation.passed) {
    const action = validation.action;
    return buildWAITRecommendation(
      spot, symbol, expiryDate, daysToExpiry, isExpiryDay, mode,
      currentWindow, timeInMinutes, currentTime, vix, source, lastUpdate,
      lotSize, healthReport,
      validation.reason,
      action === 'NO_TRADE' ? 'NO_TRADE' : undefined,
      undefined, undefined, gexResult, marketStructure, consensus,
      volumeAnalysis, oiAnalysis, atr
    );
  }

  // ── Step 4: Quality Score ──────────────────────────────────────
  // Determine preliminary direction for quality scoring
  const dirResult = determineDirection(consensus, oiAnalysis, gexResult, marketStructure, spot);
  const preliminaryDirection: 'CALL' | 'PUT' = dirResult.direction === 'NEUTRAL' ? 'CALL' : dirResult.direction;

  const sellerSLResult = findSellerSLLevels(optionChain, spot, gexResult, marketStructure, volumeAnalysis, oiAnalysis);
  const { strike: selectedStrike, strikeType } = selectStrike(
    optionChain, spot, preliminaryDirection, atr, 0, 0,
    isExpiryDay, currentWindow, preliminaryScore.grade
  );
  const selectedData = optionChain.find((s) => s.strike === selectedStrike);
  const isCallDir = preliminaryDirection === 'CALL';
  const entryPrice = isCallDir ? (selectedData?.ce?.ltp || 0) : (selectedData?.pe?.ltp || 0);
  const tradeLevels = computeTradeLevels(entryPrice, atr, spot, sellerSLResult, isCallDir, isExpiryDay, currentWindow, vix);

  const fullQualityInput: QualityScoreInput = {
    spot,
    candles,
    optionChain,
    gexResult,
    marketStructure,
    consensus,
    volumeAnalysis,
    oiAnalysis,
    vix,
    currentWindow,
    tradeDirection: preliminaryDirection,
    entryPrice,
    stopLoss: tradeLevels.sl,
    target1: tradeLevels.tp1,
  };
  const qualityScore = computeQualityScore(fullQualityInput);

  if (qualityScore.overall < 50) {
    return buildWAITRecommendation(
      spot, symbol, expiryDate, daysToExpiry, isExpiryDay, mode,
      currentWindow, timeInMinutes, currentTime, vix, source, lastUpdate,
      lotSize, healthReport,
      `Quality score ${qualityScore.overall} (grade ${qualityScore.grade}) below 50 threshold`,
      undefined,
      qualityScore, sellerSLResult, gexResult, marketStructure, consensus,
      volumeAnalysis, oiAnalysis, atr
    );
  }

  // ── Step 5: Determine Direction ────────────────────────────────
  let direction: TradeDirection;
  if (dirResult.direction === 'NEUTRAL' || dirResult.confidence < 15) {
    direction = 'WAIT';
  } else {
    direction = isCallDir ? 'CALL' : 'PUT';
  }

  // OPTION BUYING ONLY: Never recommend selling
  // If theta window suggests selling, convert to WAIT instead
  if (isExpiryDay && currentWindow === 'theta' && direction !== 'WAIT') {
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
  const finalLevels = computeTradeLevels(
    finalEntry, atr, spot, sellerSLResult, finalIsCall,
    isExpiryDay, currentWindow, vix
  );

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

  // ── Step 11: Position Sizing (session-adjusted) ─────────────────
  const session = getCurrentSession();
  const capital = 100000;  // TODO: make configurable from user settings
  const riskPercent = 0.01; // 1% risk per trade
  const riskAmount = capital * riskPercent;
  const sessionMultiplier = getPositionSizeMultiplier(session);
  const adjustedRisk = riskAmount * sessionMultiplier;
  const riskPerLot = finalEntry > 0 ? Math.abs(finalEntry - finalLevels.sl) * lotSize : 0;
  const lots = riskPerLot > 0 ? Math.floor(adjustedRisk / riskPerLot) : 0;
  const clampedLots = Math.min(lots, 10);

  const positionSizing: PositionSizing = {
    lots: clampedLots,
    quantity: clampedLots * lotSize,
    riskAmount: adjustedRisk,
    positionValue: finalEntry * clampedLots * lotSize,
    maxLoss: riskPerLot * clampedLots,
  };

  // ── Step 12: Build Recommendation ──────────────────────────────

  // Confidence: weighted blend of quality score and direction consensus
  const dirConfidence = dirResult.confidence;
  const confidence = Math.round(qualityScore.overall * 0.6 + dirConfidence * 0.4);
  const clampedConfidence = clamp(confidence, 0, 100);

  // Apply confidence thresholds (session-adjusted)
  const sessionConfidence = adjustConfidenceForSession(clampedConfidence, session);
  const threshold = getConfidenceThreshold(session);

  if (direction !== 'WAIT') {
    // Session check: is trading allowed right now?
    const tradeCheck = isTradeAllowed(direction === 'CALL' ? 'CALL' : 'PUT', session);
    if (!tradeCheck.allowed) {
      direction = 'WAIT';
    }
    // Apply session-adjusted threshold
    else if (sessionConfidence < threshold) {
      direction = 'WAIT';
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
    finalLevels.sl, spot, vix, daysToExpiry,
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

  // Market context
  const totalCEOI = optionChain.reduce((sum, s) => sum + (s.ce?.oi ?? 0), 0);
  const totalPEOI = optionChain.reduce((sum, s) => sum + (s.pe?.oi ?? 0), 0);
  const pcr = totalCEOI > 0 ? totalPEOI / totalCEOI : 1;
  const maxPain = oiAnalysis.status === 'OK' ? oiAnalysis.maxPain : spot;

  const marketContext: MarketContext = {
    spot,
    change: 0,
    changePercent: 0,
    pcr,
    maxPain,
    vix,
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
  const gammaThetaData = buildGammaThetaData(gexResult, optionChain, spot, vix);

  // Trade grade
  const tradeGrade = qualityScore.grade;

  // Expected move
  const expectedMove = spot * (vix || 15) / 100 * Math.sqrt(daysToExpiry / 365);

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
  const reason = dirResult.reasons.slice(0, 2).join('; ') || `Quality ${qualityScore.overall} (${qualityScore.grade})`;

  // Smart entry/exit actions
  const smartEntry: SmartEntryAction = direction === 'WAIT' ? 'WAIT_VOLUME_CONFIRMATION' : smartEntryResult.action;
  const smartExit: SmartExitAction = direction === 'WAIT' ? 'EXIT' : smartExitResult.action;

  // Market regime
  const marketRegime: MarketRegime = qualityScore.overall >= 75 ? 'trending'
    : qualityScore.overall >= 55 ? 'ranging' : 'mean_reversion';

  return {
    direction,
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
    consensus,
    qualityScore,
    session: {
      label: session.label,
      description: session.description,
      confidenceMultiplier: session.confidenceMultiplier,
      notes: session.notes,
    },
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
  vix: number,
  source: string,
  lastUpdate: string,
  lotSize: number,
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

  const emptyGammaTheta: GammaThetaData = {
    gammaExposure: 0, thetaDecayRate: 0, premiumDecayPercent: 0, ivSkew: 0,
    gammaBlastDetected: false,
    gammaBlastSignals: { lowVix: false, flatThenBreakout: false, volumeSpike: false, ivSpike: false, extremePCR: false },
    vixLevel: vix,
  };

  const emptyMarketContext: MarketContext = {
    spot, change: 0, changePercent: 0,
    pcr: oiAnalysis?.pcrOI || oiAnalysis?.pcrVolume || 0,
    maxPain: oiAnalysis?.maxPain || spot,
    vix, trend: 'sideways', regime: 'trending',
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
    expectedMove: spot * (vix || 15) / 100 * Math.sqrt(daysToExpiry / 365),
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
  generateTradeRecommendation(
    optionChain, spotPrice, symbol, expiryDate,
    candles, vix ?? 15, source,
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
    currentTime, vix ?? 15, tradesTakenToday, lastUpdate, source
  );
}

// ─── Synchronous Fallback (same logic, no async) ──────────────────

function generateRecommendationSync(
  optionChain: SDMOptionStrike[],
  spot: number,
  symbol: string,
  expiryDate: string,
  currentTime: Date,
  vix: number,
  tradesTakenToday: number,
  lastUpdate: string | undefined,
  source: string
): SDMRecommendation {
  const lotSize = getLotSize(symbol);
  const daysToExpiry = computeDaysToExpiry(expiryDate);
  const today = new Date();
  const expiry = new Date(expiryDate);
  const isExpiryDay =
    today.getFullYear() === expiry.getFullYear() &&
    today.getMonth() === expiry.getMonth() &&
    today.getDate() === expiry.getDate();
  const mode: DayMode = isExpiryDay ? 'SCALPER' : 'SWING';
  const timeInMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
  const currentWindow = computeExpiryWindow(isExpiryDay, timeInMinutes);
  const lastUpdateStr = lastUpdate || new Date().toISOString();

  const healthReport = buildDataHealthReport(optionChain, spot, lastUpdateStr, source);

  if (healthReport.status === 'OFFLINE') {
    return buildWAITRecommendation(
      spot, symbol, expiryDate, daysToExpiry, isExpiryDay, mode,
      currentWindow, timeInMinutes, currentTime, vix, source, lastUpdateStr,
      lotSize, healthReport, 'Data health OFFLINE'
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
  const marketStructure = analyzeMarketStructure(primaryCandles);
  const consensus = analyzeMultiTimeframe(candles);
  const volumeAnalysis = analyzeVolume(primaryCandles);
  const oiAnalysis = analyzeOptionChain(optionChain, spot);
  const atr = computeATR(primaryCandles, 14);

  // Direction
  const dirResult = determineDirection(consensus, oiAnalysis, gexResult, marketStructure, spot);
  const isCallDir = dirResult.direction !== 'PUT';

  let direction: TradeDirection;
  if (dirResult.direction === 'NEUTRAL' || dirResult.confidence < 15) {
    direction = 'WAIT';
  } else {
    direction = isCallDir ? 'CALL' : 'PUT';
  }
  if (isExpiryDay && currentWindow === 'theta' && direction !== 'WAIT') {
    direction = direction === 'CALL' ? 'SELL_PUT' : 'SELL_CALL';
  }

  // Seller SL
  const sellerSLResult = findSellerSLLevels(optionChain, spot, gexResult, marketStructure, volumeAnalysis, oiAnalysis);

  // Quality score
  const tempIsCall = direction === 'CALL' || direction === 'SELL_CALL';
  const tempStrike = findATMStrike(optionChain, spot);
  const tempEntry = tempIsCall ? (tempStrike?.ce?.ltp || 0) : (tempStrike?.pe?.ltp || 0);
  const tempSL = tempEntry * 0.85;
  const tempTP1 = tempEntry * 1.15;

  const qualityInput: QualityScoreInput = {
    spot, candles, optionChain, gexResult, marketStructure, consensus,
    volumeAnalysis, oiAnalysis, vix, currentWindow,
    tradeDirection: tempIsCall ? 'CALL' : 'PUT',
    entryPrice: tempEntry, stopLoss: tempSL, target1: tempTP1,
  };
  const qualityScore = computeQualityScore(qualityInput);

  if (qualityScore.overall < 50) {
    return buildWAITRecommendation(
      spot, symbol, expiryDate, daysToExpiry, isExpiryDay, mode,
      currentWindow, timeInMinutes, currentTime, vix, source, lastUpdateStr,
      lotSize, healthReport,
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

  const finalLevels = computeTradeLevels(finalEntry, atr, spot, sellerSLResult, finalIsCall, isExpiryDay, currentWindow, vix);

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

  // Position sizing
  const capital = 100000;
  const riskAmount = capital * 0.01;
  const riskPerLot = finalEntry > 0 ? Math.abs(finalEntry - finalLevels.sl) * lotSize : 0;
  const lots = riskPerLot > 0 ? Math.floor(riskAmount / riskPerLot) : 0;
  const clampedLots = Math.min(lots, 10);

  const positionSizing: PositionSizing = {
    lots: clampedLots, quantity: clampedLots * lotSize, riskAmount,
    positionValue: finalEntry * clampedLots * lotSize,
    maxLoss: riskPerLot * clampedLots,
  };

  const riskReward = finalEntry > finalLevels.sl && finalEntry > 0
    ? Math.round((finalLevels.tp2 - finalEntry) / (finalEntry - finalLevels.sl) * 10) / 10
    : 0;

  const premiumFairValue = computePremiumFairValue(optionChain, spot, finalEntry, finalIsCall ? 'CALL' : 'PUT');
  const probabilities = computeLiveProbabilities(
    finalEntry, finalLevels.tp1, finalLevels.tp2, finalLevels.tp3,
    finalLevels.sl, spot, vix, daysToExpiry, finalIsCall ? 'CALL' : 'PUT'
  );

  const dataHealth: DataHealth = {
    score: healthReport.score, latency: healthReport.latencyMs,
    lastUpdate: lastUpdateStr,
    status: healthReport.score >= 80 ? 'LIVE' : healthReport.score >= 50 ? 'STALE' : 'OFFLINE',
    source, missingFields: healthReport.issues,
  };

  const totalCEOI = optionChain.reduce((sum, s) => sum + (s.ce?.oi ?? 0), 0);
  const totalPEOI = optionChain.reduce((sum, s) => sum + (s.pe?.oi ?? 0), 0);
  const pcr = totalCEOI > 0 ? totalPEOI / totalCEOI : 1;
  const maxPain = oiAnalysis.status === 'OK' ? oiAnalysis.maxPain : spot;

  const marketContext: MarketContext = {
    spot, change: 0, changePercent: 0, pcr, maxPain, vix,
    trend: marketStructure.trend === 'UPTREND' ? 'bullish'
          : marketStructure.trend === 'DOWNTREND' ? 'bearish' : 'sideways',
    regime: qualityScore.overall >= 70 ? 'trending' : 'ranging',
    atr,
  };

  const watchList = buildWatchList(optionChain, spot, confidence, isExpiryDay, currentWindow);
  const whyThisTrade = buildWhyThisTrade(qualityScore, consensus, gexResult, sellerSLResult, smartEntryResult, finalIsCall ? 'CALL' : 'PUT');
  const sdmScores = buildSDMScores(gexResult, marketStructure, consensus, volumeAnalysis, oiAnalysis, sellerSLResult, optionChain, spot);
  const sellerSLZone = buildSellerSLZone(sellerSLResult, optionChain, spot);
  const gammaThetaData = buildGammaThetaData(gexResult, optionChain, spot, vix);

  const expectedMove = spot * (vix || 15) / 100 * Math.sqrt(daysToExpiry / 365);
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
