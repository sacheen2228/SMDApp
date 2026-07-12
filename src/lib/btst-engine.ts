// BTST (Buy Today Sell Tomorrow) AI Engine
// Dedicated next-day swing scanner for equity & F&O stocks.
// Runs once daily between 3:10–3:20 PM IST. Produces A+/A/B graded candidates
// with a 6-factor score, ATR-based stop, 3 profit targets, gap-risk estimate,
// and dynamic position sizing. Operates independently of the intraday engine.

export type BTSTGrade = "A+" | "A" | "B" | "C" | "SKIP";

export interface BTSTFactorScores {
  trend: number;      // /25
  smartMoney: number; // /20
  oi: number;         // /20
  volume: number;     // /15
  sector: number;     // /10
  breadth: number;    // /10
}

export interface BTSTStockInput {
  symbol: string;
  name?: string;
  sector?: string;
  price: number;
  changePct: number;
  rsi: number;
  macd: number;
  macdSignal: number;
  macdHist: number;
  adx: number;
  ema9: number;
  ema21: number;
  ema50: number;
  volume: number;
  avgVolume: number;
  oiChangePct: number; // F&O only (0 if none)
  pcr: number;         // F&O only (1 if none)
  iv: number;          // F&O only (0 if none)
  sectorStrength: number;  // -100..100
  relativeStrength: number; // vs NIFTY, %
  deliveryPct: number;  // delivery volume %
  breadth: number;      // sector advance-decline ratio 0..1
  atr: number;
  isFNO: boolean;
}

