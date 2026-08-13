// ─── Rule-Based Signal Engine ─────────────────────────────────────
// Decision-support tool, NOT investment advice.
// All thresholds are tunable constants at the top of this file.

// ═══════════════════════════════════════════════════════════════════
// TUNABLE CONSTANTS
// ═══════════════════════════════════════════════════════════════════

export const SIGNAL_CONFIG = {
  // Delta band — ideal premium-to-probability trade-off zone
  DELTA_MIN: 0.35,
  DELTA_MAX: 0.60,
  DELTA_LOTTERY: 0.15,     // below this = lottery ticket
  DELTA_LEVERAGE_MAX: 0.85, // above this = too deep ITM, low leverage

  // IV percentile — flag strikes where IV is elevated vs recent range
  IV_HIGH_PCT: 70,  // percentile above which premium is "expensive"

  // PCR / Max Pain skew thresholds
  PCR_BEARISH: 1.1,   // above this, bias puts
  PCR_BULLISH: 0.9,   // below this, bias calls

  // OI trend interpretation
  OI_SIGNIFICANT: 20000,  // minimum absolute OI change to register

  // Stop-loss / target multiples
  SL_PREMIUM_PCT: 0.30,   // 30% of premium
  TARGET1_MULTIPLE: 1.5,  // 1.5x risk
  TARGET2_MULTIPLE: 2.5,  // 2.5x risk

  // Cap target move by Max Pain distance (max % of implied max move)
  MAX_TARGET_MOVE_PCT: 0.15,

  // Confidence weights
  WEIGHT_OI: 30,
  WEIGHT_DELTA: 25,
  WEIGHT_IV: 15,
  WEIGHT_PCR: 20,
  WEIGHT_NEWS: 10,
} as const;

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export type SignalDirection = "BUY_CE" | "BUY_PE" | "NEUTRAL";

export interface StrikeSignal {
  strike: number;
  direction: SignalDirection;
  confidence: number;       // 0-100
  reason: string;           // 1-2 line summary
  ce: LegSignal | null;
  pe: LegSignal | null;
}

export interface LegSignal {
  direction: "BUY" | "NEUTRAL" | "AVOID";
  confidence: number;
  reason: string;
  oiScore: number;
  deltaScore: number;
  ivScore: number;
}

export interface SuggestedTrade {
  strike: number;
  type: "CE" | "PE";
  direction: SignalDirection;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  rr: number;
  confidence: number;
  reason: string;
}

export interface NewsSentiment {
  score: number;           // -100 to +100
  headlines: NewsHeadline[];
  lastUpdated: string;
}

export interface NewsHeadline {
  text: string;
  sentiment: "bullish" | "bearish" | "neutral";
  score: number;  // -3 to +3
}

// ═══════════════════════════════════════════════════════════════════
// NEWS KEYWORD DICTIONARY — easy to extend
// ═══════════════════════════════════════════════════════════════════

export const BULLISH_KEYWORDS = [
  "beats estimates", "rate cut", "FII buying", "bullish", "upgrade",
  "positive", "growth", "expansion", "surplus", "rally", "outperform",
  "strong demand", "record high", "buy signal", "oversold",
  "government stimulus", "capex push", "recovery", "upgraded",
  "breakout", "accumulate", "margin expansion",
];

export const BEARISH_KEYWORDS = [
  "misses estimates", "selloff", "geopolitical tension", "bearish",
  "downgrade", "negative", "slowdown", "deficit", "crash", "underperform",
  "weak demand", "record low", "sell signal", "overbought",
  "rate hike", "inflation", "recession", "default", "sanctions",
  "volatility", "uncertainty", "profit warning", "downside",
];

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function scoreOI(oiChg: number, ltp: number, prevLtp: number): { score: number; label: string } {
  const absChg = Math.abs(oiChg);
  if (absChg < SIGNAL_CONFIG.OI_SIGNIFICANT) return { score: 0, label: "OI flat" };

  const priceUp = ltp > prevLtp;
  const oiUp = oiChg > 0;

  if (oiUp && priceUp) {
    // Long buildup — bullish for this leg
    const score = clamp((absChg / 100000) * 30, 0, 30);
    return { score, label: "Long buildup" };
  }
  if (oiUp && !priceUp) {
    // Short buildup — bearish for this leg
    const score = clamp((absChg / 100000) * 25, 0, 25);
    return { score: -score, label: "Short buildup" };
  }
  if (!oiUp && priceUp) {
    // Short covering — mildly bullish
    const score = clamp((absChg / 100000) * 20, 0, 20);
    return { score, label: "Short covering" };
  }
  // Long unwinding — mildly bearish
  const score = clamp((absChg / 100000) * 15, 0, 15);
  return { score: -score, label: "Long unwinding" };
}

