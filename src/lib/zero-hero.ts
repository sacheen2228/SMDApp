// Zero Hero Engine
// Dedicated high-risk strategy for experienced users
// Only activated when explicitly enabled by the user
// Requires stricter confirmation than standard trades
// Supports F&O weekly / monthly expiry + BTST (Buy Today Sell Tomorrow) for all stocks

import type { SDMOptionStrike, SDMRecommendation, TradeDirection } from '@/types/sdm';
import { isFNO, getExpiryTypeForDate, getStandardizedExpiry, StandardizedExpiry } from '@/lib/expiry-calculator';
import { analyzeOptionChain } from '@/lib/sdm-oianalysis';
import { detectGammaBlast, getGammaBlastBoost } from '@/lib/gamma-blast';
import { calculateGreeks } from '@/lib/greeks';
import { calculatePositionSize } from '@/lib/risk-management';
import { analyzeMarketStructure } from '@/lib/market-structure';
import { analyzeVolume } from '@/lib/volume-analysis';

export type ZHMode = 'expiry' | 'btst';

export interface ZeroHeroConfig {
  enabled: boolean;
  maxCapitalPerTrade: number;    // Max capital per ZH trade
  minQualityScore: number;       // Minimum quality score (higher than normal)
  minConfidence: number;         // Minimum confidence (higher than normal)
  minRiskReward: number;         // Minimum R:R ratio
  requireVolumeConfirm: boolean; // Require volume confirmation
  requireSpreadCheck: boolean;   // Require tight spread check
  maxSpreadPercent: number;      // Max bid-ask spread %
  mode: ZHMode;                  // 'expiry' = F&O weekly/monthly, 'btst' = buy-today-sell-tomorrow
}

export const DEFAULT_ZERO_HERO_CONFIG: ZeroHeroConfig = {
  enabled: false,
  maxCapitalPerTrade: 25000,
  minQualityScore: 70,
  minConfidence: 65,
  minRiskReward: 2.5,
  requireVolumeConfirm: true,
  requireSpreadCheck: true,
  maxSpreadPercent: 5,
  mode: 'expiry',
};

export interface ZeroHeroSignal {
  eligible: boolean;
  direction: 'CALL' | 'PUT' | 'LONG' | 'SHORT' | null;
  strike: number;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  confidence: number;
  riskReward: number;
  mode: ZHMode;
  expiryType: 'weekly' | 'monthly' | 'btst' | null;
  reasons: string[];
  warnings: string[];
  premiumMetrics: {
    spread: number;
    spreadPercent: number;
    volume: number;
    oi: number;
    iv: number;
  };
}

