import type { EngineScore, OpenInterestData } from '@/types/engine';

export function evaluateOpenInterest(
  oiData: {
    symbol: string;
    openInterest: number | null;
    openInterestValue: number | null;
    oiChange5m: number | null;
    oiChange15m: number | null;
    oiChange1h: number | null;
    oiChange4h: number | null;
    oiChange24h: number | null;
    oiHistory: Array<{ time: number; oi: number; value: number }>;
    takerBuyRatio: number | null;
    buyVol: number | null;
    sellVol: number | null;
  } | null,
  price: number,
  prevPrice: number,
): { data: OpenInterestData; score: EngineScore } {
  if (!oiData || oiData.openInterest === null) {
    return {
      data: {
        currentOi: null, oi5m: null, oi15m: null, oi1h: null, oi4h: null, oi24h: null,
        oiChange: null, oiMomentum: null,
        longBuildUp: false, shortBuildUp: false, shortCovering: false, longUnwinding: false,
        oiTrend: 'neutral',
      },
      score: {
        score: 50, confidence: 0, bullishProb: 33, bearishProb: 33, neutralProb: 34,
        reasons: ['OI data unavailable'],
      },
    };
  }

  const {
    openInterest, openInterestValue,
    oiChange5m, oiChange15m, oiChange1h, oiChange4h, oiChange24h,
    oiHistory, takerBuyRatio, buyVol, sellVol,
  } = oiData;

  // Determine OI trend
  const positiveChanges = [oiChange5m, oiChange15m, oiChange1h].filter(c => c !== null && c > 0).length;
  const negativeChanges = [oiChange5m, oiChange15m, oiChange1h].filter(c => c !== null && c < 0).length;
  const oiTrend = positiveChanges >= 2 ? 'rising' : negativeChanges >= 2 ? 'falling' : 'neutral';

  // Price direction
  const priceUp = price > prevPrice;

  // OI momentum (acceleration of OI change)
  const oiMomentum = oiChange5m !== null && oiChange15m !== null
    ? oiChange5m - oiChange15m
    : null;

  // OI + Price analysis for sentiment
  const oiRising = oiTrend === 'rising';
  const longBuildUp = oiRising && priceUp;
  const shortBuildUp = oiRising && !priceUp;
  const shortCovering = !oiRising && priceUp;
  const longUnwinding = !oiRising && !priceUp;

  // Scoring
  const reasons: string[] = [];
  let bullish = 50;
  let bearish = 50;

  if (openInterest > 0) {
    reasons.push(`OI: ${openInterest.toFixed(1)} ${symbol.replace('USDT', '')} ($${(openInterestValue! / 1e9).toFixed(2)}B)`);
  }

  if (oiChange5m !== null) {
    if (oiChange5m > 0.5) {
      bullish += 10;
      reasons.push(`OI +${oiChange5m.toFixed(2)}% (5m)`);
    } else if (oiChange5m < -0.5) {
      bearish += 10;
      reasons.push(`OI ${oiChange5m.toFixed(2)}% (5m)`);
    }
  }

  if (oiChange1h !== null) {
    if (oiChange1h > 2) {
      bullish += 10;
      reasons.push(`OI +${oiChange1h.toFixed(2)}% (1h)`);
    } else if (oiChange1h < -2) {
      bearish += 10;
      reasons.push(`OI ${oiChange1h.toFixed(2)}% (1h)`);
    }
  }

  if (takerBuyRatio !== null) {
    if (takerBuyRatio > 1.1) {
      bullish += 15;
      reasons.push(`Taker buy ratio: ${takerBuyRatio.toFixed(3)}`);
    } else if (takerBuyRatio < 0.9) {
      bearish += 15;
      reasons.push(`Taker buy ratio: ${takerBuyRatio.toFixed(3)}`);
    }
  }

  if (longBuildUp) {
    bullish += 10;
    reasons.push('OI + Price ↑ = Long Build-up');
  } else if (shortBuildUp) {
    bearish += 10;
    reasons.push('OI ↑ + Price ↓ = Short Build-up');
  } else if (shortCovering) {
    bullish += 5;
    reasons.push('OI ↓ + Price ↑ = Short Covering');
  } else if (longUnwinding) {
    bearish += 5;
    reasons.push('OI ↓ + Price ↓ = Long Unwinding');
  }

  const total = bullish + bearish;
  const bullishPct = total > 0 ? (bullish / total) * 100 : 50;
  const bearishPct = total > 0 ? (bearish / total) * 100 : 50;
  const confidence = Math.min(1, oiHistory.length / 20);

  return {
    data: {
      currentOi: openInterest,
      oi5m: oiChange5m,
      oi15m: oiChange15m,
      oi1h: oiChange1h,
      oi4h: oiChange4h,
      oi24h: oiChange24h,
      oiChange: oiChange5m,
      oiMomentum,
      longBuildUp, shortBuildUp, shortCovering, longUnwinding,
      oiTrend,
    },
    score: {
      score: Math.max(0, Math.min(100, bullish)),
      confidence,
      bullishProb: Math.round(bullishPct),
      bearishProb: Math.round(bearishPct),
      neutralProb: Math.round(Math.max(0, 100 - bullishPct - bearishPct)),
      reasons,
    },
  };
}
