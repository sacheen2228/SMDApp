// Market Structure Engine - Detects HH/HL/LH/LL, BOS, CHOCH, Structural Failure, Displacement

import { Candle, SwingPoint, StructurePoint, MarketStructureEvent } from './auction-types';

export interface SwingDetectionConfig {
  leftBars: number;
  rightBars: number;
  minStrength: number;
  volumeThreshold: number;
}

const DEFAULT_SWING_CONFIG: SwingDetectionConfig = {
  leftBars: 5,
  rightBars: 5,
  minStrength: 0.002, // 0.2% move
  volumeThreshold: 1.2, // 20% above average volume
};

export function detectSwings(candles: Candle[], config: Partial<SwingDetectionConfig> = {}): SwingPoint[] {
  const cfg = { ...DEFAULT_SWING_CONFIG, ...config };
  const swings: SwingPoint[] = [];
  const avgVolume = candles.reduce((s, c) => s + c.volume, 0) / candles.length;

  for (let i = cfg.leftBars; i < candles.length - cfg.rightBars; i++) {
    const c = candles[i];
    const leftHighs = candles.slice(i - cfg.leftBars, i).map(c => c.high);
    const leftLows = candles.slice(i - cfg.leftBars, i).map(c => c.low);
    const rightHighs = candles.slice(i + 1, i + 1 + cfg.rightBars).map(c => c.high);
    const rightLows = candles.slice(i + 1, i + 1 + cfg.rightBars).map(c => c.low);

    const isHigh = c.high >= Math.max(...leftHighs) && c.high >= Math.max(...rightHighs);
    const isLow = c.low <= Math.min(...leftLows) && c.low <= Math.min(...rightLows);

    if (!isHigh && !isLow) continue;

    const strength = isHigh
      ? (c.high - Math.max(Math.max(...leftLows), Math.max(...rightLows))) / c.high
      : (Math.min(Math.max(...leftHighs), Math.max(...rightHighs)) - c.low) / c.low;

    if (strength < cfg.minStrength) continue;
    if (c.volume < avgVolume * cfg.volumeThreshold) continue;

    swings.push({
      time: c.time,
      price: isHigh ? c.high : c.low,
      type: isHigh ? 'HIGH' : 'LOW',
      strength,
      volume: c.volume,
    });
  }

  return swings;
}

export function classifyMarketStructure(swings: SwingPoint[]): StructurePoint[] {
  const structure: StructurePoint[] = [];

  for (let i = 2; i < swings.length; i++) {
    const s0 = swings[i - 2];
    const s1 = swings[i - 1];
    const s2 = swings[i];

    // Need alternating high/low
    if (s0.type === s1.type || s1.type === s2.type) continue;

    const isBullish = s0.type === 'LOW' && s1.type === 'HIGH' && s2.type === 'LOW';
    const isBearish = s0.type === 'HIGH' && s1.type === 'LOW' && s2.type === 'HIGH';

    if (!isBullish && !isBearish) continue;

    if (isBullish) {
      // Check HH/HL
      const hh = s2.price > s0.price;
      const hl = s2.price > s0.price; // both HH and HL for bullish

      structure.push({
        swing: s2,
        isValid: true,
        displaced: false,
      });
    } else if (isBearish) {
      // Check LH/LL
      const ll = s2.price < s0.price;
      const lh = s2.price < s0.price;

      structure.push({
        swing: s2,
        isValid: true,
        displaced: false,
      });
    }
  }

  return structure;
}

export function detectBOSSignals(swings: SwingPoint[]): MarketStructureEvent[] {
  const events: MarketStructureEvent[] = [];

  for (let i = 2; i < swings.length; i++) {
    const s0 = swings[i - 2];
    const s1 = swings[i - 1];
    const s2 = swings[i];

    if (s0.type === 'LOW' && s1.type === 'HIGH' && s2.type === 'LOW') {
      // Bullish structure: check BOS
      if (s2.price > s0.price) {
        // Higher high - potential BOS
        events.push('BOS_BULLISH');
      }
    } else if (s0.type === 'HIGH' && s1.type === 'LOW' && s2.type === 'HIGH') {
      // Bearish structure: check BOS
      if (s2.price < s0.price) {
        events.push('BOS_BEARISH');
      }
    }
  }

  return events;
}