// ─── Evaluate Zero Hero Eligibility (F&O weekly / monthly expiry) ──
export function evaluateZeroHero(
  optionChain: SDMOptionStrike[],
  spot: number,
  direction: 'CALL' | 'PUT',
  qualityScore: number,
  confidence: number,
  config: ZeroHeroConfig = DEFAULT_ZERO_HERO_CONFIG,
  symbol?: string
): ZeroHeroSignal {
  const result: ZeroHeroSignal = {
    eligible: false,
    direction: null,
    strike: 0,
    entry: 0,
    sl: 0,
    tp1: 0,
    tp2: 0,
    confidence: 0,
    riskReward: 0,
    mode: 'expiry',
    expiryType: null,
    reasons: [],
    warnings: [],
    premiumMetrics: { spread: 0, spreadPercent: 0, volume: 0, oi: 0, iv: 0 },
  };

  if (!config.enabled) {
    result.warnings.push('Zero Hero is disabled. Enable in settings.');
    return result;
  }

  // Determine expiry type for the symbol (weekly / monthly)
  if (symbol && isFNO(symbol)) {
    const et = getExpiryTypeForDate(symbol);
    if (et) {
      result.expiryType = et;
      result.reasons.push(`F&O ${et} expiry — ${symbol}`);
    } else if (config.mode === 'expiry') {
      result.warnings.push(`${symbol} is not expiring today — no expiry trade`);
      return result;
    }
  } else if (config.mode === 'expiry') {
    result.warnings.push(`${symbol || 'symbol'} is not F&O — switch to BTST mode`);
    return result;
  }

  // Find ATM strike
  const atm = optionChain.reduce((best, s) =>
    Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best
  );
  if (!atm) {
    result.warnings.push('No ATM strike found');
    return result;
  }

  const leg = direction === 'CALL' ? atm.ce : atm.pe;
  if (!leg || leg.ltp <= 0) {
    result.warnings.push('ATM leg has no data');
    return result;
  }

  // Check quality score threshold
  if (qualityScore < config.minQualityScore) {
    result.warnings.push(`Quality score ${qualityScore} below ZH minimum ${config.minQualityScore}`);
    return result;
  }

  // Check confidence threshold
  if (confidence < config.minConfidence) {
    result.warnings.push(`Confidence ${confidence}% below ZH minimum ${config.minConfidence}%`);
    return result;
  }

  // Check spread
  const bid = leg.bid || 0;
  const ask = leg.ask || 0;
  const spread = ask > 0 && bid > 0 ? ask - bid : 0;
  const midPrice = (ask + bid) / 2 || leg.ltp;
  const spreadPercent = midPrice > 0 ? (spread / midPrice) * 100 : 0;

  result.premiumMetrics = {
    spread,
    spreadPercent: Math.round(spreadPercent * 10) / 10,
    volume: leg.volume,
    oi: leg.oi,
    iv: leg.iv,
  };

  if (config.requireSpreadCheck && spreadPercent > config.maxSpreadPercent) {
    result.warnings.push(`Spread ${spreadPercent.toFixed(1)}% exceeds max ${config.maxSpreadPercent}%`);
    return result;
  }

  // Check volume
  if (config.requireVolumeConfirm && leg.volume < 100) {
    result.warnings.push(`Volume ${leg.volume} too low for ZH entry`);
    return result;
  }

  // Calculate ZH-specific levels
  const entry = leg.ltp;
  const sl = entry * 0.80;  // Tighter SL for ZH (20% vs normal 15%)
  const tp1 = entry * 1.50; // Higher TP1 target
  const tp2 = entry * 2.50; // Aggressive TP2
  const riskReward = entry > sl ? (tp2 - entry) / (entry - sl) : 0;

  if (riskReward < config.minRiskReward) {
    result.warnings.push(`R:R ${riskReward.toFixed(1)} below ZH minimum ${config.minRiskReward}`);
    return result;
  }

  // All checks passed
  result.eligible = true;
  result.direction = direction;
  result.strike = atm.strike;
  result.entry = entry;
  result.sl = sl;
  result.tp1 = tp1;
  result.tp2 = tp2;
  result.confidence = Math.min(confidence + 5, 95); // Slight boost for ZH
  result.riskReward = Math.round(riskReward * 10) / 10;
  result.reasons.push(`ZH eligible: quality ${qualityScore}, confidence ${confidence}%, R:R 1:${riskReward.toFixed(1)}`);
  result.reasons.push(`Spread ${spreadPercent.toFixed(1)}%, volume ${leg.volume}, IV ${leg.iv.toFixed(1)}%`);

  return result;
}

// ─── BTST (Buy Today Sell Tomorrow) — high accuracy equity mode ───
export interface BTSTInput {
  symbol: string;
  spot: number;            // current price
  rsi: number;             // 14-period RSI
  macdHistogram: number;   // MACD histogram (momentum)
  volumeRatio: number;     // current volume / avg volume
  adx: number;             // trend strength
  sectorStrength: number;  // -100..100 sector momentum
  newsScore: number;       // -100..100 news sentiment
  aboveVWAP: boolean;      // price above VWAP
  changePct: number;       // day change %
}