function scoreDelta(delta: number): { score: number; label: string } {
  const absD = Math.abs(delta);
  if (absD >= SIGNAL_CONFIG.DELTA_MIN && absD <= SIGNAL_CONFIG.DELTA_MAX) {
    return { score: 25, label: `Δ ${absD.toFixed(2)} (ideal band)` };
  }
  if (absD < SIGNAL_CONFIG.DELTA_LOTTERY) {
    return { score: 0, label: `Δ ${absD.toFixed(2)} (lottery zone)` };
  }
  if (absD > SIGNAL_CONFIG.DELTA_LEVERAGE_MAX) {
    return { score: 5, label: `Δ ${absD.toFixed(2)} (deep ITM)` };
  }
  return { score: 12, label: `Δ ${absD.toFixed(2)}` };
}

function scoreIV(iv: number): { score: number; label: string } {
  if (iv <= 0) return { score: 0, label: "IV N/A" };
  // IV > ~70th percentile = expensive premium
  if (iv > 60) return { score: -15, label: `IV ${iv.toFixed(1)}% (elevated)` };
  if (iv > 45) return { score: 0, label: `IV ${iv.toFixed(1)}% (normal)` };
  return { score: 10, label: `IV ${iv.toFixed(1)}% (low)` };
}

// ═══════════════════════════════════════════════════════════════════
// 1. SIGNAL ENGINE — per-strike composite
// ═══════════════════════════════════════════════════════════════════

export function evaluateStrikeSignal(
  strike: number,
  spot: number,
  atmStrike: number,
  maxPain: number,
  pcr: number,
  ceLtp: number,
  ceOi: number,
  ceOiChg: number,
  ceIv: number,
  ceDelta: number,
  cePrevLtp: number,
  peLtp: number,
  peOi: number,
  peOiChg: number,
  peIv: number,
  peDelta: number,
  pePrevLtp: number,
  newsScore: number = 0
): StrikeSignal {
  const reasons: string[] = [];

  // ── CE score ──
  const ceOI = scoreOI(ceOiChg, ceLtp, cePrevLtp);
  const ceDeltaS = scoreDelta(ceDelta);
  const ceIV = scoreIV(ceIv);
  let ceConf = ceOI.score + ceDeltaS.score + ceIV.score;
  let ceReason = ceOI.label + " · " + ceDeltaS.label + " · " + ceIV.label;

  // ── PE score ──
  const peOI = scoreOI(peOiChg, peLtp, pePrevLtp);
  const peDeltaS = scoreDelta(peDelta);
  const peIV = scoreIV(peIv);
  let peConf = peOI.score + peDeltaS.score + peIV.score;
  let peReason = peOI.label + " · " + peDeltaS.label + " · " + peIV.label;

  // ── PCR / Max Pain skew ──
  const spotAboveMaxPain = spot > maxPain;
  const spotBelowMaxPain = spot < maxPain;
  const trendUp = ceLtp > cePrevLtp; // rough price direction proxy

  if (pcr < SIGNAL_CONFIG.PCR_BULLISH && spotBelowMaxPain && trendUp) {
    ceConf += 20;
    reasons.push("PCR < 0.9 + below Max Pain + trending up → bias calls");
  }
  if (pcr > SIGNAL_CONFIG.PCR_BEARISH && spotAboveMaxPain && !trendUp) {
    peConf += 20;
    reasons.push("PCR > 1.1 + above Max Pain + trending down → bias puts");
  }

  // ── News impact ──
  if (newsScore > 20) { ceConf += 10; reasons.push("Positive news → call bias"); }
  if (newsScore < -20) { peConf += 10; reasons.push("Negative news → put bias"); }

  ceConf = clamp(ceConf, 0, 100);
  peConf = clamp(peConf, 0, 100);

  // Determine final direction
  let direction: SignalDirection = "NEUTRAL";
  let confidence = 0;
  let reason = "No clear signal";

  const diff = ceConf - peConf;
  if (diff > 15 && ceConf >= 45) {
    direction = "BUY_CE";
    confidence = ceConf;
    reason = "Bullish: " + ceReason + (reasons.length ? " | " + reasons[0] : "");
  } else if (diff < -15 && peConf >= 45) {
    direction = "BUY_PE";
    confidence = peConf;
    reason = "Bearish: " + peReason + (reasons.length ? " | " + reasons[0] : "");
  } else {
    confidence = Math.max(ceConf, peConf);
    reason = "Neutral — no dominant edge" + (reasons.length ? " | " + reasons[0] : "");
  }

  return {
    strike,
    direction,
    confidence,
    reason,
    ce: { direction: ceConf >= 50 ? "BUY" : ceConf >= 30 ? "NEUTRAL" : "AVOID", confidence: ceConf, reason: ceReason, oiScore: ceOI.score, deltaScore: ceDeltaS.score, ivScore: ceIV.score },
    pe: { direction: peConf >= 50 ? "BUY" : peConf >= 30 ? "NEUTRAL" : "AVOID", confidence: peConf, reason: peReason, oiScore: peOI.score, deltaScore: peDeltaS.score, ivScore: peIV.score },
  };
}

