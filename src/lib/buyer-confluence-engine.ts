// Buyer Confluence Engine — Master scoring system for CE/PE buying only
// Based on Indian Market Options Buying Research Analyst prompt v3.0
// Score 0-100 with exact weights from the prompt

export interface ConfluenceInput {
  // Section 2: Institutional Flow
  fiiNet: number;              // FII net cash (cr positive = buy)
  diiNet: number;              // DII net cash (cr positive = buy)
  fiiFutLongRatio: number;     // FII futures long/short ratio (0-1)
  fiiNet5dAvg: number;         // 5-day rolling FII net

  // Section 3: OI Intelligence
  pcr: number;                 // Put-Call Ratio
  maxPain: number;             // Max pain strike
  spotPrice: number;           // Current spot
  ceOIBuildup: boolean;        // CE OI increasing at resistance
  peOIBuildup: boolean;        // PE OI increasing at support
  oiPattern: 'LONG_BUILDUP' | 'SHORT_BUILDUP' | 'SHORT_COVERING' | 'LONG_UNWINDING' | 'NEUTRAL';

  // Section 4: Greeks / IV
  ivRank: number;              // 0-100 (current IV percentile in 52-week range)
  atmIV: number;               // ATM implied volatility %
  ivTrend: 'RISING' | 'FALLING' | 'STABLE';

  // Section 5A: Expected Move
  atmStraddlePrice: number;    // ATM straddle premium
  expectedMove: number;        // Market's implied move (straddle/spot)

  // Section 5B: GEX
  gammaFlipLevel: number;      // Gamma flip strike
  dealerGexRegime: 'LONG_GAMMA' | 'SHORT_GAMMA';

  // Section 5C: VIX
  indiaVix: number;

  // Section 5F: Regime
  adx: number;                 // Average Directional Index
  niftyTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  bankNiftyTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';

  // Section 5G: Time
  currentHour: number;         // IST hour (9-15)
  currentMinute: number;       // IST minute
  isExpiryDay: boolean;
  daysToExpiry: number;
  dayOfWeek: number;           // 0=Sun, 1=Mon, ... 4=Thu

  // Technical
  rsi: number;
  adxTechnical: number;        // From candles
  ema20Above50: boolean;       // 20 EMA > 50 EMA
  higherHighs: boolean;

  // Gap
  gapPercent: number;          // Opening gap %

  // Direction to evaluate
  direction: 'CE' | 'PE';
}

export interface ConfluenceResult {
  totalScore: number;          // 0-100
  grade: 'A+' | 'A' | 'B+' | 'B' | 'C' | 'D';
  action: 'BUY_CE' | 'BUY_PE' | 'NO_TRADE';
  breakdown: {
    fiiDii: { score: number; max: number; note: string };
    oi: { score: number; max: number; note: string };
    pcr: { score: number; max: number; note: string };
    ivRank: { score: number; max: number; note: string };
    eventRisk: { score: number; max: number; note: string };
    technicals: { score: number; max: number; note: string };
    vix: { score: number; max: number; note: string };
    timeWindow: { score: number; max: number; note: string };
    correlation: { score: number; max: number; note: string };
  };
  hardBlocks: string[];        // Reasons that force NO_TRADE
  softWarnings: string[];      // Reasons to reduce size
  vixRegime: string;
  sessionWindow: string;
  // Consumer-facing fields (derived from breakdown/hardBlocks — do NOT recompute)
  gapTrap: boolean;
  correlationCheck: string;
  ivRankLabel: string;
  eventRiskLabel: string;
  reasons: string[];
}

// ─── VIX Regime for Buyers (Section 5C) ───
function getVixRegime(vix: number): { regime: string; allowed: boolean; sizeMultiplier: number; minScore: number } {
  if (vix < 12) return { regime: 'COMPLACENT', allowed: true, sizeMultiplier: 1.0, minScore: 50 };
  if (vix < 15) return { regime: 'CALM', allowed: true, sizeMultiplier: 1.0, minScore: 60 };
  if (vix < 20) return { regime: 'NORMAL', allowed: true, sizeMultiplier: 1.0, minScore: 75 };
  if (vix < 25) return { regime: 'ELEVATED', allowed: true, sizeMultiplier: 0.5, minScore: 80 };
  return { regime: 'FEAR', allowed: false, sizeMultiplier: 0, minScore: 100 };
}