export function evaluateBTST(
  inp: BTSTInput,
  config: ZeroHeroConfig = DEFAULT_ZERO_HERO_CONFIG
): ZeroHeroSignal {
  const result: ZeroHeroSignal = {
    eligible: false,
    direction: null,
    strike: 0,
    entry: inp.spot,
    sl: 0,
    tp1: 0,
    tp2: 0,
    confidence: 0,
    riskReward: 0,
    mode: 'btst',
    expiryType: 'btst',
    reasons: [],
    warnings: [],
    premiumMetrics: { spread: 0, spreadPercent: 0, volume: 0, oi: 0, iv: 0 },
  };

  if (!config.enabled) {
    result.warnings.push('Zero Hero is disabled. Enable in settings.');
    return result;
  }

  // BTST only applies to non-F&O stocks (equity delivery style) or any stock on non-expiry
  // Score components (each 0-100), high accuracy gate
  let score = 0;
  const parts: string[] = [];

  // 1. Momentum: RSI in healthy uptrend zone (45-70 ideal for BTST)
  if (inp.rsi >= 45 && inp.rsi <= 72) {
    const rsiScore = inp.rsi >= 55 ? 100 : 70;
    score += rsiScore * 0.20;
    parts.push(`RSI ${inp.rsi.toFixed(0)} ✓`);
  } else if (inp.rsi > 72) {
    score += 30 * 0.20; // overbought — penalize
    parts.push(`RSI ${inp.rsi.toFixed(0)} overbought`);
  } else {
    score += 0;
    parts.push(`RSI ${inp.rsi.toFixed(0)} weak`);
  }

  // 2. MACD momentum (histogram positive = bullish)
  const macdScore = inp.macdHistogram > 0 ? Math.min(100, 50 + inp.macdHistogram * 10) : 10;
  score += macdScore * 0.20;
  parts.push(`MACD ${inp.macdHistogram >= 0 ? '+' : ''}${inp.macdHistogram.toFixed(2)}`);

  // 3. Volume confirmation (>= 1.5x average)
  const volScore = Math.min(100, (inp.volumeRatio / 2) * 100);
  score += volScore * 0.15;
  parts.push(`Vol ${inp.volumeRatio.toFixed(1)}x`);

  // 4. Trend strength (ADX >= 20)
  const adxScore = inp.adx >= 20 ? Math.min(100, 40 + inp.adx) : 20;
  score += adxScore * 0.15;
  parts.push(`ADX ${inp.adx.toFixed(0)}`);

  // 5. Sector strength
  const sectorScore = Math.max(0, Math.min(100, 50 + inp.sectorStrength / 2));
  score += sectorScore * 0.15;
  parts.push(`Sector ${inp.sectorStrength >= 0 ? '+' : ''}${inp.sectorStrength.toFixed(0)}`);

  // 6. News sentiment
  const newsScore = Math.max(0, Math.min(100, 50 + inp.newsScore / 2));
  score += newsScore * 0.15;
  parts.push(`News ${inp.newsScore >= 0 ? '+' : ''}${inp.newsScore.toFixed(0)}`);

  const confidence = Math.round(score);

  // High-accuracy gate: require multiple confluences
  const bullish =
    inp.rsi >= 45 &&
    inp.macdHistogram > 0 &&
    inp.volumeRatio >= 1.3 &&
    inp.adx >= 20 &&
    inp.aboveVWAP &&
    inp.sectorStrength > 0 &&
    inp.newsScore > 0;

  if (!bullish) {
    result.warnings.push('BTST requires confluence: RSI↑ + MACD↑ + Vol↑ + ADX↑ + VWAP↑ + Sector↑ + News↑');
    result.confidence = confidence;
    return result;
  }

  if (confidence < config.minConfidence) {
    result.warnings.push(`BTST confidence ${confidence}% below min ${config.minConfidence}%`);
    result.confidence = confidence;
    return result;
  }

  // BTST levels: tight SL below VWAP / day low, TP next session
  const entry = inp.spot;
  const sl = entry * 0.985;        // 1.5% stop (overnight gap protection)
  const tp1 = entry * 1.02;        // ~2% target next morning (R:R ~1.3)
  const tp2 = entry * 1.04;        // ~4% extended target
  const riskReward = entry > sl ? (tp1 - entry) / (entry - sl) : 0;

  if (riskReward < 1) {
    result.warnings.push(`BTST R:R ${riskReward.toFixed(1)} too low`);
    result.confidence = confidence;
    return result;
  }

  result.eligible = true;
  result.direction = 'LONG';
  result.entry = entry;
  result.sl = sl;
  result.tp1 = tp1;
  result.tp2 = tp2;
  result.confidence = Math.min(confidence, 95);
  result.riskReward = Math.round(riskReward * 10) / 10;
  result.reasons.push(`BTST eligible: ${parts.join(' | ')}`);
  result.reasons.push(`Entry ₹${entry.toFixed(2)} → TP1 ₹${tp1.toFixed(2)} / TP2 ₹${tp2.toFixed(2)}, SL ₹${sl.toFixed(2)}`);

  return result;
}

