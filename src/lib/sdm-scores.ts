// sdm-scores.ts — 14-Factor AI Trade Quality Score Engine
// Computes a composite 0-100 quality score from 14 weighted factors.
// Each factor independently scored 0-100 with direction (CALL/PUT/NEUTRAL).

import type {
  QualityScoreFactor,
  QualityScore,
  QualityScoreInput,
  SDMOptionStrike,
  TradeGrade,
} from '@/types/sdm';

// ─── Helpers ──────────────────────────────────────────────────────

function findATMStrike(chain: SDMOptionStrike[], spot: number): SDMOptionStrike | null {
  if (chain.length === 0) return null;
  return chain.reduce((best, s) =>
    Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best
  );
}

function getGrade(score: number): TradeGrade {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

function getISTMinutes(): number {
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function degraded(
  name: string,
  weight: number,
  source: string,
  reason: string
): QualityScoreFactor {
  return {
    name,
    score: 50,
    weight,
    weightedScore: 50 * weight,
    detail: reason,
    source,
    direction: 'NEUTRAL',
  };
}

// ─── Factor 1: Trend (15%) ────────────────────────────────────────
// Market Structure trend direction/strength

function scoreTrend(input: QualityScoreInput): QualityScoreFactor {
  const { marketStructure, tradeDirection } = input;
  const w = 0.15;

  if (marketStructure.status === 'DEGRADED') {
    return degraded(
      'Trend',
      w,
      'Market Structure',
      'Market structure data degraded — defaulting to neutral'
    );
  }

  const trend = marketStructure.trend;
  const isCall = tradeDirection === 'CALL';
  let score: number;
  let direction: 'CALL' | 'PUT' | 'NEUTRAL';

  if (trend === 'UPTREND') {
    score = isCall ? 85 : 25;
    direction = 'CALL';
  } else if (trend === 'DOWNTREND') {
    score = isCall ? 25 : 85;
    direction = 'PUT';
  } else {
    score = 45;
    direction = 'NEUTRAL';
  }

  return {
    name: 'Trend',
    score,
    weight: w,
    weightedScore: score * w,
    detail: `${trend} — ${isCall ? 'bullish' : 'bearish'} trend ${score >= 60 ? 'supports' : 'opposes'} ${tradeDirection} entry`,
    source: 'Market Structure',
    direction,
  };
}

// ─── Factor 2: Market Structure (15%) ─────────────────────────────
// BOS/CHoCH alignment with trade direction

function scoreMarketStructure(input: QualityScoreInput): QualityScoreFactor {
  const { marketStructure, tradeDirection } = input;
  const w = 0.15;

  if (marketStructure.status === 'DEGRADED') {
    return degraded(
      'Market Structure',
      w,
      'Market Structure',
      'Market structure data degraded — defaulting to neutral'
    );
  }

  const event = marketStructure.structureEvent;
  const isCall = tradeDirection === 'CALL';

  if (!event) {
    return {
      name: 'Market Structure',
      score: 40,
      weight: w,
      weightedScore: 40 * w,
      detail: 'No structure event detected — neutral',
      source: 'Market Structure',
      direction: 'NEUTRAL',
    };
  }

  const eventBullish = event.direction === 'BULLISH';
  const alignedWithTrade = (isCall && eventBullish) || (!isCall && !eventBullish);

  let score: number;
  if (event.type === 'BOS' && alignedWithTrade) {
    score = 85;
  } else if (event.type === 'CHoCH' && alignedWithTrade) {
    score = 75;
  } else if (event.type === 'CHoCH' && !alignedWithTrade) {
    score = 20;
  } else if (event.type === 'BOS' && !alignedWithTrade) {
    score = 25;
  } else {
    score = 40;
  }

  return {
    name: 'Market Structure',
    score,
    weight: w,
    weightedScore: score * w,
    detail: `${event.type} ${event.direction} at ${event.price} — ${alignedWithTrade ? 'aligned with' : 'opposes'} ${tradeDirection}`,
    source: 'Market Structure',
    direction: eventBullish ? 'CALL' : 'PUT',
  };
}

// ─── Factor 3: Volume (10%) ───────────────────────────────────────
// Cumulative delta, absorption, exhaustion

function scoreVolume(input: QualityScoreInput): QualityScoreFactor {
  const { volumeAnalysis, tradeDirection } = input;
  const w = 0.10;

  if (volumeAnalysis.status === 'DEGRADED') {
    return degraded(
      'Volume',
      w,
      'Volume Analysis',
      'Volume analysis data degraded — defaulting to neutral'
    );
  }

  const delta = volumeAnalysis.cumulativeDelta;
  const isCall = tradeDirection === 'CALL';
  const positiveDelta = delta > 0;

  let score: number;
  if ((positiveDelta && isCall) || (!positiveDelta && !isCall)) {
    score = 80;
  } else {
    score = 30;
  }

  const details: string[] = [];

  // Absorption bonus: absorption in trade direction → +15
  const hasAbsorptionInDirection = volumeAnalysis.absorptionLevels.some(
    (a) => (isCall && a.side === 'BUY') || (!isCall && a.side === 'SELL')
  );
  if (hasAbsorptionInDirection) {
    score += 15;
    details.push('absorption supports');
  }

  // Exhaustion penalty: exhaustion against trade direction → -20
  const hasExhaustionAgainst = volumeAnalysis.exhaustionSignals.some(
    (e) =>
      (isCall && e.type === 'BUY_EXHAUSTION') ||
      (!isCall && e.type === 'SELL_EXHAUSTION')
  );
  if (hasExhaustionAgainst) {
    score -= 20;
    details.push('exhaustion warns');
  }

  score = clamp(score);

  const deltaStr = `${delta > 0 ? '+' : ''}${delta.toFixed(0)}`;
  const extra = details.length > 0 ? ` — ${details.join(', ')}` : ' — no absorption/exhaustion signals';

  return {
    name: 'Volume',
    score,
    weight: w,
    weightedScore: score * w,
    detail: `Cumulative delta ${deltaStr}${extra}`,
    source: 'Volume Analysis',
    direction: positiveDelta ? 'CALL' : 'PUT',
  };
}

// ─── Factor 4: OI (10%) ───────────────────────────────────────────
// OI build-up patterns aligned with direction

function scoreOI(input: QualityScoreInput): QualityScoreFactor {
  const { oiAnalysis, tradeDirection } = input;
  const w = 0.10;

  if (oiAnalysis.status === 'DEGRADED') {
    return degraded(
      'OI',
      w,
      'OI Analysis',
      'OI analysis data degraded — defaulting to neutral'
    );
  }

  let bullishCount = 0;
  let bearishCount = 0;

  for (const cls of oiAnalysis.classifications) {
    // CALL side: LONG_BUILDUP = bullish, SHORT_BUILDUP = bearish
    if (cls.callPattern === 'LONG_BUILDUP') bullishCount++;
    if (cls.callPattern === 'SHORT_BUILDUP') bearishCount++;
    // PUT side: LONG_BUILDUP = bearish (put buyers expect drop), SHORT_BUILDUP = bullish (put sellers support)
    if (cls.putPattern === 'LONG_BUILDUP') bearishCount++;
    if (cls.putPattern === 'SHORT_BUILDUP') bullishCount++;
  }

  const isCall = tradeDirection === 'CALL';
  let score: number;
  let direction: 'CALL' | 'PUT' | 'NEUTRAL';

  if (bullishCount > bearishCount) {
    score = isCall ? 80 : 35;
    direction = 'CALL';
  } else if (bearishCount > bullishCount) {
    score = isCall ? 35 : 80;
    direction = 'PUT';
  } else {
    score = 45;
    direction = 'NEUTRAL';
  }

  return {
    name: 'OI',
    score,
    weight: w,
    weightedScore: score * w,
    detail: `Bullish patterns: ${bullishCount}, Bearish patterns: ${bearishCount} — ${direction === 'NEUTRAL' ? 'balanced' : direction + '-leaning'}`,
    source: 'OI Analysis',
    direction,
  };
}

// ─── Factor 5: OI Change (5%) ─────────────────────────────────────
// Fresh writing/unwinding detection

function scoreOIChange(input: QualityScoreInput): QualityScoreFactor {
  const { oiAnalysis, tradeDirection } = input;
  const w = 0.05;

  if (oiAnalysis.status === 'DEGRADED') {
    return degraded(
      'OI Change',
      w,
      'OI Analysis',
      'OI analysis data degraded — defaulting to neutral'
    );
  }

  const freshWriting = oiAnalysis.freshWriting;
  const isCall = tradeDirection === 'CALL';

  const callWriting = freshWriting.filter(
    (f) => f.type === 'FRESH_CALL_WRITING'
  );
  const putWriting = freshWriting.filter(
    (f) => f.type === 'FRESH_PUT_WRITING'
  );

  // Fresh PUT writing = bullish (supports CALL), Fresh CALL writing = bearish (supports PUT)
  const inDirection = isCall ? putWriting.length : callWriting.length;
  const againstDirection = isCall ? callWriting.length : putWriting.length;

  let score: number;
  let direction: 'CALL' | 'PUT' | 'NEUTRAL';

  if (inDirection > 0 && inDirection > againstDirection) {
    score = 85;
    direction = isCall ? 'CALL' : 'PUT';
  } else if (againstDirection > 0 && againstDirection > inDirection) {
    score = 20;
    direction = isCall ? 'PUT' : 'CALL';
  } else if (freshWriting.length === 0) {
    score = 40;
    direction = 'NEUTRAL';
  } else {
    score = 45;
    direction = 'NEUTRAL';
  }

  const alignment =
    inDirection > againstDirection
      ? 'aligned with'
      : againstDirection > inDirection
        ? 'opposes'
        : 'no clear signal vs';

  return {
    name: 'OI Change',
    score,
    weight: w,
    weightedScore: score * w,
    detail: `Fresh writing: ${callWriting.length} CE, ${putWriting.length} PE — ${alignment} ${tradeDirection}`,
    source: 'OI Analysis',
    direction,
  };
}

// ─── Factor 6: Greeks (10%) ───────────────────────────────────────
// Delta/gamma favorable, theta decay acceptable

function scoreGreeks(input: QualityScoreInput): QualityScoreFactor {
  const { optionChain, spot, tradeDirection } = input;
  const w = 0.10;

  const atm = findATMStrike(optionChain, spot);
  if (!atm) {
    return degraded(
      'Greeks',
      w,
      'Greeks',
      'No ATM strike found — defaulting to neutral'
    );
  }

  const isCall = tradeDirection === 'CALL';
  const leg = isCall ? atm.ce : atm.pe;

  if (!leg) {
    return degraded(
      'Greeks',
      w,
      'Greeks',
      `${tradeDirection} leg data missing at ATM strike ${atm.strike}`
    );
  }

  let score = 50;
  let direction: 'CALL' | 'PUT' | 'NEUTRAL' = 'NEUTRAL';

  // Delta favorable: positive for CALL, negative for PUT → 70
  const deltaFavorable = isCall ? leg.delta > 0 : leg.delta < 0;
  if (deltaFavorable) {
    score = 70;
    direction = isCall ? 'CALL' : 'PUT';
  }

  // Gamma positive for mean reversion → +10
  if (leg.gamma > 0) {
    score += 10;
  }

  // Theta decay < 5% of premium for expected hold (~1 hour = 1/24 day) → +10
  const expectedDecay = Math.abs(leg.theta) / 24;
  const premium = leg.ltp;
  if (premium > 0 && expectedDecay / premium < 0.05) {
    score += 10;
  }

  score = clamp(score);

  return {
    name: 'Greeks',
    score,
    weight: w,
    weightedScore: score * w,
    detail: `ATM ${atm.strike} ${tradeDirection} — delta ${leg.delta}, gamma ${leg.gamma}, theta ${leg.theta}/day`,
    source: 'Greeks',
    direction,
  };
}

// ─── Factor 7: VWAP (10%) ─────────────────────────────────────────
// Price relative to VWAP alignment (uses POC as proxy)

function scoreVWAP(input: QualityScoreInput): QualityScoreFactor {
  const { volumeAnalysis, spot, tradeDirection } = input;
  const w = 0.10;

  if (volumeAnalysis.status === 'DEGRADED' || volumeAnalysis.poc === 0) {
    return degraded(
      'VWAP',
      w,
      'Volume Analysis',
      'VWAP/POC data degraded — defaulting to neutral'
    );
  }

  const poc = volumeAnalysis.poc;
  const isCall = tradeDirection === 'CALL';
  const abovePOC = spot > poc;

  let score: number;
  let direction: 'CALL' | 'PUT' | 'NEUTRAL';

  if (abovePOC && isCall) {
    score = 80;
    direction = 'CALL';
  } else if (!abovePOC && !isCall) {
    score = 80;
    direction = 'PUT';
  } else if (abovePOC && !isCall) {
    score = 35;
    direction = 'CALL';
  } else {
    score = 35;
    direction = 'PUT';
  }

  return {
    name: 'VWAP',
    score,
    weight: w,
    weightedScore: score * w,
    detail: `Spot ${spot} ${abovePOC ? 'above' : 'below'} POC ${poc} — ${abovePOC ? 'bullish' : 'bearish'} positioning`,
    source: 'Volume Analysis (POC proxy)',
    direction,
  };
}

// ─── Factor 8: Liquidity (5%) ─────────────────────────────────────
// Bid-ask spread, OI depth at strike

function scoreLiquidity(input: QualityScoreInput): QualityScoreFactor {
  const { optionChain, spot, tradeDirection } = input;
  const w = 0.05;

  const atm = findATMStrike(optionChain, spot);
  if (!atm) {
    return degraded(
      'Liquidity',
      w,
      'Option Chain',
      'No ATM strike found — defaulting to neutral'
    );
  }

  const isCall = tradeDirection === 'CALL';
  const leg = isCall ? atm.ce : atm.pe;

  if (!leg) {
    return degraded(
      'Liquidity',
      w,
      'Option Chain',
      `${tradeDirection} leg data missing at ATM strike ${atm.strike}`
    );
  }

  // Compute average OI and volume across all strikes for this side
  let totalOI = 0;
  let totalVolume = 0;
  let count = 0;

  for (const s of optionChain) {
    const l = isCall ? s.ce : s.pe;
    if (l) {
      totalOI += l.oi;
      totalVolume += l.volume;
      count++;
    }
  }

  const avgOI = count > 0 ? totalOI / count : 0;
  const avgVolume = count > 0 ? totalVolume / count : 0;

  let score = 50;
  // OI at selected strike > average → 70
  if (leg.oi > avgOI && avgOI > 0) {
    score = 70;
  }
  // Volume at selected strike > average → +10
  if (leg.volume > avgVolume && avgVolume > 0) {
    score += 10;
  }

  score = clamp(score);

  return {
    name: 'Liquidity',
    score,
    weight: w,
    weightedScore: score * w,
    detail: `ATM ${atm.strike} ${tradeDirection} — OI ${leg.oi} (avg ${avgOI.toFixed(0)}), Vol ${leg.volume} (avg ${avgVolume.toFixed(0)})`,
    source: 'Option Chain',
    direction: 'NEUTRAL',
  };
}

// ─── Factor 9: Gamma Exposure (5%) ────────────────────────────────
// GEX regime alignment

function scoreGammaExposure(input: QualityScoreInput): QualityScoreFactor {
  const { gexResult, tradeDirection } = input;
  const w = 0.05;

  if (gexResult.status === 'DEGRADED') {
    return degraded(
      'Gamma Exposure',
      w,
      'GEX Engine',
      'GEX data degraded — defaulting to neutral'
    );
  }

  const regime = gexResult.dealerRegime;
  const isCall = tradeDirection === 'CALL';

  // LONG_GAMMA + CALL → 75 (mean reversion favors)
  // SHORT_GAMMA + PUT → 75 (trending favors)
  // Opposite → 30
  let score: number;
  let direction: 'CALL' | 'PUT' | 'NEUTRAL';

  if (
    (regime === 'LONG_GAMMA' && isCall) ||
    (regime === 'SHORT_GAMMA' && !isCall)
  ) {
    score = 75;
    direction = isCall ? 'CALL' : 'PUT';
  } else {
    score = 30;
    direction = isCall ? 'PUT' : 'CALL';
  }

  return {
    name: 'Gamma Exposure',
    score,
    weight: w,
    weightedScore: score * w,
    detail: `${regime} regime — ${score >= 60 ? 'favors' : 'opposes'} ${tradeDirection} (gamma flip at ${gexResult.gammaFlip.toFixed(0)})`,
    source: 'GEX Engine',
    direction,
  };
}

// ─── Factor 10: Dealer Positioning (5%) ───────────────────────────
// Dealer bias direction

function scoreDealerPositioning(input: QualityScoreInput): QualityScoreFactor {
  const { gexResult, tradeDirection } = input;
  const w = 0.05;

  if (gexResult.status === 'DEGRADED') {
    return degraded(
      'Dealer Positioning',
      w,
      'GEX Engine',
      'GEX data degraded — defaulting to neutral'
    );
  }

  const bias = gexResult.dealerBias;
  const isCall = tradeDirection === 'CALL';
  const matches =
    (isCall && bias === 'BULLISH') || (!isCall && bias === 'BEARISH');

  const score = matches ? 80 : bias === 'NEUTRAL' ? 50 : 20;
  const direction: 'CALL' | 'PUT' | 'NEUTRAL' =
    bias === 'BULLISH' ? 'CALL' : bias === 'BEARISH' ? 'PUT' : 'NEUTRAL';

  return {
    name: 'Dealer Positioning',
    score,
    weight: w,
    weightedScore: score * w,
    detail: `Dealer bias ${bias} — ${matches ? 'aligned with' : bias === 'NEUTRAL' ? 'neutral vs' : 'opposes'} ${tradeDirection}`,
    source: 'GEX Engine',
    direction,
  };
}

// ─── Factor 11: Volatility (5%) ───────────────────────────────────
// IV regime — not too high or too low

function scoreVolatility(input: QualityScoreInput): QualityScoreFactor {
  const { vix } = input;
  const w = 0.05;

  let score: number;
  let regime: string;

  if (vix >= 12 && vix <= 20) {
    score = 70;
    regime = 'ideal range';
  } else if (vix > 25) {
    score = 40;
    regime = 'elevated — expensive premiums';
  } else if (vix < 10) {
    score = 40;
    regime = 'too low — limited move potential';
  } else if (vix > 20 && vix <= 25) {
    score = 55;
    regime = 'moderate-high';
  } else {
    // vix 10-12
    score = 55;
    regime = 'low-moderate';
  }

  return {
    name: 'Volatility',
    score,
    weight: w,
    weightedScore: score * w,
    detail: `VIX ${vix.toFixed(1)} — ${regime}`,
    source: 'VIX',
    direction: 'NEUTRAL',
  };
}

// ─── Factor 12: Risk:Reward (5%) ──────────────────────────────────
// R:R ratio quality

function scoreRiskReward(input: QualityScoreInput): QualityScoreFactor {
  const { entryPrice, stopLoss, target1 } = input;
  const w = 0.05;

  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(target1 - entryPrice);

  if (risk === 0) {
    return {
      name: 'Risk:Reward',
      score: 85,
      weight: w,
      weightedScore: 85 * w,
      detail: 'No risk defined (entry = SL) — unlimited R:R',
      source: 'Trade Setup',
      direction: 'NEUTRAL',
    };
  }

  const rr = reward / risk;
  let score: number;

  if (rr >= 3) {
    score = 85;
  } else if (rr >= 2) {
    score = 70;
  } else if (rr >= 1.5) {
    score = 50;
  } else if (rr >= 1) {
    score = 35;
  } else {
    score = 20;
  }

  return {
    name: 'Risk:Reward',
    score,
    weight: w,
    weightedScore: score * w,
    detail: `R:R 1:${rr.toFixed(1)} — risk ${risk.toFixed(0)} pts, reward ${reward.toFixed(0)} pts`,
    source: 'Trade Setup',
    direction: 'NEUTRAL',
  };
}

// ─── Factor 13: Time of Day (5%) ──────────────────────────────────
// Session window quality (IST)

function scoreTimeOfDay(_input: QualityScoreInput): QualityScoreFactor {
  const w = 0.05;
  const mins = getISTMinutes();
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const timeStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;

  let score: number;
  let detail: string;

  if (mins >= 630 && mins < 750) {
    // 10:30 - 12:30
    score = 80;
    detail = `${timeStr} IST — prime trading window`;
  } else if (mins >= 570 && mins < 630) {
    // 09:30 - 10:30
    score = 65;
    detail = `${timeStr} IST — early session, volume building`;
  } else if (mins >= 750 && mins < 825) {
    // 12:30 - 13:45
    score = 50;
    detail = `${timeStr} IST — post-lunch session`;
  } else if (mins >= 825 && mins < 900) {
    // 13:45 - 15:00
    score = 55;
    detail = `${timeStr} IST — afternoon session`;
  } else if (mins >= 900 && mins <= 930) {
    // 15:00 - 15:30
    score = 30;
    detail = `${timeStr} IST — closing window, elevated risk`;
  } else {
    score = 20;
    detail = `${timeStr} IST — outside market hours`;
  }

  return {
    name: 'Time of Day',
    score,
    weight: w,
    weightedScore: score * w,
    detail,
    source: 'Clock',
    direction: 'NEUTRAL',
  };
}

// ─── Factor 14: Spread (5%) ───────────────────────────────────────
// Bid-ask spread / mid

function scoreSpread(input: QualityScoreInput): QualityScoreFactor {
  const { optionChain, spot, tradeDirection } = input;
  const w = 0.05;

  const atm = findATMStrike(optionChain, spot);
  if (!atm) {
    return degraded(
      'Spread',
      w,
      'Option Chain',
      'No ATM strike found — defaulting to neutral'
    );
  }

  const isCall = tradeDirection === 'CALL';
  const leg = isCall ? atm.ce : atm.pe;

  if (!leg || leg.bid == null || leg.ask == null) {
    return {
      name: 'Spread',
      score: 50,
      weight: w,
      weightedScore: 50 * w,
      detail: `Bid/ask data not available at ATM ${atm.strike} — neutral`,
      source: 'Option Chain',
      direction: 'NEUTRAL',
    };
  }

  const spread = leg.ask - leg.bid;
  const mid = (leg.ask + leg.bid) / 2;
  const spreadPct = mid > 0 ? (spread / mid) * 100 : 0;

  let score: number;
  if (spreadPct < 1) {
    score = 80;
  } else if (spreadPct < 2) {
    score = 60;
  } else if (spreadPct < 3) {
    score = 45;
  } else {
    score = 25;
  }

  return {
    name: 'Spread',
    score,
    weight: w,
    weightedScore: score * w,
    detail: `ATM ${atm.strike} ${tradeDirection} — spread ${spread.toFixed(1)} (${spreadPct.toFixed(1)}% of mid ${mid.toFixed(1)})`,
    source: 'Option Chain',
    direction: 'NEUTRAL',
  };
}

// ─── Main Entry Point ─────────────────────────────────────────────

export function computeQualityScore(input: QualityScoreInput): QualityScore {
  const factors: QualityScoreFactor[] = [
    scoreTrend(input),
    scoreMarketStructure(input),
    scoreVolume(input),
    scoreOI(input),
    scoreOIChange(input),
    scoreGreeks(input),
    scoreVWAP(input),
    scoreLiquidity(input),
    scoreGammaExposure(input),
    scoreDealerPositioning(input),
    scoreVolatility(input),
    scoreRiskReward(input),
    scoreTimeOfDay(input),
    scoreSpread(input),
  ];

  const overall = factors.reduce((sum, f) => sum + f.weightedScore, 0);
  const clampedOverall = clamp(overall);

  const bullishFactors = factors.filter((f) => f.direction === 'CALL').length;
  const bearishFactors = factors.filter((f) => f.direction === 'PUT').length;

  const anyDegraded = factors.some(
    (f) =>
      f.detail.includes('degraded') ||
      f.detail.includes('defaulting to neutral') ||
      f.detail.includes('data missing')
  );

  return {
    overall: clampedOverall,
    grade: getGrade(clampedOverall),
    factors,
    bullishFactors,
    bearishFactors,
    status: anyDegraded ? 'DEGRADED' : 'OK',
  };
}