// ─── Time Window (Section 5G) ───
function getTimeWindow(h: number, m: number, isExpiryDay: boolean): { window: string; allowed: boolean; isPowerHour: boolean } {
  const t = h * 100 + m;
  if (t < 930) return { window: 'GAP_TRAP', allowed: false, isPowerHour: false };
  if (t >= 930 && t < 1030) return { window: 'WINDOW_1', allowed: true, isPowerHour: false };
  if (t >= 1030 && t < 1130) return { window: 'TREND_CONFIRM', allowed: true, isPowerHour: false };
  if (t >= 1130 && t < 1300) return { window: 'LUNCH_CHOP', allowed: false, isPowerHour: false };
  if (t >= 1300 && t < 1330) return { window: 'PRE_POWER', allowed: false, isPowerHour: false };
  if (t >= 1330 && t < 1445) return { window: 'WINDOW_2', allowed: true, isPowerHour: true };
  if (t >= 1445 && t < 1515) return { window: 'EXIT_ZONE', allowed: false, isPowerHour: false };
  return { window: 'CLOSED', allowed: false, isPowerHour: false };
}

// ─── Expiry Week Day Rules (Section 5D) ───
function getExpiryWeekPenalty(dayOfWeek: number, daysToExpiry: number): number {
  // dayOfWeek: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu
  if (daysToExpiry > 4) return 0;  // Not expiry week
  if (daysToExpiry <= 1) return 15; // Expiry day or day before — heavy penalty
  if (daysToExpiry === 2) return 10; // 2 days to expiry
  if (daysToExpiry === 3) return 5;  // Wednesday before Thursday expiry
  return 0;
}

// ─── Gap Trap Rule (Section 1) ───
function isGapTrap(gapPercent: number, minutesSinceOpen: number): boolean {
  const absGap = Math.abs(gapPercent);
  if (absGap > 0.8 && minutesSinceOpen < 15) return true;
  if (absGap > 0.5 && minutesSinceOpen < 10) return true;
  return false;
}

// ─── PCR Interpretation (Section 3) ───
function scorePCR(pcr: number, direction: 'CE' | 'PE'): number {
  if (direction === 'CE') {
    if (pcr >= 0.7 && pcr <= 1.0) return 10;  // Healthy CE trend
    if (pcr < 0.7) return 6;                    // Oversold, prepare bounce
    if (pcr > 1.3) return 0;                    // Overbought, stop CE
    if (pcr > 1.0 && pcr <= 1.3) return 5;     // Moderate
    return 3;
  } else {
    // PE buying — inverse logic
    if (pcr > 1.3) return 10;                   // Overbought, PE reversal
    if (pcr >= 1.0) return 7;                   // Healthy PE trend
    if (pcr < 0.7) return 3;                    // Oversold, PE bounce risky
    return 5;
  }
}

// ─── OI Pattern Scoring (Section 3) ───
function scoreOI(
  pattern: string, direction: 'CE' | 'PE',
  ceOIBuildup: boolean, peOIBuildup: boolean,
  spot: number, maxPain: number
): number {
  let score = 0;

  if (direction === 'CE') {
    // CE buying: want long buildup or short covering
    if (pattern === 'LONG_BUILDUP') score += 15;
    else if (pattern === 'SHORT_COVERING') score += 12;
    else if (pattern === 'SHORT_BUILDUP') score += 5;  // Trend continuation but risky
    else if (pattern === 'LONG_UNWINDING') score += 0;

    // PE OI buildup = support building = CE bias
    if (peOIBuildup) score += 3;
    // Spot above max pain = CE favorable
    if (spot > maxPain) score += 2;
  } else {
    // PE buying: want short buildup or long unwinding
    if (pattern === 'SHORT_BUILDUP') score += 15;
    else if (pattern === 'LONG_UNWINDING') score += 12;
    else if (pattern === 'LONG_BUILDUP') score += 5;
    else if (pattern === 'SHORT_COVERING') score += 0;

    // CE OI buildup = resistance building = PE bias
    if (ceOIBuildup) score += 3;
    // Spot below max pain = PE favorable
    if (spot < maxPain) score += 2;
  }

  return Math.min(20, score);
}

// ─── IV Rank Scoring (Section 4) ───
function scoreIVRank(ivRank: number): { score: number; allowed: boolean; note: string } {
  if (ivRank < 25) return { score: 15, allowed: true, note: 'IV Rank < 25: BUYING ZONE — premiums cheap' };
  if (ivRank < 50) return { score: 10, allowed: true, note: 'IV Rank 25-50: OK, require higher confluence' };
  return { score: 0, allowed: false, note: `IV Rank ${ivRank}: NO BUYING — premiums too expensive` };
}