// ─── Get Zero Hero Position Sizing ───────────────────────────────
export function getZeroHeroPositionSize(
  entry: number,
  sl: number,
  lotSize: number,
  config: ZeroHeroConfig = DEFAULT_ZERO_HERO_CONFIG
): { lots: number; quantity: number; maxLoss: number } {
  const riskPerLot = Math.abs(entry - sl) * lotSize;
  const lots = riskPerLot > 0 ? Math.floor(config.maxCapitalPerTrade / (riskPerLot * 2)) : 0;
  const clampedLots = Math.min(lots, 5); // Max 5 lots for ZH
  return {
    lots: clampedLots,
    quantity: clampedLots * lotSize,
    maxLoss: riskPerLot * clampedLots,
  };
}

// ─── Determine if a candidate should use expiry or BTST mode ──────
export function resolveZHMode(
  symbol: string,
  preferredMode: ZHMode = 'expiry'
): ZHMode {
  if (preferredMode === 'btst') return 'btst';
  // If symbol is not F&O, force BTST
  if (!isFNO(symbol)) return 'btst';
  // If not an expiry day, BTST is the only sensible mode
  if (!isFNO(symbol) || !getExpiryTypeForDate(symbol)) return 'btst';
  return 'expiry';
}

// ═══════════════════════════════════════════════════════════════════
// Consolidated Zero Hero evaluation (production path)
// Reuses existing engines instead of duplicating them:
//   greeks.ts · risk-management.ts · sdm-oianalysis.ts · gamma-blast.ts
//   market-structure.ts · volume-analysis.ts · expiry-calculator.ts
//
// This is the SINGLE evaluation path for the Zero Hero scanner
// (ZeroHeroTerminal.tsx → zhCandidates → FullZeroHero → Trade Audit).
// The earlier parallel implementation under src/lib/zero-hero-ai/* is
// DEPRECATED and will be removed after verification.
// ═══════════════════════════════════════════════════════════════════

export interface EngineResult {
  score: number;
  confidence: number;
  direction: 'CALL' | 'PUT' | 'NONE';
  reasons: string[];
}

export interface ZeroHeroChainContext {
  oiAnalysis: ReturnType<typeof analyzeOptionChain>;
  gammaBlastBoost: number;
  expiry: StandardizedExpiry | null;
  vix: number;
}

export interface ZeroHeroCandidateInput {
  strike: number;
  type: 'CE' | 'PE';
  ltp: number;
  delta: number;
  iv: number;            // percent
  oiChg: number;
  volume: number;
  spot: number;
  lotSize: number;
  capital: number;
  riskPerTradePercent: number;
  maxPositionSize: number;
  context: ZeroHeroChainContext;
  // Optional per-candidate SMC / volume signals (when candles are wired)
  smcBias?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  pocDistancePct?: number;     // (spot - POC)/spot
  cumulativeDelta?: number;
}

