// Smart Entry Engine
// Determines optimal entry timing after AI Trade Engine picks a direction

import type {
  CandleData,
  MarketStructure,
  VolumeAnalysis,
  SDMOptionStrike,
  SmartEntryAction,
  SmartEntryResult,
} from '@/types/sdm';

// ─── ATR Calculation ──────────────────────────────────────────────

function computeATR(candles: CandleData[], period: number = 14): number {
  if (candles.length < period + 1) return 0;

  let atr = 0;
  for (let i = 1; i <= period; i++) {
    atr += trueRange(candles[i]);
  }
  atr /= period;

  // Smooth with Wilder's method
  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + trueRange(candles[i])) / period;
  }

  return atr;
}

function trueRange(candle: CandleData): number {
  // Need previous candle, but since we're given a slice, we approximate
  // using high-low as the range (standard for ATR with limited data)
  return candle.high - candle.low;
}

// ─── Nearest Level Finder ─────────────────────────────────────────

function nearestLevel(price: number, levels: number[]): number {
  if (levels.length === 0) return price;
  let closest = levels[0];
  let minDist = Math.abs(price - closest);
  for (const lv of levels) {
    const dist = Math.abs(price - lv);
    if (dist < minDist) {
      minDist = dist;
      closest = lv;
    }
  }
  return closest;
}

// ─── Structure Break Detection ────────────────────────────────────

interface StructureBreakResult {
  justBroke: boolean;
  brokeLevel: number;
  direction: 'BULLISH' | 'BEARISH';
  retestHappened: boolean;
}

function detectStructureBreak(
  candles: CandleData[],
  structure: MarketStructure,
  spot: number,
): StructureBreakResult {
  const result: StructureBreakResult = {
    justBroke: false,
    brokeLevel: 0,
    direction: 'BULLISH',
    retestHappened: false,
  };

  if (candles.length < 2 || !structure.structureEvent) return result;

  const lastCandle = candles[candles.length - 1];
  const evt = structure.structureEvent;

  // "Just broke" = last candle closed beyond a structure level
  const isRecentBreak = Math.abs(lastCandle.time - evt.time) < 60000 * 5; // within 5 min

  if (!isRecentBreak) return result;

  result.brokeLevel = evt.price;
  result.direction = evt.direction;
  result.justBroke = true;

  // Check if retest happened: after the break, price returned to the broken level
  if (candles.length >= 2) {
    const breakCandleIdx = candles.findIndex((c) => c.time === evt.time);
    if (breakCandleIdx >= 0) {
      const postBreakCandles = candles.slice(breakCandleIdx + 1);
      const level = evt.price;

      for (const c of postBreakCandles) {
        // Bullish break: price dips back to or near the broken swing high
        if (evt.direction === 'BULLISH' && c.low <= level * 1.001) {
          result.retestHappened = true;
          break;
        }
        // Bearish break: price rallies back to or near the broken swing low
        if (evt.direction === 'BEARISH' && c.high >= level * 0.999) {
          result.retestHappened = true;
          break;
        }
      }
    }
  }

  return result;
}

// ─── Main Entry Point ─────────────────────────────────────────────

