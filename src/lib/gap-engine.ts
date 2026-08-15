// Gap Engine - Detects gap types, gap fill, gap-and-go/fail

import { Candle, GapType, GapInfo } from './auction-types';

export interface GapConfig {
  minGapPercent: number; // minimum gap to consider
  fillThreshold: number; // price tolerance for fill
}

const DEFAULT_GAP_CONFIG: GapConfig = {
  minGapPercent: 0.005, // 0.5%
  fillThreshold: 0.001, // 0.1%
};

export function detectGaps(candles: Candle[], config: Partial<GapConfig> = {}): GapInfo[] {
  const cfg = { ...DEFAULT_GAP_CONFIG, ...config };
  const gaps: GapInfo[] = [];

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];

    const gapSize = curr.open - prev.close;
    const gapPercent = Math.abs(gapSize) / prev.close;

    if (gapPercent < cfg.minGapPercent) continue;

    let type: GapType;
    let openedAbove = curr.open > prev.close;

    if (gapSize > 0) {
      // Gap up
      if (curr.low <= prev.close) type = 'PARTIAL_GAP_UP';
      else type = 'FULL_GAP_UP';
    } else {
      // Gap down
      if (curr.high >= prev.close) type = 'PARTIAL_GAP_DOWN';
      else type = 'FULL_GAP_DOWN';
    }

    // Check for fill
    let filled = false;
    let fillTime: number | undefined;
    let fillPrice: number | undefined;

    for (let j = i; j < candles.length; j++) {
      const c = candles[j];
      if (openedAbove) {
        if (c.low <= prev.close + prev.close * cfg.fillThreshold) {
          filled = true;
          fillTime = c.time;
          fillPrice = prev.close;
          break;
        }
      } else {
        if (c.high >= prev.close - prev.close * cfg.fillThreshold) {
          filled = true;
          fillTime = c.time;
          fillPrice = prev.close;
          break;
        }
      }
    }

    // Determine gap-and-go vs gap-and-fail
    const gapAndGo = (type === 'FULL_GAP_UP' || type === 'FULL_GAP_DOWN') &&
      candles[i].close > candles[i].open === openedAbove;

    gaps.push({
      type,
      gapSize: Math.abs(gapSize),
      gapPercent,
      openedAbove,
      filled,
      fillTime,
      fillPrice,
      gapAndGo,
    });
  }

  return gaps;
}

export function classifyGapBehavior(
  gap: GapInfo,
  sessionCandles: Candle[],
  vwap: number,
  openingRange: { high: number; low: number }
): {
  behavior: 'GAP_AND_GO' | 'GAP_AND_FAIL' | 'GAP_FILL' | 'GAP_REVERSAL' | 'NEUTRAL';
  confidence: number;
} {
  if (gap.filled) {
    // Check if filled quickly (within first hour)
    const firstHourCandles = sessionCandles.slice(0, 60);
    const filledEarly = firstHourCandles.some(c =>
      gap.openedAbove ? c.low <= gap.fillPrice! : c.high >= gap.fillPrice!
    );
    if (filledEarly) return { behavior: 'GAP_REVERSAL', confidence: 0.8 };
    return { behavior: 'GAP_FILL', confidence: 0.7 };
  }

  // Gap and go: strong move in gap direction
  const firstCandle = sessionCandles[0];
  const movedInGapDirection = gap.openedAbove
    ? firstCandle.close > firstCandle.open
    : firstCandle.close < firstCandle.open;

  const aboveVWAP = firstCandle.close > gap.fillPrice! === gap.openedAbove;
  const brokeOpeningRange = gap.openedAbove
    ? sessionCandles.some(c => c.high > openingRange.high)
    : sessionCandles.some(c => c.low < openingRange.low);

  if (movedInGapDirection && aboveVWAP && brokeOpeningRange) {
    return { behavior: 'GAP_AND_GO', confidence: 0.85 };
  }

  if (!movedInGapDirection || !aboveVWAP) {
    return { behavior: 'GAP_AND_FAIL', confidence: 0.75 };
  }

  return { behavior: 'NEUTRAL', confidence: 0.5 };
}

export function analyzeGap(
  prevClose: number,
  currOpen: number,
  sessionCandles: Candle[],
  vwap: number,
  openingRange: { high: number; low: number }
): {
  gap: GapInfo | null;
  behavior: 'GAP_AND_GO' | 'GAP_AND_FAIL' | 'GAP_FILL' | 'GAP_REVERSAL' | 'NEUTRAL';
  tradeable: boolean;
  direction: 'LONG' | 'SHORT' | 'NO_TRADE';
} {
  const gapSize = currOpen - prevClose;
  const gapPercent = Math.abs(gapSize) / prevClose;

  if (gapPercent < 0.005) { // less than 0.5% - not a significant gap
    return { gap: null, behavior: 'NEUTRAL', tradeable: false, direction: 'NO_TRADE' };
  }

  const gap: GapInfo = {
    type: gapSize > 0 ? (currOpen > prevClose ? 'FULL_GAP_UP' : 'PARTIAL_GAP_UP') : 'FULL_GAP_DOWN',
    gapSize: Math.abs(gapSize),
    gapPercent,
    openedAbove: gapSize > 0,
    filled: false,
    gapAndGo: false,
  };

  // Check fill during session
  for (const c of sessionCandles) {
    if (gap.openedAbove && c.low <= prevClose * 1.001) {
      gap.filled = true;
      gap.fillTime = c.time;
      gap.fillPrice = prevClose;
      break;
    } else if (!gap.openedAbove && c.high >= prevClose * 0.999) {
      gap.filled = true;
      gap.fillTime = c.time;
      gap.fillPrice = prevClose;
      break;
    }
  }

  const { behavior, confidence } = classifyGapBehavior(gap, sessionCandles, vwap, openingRange);
  const tradeable = confidence > 0.7;

  let direction: 'LONG' | 'SHORT' | 'NO_TRADE' = 'NO_TRADE';
  if (behavior === 'GAP_AND_GO') direction = gap.openedAbove ? 'LONG' : 'SHORT';
  else if (behavior === 'GAP_REVERSAL') direction = gap.openedAbove ? 'SHORT' : 'LONG';

  return { gap, behavior, tradeable, direction };
}