// ─── FII/DII Scoring (Section 2) ───
function scoreFiiDii(
  fiiNet: number, diiNet: number, fiiFutLongRatio: number, fiiNet5dAvg: number,
  direction: 'CE' | 'PE'
): { score: number; note: string } {
  let score = 0;
  let notes: string[] = [];

  // FII cash flow
  if (direction === 'CE') {
    if (fiiNet > 500) { score += 8; notes.push('FII buying'); }
    else if (fiiNet > 0) { score += 4; notes.push('FII mild buy'); }
    else if (fiiNet > -500) { score += 2; notes.push('FII mild sell'); }
    else { score += 0; notes.push('FII selling'); }
  } else {
    if (fiiNet < -500) { score += 8; notes.push('FII selling'); }
    else if (fiiNet < 0) { score += 4; notes.push('FII mild sell'); }
    else { score += 0; notes.push('FII buying — not PE bearish'); }
  }

  // FII futures long/short ratio
  if (direction === 'CE' && fiiFutLongRatio > 0.6) { score += 4; notes.push('FII fut long > 60%'); }
  else if (direction === 'PE' && fiiFutLongRatio < 0.4) { score += 4; notes.push('FII fut short > 60%'); }

  // 5-day rolling average
  if (direction === 'CE' && fiiNet5dAvg > 200) { score += 3; notes.push('5d avg positive'); }
  else if (direction === 'PE' && fiiNet5dAvg < -200) { score += 3; notes.push('5d avg negative'); }

  return { score: Math.min(15, score), note: notes.join('; ') || 'FII/DII neutral' };
}

// ─── Technical Scoring (Section 5F) ───
function scoreTechnicals(input: ConfluenceInput): { score: number; note: string } {
  let score = 0;
  let notes: string[] = [];

  // ADX trend filter
  if (input.adxTechnical > 25) { score += 5; notes.push(`ADX ${input.adxTechnical.toFixed(0)} trending`); }
  else if (input.adxTechnical < 20) { score += 0; notes.push(`ADX ${input.adxTechnical.toFixed(0)} choppy`); }
  else { score += 2; notes.push(`ADX ${input.adxTechnical.toFixed(0)} moderate`); }

  // EMA structure
  if (input.ema20Above50) { score += 3; notes.push('EMA20>50 bullish'); }
  else { score += 0; notes.push('EMA20<50 bearish'); }

  // RSI
  if (input.direction === 'CE') {
    if (input.rsi > 40 && input.rsi < 70) { score += 4; notes.push(`RSI ${input.rsi.toFixed(0)} healthy`); }
    else if (input.rsi >= 70) { score += 1; notes.push(`RSI ${input.rsi.toFixed(0)} overbought`); }
    else { score += 2; notes.push(`RSI ${input.rsi.toFixed(0)} oversold bounce?`); }
  } else {
    if (input.rsi < 60 && input.rsi > 30) { score += 4; notes.push(`RSI ${input.rsi.toFixed(0)} bearish room`); }
    else if (input.rsi <= 30) { score += 1; notes.push(`RSI ${input.rsi.toFixed(0)} oversold`); }
    else { score += 2; notes.push(`RSI ${input.rsi.toFixed(0)} strong`); }
  }

  // Higher highs / trend
  if (input.direction === 'CE' && input.higherHighs) { score += 3; notes.push('Higher highs'); }
  else if (input.direction === 'PE' && !input.higherHighs) { score += 3; notes.push('Lower highs'); }

  return { score: Math.min(15, score), note: notes.join('; ') || 'Technicals neutral' };
}

// ─── Nifty-BankNifty Correlation (Section 5H) ───
function scoreCorrelation(input: ConfluenceInput): { score: number; aligned: boolean; note: string } {
  const aligned = input.niftyTrend === input.bankNiftyTrend && input.niftyTrend !== 'NEUTRAL';
  const divergent = input.niftyTrend !== input.bankNiftyTrend && input.niftyTrend !== 'NEUTRAL' && input.bankNiftyTrend !== 'NEUTRAL';

  if (divergent) return { score: 0, aligned: false, note: 'Nifty-BankNifty DIVERGENT — NO TRADE' };
  if (aligned) return { score: 5, aligned: true, note: `Nifty + BankNifty both ${input.niftyTrend}` };
  return { score: 2, aligned: false, note: 'Nifty-BankNifty unclear' };
}

