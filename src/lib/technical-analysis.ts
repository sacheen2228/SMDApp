// Technical Analysis Detection Engines
// Breakout, Pullback, Momentum, Breakdown detection with confirmation requirements
// Used by scanner, opportunities, heatmap, and trade setup cards

export interface TechnicalIndicators {
  // Price
  ltp: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  changePct: number;

  // Volume
  volume: number;
  avgVolume: number;
  relVolume: number;

  // Moving Averages
  vwap?: number;
  ema20?: number;
  ema50?: number;
  ema200?: number;
  sma20?: number;
  sma50?: number;
  sma200?: number;

  // Momentum
  rsi?: number;
  macd?: { macd: number; signal: number; histogram: number };
  stoch?: { k: number; d: number };

  // Volatility
  atr?: number;
  atrPct?: number;
  bbUpper?: number;
  bbLower?: number;
  bbMiddle?: number;

  // Support/Resistance
  dayHigh: number;
  dayLow: number;
  weekHigh52: number;
  weekLow52: number;
  prevDayHigh?: number;
  prevDayLow?: number;
  prevWeekHigh?: number;
  prevWeekLow?: number;
  swingHigh?: number;
  swingLow?: number;

  // F&O
  oi?: number;
  oiChange?: number;
  oiChangePct?: number;
  oiClassification?: string;

  // Sector/Market context
  sectorChangePct?: number;
  marketChangePct?: number;
  sectorStrength?: number;
  marketBreadth?: number;
}

export interface DetectionResult {
  detected: boolean;
  type: string;
  strength: "WEAK" | "MODERATE" | "STRONG" | "VERY_STRONG";
  confidence: number; // 0-100
  confirmations: string[];
  warnings: string[];
  entryZone?: { low: number; high: number };
  stopLoss?: number;
  targets?: number[];
  riskReward?: number;
  metadata?: Record<string, any>;
}

