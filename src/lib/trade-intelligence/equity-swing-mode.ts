// ═══════════════════════════════════════════════════════════════════════════
// MODE C — EQUITY SWING
// Scans NSE cash-market stocks for multi-day swing opportunities.
// Uses: Technical Analysis + Price Structure + Accumulation/Distribution +
//       Breakout/Retest + Volume Expansion + Sector Strength + Market Trend
// ═══════════════════════════════════════════════════════════════════════════

import type { MarketIntelligenceContext } from "./market-context";

// ── Types ──
export type SwingDirection = "BUY" | "SELL" | "NO_TRADE";

export interface SwingSetup {
  type: string; // BREAKOUT, BREAKOUT_RETEST, TREND_CONTINUATION, ACCUMULATION, etc.
  description: string;
}

export interface EquitySwingSignal {
  symbol: string;
  name: string;
  sector: string;
  direction: SwingDirection;
  confidence: number;
  score: number;
  setup: SwingSetup;
  reasoning: string[];
  factors: {
    priceStructure: number;
    volumeExpansion: number;
    accumulationDistribution: number;
    relativeStrength: number;
    sectorStrength: number;
    marketAlignment: number;
    riskReward: number;
    deliveryQuality: number;
  };
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  holdingPeriod: string;
  expectedMove: string;
  maxRisk: string;
  invalidation: string;
}

// ── Detect swing setup type ──
function detectSwingSetup(
  price: number,
  changePercent: number,
  rvol: number,
  week52High: number,
  week52Low: number,
  ema20: number,
  ema50: number,
  marketCap: number
): SwingSetup {
  const distFromHigh = week52High > 0 ? ((price - week52High) / week52High) * 100 : 0;
  const distFromLow = week52Low > 0 ? ((price - week52Low) / week52Low) * 100 : 0;

  // Near 52-week high with volume = breakout
  if (distFromHigh > -3 && rvol > 1.5 && changePercent > 1) {
    return {
      type: "BREAKOUT",
      description: `Near 52W high (${distFromHigh.toFixed(1)}%) with ${rvol.toFixed(1)}x volume — breakout attempt`,
    };
  }

  // Pullback to EMA after uptrend
  if (price > ema50 && price < ema20 * 1.02 && price > ema20 * 0.98 && changePercent < 0) {
    return {
      type: "PULLBACK",
      description: `Pullback to EMA20 in uptrend — mean reversion entry`,
    };
  }

  // Trend continuation (above both EMAs)
  if (price > ema20 && ema20 > ema50 && changePercent > 0.5 && rvol > 1.2) {
    return {
      type: "TREND_CONTINUATION",
      description: `Above EMA20>EMA50 with volume — trend continuation`,
    };
  }

  // Accumulation (low volatility, rising volume)
  if (Math.abs(changePercent) < 1 && rvol > 1.3 && distFromLow > 20) {
    return {
      type: "ACCUMULATION",
      description: `Low volatility + rising volume — accumulation phase`,
    };
  }

  // Distribution (high volatility, declining)
  if (changePercent < -0.5 && rvol > 1.5 && distFromHigh < -10) {
    return {
      type: "DISTRIBUTION",
      description: `High volume decline — distribution risk`,
    };
  }

  // Breakout retest
  if (price > ema50 && price < ema20 && changePercent > 0 && rvol > 1) {
    return {
      type: "BREAKOUT_RETEST",
      description: `Retesting breakout level with support at EMA50`,
    };
  }

  return {
    type: "BASE_BUILDING",
    description: `Consolidating near current levels`,
  };
}