export interface ZeroHeroCandidateResult extends EngineResult {
  conf: number;          // 0-100 (maps to ZHCandidate.conf)
  prob: number;          // 0-100 probability of profit
  rr: number;            // risk:reward ratio
  sl: number;            // stop-loss premium
  tp1: number;           // target 1 premium
  tp2: number;           // target 2 premium
  stars: number;         // 1-5
  lots: number;
}

// Map terminal ChainRow[] → SDMOptionStrike[] for reuse of existing engines
function mapChainToSDM(chain: any[]): SDMOptionStrike[] {
  return chain.map((s) => ({
    strike: s.strike,
    ce: s.ce
      ? { ltp: s.ce.ltp, oi: s.ce.oi, oiChg: s.ce.oiChg, volume: s.ce.vol, iv: s.ce.iv, delta: s.ce.delta, theta: s.ce.theta, gamma: s.ce.gamma, vega: s.ce.vega }
      : null,
    pe: s.pe
      ? { ltp: s.pe.ltp, oi: s.pe.oi, oiChg: s.pe.oiChg, volume: s.pe.vol, iv: s.pe.iv, delta: s.pe.delta, theta: s.pe.theta, gamma: s.pe.gamma, vega: s.pe.vega }
      : null,
  }));
}

// Compute chain-wide context ONCE per scan (reuses sdm-oianalysis + gamma-blast + expiry-calculator)
export function analyzeZeroHeroChain(
  chain: any[],
  spot: number,
  vix: number,
  symbol: string,
  candles?: any[]
): ZeroHeroChainContext {
  const sdm = mapChainToSDM(chain);
  const oiAnalysis = analyzeOptionChain(sdm, spot);
  const gammaBlast = detectGammaBlast(sdm, spot, vix, candles);
  const gammaBlastBoost = getGammaBlastBoost(gammaBlast);
  const expiry = getStandardizedExpiry(symbol);
  return { oiAnalysis, gammaBlastBoost, expiry, vix };
}