export interface ScanContext {
  marketRegime: "STRONG_BULLISH" | "BULLISH" | "NEUTRAL" | "BEARISH" | "STRONG_BEARISH" | "HIGH_VOLATILITY";
  marketBreadth: number; // 0-100
  vix: number;
  session: "PRE_OPEN" | "OPEN" | "REGULAR" | "POST_MARKET" | "CLOSED";
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round1(n: number): number { return Math.round(n * 10) / 10; }

function pctChange(current: number, base: number): number {
  if (base === 0) return 0;
  return round2(((current - base) / base) * 100);
}

function isNear(value: number, target: number, tolerancePct: number = 0.5): boolean {
  return Math.abs(value - target) / target * 100 <= tolerancePct;
}

function isAbove(value: number, target: number, bufferPct: number = 0): boolean {
  return value >= target * (1 + bufferPct / 100);
}

function isBelow(value: number, target: number, bufferPct: number = 0): boolean {
  return value <= target * (1 - bufferPct / 100);
}

// ============================================================
// BREAKOUT DETECTION ENGINE
// ============================================================

export function detectBreakout(data: TechnicalIndicators, context?: ScanContext): DetectionResult {
  const confirmations: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  // 1. Price above resistance level
  const resistanceLevels = [
    { level: data.dayHigh, name: "Day High", weight: 15 },
    { level: data.prevDayHigh || 0, name: "Previous Day High", weight: 20 },
    { level: data.prevWeekHigh || 0, name: "Previous Week High", weight: 25 },
    { level: data.weekHigh52, name: "52-Week High", weight: 30 },
    { level: data.bbUpper || 0, name: "Bollinger Band Upper", weight: 10 },
  ];

  let breakoutLevel = 0;
  let breakoutName = "";
  let breakoutWeight = 0;

  for (const r of resistanceLevels) {
    if (r.level > 0 && isAbove(data.ltp, r.level, 0.2)) {
      if (r.weight > breakoutWeight) {
        breakoutLevel = r.level;
        breakoutName = r.name;
        breakoutWeight = r.weight;
      }
    }
  }

  if (breakoutLevel === 0) {
    return { detected: false, type: "BREAKOUT", strength: "WEAK", confidence: 0, confirmations: [], warnings: ["No resistance breakout detected"] };
  }

  score += breakoutWeight;
  confirmations.push(`Price broke above ${breakoutName} (₹${round2(breakoutLevel)})`);

  // 2. Volume expansion
  if (data.relVolume >= 2) {
    score += 20;
    confirmations.push(`Volume expansion: ${data.relVolume.toFixed(1)}x avg`);
  } else if (data.relVolume >= 1.5) {
    score += 12;
    confirmations.push(`Above average volume: ${data.relVolume.toFixed(1)}x`);
  } else if (data.relVolume >= 1) {
    score += 5;
  } else {
    warnings.push("Weak volume on breakout - false breakout risk");
    score -= 10;
  }

  // 3. Candle confirmation - close near high
  const candleRange = data.high - data.low;
  if (candleRange > 0) {
    const closePosition = (data.ltp - data.low) / candleRange;
    if (closePosition > 0.75) {
      score += 15;
      confirmations.push("Strong close near high");
    } else if (closePosition > 0.5) {
      score += 8;
    } else {
      warnings.push("Close not near high - rejection risk");
      score -= 5;
    }
  }

  // 4. VWAP confirmation
  if (data.vwap && isAbove(data.ltp, data.vwap, 0.1)) {
    score += 10;
    confirmations.push("Above VWAP");
  } else if (data.vwap) {
    warnings.push("Below VWAP");
    score -= 5;
  }

  // 5. EMA structure
  let emaBullish = 0;
  if (data.ema20 && data.ltp > data.ema20) emaBullish++;
  if (data.ema50 && data.ltp > data.ema50) emaBullish++;
  if (data.ema200 && data.ltp > data.ema200) emaBullish++;
  if (data.ema20 && data.ema50 && data.ema20 > data.ema50) emaBullish++;
  if (data.ema50 && data.ema200 && data.ema50 > data.ema200) emaBullish++;

  if (emaBullish >= 4) {
    score += 15;
    confirmations.push("Strong EMA alignment");
  } else if (emaBullish >= 2) {
    score += 8;
    confirmations.push("EMA structure supportive");
  } else {
    warnings.push("EMA structure not bullish");
    score -= 5;
  }

  // 6. RSI confirmation
  if (data.rsi) {
    if (data.rsi > 50 && data.rsi < 75) {
      score += 8;
      confirmations.push(`RSI bullish at ${round1(data.rsi)}`);
    } else if (data.rsi >= 75) {
      warnings.push(`RSI overbought at ${round1(data.rsi)}`);
      score -= 5;
    } else {
      warnings.push(`RSI below 50 at ${round1(data.rsi)}`);
      score -= 5;
    }
  }

  // 7. Sector confirmation
  if (data.sectorChangePct && data.sectorChangePct > 0) {
    score += 8;
    confirmations.push(`Sector outperforming (${data.sectorChangePct >= 0 ? "+" : ""}${data.sectorChangePct}%)`);
  }

  // 8. Market regime alignment
  if (context) {
    if (context.marketRegime === "BULLISH" || context.marketRegime === "STRONG_BULLISH") {
      score += 8;
      confirmations.push(`Market regime: ${context.marketRegime}`);
    } else if (context.marketRegime === "BEARISH" || context.marketRegime === "STRONG_BEARISH") {
      warnings.push(`Market regime against: ${context.marketRegime}`);
      score -= 15;
    }
  }

  // 9. F&O confirmation
  if (data.oiClassification) {
    if (data.oiClassification === "LONG_BUILDUP") {
      score += 12;
      confirmations.push("F&O: Long Buildup");
    } else if (data.oiClassification === "SHORT_COVERING") {
      score += 8;
      confirmations.push("F&O: Short Covering");
    } else if (data.oiClassification === "SHORT_BUILDUP") {
      warnings.push("F&O: Short Buildup");
      score -= 10;
    } else if (data.oiClassification === "LONG_UNWINDING") {
      warnings.push("F&O: Long Unwinding");
      score -= 8;
    }
  }

  // 10. MACD confirmation
  if (data.macd && data.macd.macd > data.macd.signal && data.macd.histogram > 0) {
    score += 8;
    confirmations.push("MACD bullish crossover");
  }

  // Determine strength
  let strength: DetectionResult["strength"] = "WEAK";
  if (score >= 70) strength = "VERY_STRONG";
  else if (score >= 55) strength = "STRONG";
  else if (score >= 40) strength = "MODERATE";

  // Calculate entry, SL, targets
  const atr = data.atr || (data.high - data.low) || data.ltp * 0.015;
  const entryLow = Math.max(breakoutLevel, data.ltp * 0.998);
  const entryHigh = data.ltp * 1.005;
  const stopLoss = entryLow - atr * 1.2;
  const target1 = entryHigh + atr * 2;
  const target2 = entryHigh + atr * 3;
  const risk = entryHigh - stopLoss;
  const reward = target1 - entryHigh;
  const riskReward = risk > 0 ? round2(reward / risk) : 0;

  // Only return if minimum confirmations met
  if (score < 35) {
    return { detected: false, type: "BREAKOUT", strength, confidence: Math.max(0, score), confirmations, warnings };
  }

  return {
    detected: true,
    type: "BREAKOUT",
    strength,
    confidence: Math.min(100, Math.max(0, score)),
    confirmations,
    warnings,
    entryZone: { low: round2(entryLow), high: round2(entryHigh) },
    stopLoss: round2(stopLoss),
    targets: [round2(target1), round2(target2)],
    riskReward,
    metadata: { breakoutLevel, breakoutName, relVolume: data.relVolume, emaBullish },
  };
}

// ============================================================
// PULLBACK DETECTION ENGINE
// ============================================================

export function detectPullback(data: TechnicalIndicators, context?: ScanContext): DetectionResult {
  const confirmations: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  // Primary trend must be bullish
  const trendBullish = (data.ema20 && data.ltp > data.ema20) &&
    (data.ema50 && data.ltp > data.ema50) &&
    (data.ema20 && data.ema50 && data.ema20 > data.ema50);

  if (!trendBullish) {
    return { detected: false, type: "PULLBACK", strength: "WEAK", confidence: 0, confirmations: [], warnings: ["Primary trend not bullish"] };
  }

  score += 20;
  confirmations.push("Primary trend bullish (EMA20 > EMA50 > price)");

  // Pullback to support zones
  const supportZones = [
    { level: data.vwap || 0, name: "VWAP", weight: 20, tolerance: 0.5 },
    { level: data.ema20 || 0, name: "EMA 20", weight: 25, tolerance: 0.8 },
    { level: data.ema50 || 0, name: "EMA 50", weight: 20, tolerance: 1.0 },
    { level: data.prevDayLow || 0, name: "Previous Day Low", weight: 15, tolerance: 0.5 },
    { level: data.swingLow || 0, name: "Swing Low", weight: 10, tolerance: 0.5 },
  ];

  let pullbackLevel = 0;
  let pullbackName = "";
  let pullbackWeight = 0;

  for (const s of supportZones) {
    if (s.level > 0 && isNear(data.ltp, s.level, s.tolerance) && data.ltp >= s.level * 0.995) {
      if (s.weight > pullbackWeight) {
        pullbackLevel = s.level;
        pullbackName = s.name;
        pullbackWeight = s.weight;
      }
    }
  }

  if (pullbackLevel === 0) {
    return { detected: false, type: "PULLBACK", strength: "WEAK", confidence: 0, confirmations: [], warnings: ["No pullback to support zone detected"] };
  }

  score += pullbackWeight;
  confirmations.push(`Pullback to ${pullbackName} (₹${round2(pullbackLevel)})`);

  // Volume drying up on pullback
  if (data.relVolume < 0.8) {
    score += 15;
    confirmations.push("Volume drying up on pullback");
  } else if (data.relVolume < 1) {
    score += 8;
  } else {
    warnings.push("Volume not drying up");
    score -= 5;
  }

  // RSI recovery from oversold
  if (data.rsi !== undefined) {
    if (data.rsi > 40 && data.rsi < 60) {
      score += 10;
      confirmations.push(`RSI recovering at ${round1(data.rsi)}`);
    } else if (data.rsi < 40) {
      score += 5;
      confirmations.push(`RSI oversold bounce at ${round1(data.rsi)}`);
    } else if (data.rsi > 70) {
      warnings.push("RSI overbought - pullback may continue");
      score -= 10;
    }
  }

  // VWAP reclaim
  if (data.vwap && data.ltp > data.vwap && data.low < data.vwap) {
    score += 15;
    confirmations.push("VWAP reclaim during session");
  } else if (data.vwap && data.ltp > data.vwap) {
    score += 8;
    confirmations.push("Above VWAP");
  }

  // Bollinger Band lower band bounce
  if (data.bbLower && data.low <= data.bbLower * 1.005 && data.ltp > data.bbLower) {
    score += 10;
    confirmations.push("Bollinger Band lower band bounce");
  }

  // Sector confirmation
  if (data.sectorChangePct && data.sectorChangePct > 0) {
    score += 8;
    confirmations.push(`Sector supportive (${data.sectorChangePct >= 0 ? "+" : ""}${data.sectorChangePct}%)`);
  }

  // Market regime
  if (context && (context.marketRegime === "BULLISH" || context.marketRegime === "STRONG_BULLISH")) {
    score += 8;
    confirmations.push(`Market regime: ${context.marketRegime}`);
  }

  // F&O
  if (data.oiClassification === "LONG_BUILDUP" || data.oiClassification === "SHORT_COVERING") {
    score += 10;
    confirmations.push(`F&O: ${data.oiClassification}`);
  }

  let strength: DetectionResult["strength"] = "WEAK";
  if (score >= 70) strength = "VERY_STRONG";
  else if (score >= 55) strength = "STRONG";
  else if (score >= 40) strength = "MODERATE";

  if (score < 35) {
    return { detected: false, type: "PULLBACK", strength, confidence: Math.max(0, score), confirmations, warnings };
  }

  const atr = data.atr || (data.high - data.low) || data.ltp * 0.015;
  const entryLow = pullbackLevel * 0.998;
  const entryHigh = Math.min(pullbackLevel * 1.01, data.ltp * 1.005);
  const stopLoss = pullbackLevel - atr * 1.5;
  const target1 = data.ltp + atr * 2;
  const target2 = data.ltp + atr * 3;
  const riskReward = round2((target1 - entryHigh) / (entryHigh - stopLoss));

  return {
    detected: true,
    type: "PULLBACK",
    strength,
    confidence: Math.min(100, Math.max(0, score)),
    confirmations,
    warnings,
    entryZone: { low: round2(entryLow), high: round2(entryHigh) },
    stopLoss: round2(stopLoss),
    targets: [round2(target1), round2(target2)],
    riskReward,
    metadata: { pullbackLevel, pullbackName, relVolume: data.relVolume, rsi: data.rsi },
  };
}

// ============================================================
// MOMENTUM DETECTION ENGINE
// ============================================================

export function detectMomentum(data: TechnicalIndicators, context?: ScanContext): DetectionResult {
  const confirmations: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  // 1. Strong price acceleration
  if (data.changePct > 3) {
    score += 25;
    confirmations.push(`Strong momentum: ${data.changePct >= 0 ? "+" : ""}${data.changePct}%`);
  } else if (data.changePct > 1.5) {
    score += 15;
    confirmations.push(`Good momentum: ${data.changePct >= 0 ? "+" : ""}${data.changePct}%`);
  } else if (data.changePct > 0.5) {
    score += 8;
    confirmations.push(`Positive momentum: ${data.changePct >= 0 ? "+" : ""}${data.changePct}%`);
  } else {
    return { detected: false, type: "MOMENTUM", strength: "WEAK", confidence: 0, confirmations: [], warnings: ["Insufficient price momentum"] };
  }

  // 2. High relative volume
  if (data.relVolume >= 3) {
    score += 20;
    confirmations.push(`Explosive volume: ${data.relVolume.toFixed(1)}x avg`);
  } else if (data.relVolume >= 2) {
    score += 15;
    confirmations.push(`High relative volume: ${data.relVolume.toFixed(1)}x`);
  } else if (data.relVolume >= 1.5) {
    score += 10;
    confirmations.push(`Elevated volume: ${data.relVolume.toFixed(1)}x`);
  } else {
    warnings.push("Volume not confirming momentum");
    score -= 10;
  }

  // 3. Price above VWAP with distance
  if (data.vwap) {
    const vwapDist = pctChange(data.ltp, data.vwap);
    if (vwapDist > 1) {
      score += 12;
      confirmations.push(`Above VWAP by ${vwapDist}%`);
    } else if (vwapDist > 0) {
      score += 6;
      confirmations.push("Above VWAP");
    } else {
      warnings.push("Below VWAP");
      score -= 8;
    }
  }

  // 4. RSI momentum (not overbought yet)
  if (data.rsi !== undefined) {
    if (data.rsi > 55 && data.rsi < 75) {
      score += 12;
      confirmations.push(`RSI momentum at ${round1(data.rsi)}`);
    } else if (data.rsi >= 75) {
      warnings.push(`RSI overbought at ${round1(data.rsi)} - exhaustion risk`);
      score -= 8;
    } else if (data.rsi < 50) {
      warnings.push("RSI below 50");
      score -= 5;
    }
  }

  // 5. MACD acceleration
  if (data.macd && data.macd.histogram > 0 && data.macd.macd > data.macd.signal) {
    score += 10;
    confirmations.push("MACD accelerating");
  }

  // 6. Bollinger Band squeeze/expansion
  if (data.bbUpper && data.bbLower && data.bbMiddle) {
    const bbWidth = (data.bbUpper - data.bbLower) / data.bbMiddle;
    if (bbWidth > 0.05) {
      score += 5;
      confirmations.push("Bollinger Bands expanding");
    }
  }

  // 7. Price near day high
  if (data.dayHigh > data.dayLow) {
    const position = (data.ltp - data.dayLow) / (data.dayHigh - data.dayLow);
    if (position > 0.8) {
      score += 10;
      confirmations.push("Trading near day high");
    } else if (position > 0.6) {
      score += 5;
    }
  }

  // 8. Sector leadership
  if (data.sectorChangePct && data.sectorChangePct > data.marketChangePct!) {
    const outperformance = data.sectorChangePct - (data.marketChangePct || 0);
    if (outperformance > 1) {
      score += 10;
      confirmations.push(`Sector leader (+${outperformance}% vs market)`);
    } else if (outperformance > 0) {
      score += 5;
      confirmations.push("Sector outperforming market");
    }
  }

  // 9. Market regime
  if (context && (context.marketRegime === "BULLISH" || context.marketRegime === "STRONG_BULLISH")) {
    score += 8;
    confirmations.push(`Market regime: ${context.marketRegime}`);
  }

  // 10. F&O confirmation
  if (data.oiClassification === "LONG_BUILDUP") {
    score += 10;
    confirmations.push("F&O: Long Buildup");
  } else if (data.oiClassification === "SHORT_COVERING") {
    score += 6;
    confirmations.push("F&O: Short Covering");
  }

  let strength: DetectionResult["strength"] = "WEAK";
  if (score >= 75) strength = "VERY_STRONG";
  else if (score >= 60) strength = "STRONG";
  else if (score >= 45) strength = "MODERATE";

  if (score < 40) {
    return { detected: false, type: "MOMENTUM", strength, confidence: Math.max(0, score), confirmations, warnings };
  }

  const atr = data.atr || (data.high - data.low) || data.ltp * 0.015;
  const entryLow = data.ltp * 0.998;
  const entryHigh = data.ltp * 1.005;
  const stopLoss = data.ltp - atr * 1.5;
  const target1 = data.ltp + atr * 2;
  const target2 = data.ltp + atr * 3;
  const riskReward = round2((target1 - entryHigh) / (entryHigh - stopLoss));

  return {
    detected: true,
    type: "MOMENTUM",
    strength,
    confidence: Math.min(100, Math.max(0, score)),
    confirmations,
    warnings,
    entryZone: { low: round2(entryLow), high: round2(entryHigh) },
    stopLoss: round2(stopLoss),
    targets: [round2(target1), round2(target2)],
    riskReward,
    metadata: { changePct: data.changePct, relVolume: data.relVolume, rsi: data.rsi, vwapDist: data.vwap ? pctChange(data.ltp, data.vwap) : 0 },
  };
}

// ============================================================
// BREAKDOWN DETECTION ENGINE (inverse of breakout)
// ============================================================

export function detectBreakdown(data: TechnicalIndicators, context?: ScanContext): DetectionResult {
  // Mirror of breakout but for support breakdown
  const confirmations: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  const supportLevels = [
    { level: data.dayLow, name: "Day Low", weight: 15 },
    { level: data.prevDayLow || 0, name: "Previous Day Low", weight: 20 },
    { level: data.prevWeekLow || 0, name: "Previous Week Low", weight: 25 },
    { level: data.weekLow52, name: "52-Week Low", weight: 30 },
    { level: data.bbLower || 0, name: "Bollinger Band Lower", weight: 10 },
  ];

  let breakdownLevel = 0;
  let breakdownName = "";
  let breakdownWeight = 0;

  for (const s of supportLevels) {
    if (s.level > 0 && isBelow(data.ltp, s.level, 0.2)) {
      if (s.weight > breakdownWeight) {
        breakdownLevel = s.level;
        breakdownName = s.name;
        breakdownWeight = s.weight;
      }
    }
  }

  if (breakdownLevel === 0) {
    return { detected: false, type: "BREAKDOWN", strength: "WEAK", confidence: 0, confirmations: [], warnings: ["No support breakdown detected"] };
  }

  score += breakdownWeight;
  confirmations.push(`Price broke below ${breakdownName} (₹${round2(breakdownLevel)})`);

  // Volume expansion on breakdown
  if (data.relVolume >= 2) {
    score += 20;
    confirmations.push(`Volume expansion: ${data.relVolume.toFixed(1)}x`);
  } else if (data.relVolume >= 1.5) {
    score += 12;
  } else {
    warnings.push("Weak volume on breakdown");
    score -= 10;
  }

  // Close near low
  const candleRange = data.high - data.low;
  if (candleRange > 0) {
    const closePosition = (data.ltp - data.low) / candleRange;
    if (closePosition < 0.25) {
      score += 15;
      confirmations.push("Strong close near low");
    } else if (closePosition < 0.5) {
      score += 8;
    } else {
      warnings.push("Close not near low");
      score -= 5;
    }
  }

  // Below VWAP
  if (data.vwap && isBelow(data.ltp, data.vwap)) {
    score += 10;
    confirmations.push("Below VWAP");
  }

  // EMA structure bearish
  let emaBearish = 0;
  if (data.ema20 && data.ltp < data.ema20) emaBearish++;
  if (data.ema50 && data.ltp < data.ema50) emaBearish++;
  if (data.ema200 && data.ltp < data.ema200) emaBearish++;
  if (data.ema20 && data.ema50 && data.ema20 < data.ema50) emaBearish++;

  if (emaBearish >= 3) {
    score += 15;
    confirmations.push("Bearish EMA alignment");
  } else if (emaBearish >= 2) {
    score += 8;
  } else {
    warnings.push("EMA structure not bearish");
    score -= 5;
  }

  // RSI
  if (data.rsi !== undefined) {
    if (data.rsi < 45 && data.rsi > 25) {
      score += 8;
      confirmations.push(`RSI bearish at ${round1(data.rsi)}`);
    } else if (data.rsi <= 25) {
      score += 5;
      confirmations.push(`RSI oversold at ${round1(data.rsi)}`);
    } else {
      warnings.push("RSI not bearish");
      score -= 5;
    }
  }

  // Market regime
  if (context && (context.marketRegime === "BEARISH" || context.marketRegime === "STRONG_BEARISH")) {
    score += 8;
    confirmations.push(`Market regime: ${context.marketRegime}`);
  }

  // F&O
  if (data.oiClassification === "SHORT_BUILDUP" || data.oiClassification === "LONG_UNWINDING") {
    score += 10;
    confirmations.push(`F&O: ${data.oiClassification}`);
  }

  let strength: DetectionResult["strength"] = "WEAK";
  if (score >= 70) strength = "VERY_STRONG";
  else if (score >= 55) strength = "STRONG";
  else if (score >= 40) strength = "MODERATE";

  if (score < 35) {
    return { detected: false, type: "BREAKDOWN", strength, confidence: Math.max(0, score), confirmations, warnings };
  }

  const atr = data.atr || (data.high - data.low) || data.ltp * 0.015;
  const entryHigh = Math.min(breakdownLevel, data.ltp * 1.002);
  const entryLow = data.ltp * 0.995;
  const stopLoss = entryHigh + atr * 1.2;
  const target1 = entryLow - atr * 2;
  const target2 = entryLow - atr * 3;
  const riskReward = round2((entryLow - target1) / (stopLoss - entryLow));

  return {
    detected: true,
    type: "BREAKDOWN",
    strength,
    confidence: Math.min(100, Math.max(0, score)),
    confirmations,
    warnings,
    entryZone: { low: round2(entryLow), high: round2(entryHigh) },
    stopLoss: round2(stopLoss),
    targets: [round2(target1), round2(target2)],
    riskReward,
    metadata: { breakdownLevel, breakdownName, relVolume: data.relVolume },
  };
}

// ============================================================
// REVERSAL DETECTION ENGINE
// ============================================================

export function detectReversal(data: TechnicalIndicators, context?: ScanContext): DetectionResult {
  const confirmations: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  // Bullish reversal (downtrend to uptrend)
  const isDowntrend = data.ema20 && data.ema50 && data.ema20 < data.ema50 && data.ltp < data.ema20;
  const isUptrend = data.ema20 && data.ema50 && data.ema20 > data.ema50 && data.ltp > data.ema20;

  // Hammer/Doji at support
  const bodySize = Math.abs(data.ltp - data.open);
  const lowerWick = data.open < data.ltp ? data.open - data.low : data.ltp - data.low;
  const upperWick = data.open > data.ltp ? data.open - data.high : data.ltp - data.high;

  if (isDowntrend && lowerWick > bodySize * 2 && upperWick < bodySize * 0.5) {
    score += 25;
    confirmations.push("Hammer candle at support");
  } else if (isUptrend && upperWick > bodySize * 2 && lowerWick < bodySize * 0.5) {
    score += 25;
    confirmations.push("Shooting star at resistance");
  } else {
    return { detected: false, type: "REVERSAL", strength: "WEAK", confidence: 0, confirmations: [], warnings: ["No reversal candle pattern"] };
  }

  // RSI divergence (simplified - would need historical data for real divergence)
  if (data.rsi !== undefined) {
    if (isDowntrend && data.rsi < 35) {
      score += 10;
      confirmations.push(`RSI oversold at ${round1(data.rsi)}`);
    } else if (isUptrend && data.rsi > 65) {
      score += 10;
      confirmations.push(`RSI overbought at ${round1(data.rsi)}`);
    }
  }

  // Volume spike on reversal
  if (data.relVolume >= 2) {
    score += 15;
    confirmations.push(`Volume spike: ${data.relVolume.toFixed(1)}x`);
  }

  // VWAP reclaim/rejection
  if (data.vwap) {
    if (isDowntrend && data.ltp > data.vwap) {
      score += 12;
      confirmations.push("VWAP reclaim");
    } else if (isUptrend && data.ltp < data.vwap) {
      score += 12;
      confirmations.push("VWAP rejection");
    }
  }

  // Bollinger Band bounce
  if (data.bbLower && isDowntrend && data.low <= data.bbLower * 1.005 && data.ltp > data.bbLower) {
    score += 10;
    confirmations.push("Lower Bollinger Band bounce");
  } else if (data.bbUpper && isUptrend && data.high >= data.bbUpper * 0.995 && data.ltp < data.bbUpper) {
    score += 10;
    confirmations.push("Upper Bollinger Band rejection");
  }

  let strength: DetectionResult["strength"] = "WEAK";
  if (score >= 65) strength = "VERY_STRONG";
  else if (score >= 50) strength = "STRONG";
  else if (score >= 35) strength = "MODERATE";

  if (score < 30) {
    return { detected: false, type: "REVERSAL", strength, confidence: Math.max(0, score), confirmations, warnings };
  }

  const atr = data.atr || (data.high - data.low) || data.ltp * 0.015;
  const entry = data.ltp;
  const stopLoss = isDowntrend ? data.low - atr * 0.5 : data.high + atr * 0.5;
  const target1 = isDowntrend ? data.ltp + atr * 2 : data.ltp - atr * 2;
  const target2 = isDowntrend ? data.ltp + atr * 3 : data.ltp - atr * 3;
  const riskReward = round2(Math.abs(target1 - entry) / Math.abs(entry - stopLoss));

  return {
    detected: true,
    type: "REVERSAL",
    strength,
    confidence: Math.min(100, Math.max(0, score)),
    confirmations,
    warnings,
    entryZone: { low: round2(entry * 0.998), high: round2(entry * 1.002) },
    stopLoss: round2(stopLoss),
    targets: [round2(target1), round2(target2)],
    riskReward,
    metadata: { direction: isDowntrend ? "BULLISH" : "BEARISH", candleType: lowerWick > bodySize * 2 ? "HAMMER" : "SHOOTING_STAR" },
  };
}

// ============================================================
// MASTER SCANNER - runs all detectors and returns best setup
// ============================================================

export interface ScanResult {
  symbol: string;
  name: string;
  ltp: number;
  changePct: number;
  volume: number;
  relVolume: number;
  sector: string;
  bestSetup: DetectionResult | null;
  allSetups: DetectionResult[];
  overallScore: number;
  entryState: "WATCH" | "CONFIRMING" | "CONFIRMED" | "INVALIDATED";
}

export function scanStock(data: TechnicalIndicators, context?: ScanContext): ScanResult {
  const breakout = detectBreakout(data, context);
  const pullback = detectPullback(data, context);
  const momentum = detectMomentum(data, context);
  const breakdown = detectBreakdown(data, context);
  const reversal = detectReversal(data, context);

  const allSetups = [breakout, pullback, momentum, breakdown, reversal].filter(s => s.detected);
  const bestSetup = allSetups.length > 0
    ? allSetups.reduce((best, current) => current.confidence > best.confidence ? current : best)
    : null;

  // Calculate overall score
  const overallScore = allSetups.length > 0
    ? Math.round(allSetups.reduce((sum, s) => sum + s.confidence, 0) / allSetups.length)
    : 0;

  // Determine entry state
  let entryState: ScanResult["entryState"] = "WATCH";
  if (bestSetup) {
    if (bestSetup.confidence >= 75 && bestSetup.warnings.length === 0) {
      entryState = "CONFIRMED";
    } else if (bestSetup.confidence >= 55 && bestSetup.warnings.length <= 1) {
      entryState = "CONFIRMING";
    } else if (bestSetup.warnings.length > 2 || bestSetup.confidence < 35) {
      entryState = "INVALIDATED";
    }
  }

  return {
    symbol: "",
    name: "",
    ltp: data.ltp,
    changePct: data.changePct,
    volume: data.volume,
    relVolume: data.relVolume,
    sector: data.sector || "",
    bestSetup,
    allSetups,
    overallScore,
    entryState,
  };
}

// ============================================================
// FALSE BREAKOUT PROTECTION
// ============================================================

export function checkFalseBreakoutRisk(data: TechnicalIndicators, setup: DetectionResult): {
  risk: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  reasons: string[];
} {
  const reasons: string[] = [];

  // Weak volume
  if (data.relVolume < 1) {
    reasons.push("Volume below average");
  }

  // Extended candle (too far from open)
  const bodySize = Math.abs(data.ltp - data.open);
  const candleRange = data.high - data.low;
  if (candleRange > 0 && bodySize / candleRange < 0.3) {
    reasons.push("Candle mostly wicks - extended move");
  }

  // Spread too wide (would need bid/ask data)
  // Skip for now

  // Market strongly against
  if (context && (
    (setup.type === "BREAKOUT" && (context.marketRegime === "BEARISH" || context.marketRegime === "STRONG_BEARISH")) ||
    (setup.type === "BREAKDOWN" && (context.marketRegime === "BULLISH" || context.marketRegime === "STRONG_BULLISH"))
  )) {
    reasons.push("Market regime strongly against trade direction");
  }

  // Sector weak
  if (data.sectorChangePct && (
    (setup.type === "BREAKOUT" && data.sectorChangePct < -1) ||
    (setup.type === "BREAKDOWN" && data.sectorChangePct > 1)
  )) {
    reasons.push("Sector moving against trade");
  }

  // Price immediately falling back below breakout
  // Would need tick data - skip for now

  // RSI extreme
  if (data.rsi && (
    (setup.type === "BREAKOUT" && data.rsi > 80) ||
    (setup.type === "BREAKDOWN" && data.rsi < 20)
  )) {
    reasons.push("RSI at extreme level - exhaustion risk");
  }

  let risk: "LOW" | "MODERATE" | "HIGH" | "CRITICAL" = "LOW";
  if (reasons.length >= 3) risk = "CRITICAL";
  else if (reasons.length === 2) risk = "HIGH";
  else if (reasons.length === 1) risk = "MODERATE";

  return { risk, reasons };
}

// ============================================================
// F&O OI CLASSIFICATION ENGINE
// ============================================================

export type OIClassification = 
  | "LONG_BUILDUP" 
  | "SHORT_BUILDUP" 
  | "SHORT_COVERING" 
  | "LONG_UNWINDING" 
  | "NEUTRAL";

export interface OIAnalysis {
  classification: OIClassification;
  strength: "WEAK" | "MODERATE" | "STRONG";
  description: string;
  bullishScore: number; // -100 to +100
}

export function classifyOI(data: {
  priceChangePct: number;
  oiChangePct: number;
  volumeChangePct?: number;
  callOIChangePct?: number;
  putOIChangePct?: number;
  pcr?: number;
  pcrChange?: number;
}): OIAnalysis {
  const { priceChangePct, oiChangePct, volumeChangePct, callOIChangePct, putOIChangePct, pcr, pcrChange } = data;

  let classification: OIClassification = "NEUTRAL";
  let bullishScore = 0;

  // Core classification logic
  // Price UP + OI UP = Long Buildup (Bullish)
  // Price DOWN + OI UP = Short Buildup (Bearish)
  // Price UP + OI DOWN = Short Covering (Bullish)
  // Price DOWN + OI DOWN = Long Unwinding (Bearish)

  if (priceChangePct > 0.3 && oiChangePct > 5) {
    classification = "LONG_BUILDUP";
    bullishScore = 60;
  } else if (priceChangePct > 0.3 && oiChangePct > 0) {
    classification = "LONG_BUILDUP";
    bullishScore = 40;
  } else if (priceChangePct < -0.3 && oiChangePct > 5) {
    classification = "SHORT_BUILDUP";
    bullishScore = -60;
  } else if (priceChangePct < -0.3 && oiChangePct > 0) {
    classification = "SHORT_BUILDUP";
    bullishScore = -40;
  } else if (priceChangePct > 0.3 && oiChangePct < -5) {
    classification = "SHORT_COVERING";
    bullishScore = 50;
  } else if (priceChangePct > 0.3 && oiChangePct < 0) {
    classification = "SHORT_COVERING";
    bullishScore = 30;
  } else if (priceChangePct < -0.3 && oiChangePct < -5) {
    classification = "LONG_UNWINDING";
    bullishScore = -50;
  } else if (priceChangePct < -0.3 && oiChangePct < 0) {
    classification = "LONG_UNWINDING";
    bullishScore = -30;
  } else {
    classification = "NEUTRAL";
    bullishScore = 0;
  }

  // Strength based on magnitude
  let strength: OIAnalysis["strength"] = "WEAK";
  const oiMagnitude = Math.abs(oiChangePct);
  if (oiMagnitude > 20) strength = "STRONG";
  else if (oiMagnitude > 10) strength = "MODERATE";

  // Volume confirmation
  if (volumeChangePct !== undefined) {
    if (classification === "LONG_BUILDUP" && volumeChangePct > 20) bullishScore += 10;
    if (classification === "SHORT_BUILDUP" && volumeChangePct > 20) bullishScore -= 10;
    if (classification === "SHORT_COVERING" && volumeChangePct > 20) bullishScore += 5;
    if (classification === "LONG_UNWINDING" && volumeChangePct > 20) bullishScore -= 5;
  }

  // PCR confirmation
  if (pcr !== undefined && pcrChange !== undefined) {
    if (classification === "LONG_BUILDUP" && pcrChange > 0) bullishScore += 5;
    if (classification === "SHORT_BUILDUP" && pcrChange < 0) bullishScore -= 5;
    if (classification === "SHORT_COVERING" && pcrChange > 0) bullishScore += 5;
    if (classification === "LONG_UNWINDING" && pcrChange < 0) bullishScore -= 5;
  }

  // Call/Put OI breakdown
  if (callOIChangePct !== undefined && putOIChangePct !== undefined) {
    if (classification === "LONG_BUILDUP" && callOIChangePct > putOIChangePct) bullishScore += 5;
    if (classification === "SHORT_BUILDUP" && putOIChangePct > callOIChangePct) bullishScore -= 5;
  }

  // Cap score
  bullishScore = Math.max(-100, Math.min(100, bullishScore));

  const descriptions: Record<OIClassification, string> = {
    LONG_BUILDUP: "Fresh longs added - price rising with OI increase",
    SHORT_BUILDUP: "Fresh shorts added - price falling with OI increase",
    SHORT_COVERING: "Shorts covering - price rising with OI decrease",
    LONG_UNWINDING: "Longs exiting - price falling with OI decrease",
    NEUTRAL: "No clear OI signal",
  };

  return {
    classification,
    strength,
    description: descriptions[classification],
    bullishScore,
  };
}

// ============================================================
// OPTION CHAIN ANALYSIS
// ============================================================

export interface OptionChainAnalysis {
  pcr: number;
  pcrChange: number;
  maxPain: number;
  maxPainDistance: number; // % from spot
  atmIV: number;
  ivRank?: number;
  callOI: number;
  putOI: number;
  callOIChange: number;
  putOIChange: number;
  atmStrike: number;
  supportStrikes: number[];   // High Put OI strikes
  resistanceStrikes: number[]; // High Call OI strikes
  ivSkew: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  interpretation: string;
}

export function analyzeOptionChain(data: {
  spot: number;
  atmStrike: number;
  strikes: Array<{
    strike: number;
    callOI: number;
    putOI: number;
    callOIChange: number;
    putOIChange: number;
    callIV: number;
    putIV: number;
    callVolume: number;
    putVolume: number;
  }>;
}): OptionChainAnalysis {
  const { spot, atmStrike, strikes } = data;

  // Total OI
  const totalCallOI = strikes.reduce((sum, s) => sum + s.callOI, 0);
  const totalPutOI = strikes.reduce((sum, s) => sum + s.putOI, 0);
  const totalCallOIChange = strikes.reduce((sum, s) => sum + s.callOIChange, 0);
  const totalPutOIChange = strikes.reduce((sum, s) => sum + s.putOIChange, 0);

  const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;
  const pcrChange = totalCallOIChange !== 0 ? totalPutOIChange / totalCallOIChange : 0;

  // Max Pain calculation
  let maxPain = atmStrike;
  let minPain = Infinity;
  for (const s of strikes) {
    let pain = 0;
    for (const t of strikes) {
      if (t.strike > s.strike) {
        pain += (t.strike - s.strike) * t.callOI;
      } else if (t.strike < s.strike) {
        pain += (s.strike - t.strike) * t.putOI;
      }
    }
    if (pain < minPain) {
      minPain = pain;
      maxPain = s.strike;
    }
  }

  const maxPainDistance = ((maxPain - spot) / spot) * 100;

  // ATM IV
  const atmStrikeData = strikes.find(s => s.strike === atmStrike);
  const atmIV = atmStrikeData ? (atmStrikeData.callIV + atmStrikeData.putIV) / 2 : 0;

  // Support/Resistance from OI clusters
  const sortedByPutOI = [...strikes].sort((a, b) => b.putOI - a.putOI);
  const sortedByCallOI = [...strikes].sort((a, b) => b.callOI - a.callOI);
  const supportStrikes = sortedByPutOI.slice(0, 3).map(s => s.strike);
  const resistanceStrikes = sortedByCallOI.slice(0, 3).map(s => s.strike);

  // IV Skew
  const otmCalls = strikes.filter(s => s.strike > spot).slice(0, 3);
  const otmPuts = strikes.filter(s => s.strike < spot).slice(-3);
  const avgCallIV = otmCalls.length ? otmCalls.reduce((sum, s) => sum + s.callIV, 0) / otmCalls.length : 0;
  const avgPutIV = otmPuts.length ? otmPuts.reduce((sum, s) => sum + s.putIV, 0) / otmPuts.length : 0;
  let ivSkew: OptionChainAnalysis["ivSkew"] = "NEUTRAL";
  if (avgPutIV > avgCallIV * 1.1) ivSkew = "POSITIVE"; // Put IV higher - bearish skew
  else if (avgCallIV > avgPutIV * 1.1) ivSkew = "NEGATIVE"; // Call IV higher - bullish skew

  // Interpretation
  let interpretation = "";
  if (pcr > 1.3) interpretation += "High PCR - Put heavy, potential support. ";
  else if (pcr < 0.7) interpretation += "Low PCR - Call heavy, potential resistance. ";
  else interpretation += "PCR neutral. ";

  if (maxPainDistance > 1) interpretation += `Max Pain (${maxPain}) above spot - upward gravity. `;
  else if (maxPainDistance < -1) interpretation += `Max Pain (${maxPain}) below spot - downward gravity. `;
  else interpretation += `Max Pain at ${maxPain} near spot. `;

  if (ivSkew === "POSITIVE") interpretation += "Put IV premium - downside protection demand. ";
  else if (ivSkew === "NEGATIVE") interpretation += "Call IV premium - upside speculation. ";

  return {
    pcr,
    pcrChange,
    maxPain,
    maxPainDistance: Math.round(maxPainDistance * 100) / 100,
    atmIV,
    callOI: totalCallOI,
    putOI: totalPutOI,
    callOIChange: totalCallOIChange,
    putOIChange: totalPutOIChange,
    atmStrike,
    supportStrikes,
    resistanceStrikes,
    ivSkew,
    interpretation,
  };
}

// ============================================================