// ═══════════════════════════════════════════════════════════════════
// 2. STRIKE + PREMIUM SUGGESTION
// ═══════════════════════════════════════════════════════════════════

export function suggestTrade(
  signals: StrikeSignal[],
  chainData: any[],
  spot: number,
  maxPain: number,
): SuggestedTrade | null {
  const best = signals
    .filter(s => s.direction !== "NEUTRAL" && s.confidence >= 40)
    .sort((a, b) => b.confidence - a.confidence)[0];

  if (!best) return null;

  const type = best.direction === "BUY_CE" ? "CE" : "PE";
  const isPut = type === "PE";
  const row = chainData.find((r: any) => r.strike === best.strike);
  const leg = row?.[type === "CE" ? "ce" : "pe"];
  if (!leg || !leg.ltp) return null;

  const entry = leg.ltp;
  const delta = Math.abs(leg.delta || 0.4);
  const slPremium = Math.max(entry * SIGNAL_CONFIG.SL_PREMIUM_PCT, 5);
  // For both CALL and PUT buys: premium falls when underlying moves against us
  // CALL: spot↓ → premium↓ → SL below entry
  // PUT:  spot↑ → premium↓ → SL below entry
  const sl = entry - slPremium;
  const risk = Math.abs(entry - sl);

  // Cap target by Max Pain distance
  const maxPainDist = Math.abs(best.strike - maxPain);
  const maxMove = maxPainDist * SIGNAL_CONFIG.MAX_TARGET_MOVE_PCT;

  // For both CALL and PUT buys: premium rises when underlying moves in our direction
  // CALL: spot↑ → premium↑ → TP above entry
  // PUT:  spot↓ → premium↑ → TP above entry
  const tp1Raw = entry + risk * SIGNAL_CONFIG.TARGET1_MULTIPLE;
  const tp2Raw = entry + risk * SIGNAL_CONFIG.TARGET2_MULTIPLE;
  const cappedTp1 = Math.min(tp1Raw, entry + maxMove);
  const cappedTp2 = Math.min(tp2Raw, entry + maxMove * 1.5);

  const rr = risk > 0 ? Math.abs(cappedTp1 - entry) / risk : 0;

  return {
    strike: best.strike,
    type,
    direction: best.direction,
    entry: Math.round(entry * 100) / 100,
    sl: Math.round(sl * 100) / 100,
    tp1: Math.round(cappedTp1 * 100) / 100,
    tp2: Math.round(cappedTp2 * 100) / 100,
    rr: Math.round(rr * 10) / 10,
    confidence: best.confidence,
    reason: best.reason,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 3. NEWS SENTIMENT — keyword-based heuristic
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// ATR (Average True Range) — used by smc-engine & canonical.ts
// ═══════════════════════════════════════════════════════════════════

export function calculateATR(
  candles: { high: number; low: number; close: number }[],
  period: number = 14
): number {
  if (!candles?.length) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  if (trs.length === 0) return 0;
  const usePeriod = Math.min(period, trs.length);
  const recent = trs.slice(-usePeriod);
  return recent.reduce((s, v) => s + v, 0) / recent.length;
}

export function analyzeNewsSentiment(headlines: string[]): NewsSentiment {
  let totalScore = 0;
  const results: NewsHeadline[] = [];

  for (const text of headlines) {
    const lower = text.toLowerCase();
    let sentiment: "bullish" | "bearish" | "neutral" = "neutral";
    let score = 0;

    for (const kw of BULLISH_KEYWORDS) {
      if (lower.includes(kw)) { score += 1; }
    }
    for (const kw of BEARISH_KEYWORDS) {
      if (lower.includes(kw)) { score -= 1; }
    }

    if (score > 0) sentiment = "bullish";
    else if (score < 0) sentiment = "bearish";

    totalScore += score;
    results.push({ text, sentiment, score: clamp(score, -3, 3) });
  }

  // Normalize total to -100..+100
  const normalized = headlines.length > 0
    ? clamp(Math.round((totalScore / headlines.length) * 50), -100, 100)
    : 0;

  return {
    score: normalized,
    headlines: results,
    lastUpdated: new Date().toISOString(),
  };
}
