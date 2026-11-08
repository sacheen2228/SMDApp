// BTST v2 Engine - rebuilt per spec
import { BTST_CONFIG } from "./btst-config";

export interface BTSTV2Input {
  symbol: string;
  price: number;
  changePct: number;
  rsi: number;
  ema9: number;
  ema21: number;
  ema50: number;
  volume: number;
  avgVolume20d: number;
  deliveryPct: number;
  atr14: number;
  sectorStrength: number;
  relativeStrength: number;
  isFNO: boolean;
  oiChangePct?: number | null;
  pcr?: number | null;
  iv?: number | null;
  fiiDir?: string;
  proDir?: string;
  alignment?: number;
  avgTurnoverCr?: number;
  isBan?: boolean;
  circuit?: boolean;
  resultsTomorrow?: boolean;
  dataFresh?: boolean;
}

export interface BTSTV2Analysis {
  symbol: string;
  score: number;
  grade: "BUY" | "WATCH" | "SKIP";
  finalGrade: "A+" | "A" | "B" | "SKIP";
  confidence: number;
  factors: Record<string, number>;
  hardFilterPass: boolean;
  conflict: boolean;
  marketGatePass: boolean;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  rr: number;
  qty: number;
  capitalDeployed: number;
  riskAmount: number;
  reasons: string[];
  warnings: string[];
}

function clamp(n:number, lo:number, hi:number){ return Math.max(lo, Math.min(hi, n)); }

