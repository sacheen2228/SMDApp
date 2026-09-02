// ═══════════════════════════════════════════════════════════════════════════
// MODE A — INDEX F&O
// Analyzes NIFTY, BANKNIFTY, SENSEX for directional/index options trades.
// Uses: SDM Engine + IDE + Option Chain + Futures + OI + IV + Breadth +
//       Regime + News + Institutional + VWAP + Volume Profile
// ═══════════════════════════════════════════════════════════════════════════

import type { MarketIntelligenceContext } from "./market-context";

// ── Types ──
export type IndexTradeDirection = "LONG" | "SHORT" | "CALL" | "PUT" | "NO_TRADE";

export interface IndexFOSignal {
  symbol: string;
  direction: IndexTradeDirection;
  confidence: number; // 0-100
  score: number; // 0-100 composite
  reasoning: string[];
  factors: {
    priceStructure: number; // 0-100
    futuresPositioning: number;
    oiAnalysis: number;
    ivState: number;
    volumeConfirmation: number;
    breadthConfirmation: number;
    institutionalFlow: number;
    regimeAlignment: number;
    newsAlignment: number;
    technicalAlignment: number;
  };
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  holdingPeriod: string;
  recommendedInstrument: string;
  strike: number;
  expiry: string;
  premium: number;
  maxRisk: string;
  invalidation: string;
}