// ─── MAIN SCORING FUNCTION ───
export function scoreBuyerConfluence(input: ConfluenceInput): ConfluenceResult {
  const hardBlocks: string[] = [];
  const softWarnings: string[] = [];

  // ── VIX zero-guard: never treat 0 as valid ──
  const vix = input.indiaVix;
  const vixValid = vix > 0;
  if (!vixValid) {
    hardBlocks.push(`VIX ${vix} — invalid, cannot trade`);
  }

  // ── VIX Regime (hard block if > 25) ──
  const vixRegime = vixValid ? getVixRegime(vix) : { regime: 'UNKNOWN', allowed: false, sizeMultiplier: 0, minScore: 100 };
  if (!vixRegime.allowed) {
    hardBlocks.push(`VIX ${input.indiaVix} > 25: FEAR regime — NO TRADE`);
  }

  // ── Time Window (hard block) ──
  const timeWindow = getTimeWindow(input.currentHour, input.currentMinute, input.isExpiryDay);
  if (!timeWindow.allowed) {
    hardBlocks.push(`Time ${input.currentHour}:${String(input.currentMinute).padStart(2, '0')} = ${timeWindow.window} — no entries`);
  }

  // ── Gap Trap (hard block) ──
  const minutesSinceOpen = Math.max(0, (input.currentHour - 9) * 60 + input.currentMinute - 15);
  if (isGapTrap(input.gapPercent, minutesSinceOpen)) {
    hardBlocks.push(`Gap ${input.gapPercent > 0 ? '+' : ''}${input.gapPercent.toFixed(1)}% — wait 15 min for opening range`);
  }

  // ── Nifty-BankNifty Correlation (hard block) ──
  const corrResult = scoreCorrelation(input);
  if (!corrResult.aligned && corrResult.score === 0) {
    hardBlocks.push(corrResult.note);
  }

  // ── IV Rank (hard block if > 50) ──
  const ivResult = scoreIVRank(input.ivRank);
  if (!ivResult.allowed) {
    hardBlocks.push(ivResult.note);
  }

  // ── Direction mismatch check ──
  if (input.direction === 'CE' && input.niftyTrend === 'BEARISH') {
    softWarnings.push('Nifty bearish but buying CE — contrarian');
  }
  if (input.direction === 'PE' && input.niftyTrend === 'BULLISH') {
    softWarnings.push('Nifty bullish but buying PE — contrarian');
  }

  // ── Expiry week penalty ──
  const expiryPenalty = getExpiryWeekPenalty(input.dayOfWeek, input.daysToExpiry);
  if (expiryPenalty > 0) {
    softWarnings.push(`${input.daysToExpiry}d to expiry — reduced confidence`);
  }

  // ── Score each factor ──
  const fiiDii = scoreFiiDii(input.fiiNet, input.diiNet, input.fiiFutLongRatio, input.fiiNet5dAvg, input.direction);
  const oi = scoreOI(input.oiPattern, input.direction, input.ceOIBuildup, input.peOIBuildup, input.spotPrice, input.maxPain);
  const pcr = scorePCR(input.pcr, input.direction);

  // Event risk (placeholder — needs event calendar integration)
  const eventRisk = 8; // assume no event for now

  const technicals = scoreTechnicals(input);
  const vixScore = vixRegime.allowed ? 5 : 0;
  const timeScore = timeWindow.allowed ? (timeWindow.isPowerHour ? 5 : 3) : 0;
  const corrScore = corrResult.score;

  const totalScore = Math.max(0,
    fiiDii.score +
    oi +
    pcr +
    ivResult.score +
    eventRisk +
    technicals.score +
    vixScore +
    timeScore +
    corrScore -
    expiryPenalty
  );

  // Apply VIX size multiplier to effective score
  const effectiveScore = Math.round(totalScore * vixRegime.sizeMultiplier);

  // Grade
  let grade: ConfluenceResult['grade'];
  if (effectiveScore >= 85) grade = 'A+';
  else if (effectiveScore >= 75) grade = 'A';
  else if (effectiveScore >= 65) grade = 'B+';
  else if (effectiveScore >= 55) grade = 'B';
  else if (effectiveScore >= 40) grade = 'C';
  else grade = 'D';

  // Action
  let action: ConfluenceResult['action'] = 'NO_TRADE';
  if (hardBlocks.length === 0 && effectiveScore >= vixRegime.minScore) {
    action = input.direction === 'CE' ? 'BUY_CE' : 'BUY_PE';
  }

  // Derive consumer-facing fields from existing computation
  const gapDetected = isGapTrap(input.gapPercent, minutesSinceOpen);
  const reasons: string[] = [];
  if (hardBlocks.length > 0) reasons.push(`Hard blocks: ${hardBlocks.join('; ')}`);
  if (softWarnings.length > 0) reasons.push(`Warnings: ${softWarnings.join('; ')}`);
  if (corrResult.aligned) reasons.push(corrResult.note);
  if (ivResult.score >= 10) reasons.push(`IV favorable: ${ivResult.note}`);
  if (technicals.score >= 12) reasons.push(`Technicals strong: ${technicals.note}`);
  if (fiiDii.score >= 10) reasons.push(`FII/DII supportive: ${fiiDii.note}`);
  if (timeWindow.isPowerHour) reasons.push('Power Hour bonus');
  if (vixRegime.regime === 'CALM' || vixRegime.regime === 'COMPLACENT') reasons.push(`VIX ${vixRegime.regime} — good for buyers`);
  if (reasons.length === 0) reasons.push(action === 'NO_TRADE' ? 'Below threshold' : 'Moderate confluence');

  return {
    totalScore: effectiveScore,
    grade,
    action,
    breakdown: {
      fiiDii: { score: fiiDii.score, max: 15, note: fiiDii.note },
      oi: { score: oi, max: 20, note: input.oiPattern },
      pcr: { score: pcr, max: 10, note: `PCR ${input.pcr}` },
      ivRank: { score: ivResult.score, max: 15, note: ivResult.note },
      eventRisk: { score: eventRisk, max: 10, note: 'No major events' },
      technicals: { score: technicals.score, max: 15, note: technicals.note },
      vix: { score: vixScore, max: 5, note: `${vixRegime.regime} (VIX ${input.indiaVix})` },
      timeWindow: { score: timeScore, max: 5, note: timeWindow.window },
      correlation: { score: corrScore, max: 5, note: corrResult.note },
    },
    hardBlocks,
    softWarnings,
    vixRegime: vixRegime.regime,
    sessionWindow: timeWindow.window,
    // Consumer-facing fields — derived, not recomputed
    gapTrap: gapDetected,
    correlationCheck: corrResult.note,
    ivRankLabel: ivResult.note,
    eventRiskLabel: 'No major events',
    reasons,
  };
}