export function determineSmartEntry(
  spot: number,
  tradeDirection: 'CALL' | 'PUT',
  entryPrice: number,
  candles: CandleData[],
  marketStructure: MarketStructure,
  volumeAnalysis: VolumeAnalysis,
  optionChain: SDMOptionStrike[],
): SmartEntryResult {
  const status = candles.length >= 15 ? 'OK' : 'DEGRADED';

  // ATR over last 14 candles
  const atr = computeATR(candles, 14);

  // VWAP proxy = POC (Point of Control)
  const vwap = volumeAnalysis.poc;

  // Current volume vs session average
  const lastCandle = candles.length > 0 ? candles[candles.length - 1] : null;
  const lastVolume = lastCandle ? lastCandle.volume : 0;
  const avgVolume = volumeAnalysis.avgVolume > 0 ? volumeAnalysis.avgVolume : 1;
  const volumeRatio = lastVolume / avgVolume;

  // Distance from spot to VWAP (POC)
  const distFromVwap = Math.abs(spot - vwap);

  // Distance from spot to entry
  const distFromEntry = Math.abs(spot - entryPrice);

  // Collect all relevant levels for reference
  const allLevels = [
    ...marketStructure.supportLevels,
    ...marketStructure.resistanceLevels,
    vwap,
  ].filter((l) => l > 0);

  const nearestStructLevel = nearestLevel(spot, allLevels);

  // --- Condition checks (each returns action + reason) ---

  // 1. Volume confirmation check
  const hasVolumeConfirm = volumeRatio >= 1.5;

  // 2. Structure break detection
  const structBreak = detectStructureBreak(candles, marketStructure, spot);

  // 3. Approaching resistance/support (within 0.3% of a level, not yet broken)
  const isNearLevel = (() => {
    const threshold = atr > 0 ? atr * 0.2 : spot * 0.002; // 0.2 ATR or 0.2%
    const nearest = nearestLevel(spot, allLevels);
    return Math.abs(spot - nearest) < threshold;
  })();

  // --- Apply decision table with priority ---

  // Priority 1: ENTER_NOW — price already broke structure level with volume confirmation
  if (structBreak.justBroke && hasVolumeConfirm) {
    return {
      action: 'ENTER_NOW',
      reason: `price ${spot.toFixed(0)} broke ${structBreak.direction} structure level ${structBreak.brokeLevel.toFixed(0)}, volume ${volumeRatio.toFixed(1)}x average`,
      currentPrice: spot,
      referenceLevel: structBreak.brokeLevel,
      atr,
      distanceFromLevel: Math.abs(spot - structBreak.brokeLevel),
      volumeRatio,
      status,
    };
  }

  // Priority 2: WAIT_RETEST — just broke a level, no retest yet
  if (structBreak.justBroke && !structBreak.retestHappened) {
    return {
      action: 'WAIT_RETEST',
      reason: `price ${spot.toFixed(0)} broke ${structBreak.direction} level ${structBreak.brokeLevel.toFixed(0)}, no retest yet — wait for pullback to ${structBreak.brokeLevel.toFixed(0)}`,
      currentPrice: spot,
      referenceLevel: structBreak.brokeLevel,
      atr,
      distanceFromLevel: Math.abs(spot - structBreak.brokeLevel),
      volumeRatio,
      status,
    };
  }

  // Priority 3: WAIT_BREAKOUT — price approaching resistance/support, not yet broken
  if (isNearLevel) {
    const nearest = nearestLevel(spot, allLevels);
    const isResistance = nearest > spot;
    const direction = tradeDirection === 'CALL' ? 'resistance' : 'support';

    // Only warn if the nearby level opposes the trade direction
    if (
      (tradeDirection === 'CALL' && isResistance) ||
      (tradeDirection === 'PUT' && !isResistance)
    ) {
      return {
        action: 'WAIT_BREAKOUT',
        reason: `price ${spot.toFixed(0)} near ${direction} ${nearest.toFixed(0)} (dist ${Math.abs(spot - nearest).toFixed(0)}), wait for confirmed breakout`,
        currentPrice: spot,
        referenceLevel: nearest,
        atr,
        distanceFromLevel: Math.abs(spot - nearest),
        volumeRatio,
        status,
      };
    }
  }

  // Priority 4: WAIT_PULLBACK — price extended > 1.5 ATR from VWAP/entry
  if (atr > 0) {
    const distFromRef = Math.min(distFromVwap, distFromEntry);
    if (distFromRef > 1.5 * atr) {
      // Check if extension is in trade direction (which is bad — overextended)
      const overextended =
        (tradeDirection === 'CALL' && spot > vwap + 1.5 * atr) ||
        (tradeDirection === 'PUT' && spot < vwap - 1.5 * atr);

      if (overextended) {
        const refLevel = distFromVwap < distFromEntry ? vwap : entryPrice;
        return {
          action: 'WAIT_PULLBACK',
          reason: `price ${spot.toFixed(0)} extended ${(distFromRef / atr).toFixed(1)} ATR from ${refLevel === vwap ? 'VWAP' : 'entry'} ${refLevel.toFixed(0)} (> 1.5x threshold), wait for mean reversion`,
          currentPrice: spot,
          referenceLevel: refLevel,
          atr,
          distanceFromLevel: distFromRef,
          volumeRatio,
          status,
        };
      }
    }
  }

  // Priority 5: WAIT_ABOVE_VWAP / WAIT_BELOW_VWAP
  if (tradeDirection === 'CALL' && spot < vwap) {
    return {
      action: 'WAIT_ABOVE_VWAP',
      reason: `bullish trade but price ${spot.toFixed(0)} below VWAP ${vwap.toFixed(0)} (dist ${Math.abs(spot - vwap).toFixed(0)}), wait for reclaim above VWAP`,
      currentPrice: spot,
      referenceLevel: vwap,
      atr,
      distanceFromLevel: Math.abs(spot - vwap),
      volumeRatio,
      status,
    };
  }

  if (tradeDirection === 'PUT' && spot > vwap) {
    return {
      action: 'WAIT_BELOW_VWAP',
      reason: `bearish trade but price ${spot.toFixed(0)} above VWAP ${vwap.toFixed(0)} (dist ${Math.abs(spot - vwap).toFixed(0)}), wait for rejection below VWAP`,
      currentPrice: spot,
      referenceLevel: vwap,
      atr,
      distanceFromLevel: Math.abs(spot - vwap),
      volumeRatio,
      status,
    };
  }

  // Priority 6: WAIT_VOLUME_CONFIRMATION — volume below session average at breakout point
  if (!hasVolumeConfirm) {
    return {
      action: 'WAIT_VOLUME_CONFIRMATION',
      reason: `volume ${volumeRatio.toFixed(2)}x below 1.5x threshold (need ${(1.5 * avgVolume).toFixed(0)}, have ${lastVolume.toFixed(0)}), wait for volume surge to confirm breakout`,
      currentPrice: spot,
      referenceLevel: vwap,
      atr,
      distanceFromLevel: distFromVwap,
      volumeRatio,
      status,
    };
  }

  // All conditions passed — green light
  return {
    action: 'ENTER_NOW',
    reason: `price ${spot.toFixed(0)} aligned with direction, within VWAP range, volume confirmed (${volumeRatio.toFixed(1)}x avg)`,
    currentPrice: spot,
    referenceLevel: vwap,
    atr,
    distanceFromLevel: distFromVwap,
    volumeRatio,
    status,
  };
}