// Evaluate a single CE/PE candidate — expiry-aware
// On expiry day, premium decays to zero for OTM strikes, SL must be tight, TP must be realistic.
export function evaluateZeroHeroCandidate(input: ZeroHeroCandidateInput): ZeroHeroCandidateResult {
  const { strike, type, ltp, delta, iv, oiChg, volume, spot, lotSize, capital, riskPerTradePercent, maxPositionSize, context } = input;
  const reasons: string[] = [];

  // Days to expiry from standardized expiry
  const daysToExpiry = context.expiry?.days_to_expiry ?? 1;
  const tte = Math.max(1 / 365, daysToExpiry / 365);
  const ivDecimal = iv > 0 ? iv / 100 : 0.15;
  const isExpiryDay = daysToExpiry < 1;
  const isExpiryEve = daysToExpiry <= 1;

  // ── Greeks (reuse greeks.ts) ──
  const g = calculateGreeks(spot, strike, tte, ivDecimal, type === 'CE');
  reasons.push(`Γ=${g.gamma.toFixed(4)} Θ=${g.theta.toFixed(1)} Δ=${g.delta.toFixed(2)}`);

  // ── Expiry day premium survival checks ──
  const distFromSpot = Math.abs(strike - spot);
  const isOTM = type === "CE" ? strike > spot : strike < spot;
  const strikesAway = Math.round(distFromSpot / 50); // NIFTY 50pt increments

  if (isExpiryDay || isExpiryEve) {
    reasons.push(`EXPIRY: ${daysToExpiry}d — premium decay extreme`);

    // OTM > 3 strikes on expiry day: premium already near zero, skip
    if (isOTM && strikesAway > 3) {
      return {
        score: 0, confidence: 0, direction: "NONE", reasons: [`OTM ${strikesAway} strikes away — premium will go to ZERO on expiry`],
        conf: 0, prob: 0, rr: 0, sl: ltp * 0.5, tp1: ltp, tp2: ltp, stars: 0, lots: 0,
      };
    }

    // Premium < ₹20 and OTM on expiry day: essentially zero
    if (isOTM && ltp < 20) {
      return {
        score: 0, confidence: 0, direction: "NONE", reasons: [`OTM premium ₹${ltp} — already near zero, further decay to ₹0`],
        conf: 0, prob: 0, rr: 0, sl: ltp * 0.5, tp1: ltp, tp2: ltp, stars: 0, lots: 0,
      };
    }
  }

  // ── Position sizing (reuse risk-management.ts) ──
  // Expiry day: tighter SL for buyers
  const slPct = isExpiryDay ? 0.25 : isExpiryEve ? 0.35 : 0.50;
  const slPremium = ltp * slPct;
  const pos = calculatePositionSize({
    capital,
    riskPerTradePercent,
    entryPremium: ltp,
    stopLossPremium: slPremium,
    lotSize,
    maxPositionSize,
  });
  const lots = pos.lots;

  // ── Confidence from existing engines (0-100) ──
  let conf = 0;

  // Delta proximity — on expiry day, only ATM/ITM have premium survival
  const absDelta = Math.abs(g.delta);
  if (isExpiryDay || isExpiryEve) {
    if (absDelta >= 0.45) conf += 25;      // Near ITM/ITM — premium survives
    else if (absDelta >= 0.30) conf += 12; // ATM-ish — partial survival
    else conf += 2;                         // OTM — premium going to zero
    reasons.push(absDelta >= 0.45 ? "Delta safe (ITM/ATM — premium survives)" : "Low delta — premium at risk");
  } else {
    if (absDelta >= 0.40 && absDelta <= 0.60) conf += 25;
    else if (absDelta >= 0.30 && absDelta <= 0.70) conf += 15;
    else conf += 5;
  }

  // ═══════════════════════════════════════════════════════════════
  // CORRECTED: OI change momentum — uses SIGNED direction, not abs()
  // CE: positive oiChg = buildup (bullish) → +points
  // CE: negative oiChg = unwinding (bearish) → -penalty
  // PE: positive oiChg = buildup (bearish for puts, actually negative) → -points
  // PE: negative oiChg = unwinding (bullish for puts) → +points
  // ═══════════════════════════════════════════════════════════════
  const isOiBullish = (type === "CE" && oiChg > 0) || (type === "PE" && oiChg < 0);
  const isOiBearish = (type === "CE" && oiChg < 0) || (type === "PE" && oiChg > 0);

  if (isOiBullish) {
    // OI buildup in the direction of the trade = strong conviction
    const oiBullScore = Math.min(25, (Math.abs(oiChg) / 50000) * 25);
    conf += oiBullScore;
    reasons.push(`OI +${Math.round(oiBullScore)} (${type==="CE"?"call":"put"} buildup +${Math.round(oiChg)})`);
  } else if (isOiBearish) {
    // OI unwinding or counter-directional = penalize
    const oiBearPenalty = Math.min(20, (Math.abs(oiChg) / 60000) * 20);
    conf -= oiBearPenalty;
    reasons.push(`OI -${Math.round(oiBearPenalty)} (counter-directional OI ${Math.round(oiChg)})`);
  } else {
    // Minimal / no OI change
    if (Math.abs(oiChg) < 500) {
      reasons.push("OI flat — no conviction");
    }
  }

  // PCR context adjustment: use the chain-wide PCR to bias direction
  const pcr = context.oiAnalysis.pcrOI;
  if (pcr > 0) {
    if (type === "CE" && pcr < 0.8) {
      conf += 8; reasons.push(`PCR ${pcr.toFixed(2)} (low — bullish, calls favored)`);
    } else if (type === "CE" && pcr > 1.3) {
      conf -= 8; reasons.push(`PCR ${pcr.toFixed(2)} (high — bearish, calls penalized)`);
    } else if (type === "PE" && pcr > 1.3) {
      conf += 8; reasons.push(`PCR ${pcr.toFixed(2)} (high — bearish, puts favored)`);
    } else if (type === "PE" && pcr < 0.8) {
      conf -= 8; reasons.push(`PCR ${pcr.toFixed(2)} (low — bullish, puts penalized)`);
    }
  }

  // Max pain alignment: if max pain is above spot, pinning up favors PE; below spot favors CE
  const maxPain = context.oiAnalysis.maxPain;
  if (maxPain > 0) {
    const mpDist = (maxPain - spot) / spot;
    if (type === "CE" && mpDist < -0.005) {
      conf += 5; reasons.push(`Max Pain ${maxPain} below spot — calls aligned`);
    } else if (type === "PE" && mpDist > 0.005) {
      conf += 5; reasons.push(`Max Pain ${maxPain} above spot — puts aligned`);
    } else if (type === "CE" && mpDist > 0.01) {
      conf -= 5; reasons.push(`Max Pain ${maxPain} far above — calls fighting pin`);
    } else if (type === "PE" && mpDist < -0.01) {
      conf -= 5; reasons.push(`Max Pain ${maxPain} far below — puts fighting pin`);
    }
  }

  // Volume confirmation — volume > 5000 confirms liquidity, not direction
  if (volume >= 5000) conf += 8;
  else if (volume >= 2000) conf += 4;
  else if (volume > 0) conf += 2;

  // IV rank context
  if (iv > 0 && iv < 60) conf += 10;

  // Gamma blast boost
  if (context.gammaBlastBoost > 0) {
    conf += context.gammaBlastBoost;
    reasons.push(`Gamma Blast +${context.gammaBlastBoost}`);
  }

  // SMC bias (optional)
  if (input.smcBias === 'BULLISH' && type === 'CE') { conf += 10; reasons.push('SMC bullish'); }
  if (input.smcBias === 'BEARISH' && type === 'PE') { conf += 10; reasons.push('SMC bearish'); }

  // Volume profile (optional)
  if (input.pocDistancePct !== undefined) {
    if (Math.abs(input.pocDistancePct) < 0.005) { conf += 5; reasons.push('Near POC'); }
  }

  // ── Theta penalty on expiry day ──
  // Theta burns 60-80% of remaining premium on expiry day
  // Higher theta = faster premium decay = lower confidence for buyers
  if (isExpiryDay || isExpiryEve) {
    const thetaPenalty = Math.min(30, Math.abs(g.theta) * 2);
    conf -= thetaPenalty;
    reasons.push(`Theta burn -${Math.round(thetaPenalty)} (₹${Math.abs(g.theta).toFixed(1)}/day decay)`);
  }

  conf = Math.max(0, Math.min(100, Math.round(conf)));

  // Probability of profit
  const prob = Math.min(95, Math.round(conf * 0.85 + absDelta * 10));

  // Risk:Reward — compute from actual SL and TP levels
  const sl = ltp * (1 - slPct);
  const tp1Mult = isExpiryDay ? 0.20 : isExpiryEve ? 0.30 : 0.50;
  const tp1 = ltp * (1 + tp1Mult);
  const tp2 = isExpiryDay ? ltp * (1 + 0.35) : isExpiryEve ? ltp * (1 + 0.50) : ltp * (1 + slPct * 3);
  const rr = Math.round((tp1 - ltp) / (ltp - sl) * 10) / 10;

  const stars = Math.max(1, Math.min(5, Math.round(conf / 20)));
  const direction: 'CALL' | 'PUT' | 'NONE' = type === 'CE' ? 'CALL' : 'PUT';

  // ── Expiry day special notes in reasons ──
  if (isExpiryDay) {
    reasons.push("⚠️ Expiry day: close by 2:30 PM, theta accelerates");
    reasons.push(`SL ${Math.round(slPct * 100)}% · TP +${Math.round(tp1Mult * 100)}% (tight expiry targets)`);
  }

  return {
    score: conf,
    confidence: conf,
    direction,
    reasons,
    conf,
    prob,
    rr,
    sl,
    tp1,
    tp2,
    stars,
    lots,
  };
}