export interface BTSTAnalysis {
  symbol: string;
  name?: string;
  sector?: string;
  price: number;
  factors: BTSTFactorScores;
  total: number;          // /100
  confidence: number;     // %
  grade: BTSTGrade;
  trendLabel: string;     // Strong Bullish / Bullish / Weak
  sectorLabel: string;    // Strong / Neutral / Weak
  relativeStrength: number;
  volumeMultiple: number;
  deliveryLabel: string;  // High / Medium / Low
  oiLabel: string;        // Bullish / Neutral / Bearish
  pcr: number;
  smartMoney: "Active" | "Building" | "Absent";
  gapRisk: "Low" | "Medium" | "High";
  expectedGapPct: number; // signed
  expectedMovePct: number;
  expectedRiskPct: number;
  riskReward: number;
  holding: string;        // "1 Day"
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  positionSize: { qty: number; capital: number; riskPerTrade: number };
  reasons: string[];
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

function gradeFromScore(total: number): BTSTGrade {
  if (total >= 85) return "A+";
  if (total >= 75) return "A";
  if (total >= 65) return "B";
  if (total >= 55) return "C";
  return "SKIP";
}

// ─── Core scoring ─────────────────────────────────────────────────
export function analyzeBTST(inp: BTSTStockInput): BTSTAnalysis {
  const reasons: string[] = [];

  // 1. TREND (/25): RSI zone + EMA alignment + MACD + ADX
  let trend = 0;
  // RSI: ideal 50-70 (momentum without overbought)
  if (inp.rsi >= 50 && inp.rsi <= 70) trend += 9;
  else if (inp.rsi > 70) trend += 4;       // overbought — risky for BTST
  else if (inp.rsi >= 40) trend += 5;
  else trend += 1;
  // EMA alignment: ema9 > ema21 > ema50 = bullish stack
  if (inp.ema9 > inp.ema21 && inp.ema21 > inp.ema50) trend += 8;
  else if (inp.ema9 > inp.ema21) trend += 4;
  else trend += 1;
  // MACD histogram positive = momentum up
  if (inp.macdHist > 0) trend += 5;
  else if (inp.macdHist > inp.macdSignal) trend += 3;
  else trend += 1;
  // ADX trend strength
  if (inp.adx >= 25) trend += 3;
  else if (inp.adx >= 20) trend += 2;
  else trend += 1;
  trend = clamp(trend, 0, 25);
  if (trend >= 20) reasons.push("Trend: strong bullish stack (EMA9>21>50, ADX " + inp.adx.toFixed(0) + ")");

  // 2. SMART MONEY (/20): delivery + FII proxy (relative strength) + OI buildup
  let smartMoney = 0;
  // Delivery volume (institutional conviction)
  if (inp.deliveryPct >= 60) smartMoney += 8;
  else if (inp.deliveryPct >= 45) smartMoney += 5;
  else if (inp.deliveryPct >= 30) smartMoney += 3;
  else smartMoney += 1;
  // Relative strength vs NIFTY (smart money rotates into leaders)
  if (inp.relativeStrength >= 1.5) smartMoney += 7;
  else if (inp.relativeStrength >= 0.5) smartMoney += 5;
  else if (inp.relativeStrength >= 0) smartMoney += 3;
  else smartMoney += 0;
  // OI buildup for F&O (bullish if OI rising with price)
  if (inp.isFNO) {
    if (inp.oiChangePct >= 5) smartMoney += 5;
    else if (inp.oiChangePct >= 0) smartMoney += 3;
    else smartMoney += 1;
  } else {
    smartMoney += 5; // equity delivery counts as smart money proxy
  }
  smartMoney = clamp(smartMoney, 0, 20);

  // 3. OI (/20): only meaningful for F&O
  let oi = 0;
  if (inp.isFNO) {
    // PCR < 1.2 bullish; OI change supports
    if (inp.pcr < 1.0) oi += 9;
    else if (inp.pcr < 1.2) oi += 6;
    else if (inp.pcr < 1.4) oi += 3;
    else oi += 1;
    if (inp.oiChangePct >= 5) oi += 7;
    else if (inp.oiChangePct >= 0) oi += 4;
    else oi += 1;
    if (inp.iv > 0 && inp.iv < 30) oi += 4; // moderate IV = room to run
    else oi += 2;
  } else {
    oi = 18; // equity has no OI; neutral-high default
  }
  oi = clamp(oi, 0, 20);

  // 4. VOLUME (/15): relative volume
  const vrm = inp.avgVolume > 0 ? inp.volume / inp.avgVolume : 1;
  let volume = 0;
  if (vrm >= 2.0) volume = 15;
  else if (vrm >= 1.5) volume = 13;
  else if (vrm >= 1.2) volume = 10;
  else if (vrm >= 1.0) volume = 6;
  else volume = 2;

  // 5. SECTOR (/10)
  let sector = 0;
  if (inp.sectorStrength >= 30) sector = 10;
  else if (inp.sectorStrength >= 10) sector = 8;
  else if (inp.sectorStrength >= 0) sector = 5;
  else if (inp.sectorStrength >= -20) sector = 2;
  else sector = 0;

  // 6. BREADTH (/10): sector advance-decline
  let breadth = 0;
  if (inp.breadth >= 0.65) breadth = 10;
  else if (inp.breadth >= 0.55) breadth = 8;
  else if (inp.breadth >= 0.5) breadth = 5;
  else if (inp.breadth >= 0.4) breadth = 2;
  else breadth = 0;

  const factors: BTSTFactorScores = {
    trend: Math.round(trend),
    smartMoney: Math.round(smartMoney),
    oi: Math.round(oi),
    volume: Math.round(volume),
    sector: Math.round(sector),
    breadth: Math.round(breadth),
  };

  const total = factors.trend + factors.smartMoney + factors.oi + factors.volume + factors.sector + factors.breadth;
  const grade = gradeFromScore(total);
  // Confidence: score-weighted with volume bonus
  const confidence = clamp(Math.round(total * 0.92 + Math.min(8, vrm * 2)));

  // ─── Trade levels ────────────────────────────────────────────────
  const atr = inp.atr > 0 ? inp.atr : inp.price * 0.012;
  const entry = inp.price;
  // ATR-based stop: ~1.2 ATR below entry, floored at 0.6% / capped at 2.5%
  let slPct = (atr * 1.2) / entry;
  slPct = Math.max(0.006, Math.min(0.025, slPct));
  const sl = entry * (1 - slPct);
  // Targets scaled by expected move (expectedMovePct is in %)
  // Overnight holds can capture larger gaps, so targets are set at 2.2x / 3.8x / 5.5x
  // the ATR-derived expected move → typical R:R ~2.5 (matches BTST playbook).
  const expectedMovePct = clamp((atr / entry) * 100 * 1.4, 0.8, 3.5);
  const moveMult = expectedMovePct / 100;
  const tp1 = entry * (1 + moveMult * 2.2);
  const tp2 = entry * (1 + moveMult * 3.8);
  const tp3 = entry * (1 + moveMult * 5.5);
  const riskReward = (tp1 - entry) / (entry - sl);

  // ─── Gap risk estimate ───────────────────────────────────────────
  // Lower when trend strong, volume confirmed, sector supportive, no overbought
  let gapRiskScore = 0;
  if (inp.rsi > 72) gapRiskScore += 2;     // overbought → gap-down risk
  if (inp.pcr > 1.4 && inp.isFNO) gapRiskScore += 1; // heavy puts
  if (sector < 5) gapRiskScore += 1;
  if (vrm < 1.0) gapRiskScore += 1;
  if (inp.changePct < -0.5) gapRiskScore += 1;
  const gapRisk: "Low" | "Medium" | "High" = gapRiskScore === 0 ? "Low" : gapRiskScore <= 2 ? "Medium" : "High";
  const expectedGapPct = gapRisk === "Low" ? 0.8 : gapRisk === "Medium" ? 0.3 : -0.5;

  // ─── Position sizing ─────────────────────────────────────────────
  const riskPerShare = entry - sl;
  const maxCapital = 100000;
  const riskPct = 1.0; // 1% account risk
  const qty = riskPerShare > 0 ? Math.floor((maxCapital * riskPct / 100) / riskPerShare) : 0;
  const capital = qty * entry;
  const riskPerTrade = qty * riskPerShare;

  const trendLabel = factors.trend >= 20 ? "Strong Bullish" : factors.trend >= 12 ? "Bullish" : "Weak";
  const sectorLabel = factors.sector >= 8 ? "Strong" : factors.sector >= 5 ? "Neutral" : "Weak";
  const deliveryLabel = inp.deliveryPct >= 60 ? "High" : inp.deliveryPct >= 45 ? "Medium" : "Low";
  const oiLabel = !inp.isFNO ? "N/A" : inp.pcr < 1.2 && inp.oiChangePct >= 0 ? "Bullish" : inp.pcr < 1.4 ? "Neutral" : "Bearish";
  const smartMoneyLabel: "Active" | "Building" | "Absent" =
    factors.smartMoney >= 15 ? "Active" : factors.smartMoney >= 9 ? "Building" : "Absent";

  return {
    symbol: inp.symbol,
    name: inp.name,
    sector: inp.sector,
    price: entry,
    factors,
    total,
    confidence,
    grade,
    trendLabel,
    sectorLabel,
    relativeStrength: inp.relativeStrength,
    volumeMultiple: Math.round(vrm * 10) / 10,
    deliveryLabel,
    oiLabel,
    pcr: inp.pcr,
    smartMoney: smartMoneyLabel,
    gapRisk,
    expectedGapPct,
    expectedMovePct: Math.round(expectedMovePct * 10) / 10,
    expectedRiskPct: Math.round(slPct * 1000) / 10,
    riskReward: Math.round(riskReward * 10) / 10,
    holding: "1 Day",
    entry,
    sl: Math.round(sl * 100) / 100,
    tp1: Math.round(tp1 * 100) / 100,
    tp2: Math.round(tp2 * 100) / 100,
    tp3: Math.round(tp3 * 100) / 100,
    positionSize: { qty, capital: Math.round(capital), riskPerTrade: Math.round(riskPerTrade) },
    reasons,
  };
}

// ─── Should this stock be alerted? ────────────────────────────────
export function shouldAlertBTST(a: BTSTAnalysis): boolean {
  return a.total >= 85 && a.gapRisk !== "High";
}
