// Market Structure Engine
// Price-action analysis: swing points, BOS, CHoCH, liquidity grabs, S/R levels

import type { CandleData, SwingPoint, StructureEvent, MarketStructure } from '@/types/sdm';

// ─── Swing Point Detection ────────────────────────────────────────
// Fractal method: a swing high is where high[i] > high[i-N..i-1] and high[i] > high[i+1..i+N]
// A swing low is the inverse for lows.

export function detectSwingPoints(
  candles: CandleData[],
  lookback: number = 3
): SwingPoint[] {
  if (candles.length < lookback * 2 + 1) return [];

  const swingPoints: SwingPoint[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const current = candles[i];

    // Check for swing high
    let isSwingHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (current.high <= candles[i - j].high || current.high <= candles[i + j].high) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) {
      swingPoints.push({
        index: i,
        time: current.time,
        price: current.high,
        type: 'HIGH',
      });
    }

    // Check for swing low
    let isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (current.low >= candles[i - j].low || current.low >= candles[i + j].low) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) {
      swingPoints.push({
        index: i,
        time: current.time,
        price: current.low,
        type: 'LOW',
      });
    }
  }

  // Sort by index for chronological order
  swingPoints.sort((a, b) => a.index - b.index);
  return swingPoints;
}

// ─── Structure Event Detection ────────────────────────────────────
// Determines BOS, CHoCH, and liquidity grabs by comparing the last candle's
// close (and wick) against the most recent swing points.

export function detectStructureEvents(
  candles: CandleData[],
  swingPoints: SwingPoint[]
): StructureEvent[] {
  if (candles.length < 2 || swingPoints.length < 2) return [];

  const events: StructureEvent[] = [];
  const lastCandle = candles[candles.length - 1];
  const lastClose = lastCandle.close;
  const lastHigh = lastCandle.high;
  const lastLow = lastCandle.low;
  const lastTime = lastCandle.time;

  // Get the two most recent swing points
  const recentSwings = swingPoints.slice(-2);
  const [prevSwing, lastSwing] = recentSwings;

  // Determine the existing trend direction based on swing point sequence
  // If the last two swing points form higher-highs or higher-lows → uptrend
  // If they form lower-lows or lower-highs → downtrend
  const swingHighs = swingPoints.filter((s) => s.type === 'HIGH');
  const swingLows = swingPoints.filter((s) => s.type === 'LOW');

  let trendDirection: 'BULLISH' | 'BEARISH' = 'BULLISH';
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const recentHighs = swingHighs.slice(-2);
    const recentLows = swingLows.slice(-2);

    const higherHighs = recentHighs[1].price > recentHighs[0].price;
    const higherLows = recentLows[1].price > recentLows[0].price;
    const lowerHighs = recentHighs[1].price < recentHighs[0].price;
    const lowerLows = recentLows[1].price < recentLows[0].price;

    if (higherHighs && higherLows) trendDirection = 'BULLISH';
    else if (lowerHighs && lowerLows) trendDirection = 'BEARISH';
    else if (higherHighs || higherLows) trendDirection = 'BULLISH';
    else trendDirection = 'BEARISH';
  }

  // Check for BOS — break in direction of trend
  if (lastSwing.type === 'HIGH' && trendDirection === 'BULLISH') {
    // Bullish BOS: close above the most recent swing high
    if (lastClose > lastSwing.price) {
      events.push({
        type: 'BOS',
        direction: 'BULLISH',
        price: lastSwing.price,
        time: lastTime,
        swingHigh: lastSwing.price,
      });
    }
  } else if (lastSwing.type === 'LOW' && trendDirection === 'BEARISH') {
    // Bearish BOS: close below the most recent swing low
    if (lastClose < lastSwing.price) {
      events.push({
        type: 'BOS',
        direction: 'BEARISH',
        price: lastSwing.price,
        time: lastTime,
        swingLow: lastSwing.price,
      });
    }
  }

  // Check for CHoCH — break against the trend direction
  if (lastSwing.type === 'LOW' && trendDirection === 'BULLISH') {
    // Price broke below a swing low while in uptrend → bearish CHoCH
    if (lastClose < lastSwing.price) {
      events.push({
        type: 'CHoCH',
        direction: 'BEARISH',
        price: lastSwing.price,
        time: lastTime,
        swingLow: lastSwing.price,
      });
    }
  } else if (lastSwing.type === 'HIGH' && trendDirection === 'BEARISH') {
    // Price broke above a swing high while in downtrend → bullish CHoCH
    if (lastClose > lastSwing.price) {
      events.push({
        type: 'CHoCH',
        direction: 'BULLISH',
        price: lastSwing.price,
        time: lastTime,
        swingHigh: lastSwing.price,
      });
    }
  }

  // Check for liquidity grabs — wick beyond swing point but fail to close beyond it
  for (const swing of recentSwings) {
    if (swing.type === 'HIGH') {
      // Wick above swing high but close below it → bearish liquidity grab
      if (lastHigh > swing.price && lastClose < swing.price) {
        events.push({
          type: 'LIQUIDITY_GRAB',
          direction: 'BEARISH',
          price: swing.price,
          time: lastTime,
          swingHigh: swing.price,
        });
      }
    } else {
      // Wick below swing low but close above it → bullish liquidity grab
      if (lastLow < swing.price && lastClose > swing.price) {
        events.push({
          type: 'LIQUIDITY_GRAB',
          direction: 'BULLISH',
          price: swing.price,
          time: lastTime,
          swingLow: swing.price,
        });
      }
    }
  }

  return events;
}