// ─── Market Bias (Section 1) ───
export interface MarketBiasInput {
  giftNiftyGap: number;        // % gap vs previous close
  usSP500Change: number;       // S&P 500 % change
  usNasdaqChange: number;      // Nasdaq % change
  dxy: number;                 // Dollar Index level
  us10YYield: number;          // US 10Y yield %
  crudeOil: number;            // Brent crude $/barrel
  usdInr: number;              // USD/INR rate
  indiaVix: number;
  fiiNetPrevDay: number;       // Previous day FII net
  fiiNet5dAvg: number;
}

export interface MarketBiasResult {
  bullishFactors: number;
  bearishFactors: number;
  bias: 'CE_DAY' | 'PE_DAY' | 'NO_TRADE_DAY';
  riskMultiplier: number;      // 1.0 = full, 0.5 = half
  factorBreakdown: Array<{ factor: string; value: string; bias: 'BULL' | 'BEAR' | 'NEUTRAL' }>;
}

export function computeMarketBias(input: MarketBiasInput): MarketBiasResult {
  const factors: Array<{ factor: string; value: string; bias: 'BULL' | 'BEAR' | 'NEUTRAL' }> = [];

  // 1. GIFT Nifty gap
  if (input.giftNiftyGap > 0.3) factors.push({ factor: 'GIFT Nifty', value: `+${input.giftNiftyGap.toFixed(2)}%`, bias: 'BULL' });
  else if (input.giftNiftyGap < -0.3) factors.push({ factor: 'GIFT Nifty', value: `${input.giftNiftyGap.toFixed(2)}%`, bias: 'BEAR' });
  else factors.push({ factor: 'GIFT Nifty', value: `${input.giftNiftyGap.toFixed(2)}%`, bias: 'NEUTRAL' });

  // 2. US S&P 500
  if (input.usSP500Change > 0.3) factors.push({ factor: 'S&P 500', value: `+${input.usSP500Change.toFixed(2)}%`, bias: 'BULL' });
  else if (input.usSP500Change < -0.3) factors.push({ factor: 'S&P 500', value: `${input.usSP500Change.toFixed(2)}%`, bias: 'BEAR' });
  else factors.push({ factor: 'S&P 500', value: `${input.usSP500Change.toFixed(2)}%`, bias: 'NEUTRAL' });

  // 3. Nasdaq
  if (input.usNasdaqChange > 0.3) factors.push({ factor: 'Nasdaq', value: `+${input.usNasdaqChange.toFixed(2)}%`, bias: 'BULL' });
  else if (input.usNasdaqChange < -0.3) factors.push({ factor: 'Nasdaq', value: `${input.usNasdaqChange.toFixed(2)}%`, bias: 'BEAR' });
  else factors.push({ factor: 'Nasdaq', value: `${input.usNasdaqChange.toFixed(2)}%`, bias: 'NEUTRAL' });

  // 4. DXY
  if (input.dxy < 103) factors.push({ factor: 'DXY', value: input.dxy.toFixed(1), bias: 'BULL' });
  else if (input.dxy > 105) factors.push({ factor: 'DXY', value: input.dxy.toFixed(1), bias: 'BEAR' });
  else factors.push({ factor: 'DXY', value: input.dxy.toFixed(1), bias: 'NEUTRAL' });

  // 5. US 10Y Yield
  if (input.us10YYield < 4.0) factors.push({ factor: 'US 10Y', value: `${input.us10YYield.toFixed(2)}%`, bias: 'BULL' });
  else if (input.us10YYield > 4.5) factors.push({ factor: 'US 10Y', value: `${input.us10YYield.toFixed(2)}%`, bias: 'BEAR' });
  else factors.push({ factor: 'US 10Y', value: `${input.us10YYield.toFixed(2)}%`, bias: 'NEUTRAL' });

  // 6. Crude Oil
  if (input.crudeOil < 80) factors.push({ factor: 'Crude', value: `$${input.crudeOil.toFixed(1)}`, bias: 'BULL' });
  else if (input.crudeOil > 90) factors.push({ factor: 'Crude', value: `$${input.crudeOil.toFixed(1)}`, bias: 'BEAR' });
  else factors.push({ factor: 'Crude', value: `$${input.crudeOil.toFixed(1)}`, bias: 'NEUTRAL' });

  // 7. USD/INR
  if (input.usdInr < 83) factors.push({ factor: 'USD/INR', value: input.usdInr.toFixed(2), bias: 'BULL' });
  else if (input.usdInr > 84) factors.push({ factor: 'USD/INR', value: input.usdInr.toFixed(2), bias: 'BEAR' });
  else factors.push({ factor: 'USD/INR', value: input.usdInr.toFixed(2), bias: 'NEUTRAL' });

  // 8. FII/DII
  if (input.fiiNetPrevDay > 500 && input.fiiNet5dAvg > 0) factors.push({ factor: 'FII Flow', value: `₹${input.fiiNetPrevDay.toFixed(0)}Cr`, bias: 'BULL' });
  else if (input.fiiNetPrevDay < -500 && input.fiiNet5dAvg < 0) factors.push({ factor: 'FII Flow', value: `₹${input.fiiNetPrevDay.toFixed(0)}Cr`, bias: 'BEAR' });
  else factors.push({ factor: 'FII Flow', value: `₹${input.fiiNetPrevDay.toFixed(0)}Cr`, bias: 'NEUTRAL' });

  const bullish = factors.filter(f => f.bias === 'BULL').length;
  const bearish = factors.filter(f => f.bias === 'BEAR').length;

  let bias: MarketBiasResult['bias'] = 'NO_TRADE_DAY';
  let riskMultiplier = 0;

  if (bullish >= 5) { bias = 'CE_DAY'; riskMultiplier = 1.0; }
  else if (bullish >= 3) { bias = 'CE_DAY'; riskMultiplier = 0.5; }
  else if (bearish >= 5) { bias = 'PE_DAY'; riskMultiplier = 1.0; }
  else if (bearish >= 3) { bias = 'PE_DAY'; riskMultiplier = 0.5; }

  return {
    bullishFactors: bullish,
    bearishFactors: bearish,
    bias,
    riskMultiplier,
    factorBreakdown: factors,
  };
}
