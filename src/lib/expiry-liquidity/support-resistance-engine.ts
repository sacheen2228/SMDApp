// ─── Support/Resistance Engine ─────────────────────────────────────────
// Builds dynamic S/R levels from multiple sources:
// OI walls, Volume Profile, VWAP, PDH/PDL, Swing points, Max Pain, ATM

import { SupportResistanceAnalysis, SupportResistanceLevel } from './types';

interface SupportResistanceConfig {
  equalHighLowThreshold: number;
  swingLookback: number;
  minTouches: number;
  proximityThreshold: number; // % distance to consider "near"
}

class SupportResistanceEngine {
  private config: SupportResistanceConfig = {
    equalHighLowThreshold: 0.001, // 0.1%
    swingLookback: 20,
    minTouches: 2,
    proximityThreshold: 0.003, // 0.3%
  };

  // ─── Build All Support/Resistance Levels ────────────────────────────
  buildLevels(context: {
    spot: number;
    candles: Array<{
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>;
    optionChain: {
      strikes: Array<{
        strike: number;
        ce: { oi: number; oiChange: number };
        pe: { oi: number; oiChange: number };
      }>;
      spot: number;
      atmStrike: number;
      maxPain: number;
    };
    prevDayHigh: number;
    prevDayLow: number;
    prevWeekHigh: number;
    prevWeekLow: number;
    vwap: number;
    sessionHigh: number;
    sessionLow: number;
  }): SupportResistanceAnalysis {
    const levels: SupportResistanceLevel[] = [];

    // 1. Previous Day High/Low
    if (context.prevDayHigh > 0) {
      levels.push(this.createLevel(context.prevDayHigh, 'PDH', context));
    }
    if (context.prevDayLow > 0) {
      levels.push(this.createLevel(context.prevDayLow, 'PDL', context));
    }

    // 2. Previous Week High/Low
    if (context.prevWeekHigh > 0) {
      levels.push(this.createLevel(context.prevWeekHigh, 'PWH', context));
    }
    if (context.prevWeekLow > 0) {
      levels.push(this.createLevel(context.prevWeekLow, 'PWL', context));
    }

    // 3. Session High/Low
    levels.push(this.createLevel(context.sessionHigh, 'SESSION_HIGH', context));
    levels.push(this.createLevel(context.sessionLow, 'SESSION_LOW', context));

    // 3. VWAP
    if (context.vwap > 0) {
      levels.push(this.createLevel(context.vwap, 'VWAP', context));
    }

    // 4. Max Pain
    if (context.optionChain.maxPain > 0) {
      levels.push(this.createLevel(context.optionChain.maxPain, 'MAX_PAIN', context));
    }

    // 4. ATM Strike
    if (context.optionChain.atmStrike > 0) {
      levels.push(this.createLevel(context.optionChain.atmStrike, 'ATM_STRIKE', context));
    }

    // 5. Swing Highs/Lows
    const swings = this.findSwings(context.candles, this.config.swingLookback);
    for (const swing of swings) {
      const type = swing.type === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW';
      levels.push(this.createLevel(swing.price, type, context));
    }

    // 5. OI Walls from Option Chain
    const oiWalls = this.extractOIWalls(context.optionChain);
    for (const wall of oiWalls) {
      levels.push(this.createLevel(wall.price, wall.type, context));
    }

    // 6. Equal Highs/Lows
    const equalLevels = this.findEqualHighsLows(swings);
    for (const eq of equalLevels) {
      const type = eq.type === 'HIGH' ? 'EQUAL_HIGH' : 'EQUAL_LOW';
      const level = this.createLevel(eq.price, type, context);
      level.touches = eq.count;
      levels.push(level);
    }

    // 6. Volume Profile HVN/LVN (if available)
    // Would integrate with existing auction engine

    // Filter and sort
    const validLevels = levels
      .filter(l => l.price > 0)
      .sort((a, b) => a.price - b.price);

    // Find nearest resistance/support
    const currentPrice = context.spot;
    const resistanceLevels = validLevels.filter(l => l.price > currentPrice);
    const supportLevels = validLevels.filter(l => l.price < currentPrice);

    const nearestResistance = resistanceLevels.length > 0 ? resistanceLevels[0] : null;
    const nearestSupport = supportLevels.length > 0 ? supportLevels[supportLevels.length - 1] : null;

    // Distance calculations
    const distanceToResistancePct = nearestResistance
      ? ((nearestResistance.price - currentPrice) / currentPrice) * 100
      : 0;
    const distanceToSupportPct = nearestSupport
      ? ((currentPrice - nearestSupport.price) / currentPrice) * 100
      : 0;

    // Volume Profile Value Area
    const { vah, val, poc } = this.calculateValueArea(context.candles);

    // In Value Area check
    const inValueArea = currentPrice <= vah && currentPrice >= val;

    return {
      levels: validLevels,
      nearestResistance,
      nearestSupport,
      currentPrice: context.spot,
      distanceToResistancePct: Math.round(distanceToResistancePct * 100) / 100,
      distanceToSupportPct: Math.round(distanceToSupportPct * 100) / 100,
      inValueArea,
      valueAreaHigh: vah,
      valueAreaLow: val,
      poc,
    };
  }

  private createLevel(
    price: number,
    type: SupportResistanceLevel['type'],
    context: any
  ): SupportResistanceLevel {
    const currentPrice = context.spot;
    const proximity = Math.abs(currentPrice - price) / currentPrice;

    return {
      price,
      type,
      strength: this.calculateStrength(type, price, context),
      touches: this.countTouches(price, context),
      lastTouch: Date.now(),
      swept: false,
    };
  }

  private calculateStrength(type: string, price: number, context: any): number {
    let strength = 50;

    switch (type) {
      case 'PDH':
      case 'PDL':
        strength = 80;
        break;
      case 'PWH':
      case 'PWL':
        strength = 70;
        break;
      case 'VWAP':
        strength = 75;
        break;
      case 'MAX_PAIN':
        strength = 85;
        break;
      case 'ATM_STRIKE':
        strength = 70;
        break;
      case 'VWAP_RECLAIM':
      case 'VWAP_REJECTION':
        strength = 80;
        break;
      case 'SESSION_HIGH':
      case 'SESSION_LOW':
        strength = 60;
        break;
    }

    // Boost if near current price
    const proximity = Math.abs(context.spot - price) / context.spot;
    if (proximity < 0.005) strength += 10;
    else if (proximity < 0.01) strength += 5;

    return Math.min(100, Math.max(0, strength));
  }

  private countTouches(price: number, context: any): number {
    const threshold = price * this.config.equalHighLowThreshold;
    return context.candles.filter(c =>
      Math.abs(c.high - price) < threshold || Math.abs(c.low - price) < threshold
    ).length;
  }

  // ─── Find Swing Highs/Lows ──────────────────────────────────────────
  private findSwings(
    candles: Array<{ time: number; high: number; low: number }>,
    lookback: number
  ): Array<{ time: number; price: number; type: 'HIGH' | 'LOW'; strength: number; volume: number }> {
    const swings: Array<{ time: number; price: number; type: 'HIGH' | 'LOW'; strength: number; volume: number }> = [];

    if (candles.length < 5) return swings;

    for (let i = 2; i < candles.length - 2; i++) {
      const c = candles[i];

      // Swing High
      if (c.high > candles[i - 1].high &&
          c.high > candles[i - 2].high &&
          c.high > candles[i + 1].high &&
          c.high > candles[i + 2].high) {
        swings.push({
          time: c.time,
          price: c.high,
          type: 'HIGH',
          strength: 1,
          volume: 0,
        });
      }

      // Swing Low
      if (c.low < candles[i - 1].low &&
          c.low < candles[i - 2].low &&
          c.low < candles[i + 1].low &&
          c.low < candles[i + 2].low) {
        swings.push({
          time: c.time,
          price: c.low,
          type: 'LOW',
          strength: 1,
          volume: 0,
        });
      }
    }

    return swings.slice(-this.config.swingLookback);
  }

  // ─── Find Equal Highs/Lows ──────────────────────────────────────────
  private findEqualHighsLows(swings: Array<{ type: 'HIGH' | 'LOW'; price: number }>): Array<{
    price: number;
    type: 'HIGH' | 'LOW';
    count: number;
  }> {
    const groups: Map<string, { price: number; type: 'HIGH' | 'LOW'; count: number }> = new Map();

    for (const s of swings) {
      const key = `${s.type}_${Math.round(s.price / (s.price * this.config.equalHighLowThreshold))}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
        existing.price = (existing.price * (existing.count - 1) + s.price) / existing.count;
      } else {
        groups.set(key, { price: s.price, type: s.type, count: 1 });
      }
    }

    return Array.from(groups.values()).filter(g => g.count >= this.config.minTouches);
  }

  // ─── Calculate Value Area (POC, VAH, VAL) ──────────────────────────
  private calculateValueArea(candles: Array<{ high: number; low: number; close: number; volume: number }>): {
    vah: number; val: number; poc: number;
  } {
    if (candles.length === 0) return { vah: 0, val: 0, poc: 0 };

    // Simple volume profile
    const priceVolumeMap = new Map<number, number>();
    const tickSize = 0.05;

    for (const c of candles) {
      const range = c.high - c.low;
      if (range <= 0) {
        const price = Math.round(c.close / tickSize) * tickSize;
        priceVolumeMap.set(price, (priceVolumeMap.get(price) || 0) + c.volume);
        continue;
      }

      const numTicks = Math.max(1, Math.round(range / tickSize));
      const volPerTick = c.volume / numTicks;

      for (let i = 0; i <= numTicks; i++) {
        const price = Math.round((c.low + i * tickSize) / tickSize) * tickSize;
        priceVolumeMap.set(price, (priceVolumeMap.get(price) || 0) + volPerTick);
      }
    }

    const levels = Array.from(priceVolumeMap.entries())
      .map(([price, volume]) => ({ price, volume }))
      .sort((a, b) => b.volume - a.volume);

    if (levels.length === 0) return { vah: 0, val: 0, poc: 0 };

    const poc = levels[0].price;
    const totalVolume = levels.reduce((s, l) => s + l.volume, 0);
    const targetVolume = totalVolume * 0.7;

    const pocIndex = levels.findIndex(l => l.price === poc);
    let vah = poc;
    let val = poc;
    let accumulated = levels[pocIndex].volume;

    let upIdx = pocIndex - 1;
    let downIdx = pocIndex + 1;

    while (accumulated < targetVolume && (upIdx >= 0 || downIdx < levels.length)) {
      const upVol = upIdx >= 0 ? levels[upIdx].volume : 0;
      const downVol = downIdx < levels.length ? levels[downIdx].volume : 0;

      if (upVol >= downVol && upIdx >= 0) {
        accumulated += upVol;
        vah = levels[upIdx].price;
        upIdx--;
      } else if (downIdx < levels.length) {
        accumulated += downVol;
        val = levels[downIdx].price;
        downIdx++;
      } else {
        break;
      }
    }

    return { vah, val, poc };
  }

  // ─── Configure ──────────────────────────────────────────────────────
  configure(config: Partial<SupportResistanceConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────
let supportResistanceEngineInstance: SupportResistanceEngine | null = null;

export function getSupportResistanceEngine(): SupportResistanceEngine {
  if (!supportResistanceEngineInstance) {
    supportResistanceEngineInstance = new SupportResistanceEngine();
  }
  return supportResistanceEngineInstance;
}