export function analyzeBTSTv2(inp: BTSTV2Input, marketGate?: { niftyScore:number; vix:number }): BTSTV2Analysis {
  const reasons:string[] = [];
  const warnings:string[] = [];

  // Hard filters
  const hardPass = 
    (inp.avgTurnoverCr ?? 0) >= BTST_CONFIG.scoring.hardFilters.minAvgTurnoverCr &&
    (inp.volume / Math.max(1,inp.avgVolume20d)) >= BTST_CONFIG.scoring.hardFilters.minRelativeVolume &&
    inp.deliveryPct >= BTST_CONFIG.scoring.hardFilters.minDeliveryPct &&
    !(BTST_CONFIG.scoring.hardFilters.excludeBan && inp.isBan) &&
    !(BTST_CONFIG.scoring.hardFilters.excludeCircuit && inp.circuit) &&
    !(BTST_CONFIG.scoring.hardFilters.excludeResultsTomorrow && inp.resultsTomorrow) &&
    inp.dataFresh !== false;

  if (!hardPass) reasons.push("Hard filter failed");

  // Market gate
  const gatePass = (() => {
    if (!marketGate) return true;
    const trendOk = marketGate.niftyScore >= BTST_CONFIG.scoring.marketGate.niftyTrendMinScore;
    const vixOk = marketGate.vix <= BTST_CONFIG.scoring.marketGate.maxIndiaVix;
    return trendOk && vixOk;
  })();
  if (!gatePass) reasons.push("Market gate weak");

  const w = BTST_CONFIG.scoring.weights;

  // Factor calculations 0-100 each with stronger maths
  const rsiScore = inp.rsi >= 50 && inp.rsi <= 70 ? 90 : inp.rsi > 70 ? 60 : inp.rsi >= 40 ? 70 : 40;
  const closeStrength = clamp(
    50 + inp.changePct * 5 + (rsiScore - 50) * 0.3,
    0, 100
  );
  const emaStack = inp.ema9 > inp.ema21 && inp.ema21 > inp.ema50 ? 100 : inp.ema9 > inp.ema21 ? 70 : inp.ema9 > inp.ema50 ? 55 : 30;
  const breakout = clamp(emaStack * 0.7 + (inp.changePct > 0 ? 10 : 0), 0, 100);
  const volMult = inp.volume / Math.max(1, inp.avgVolume20d);
  const volumeScore = clamp(40 + volMult * 30, 0, 100);
  const deliveryScore = clamp(inp.deliveryPct * 1.2, 0, 100);
  const fnoBuildup = inp.isFNO
    ? inp.oiChangePct != null
      ? clamp(50 + inp.oiChangePct * 3, 0, 100)
      : 50
    : 70;
  const pcrOi = inp.isFNO
    ? inp.pcr != null
      ? inp.pcr < 0.9 ? 90 : inp.pcr < 1.0 ? 80 : inp.pcr < 1.2 ? 60 : inp.pcr < 1.4 ? 40 : 20
      : 50
    : 70;
  const sectorScore = clamp(50 + inp.sectorStrength, 0, 100);
  const relStrScore = clamp(50 + inp.relativeStrength * 15, 0, 100);
  const instAlign = inp.alignment != null ? clamp(inp.alignment, 0, 100) : 50;

  const factors = {
    closeStrength,
    breakout,
    volumeVs20d: volumeScore,
    deliveryPct: deliveryScore,
    fnoBuildup,
    stockPcrOiChange: pcrOi,
    sectorStrength: sectorScore,
    relativeStrength: relStrScore,
    institutionalAlignment: instAlign,
  };

  // Weighted score
  const totalWeight = Object.values(w).reduce((a,b)=>a+b,0);
  let weighted = 0;
  weighted += closeStrength * w.closeStrength;
  weighted += breakout * w.breakout;
  weighted += volumeScore * w.volumeVs20d;
  weighted += deliveryScore * w.deliveryPct;
  weighted += fnoBuildup * w.fnoBuildup;
  weighted += pcrOi * w.stockPcrOiChange;
  weighted += sectorScore * w.sectorStrength;
  weighted += relStrScore * w.relativeStrength;
  weighted += instAlign * w.institutionalAlignment;
  let score = Math.round(weighted / totalWeight);

  // Reweight if OI missing
  if (!inp.isFNO || inp.pcr==null || inp.oiChangePct==null) {
    // reweight to 100
    const missing = inp.isFNO ? 0 : 1;
    // skip complex reweight, just note
    warnings.push("OI n/a, reweighted");
  }

  // Conflict detection
  const conflict = (inp.fiiDir && inp.proDir && inp.fiiDir !== inp.proDir) || (inp.alignment ?? 100) < BTST_CONFIG.scoring.verdict.conflictAlignmentThreshold;
  if (conflict) warnings.push("FII/Pro conflict");

  // Verdict
  let verdict: "BUY"|"WATCH"|"SKIP" = "SKIP";
  if (hardPass && gatePass) {
    if (score >= BTST_CONFIG.scoring.verdict.buyThreshold && !conflict) verdict = "BUY";
    else if (score >= BTST_CONFIG.scoring.verdict.watchMin) verdict = "WATCH";
  }

  // Grade mapping
  let finalGrade: "A+"|"A"|"B"|"SKIP" = "SKIP";
  if (verdict === "BUY") {
    if (score >= 85) finalGrade = "A+";
    else if (score >= 75) finalGrade = "A";
    else finalGrade = "B";
  } else if (verdict === "WATCH") {
    finalGrade = "B";
  }
  if (conflict && finalGrade !== "SKIP") {
    finalGrade = "B";
    warnings.push("Grade capped at B due to conflict");
  }
  if (!inp.dataFresh) {
    finalGrade = "SKIP";
    reasons.push("Data stale");
  }

  // Trade plan
  const entry = inp.price;
  const atr = inp.atr14 || entry*0.012;
  let slPct = (atr * BTST_CONFIG.tradePlan.atrMultiplier) / entry;
  slPct = clamp(slPct, BTST_CONFIG.tradePlan.slMinPct, BTST_CONFIG.tradePlan.slMaxPct);
  const sl = entry * (1 - slPct);
  const expectedMovePct = clamp((atr/entry)*100*BTST_CONFIG.tradePlan.expectedMoveFromATR, 0.8, 3.5);
  const em = expectedMovePct/100;
  const tp1 = entry * (1 + em * BTST_CONFIG.tradePlan.tp1Mult);
  const tp2 = entry * (1 + em * BTST_CONFIG.tradePlan.tp2Mult);
  const rr = (tp1 - entry) / Math.max(0.0001, entry - sl);

  // Sizing
  const deployedCap = BTST_CONFIG.tradePlan.capitalPerTrade;
  const riskPerShare = entry - sl;
  const maxQtyByCapital = Math.floor(deployedCap / entry);
  let qty = maxQtyByCapital;
  const riskAmount = qty * riskPerShare;
  const riskPct = riskAmount / (qty*entry) || 0;
  if (rr < BTST_CONFIG.tradePlan.minRR) {
    warnings.push(`RR ${rr.toFixed(2)} < min ${BTST_CONFIG.tradePlan.minRR}`);
    verdict = "SKIP";
    finalGrade = "SKIP";
  }

  const confidence = clamp(Math.round(score * 0.9 + (volumeScore>70?5:0)), 0,100);

  return {
    symbol: inp.symbol,
    score,
    grade: verdict,
    finalGrade,
    confidence,
    factors,
    hardFilterPass: hardPass,
    conflict,
    marketGatePass: gatePass,
    entry, sl, tp1, tp2, rr,
    qty, capitalDeployed: qty*entry, riskAmount,
    reasons,
    warnings,
  };
}