// ─── Main Entry Point ─────────────────────────────────────────────

export function analyzeMarketStructure(
  candles: CandleData[],
  lookback: number = 3
): MarketStructure {
  const status: 'OK' | 'DEGRADED' = candles.length < 10 ? 'DEGRADED' : 'OK';
  const swingPoints = detectSwingPoints(candles, lookback);
  const events = detectStructureEvents(candles, swingPoints);

  // Determine trend
  const swingHighs = swingPoints.filter((s) => s.type === 'HIGH');
  const swingLows = swingPoints.filter((s) => s.type === 'LOW');

  let trend: 'UPTREND' | 'DOWNTREND' | 'RANGING' = 'RANGING';

  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const recentHighs = swingHighs.slice(-2);
    const recentLows = swingLows.slice(-2);

    const higherHighs = recentHighs[1].price > recentHighs[0].price;
    const higherLows = recentLows[1].price > recentLows[0].price;
    const lowerHighs = recentHighs[1].price < recentHighs[0].price;
    const lowerLows = recentLows[1].price < recentLows[0].price;

    if (higherHighs && higherLows) trend = 'UPTREND';
    else if (lowerHighs && lowerLows) trend = 'DOWNTREND';
  }

  const lastSwingHigh = swingHighs.length > 0 ? swingHighs[swingHighs.length - 1].price : 0;
  const lastSwingLow = swingLows.length > 0 ? swingLows[swingLows.length - 1].price : 0;

  // Support = swing lows below current price, sorted closest first
  const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : 0;
  const supportLevels = swingLows
    .filter((s) => s.price < currentPrice)
    .map((s) => s.price)
    .sort((a, b) => b - a); // closest below first

  // Resistance = swing highs above current price, sorted closest first
  const resistanceLevels = swingHighs
    .filter((s) => s.price > currentPrice)
    .map((s) => s.price)
    .sort((a, b) => a - b); // closest above first

  const structureEvent = events.length > 0 ? events[events.length - 1] : null;

  return {
    trend,
    swingPoints,
    lastSwingHigh,
    lastSwingLow,
    structureEvent,
    supportLevels,
    resistanceLevels,
    status,
  };
}