export function detectCHOCHSignals(swings: SwingPoint[]): MarketStructureEvent[] {
  const events: MarketStructureEvent[] = [];
  let lastTrend = 0; // 1 = up, -1 = down

  for (let i = 2; i < swings.length; i++) {
    const s0 = swings[i - 2];
    const s1 = swings[i - 1];
    const s2 = swings[i];

    if (s0.type === 'LOW' && s1.type === 'HIGH' && s2.type === 'LOW') {
      if (s2.price > s0.price) {
        // Higher high - trend up
        if (lastTrend === -1) events.push('CHOCH_BULLISH');
        lastTrend = 1;
      } else if (s2.price < s0.price) {
        // Lower low - trend down
        if (lastTrend === 1) events.push('CHOCH_BEARISH');
        lastTrend = -1;
      }
    } else if (s0.type === 'HIGH' && s1.type === 'LOW' && s2.type === 'HIGH') {
      if (s2.price > s0.price) {
        if (lastTrend === -1) events.push('CHOCH_BULLISH');
        lastTrend = 1;
      } else if (s2.price < s0.price) {
        if (lastTrend === 1) events.push('CHOCH_BEARISH');
        lastTrend = -1;
      }
    }
  }

  return events;
}

export function detectStructuralFailure(swings: SwingPoint[]): MarketStructureEvent[] {
  const events: MarketStructureEvent[] = [];

  for (let i = 2; i < swings.length; i++) {
    const s0 = swings[i - 2];
    const s1 = swings[i - 1];
    const s2 = swings[i];

    // Failed bullish: made HH but then broke HL
    if (s0.type === 'LOW' && s1.type === 'HIGH' && s2.type === 'LOW') {
      if (s2.price < s0.price) {
        // Broke previous low - structural failure
        events.push('STRUCTURAL_FAILURE_BEARISH');
      }
    }

    // Failed bearish: made LL but then broke LH
    if (s0.type === 'HIGH' && s1.type === 'LOW' && s2.type === 'HIGH') {
      if (s2.price > s0.price) {
        events.push('STRUCTURAL_FAILURE_BULLISH');
      }
    }
  }

  return events;
}

export function detectDisplacement(candles: Candle[], lookback: number = 20): MarketStructureEvent[] {
  const events: MarketStructureEvent[] = [];
  if (candles.length < lookback + 5) return events;

  const recent = candles.slice(-lookback);
  const avgRange = recent.reduce((s, c) => s + (c.high - c.low), 0) / recent.length;
  const avgVolume = recent.reduce((s, c) => s + c.volume, 0) / recent.length;

  for (let i = 0; i < recent.length - 3; i++) {
    const c = recent[i];
    const range = c.high - c.low;
    const bodySize = Math.abs(c.close - c.open);

    // Displacement: large range, large body, high volume, closes near extreme
    if (range > avgRange * 2 && bodySize > range * 0.7 && c.volume > avgVolume * 1.5) {
      if (c.close > c.open && c.close >= c.high - range * 0.1) {
        events.push('DISPLACEMENT_UP');
      } else if (c.close < c.open && c.close <= c.low + range * 0.1) {
        events.push('DISPLACEMENT_DOWN');
      }
    }
  }

  return events;
}

export function analyzeMarketStructure(candles: Candle[]): {
  swings: SwingPoint[];
  structurePoints: StructurePoint[];
  bosEvents: MarketStructureEvent[];
  chochEvents: MarketStructureEvent[];
  structuralFailures: MarketStructureEvent[];
  displacements: MarketStructureEvent[];
  currentTrend: 'UP' | 'DOWN' | 'SIDEWAYS';
  lastSwing: SwingPoint | null;
} {
  const swings = detectSwings(candles);
  const structurePoints = classifyMarketStructure(swings);
  const bosEvents = detectBOSSignals(swings);
  const chochEvents = detectCHOCHSignals(swings);
  const structuralFailures = detectStructuralFailure(swings);
  const displacements = detectDisplacement(candles);

  // Determine current trend
  let currentTrend: 'UP' | 'DOWN' | 'SIDEWAYS' = 'SIDEWAYS';
  const recentSwings = swings.slice(-4);
  if (recentSwings.length >= 3) {
    const highs = recentSwings.filter(s => s.type === 'HIGH');
    const lows = recentSwings.filter(s => s.type === 'LOW');
    if (highs.length >= 2 && lows.length >= 2) {
      const higherHighs = highs[1].price > highs[0].price;
      const higherLows = lows[1].price > lows[0].price;
      const lowerHighs = highs[1].price < highs[0].price;
      const lowerLows = lows[1].price < lows[0].price;

      if (higherHighs && higherLows) currentTrend = 'UP';
      else if (lowerHighs && lowerLows) currentTrend = 'DOWN';
    }
  }

  return {
    swings,
    structurePoints,
    bosEvents,
    chochEvents,
    structuralFailures,
    displacements,
    currentTrend,
    lastSwing: swings[swings.length - 1] || null,
  };
}