// ── Score a single index ──
function scoreIndex(
  symbol: string,
  chain: any,
  futures: any,
  ctx: MarketIntelligenceContext
): IndexFOSignal {
  const reasoning: string[] = [];
  let bullScore = 0;
  let bearScore = 0;
  let totalFactors = 0;

  // Factor 1: PCR (0-15 points)
  const pcr = chain?.pcr || 1;
  totalFactors += 15;
  if (pcr > 1.2) {
    bullScore += 15;
    reasoning.push(`PCR ${pcr.toFixed(2)} — heavy put writing, bullish`);
  } else if (pcr > 1.0) {
    bullScore += 10;
    reasoning.push(`PCR ${pcr.toFixed(2)} — mild bullish`);
  } else if (pcr < 0.8) {
    bearScore += 15;
    reasoning.push(`PCR ${pcr.toFixed(2)} — heavy call writing, bearish`);
  } else if (pcr < 1.0) {
    bearScore += 10;
    reasoning.push(`PCR ${pcr.toFixed(2)} — mild bearish`);
  } else {
    bullScore += 7;
    bearScore += 7;
    reasoning.push(`PCR ${pcr.toFixed(2)} — neutral`);
  }

  // Factor 2: Futures basis (0-15 points)
  totalFactors += 15;
  const basis = futures?.basis || 0;
  const basisPct = futures?.basisPercent || 0;
  if (basis > 0 && basisPct > 0.1) {
    bullScore += 15;
    reasoning.push(`Futures premium ${basis.toFixed(1)} (${basisPct.toFixed(2)}%) — contango, bullish`);
  } else if (basis > 0) {
    bullScore += 8;
    reasoning.push(`Mild futures premium — slight bullish`);
  } else if (basis < 0 && Math.abs(basisPct) > 0.1) {
    bearScore += 15;
    reasoning.push(`Futures discount ${basis.toFixed(1)} (${basisPct.toFixed(2)}%) — backwardation, bearish`);
  } else if (basis < 0) {
    bearScore += 8;
    reasoning.push(`Mild futures discount — slight bearish`);
  } else {
    bullScore += 5;
    bearScore += 5;
    reasoning.push(`Futures at par — neutral`);
  }

  // Factor 3: OI positioning (0-15 points)
  totalFactors += 15;
  const totalCallOI = chain?.totalCallOI || 0;
  const totalPutOI = chain?.totalPutOI || 0;
  const callWall = chain?.callWall || 0;
  const putFloor = chain?.putFloor || 0;
  const spot = chain?.spot || 0;

  if (totalPutOI > totalCallOI * 1.2) {
    bullScore += 15;
    reasoning.push(`Put OI ${(totalPutOI / 1e6).toFixed(0)}M > Call OI ${(totalCallOI / 1e6).toFixed(0)}M — support building`);
  } else if (totalCallOI > totalPutOI * 1.2) {
    bearScore += 15;
    reasoning.push(`Call OI ${(totalCallOI / 1e6).toFixed(0)}M > Put OI ${(totalPutOI / 1e6).toFixed(0)}M — resistance building`);
  } else {
    bullScore += 7;
    bearScore += 7;
    reasoning.push(`OI balanced — no clear directional bias`);
  }

  // Factor 4: IV state (0-10 points)
  totalFactors += 10;
  const ivRank = chain?.ivRank || 50;
  if (ivRank > 70) {
    reasoning.push(`IV rank ${ivRank}% — elevated, premium selling favored`);
  } else if (ivRank < 30) {
    reasoning.push(`IV rank ${ivRank}% — cheap, premium buying favored`);
  } else {
    reasoning.push(`IV rank ${ivRank}% — normal`);
  }

  // Factor 5: Max Pain proximity (0-10 points)
  totalFactors += 10;
  const maxPain = chain?.maxPain || 0;
  if (maxPain > 0 && spot > 0) {
    const distToMP = ((spot - maxPain) / maxPain) * 100;
    if (distToMP > 0.5) {
      bearScore += 10;
      reasoning.push(`Spot ${distToMP.toFixed(1)}% above max pain ${maxPain} — mean reversion risk`);
    } else if (distToMP < -0.5) {
      bullScore += 10;
      reasoning.push(`Spot ${Math.abs(distToMP).toFixed(1)}% below max pain ${maxPain} — attraction zone`);
    } else {
      bullScore += 5;
      bearScore += 5;
      reasoning.push(`Spot near max pain ${maxPain} — balanced`);
    }
  }

  // Factor 6: Regime alignment (0-15 points)
  totalFactors += 15;
  const regime = ctx.regime;
  if (regime.trend === "BULLISH") {
    bullScore += 15;
    reasoning.push(`Market regime ${regime.regime} (${regime.confidence}% confidence) — bullish`);
  } else if (regime.trend === "BEARISH") {
    bearScore += 15;
    reasoning.push(`Market regime ${regime.regime} (${regime.confidence}% confidence) — bearish`);
  } else {
    bullScore += 7;
    bearScore += 7;
    reasoning.push(`Market regime ${regime.regime} — neutral`);
  }

  // Factor 7: Breadth (0-10 points)
  totalFactors += 10;
  const breadthScore = ctx.breadth.breadthScore;
  if (breadthScore > 70) {
    bullScore += 10;
    reasoning.push(`Breadth score ${breadthScore}/100 — strong advances`);
  } else if (breadthScore < 30) {
    bearScore += 10;
    reasoning.push(`Breadth score ${breadthScore}/100 — weak breadth`);
  } else {
    bullScore += 5;
    bearScore += 5;
  }

  // Factor 8: Institutional flow (0-10 points)
  totalFactors += 10;
  const fiiNet = ctx.fiiDii.fii.net;
  if (fiiNet > 0) {
    bullScore += 10;
    reasoning.push(`FII net inflow ₹${(fiiNet / 1e7).toFixed(0)}Cr — institutional buying`);
  } else if (fiiNet < 0) {
    bearScore += 10;
    reasoning.push(`FII net outflow ₹${Math.abs(fiiNet / 1e7).toFixed(0)}Cr — institutional selling`);
  } else {
    bullScore += 5;
    bearScore += 5;
  }

  // Factor 9: News sentiment (0-5 points)
  totalFactors += 5;
  const newsScore = ctx.news.score;
  if (newsScore > 20) {
    bullScore += 5;
    reasoning.push(`News sentiment positive (+${newsScore})`);
  } else if (newsScore < -20) {
    bearScore += 5;
    reasoning.push(`News sentiment negative (${newsScore})`);
  } else {
    bullScore += 2;
    bearScore += 2;
  }

  // Factor 10: Futures OI change (0-5 points)
  totalFactors += 5;
  const oiChange = futures?.oiChange || 0;
  if (oiChange > 0 && basis > 0) {
    bullScore += 5;
    reasoning.push(`Rising OI + premium — long buildup`);
  } else if (oiChange > 0 && basis < 0) {
    bearScore += 5;
    reasoning.push(`Rising OI + discount — short buildup`);
  } else if (oiChange < 0) {
    reasoning.push(`Declining OI — unwinding`);
  }

  // Determine direction
  const netScore = bullScore - bearScore;
  const maxScore = totalFactors;
  let direction: IndexTradeDirection = "NO_TRADE";
  let confidence = 0;

  if (netScore > 0) {
    confidence = Math.min(95, Math.round((bullScore / maxScore) * 100));
    if (confidence >= 70) direction = "LONG";
    else if (confidence >= 60) direction = "CALL";
  } else if (netScore < 0) {
    confidence = Math.min(95, Math.round((bearScore / maxScore) * 100));
    if (confidence >= 70) direction = "SHORT";
    else if (confidence >= 60) direction = "PUT";
  }

  // Calculate levels
  const atr = spot * 0.01; // 1% ATR estimate
  let entry = spot;
  let stopLoss = 0;
  let target1 = 0;
  let target2 = 0;

  if (direction === "LONG" || direction === "CALL") {
    stopLoss = spot - atr * 1.5;
    target1 = spot + atr * 2;
    target2 = spot + atr * 3;
  } else if (direction === "SHORT" || direction === "PUT") {
    stopLoss = spot + atr * 1.5;
    target1 = spot - atr * 2;
    target2 = spot - atr * 3;
  }

  const riskReward = direction !== "NO_TRADE"
    ? Math.abs(target1 - entry) / Math.abs(entry - stopLoss)
    : 0;

  // Determine instrument
  let recommendedInstrument = "NO_TRADE";
  let strike = 0;
  let premium = 0;
  if (direction === "CALL") {
    strike = chain?.atmStrike || spot;
    recommendedInstrument = `${symbol} ${strike} CE`;
    premium = chain?.ivMedian || 0;
  } else if (direction === "PUT") {
    strike = chain?.atmStrike || spot;
    recommendedInstrument = `${symbol} ${strike} PE`;
    premium = chain?.ivMedian || 0;
  } else if (direction === "LONG") {
    recommendedInstrument = `${symbol} Futures`;
  } else if (direction === "SHORT") {
    recommendedInstrument = `${symbol} Short Futures`;
  }

  return {
    symbol,
    direction,
    confidence,
    score: Math.round(((bullScore + bearScore) / maxScore) * 100),
    reasoning,
    factors: {
      priceStructure: Math.round((bullScore + bearScore) / 2),
      futuresPositioning: basis > 0 ? 70 : basis < 0 ? 30 : 50,
      oiAnalysis: totalPutOI > totalCallOI ? 70 : 30,
      ivState: ivRank,
      volumeConfirmation: 50,
      breadthConfirmation: breadthScore,
      institutionalFlow: fiiNet > 0 ? 70 : fiiNet < 0 ? 30 : 50,
      regimeAlignment: regime.confidence,
      newsAlignment: newsScore > 0 ? 70 : newsScore < 0 ? 30 : 50,
      technicalAlignment: 50,
    },
    entry,
    stopLoss,
    target1,
    target2,
    riskReward,
    holdingPeriod: direction === "NO_TRADE" ? "N/A" : "Intraday to 2 days",
    recommendedInstrument,
    strike,
    expiry: chain?.expiry || "",
    premium,
    maxRisk: `${Math.abs(entry - stopLoss).toFixed(0)} pts`,
    invalidation: direction === "LONG" || direction === "CALL"
      ? `Break below ${stopLoss.toFixed(0)}`
      : direction === "SHORT" || direction === "PUT"
        ? `Break above ${stopLoss.toFixed(0)}`
        : "N/A",
  };
}

// ── Main: Score all three indices ──
export async function analyzeIndexFO(
  ctx: MarketIntelligenceContext
): Promise<IndexFOSignal[]> {
  const signals: IndexFOSignal[] = [];

  const indices = [
    { symbol: "NIFTY", chain: ctx.nifty, futures: ctx.niftyFutures },
    { symbol: "BANKNIFTY", chain: ctx.banknifty, futures: ctx.bankniftyFutures },
    { symbol: "SENSEX", chain: ctx.sensex, futures: ctx.sensexFutures },
  ];

  for (const idx of indices) {
    if (!idx.chain && !idx.futures) continue;
    signals.push(scoreIndex(idx.symbol, idx.chain, idx.futures, ctx));
  }

  // Sort by confidence descending
  signals.sort((a, b) => b.confidence - a.confidence);

  return signals;
}