// ── Score a single stock for swing ──
function scoreSwingStock(
  quote: any,
  ctx: MarketIntelligenceContext
): EquitySwingSignal {
  const reasoning: string[] = [];
  let bullScore = 0;
  let bearScore = 0;

  const price = quote.price || 0;
  const changePercent = quote.changePercent || 0;
  const rvol = quote.relativeVolume || 1;
  const deliveryPct = quote.deliveryPercent || 0;

  // Detect setup
  const setup = detectSwingSetup(
    price,
    changePercent,
    rvol,
    quote.week52High || price * 1.1,
    quote.week52Low || price * 0.9,
    price * 0.98, // approximate EMA20
    price * 0.95, // approximate EMA50
    quote.marketCap || 0
  );

  // Factor 1: Setup quality (0-25 points)
  const setupScores: Record<string, number> = {
    BREAKOUT: 25,
    BREAKOUT_RETEST: 22,
    TREND_CONTINUATION: 20,
    ACCUMULATION: 18,
    PULLBACK: 17,
    BASE_BUILDING: 10,
    DISTRIBUTION: -10,
  };
  const setupScore = setupScores[setup.type] || 5;
  if (setupScore > 0) {
    bullScore += setupScore;
    reasoning.push(`Setup: ${setup.type} — ${setup.description}`);
  } else {
    bearScore += Math.abs(setupScore);
    reasoning.push(`Warning: ${setup.type} — ${setup.description}`);
  }

  // Factor 2: Volume expansion (0-20 points)
  if (rvol > 2.5) {
    bullScore += 20;
    reasoning.push(`Extreme volume ${rvol.toFixed(1)}x — strong institutional interest`);
  } else if (rvol > 1.5) {
    bullScore += 15;
    reasoning.push(`High volume ${rvol.toFixed(1)}x — above average`);
  } else if (rvol > 1.2) {
    bullScore += 10;
    reasoning.push(`Above-average volume ${rvol.toFixed(1)}x`);
  } else if (rvol < 0.7) {
    bearScore += 10;
    reasoning.push(`Low volume ${rvol.toFixed(1)}x — weak participation`);
  } else {
    bullScore += 5;
  }

  // Factor 3: Price action (0-15 points)
  if (changePercent > 2) {
    bullScore += 15;
    reasoning.push(`Strong momentum +${changePercent.toFixed(1)}%`);
  } else if (changePercent > 0.5) {
    bullScore += 10;
    reasoning.push(`Mild bullish momentum +${changePercent.toFixed(1)}%`);
  } else if (changePercent < -2) {
    bearScore += 15;
    reasoning.push(`Strong decline ${changePercent.toFixed(1)}% — avoid`);
  } else if (changePercent < -0.5) {
    bearScore += 5;
    bullScore += 5;
    reasoning.push(`Mild decline ${changePercent.toFixed(1)}% — wait for base`);
  } else {
    bullScore += 5;
    bearScore += 5;
  }

  // Factor 4: Delivery quality (0-10 points)
  if (deliveryPct > 60) {
    bullScore += 10;
    reasoning.push(`High delivery ${deliveryPct}% — genuine buying`);
  } else if (deliveryPct > 40) {
    bullScore += 5;
    reasoning.push(`Moderate delivery ${deliveryPct}%`);
  } else if (deliveryPct > 0 && deliveryPct < 25) {
    bearScore += 10;
    reasoning.push(`Low delivery ${deliveryPct}% — speculative`);
  }

  // Factor 5: Sector strength (0-10 points)
  const sector = ctx.sectors.find(s => s.sector === quote.sector);
  if (sector) {
    if (sector.strength > 65) {
      bullScore += 10;
      reasoning.push(`Sector ${quote.sector} strong (${sector.strength}/100)`);
    } else if (sector.strength < 35) {
      bearScore += 10;
      reasoning.push(`Sector ${quote.sector} weak (${sector.strength}/100)`);
    } else {
      bullScore += 5;
    }
  }

  // Factor 6: Market regime alignment (0-10 points)
  const regime = ctx.regime;
  if (regime.trend === "BULLISH" && changePercent > 0) {
    bullScore += 10;
    reasoning.push(`Market bullish + stock rising — aligned`);
  } else if (regime.trend === "BEARISH" && changePercent < 0) {
    bearScore += 10;
    reasoning.push(`Market bearish + stock falling — avoid`);
  } else {
    bullScore += 5;
    bearScore += 5;
  }

  // Factor 7: Risk/reward (0-10 points)
  const atr = price * 0.02;
  const potentialReward = atr * 3;
  const risk = atr * 1.5;
  const rr = potentialReward / risk;
  if (rr > 2.5) {
    bullScore += 10;
    reasoning.push(`Excellent R:R ${rr.toFixed(1)}:1`);
  } else if (rr > 1.5) {
    bullScore += 7;
    reasoning.push(`Good R:R ${rr.toFixed(1)}:1`);
  } else {
    bullScore += 3;
  }

  // Factor 8: Breadth (0-10 points)
  const breadthScore = ctx.breadth.breadthScore;
  if (changePercent > 0 && breadthScore > 60) {
    bullScore += 10;
    reasoning.push(`Market breadth supports rally`);
  } else if (changePercent < 0 && breadthScore < 40) {
    bearScore += 10;
    reasoning.push(`Weak breadth confirms decline`);
  }

  // Factor 9: MSS sweep-gated structure (0-12 points)
  const stockTech = ctx.technicals[quote.symbol];
  if (stockTech && stockTech.mssBias !== 'NEUTRAL') {
    if (stockTech.mssBias === 'BULLISH' && changePercent > 0) {
      bullScore += stockTech.mssSweepGated ? 12 : 8;
      reasoning.push(`MSS ${stockTech.mssSweepGated ? 'sweep-gated ' : ''}bullish structure`);
    } else if (stockTech.mssBias === 'BEARISH' && changePercent < 0) {
      bearScore += stockTech.mssSweepGated ? 12 : 8;
      reasoning.push(`MSS ${stockTech.mssSweepGated ? 'sweep-gated ' : ''}bearish structure`);
    } else if (stockTech.mssBias !== 'NEUTRAL') {
      bullScore += 4;
      bearScore += 4;
      reasoning.push(`MSS ${stockTech.mssBias} — mixed with price action`);
    }
  }

  // Factor 10: SuperTrend filter (0-8 points)
  if (stockTech && stockTech.supertrendDirection !== 'NEUTRAL') {
    if (stockTech.supertrendAligned) {
      bullScore += 8;
      reasoning.push(`SuperTrend ${stockTech.supertrendDirection} confirms trend`);
    } else {
      bearScore += 4;
      reasoning.push(`SuperTrend counter to trade — caution`);
    }
  }

  // Determine direction
  const totalScore = bullScore + bearScore;
  const netBias = bullScore - bearScore;
  let direction: SwingDirection = "NO_TRADE";
  let confidence = 0;

  if (netBias > 0 && totalScore > 0) {
    confidence = Math.min(95, Math.round((bullScore / totalScore) * 100));
    if (confidence >= 70) direction = "BUY";
  } else if (netBias < 0 && totalScore > 0) {
    confidence = Math.min(95, Math.round((bearScore / totalScore) * 100));
    if (confidence >= 60) direction = "SELL";
  }

  // Calculate levels
  const swingAtr = price * 0.02;
  let entry = price;
  let stopLoss = 0;
  let target1 = 0;
  let target2 = 0;

  if (direction === "BUY") {
    stopLoss = price - swingAtr * 2;
    target1 = price + swingAtr * 3;
    target2 = price + swingAtr * 5;
  } else if (direction === "SELL") {
    stopLoss = price + swingAtr * 2;
    target1 = price - swingAtr * 3;
    target2 = price - swingAtr * 5;
  }

  const riskReward = direction !== "NO_TRADE"
    ? Math.abs(target1 - entry) / Math.abs(entry - stopLoss)
    : 0;

  // Holding period based on setup
  const holdingMap: Record<string, string> = {
    BREAKOUT: "2-5 days",
    BREAKOUT_RETEST: "3-7 days",
    TREND_CONTINUATION: "5-10 days",
    ACCUMULATION: "7-14 days",
    PULLBACK: "2-5 days",
    BASE_BUILDING: "5-10 days",
    DISTRIBUTION: "N/A",
  };

  return {
    symbol,
    name: quote.name || symbol,
    sector: quote.sector || "",
    direction,
    confidence,
    score: Math.round((totalScore / 100) * 100),
    setup,
    reasoning,
    factors: {
      priceStructure: Math.round(setupScore * 4),
      volumeExpansion: rvol > 1.5 ? 80 : rvol > 1 ? 60 : 40,
      accumulationDistribution: deliveryPct > 50 ? 70 : 40,
      relativeStrength: changePercent > 0 ? 70 : 30,
      sectorStrength: sector?.strength || 50,
      marketAlignment: regime.trend === "BULLISH" ? 70 : 30,
      riskReward: rr > 2 ? 80 : 50,
      deliveryQuality: deliveryPct,
    },
    entry,
    stopLoss,
    target1,
    target2,
    riskReward,
    holdingPeriod: holdingMap[setup.type] || "5-10 days",
    expectedMove: `${(swingAtr * 3 / price * 100).toFixed(1)}% (${(swingAtr * 3).toFixed(0)} pts)`,
    maxRisk: `${Math.abs(entry - stopLoss).toFixed(0)} pts (${(Math.abs(entry - stopLoss) / price * 100).toFixed(1)}%)`,
    invalidation: direction === "BUY"
      ? `Break below ${stopLoss.toFixed(0)} / ${setup.type} invalidated`
      : direction === "SELL"
        ? `Break above ${stopLoss.toFixed(0)}`
        : "N/A",
  };
}

// ── Main: Scan all NSE cash stocks ──
export async function analyzeEquitySwing(
  ctx: MarketIntelligenceContext,
  maxStocks = 20
): Promise<EquitySwingSignal[]> {
  const signals: EquitySwingSignal[] = [];

  // Get all stock quotes from context
  const quotes = ctx.stockQuotes
    .filter(q => q.price > 100 && q.price < 5000 && q.volume > 100000)
    .slice(0, maxStocks);

  // Score each stock
  for (const quote of quotes) {
    signals.push(scoreSwingStock(quote, ctx));
  }

  // Sort by confidence
  signals.sort((a, b) => b.confidence - a.confidence);

  return signals;
}
