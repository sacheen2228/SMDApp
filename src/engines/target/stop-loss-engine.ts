import type { Candle, OrderBookLevel, SmartMoneyData, VolatilityData } from '@/types/engine';
import type { StopLossCandidate } from './types';

export function generateStopLoss(
  candles: Candle[],
  levels: OrderBookLevel[],
  price: number,
  side: 'long' | 'short',
  sm: SmartMoneyData,
  atr: number,
): { price: number; type: string; source: string; explanation: string } {
  if (side === 'wait') {
    return { price: 0, type: 'none', source: 'No trade', explanation: 'No stop loss (wait signal)' };
  }

  const candidates: StopLossCandidate[] = [];

  // 1. Liquidity Sweep — below most recent swing low (long) / above most recent swing high (short)
  if (side === 'long') {
    if (sm.swingLow.length > 0) {
      const sl = sm.swingLow[sm.swingLow.length - 1];
      const sweepLevel = sl - atr * 0.2;
      candidates.push({ price: sweepLevel, type: 'Liquidity Sweep (swing low)', strength: 85, source: `Below swing low ${sl.toFixed(2)}` });
    }
    if (sm.swingLow.length > 1) {
      const sl2 = sm.swingLow[sm.swingLow.length - 2];
      candidates.push({ price: sl2 - atr * 0.2, type: 'Liquidity Sweep (prior swing low)', strength: 70, source: `Below prior swing low ${sl2.toFixed(2)}` });
    }
  } else {
    if (sm.swingHigh.length > 0) {
      const sh = sm.swingHigh[sm.swingHigh.length - 1];
      const sweepLevel = sh + atr * 0.2;
      candidates.push({ price: sweepLevel, type: 'Liquidity Sweep (swing high)', strength: 85, source: `Above swing high ${sh.toFixed(2)}` });
    }
    if (sm.swingHigh.length > 1) {
      const sh2 = sm.swingHigh[sm.swingHigh.length - 2];
      candidates.push({ price: sh2 + atr * 0.2, type: 'Liquidity Sweep (prior swing high)', strength: 70, source: `Above prior swing high ${sh2.toFixed(2)}` });
    }
  }

  // 2. Order Block — below bullish OB for long, above bearish OB for short
  if (sm.orderBlock) {
    if (side === 'long' && sm.orderBlock.type === 'bullish') {
      candidates.push({ price: sm.orderBlock.price - atr * 0.3, type: 'Order Block', strength: 80, source: `Below bullish OB ${sm.orderBlock.price.toFixed(2)}` });
    } else if (side === 'short' && sm.orderBlock.type === 'bearish') {
      candidates.push({ price: sm.orderBlock.price + atr * 0.3, type: 'Order Block', strength: 80, source: `Above bearish OB ${sm.orderBlock.price.toFixed(2)}` });
    }
  }

  // 3. Swing High/Low — nearest swing point
  if (side === 'long' && sm.swingLow.length > 0) {
    const nearestSwing = sm.swingLow[sm.swingLow.length - 1];
    candidates.push({ price: nearestSwing - atr * 0.15, type: 'Swing Low', strength: 75, source: `Below swing low ${nearestSwing.toFixed(2)}` });
  }
  if (side === 'short' && sm.swingHigh.length > 0) {
    const nearestSwing = sm.swingHigh[sm.swingHigh.length - 1];
    candidates.push({ price: nearestSwing + atr * 0.15, type: 'Swing High', strength: 75, source: `Above swing high ${nearestSwing.toFixed(2)}` });
  }

  // 4. Market Structure — below last BOS for long, above last BOS for short
  if (sm.bos) {
    if (side === 'long' && sm.bos === 'bullish') {
      const bosLevel = Math.min(...sm.swingLow.slice(-2));
      candidates.push({ price: bosLevel - atr * 0.25, type: 'Market Structure (BOS)', strength: 78, source: `Below BOS level ${bosLevel.toFixed(2)}` });
    } else if (side === 'short' && sm.bos === 'bearish') {
      const bosLevel = Math.max(...sm.swingHigh.slice(-2));
      candidates.push({ price: bosLevel + atr * 0.25, type: 'Market Structure (BOS)', strength: 78, source: `Above BOS level ${bosLevel.toFixed(2)}` });
    }
  }

  // 5. CHoCH level
  if (sm.choch) {
    const chochLevel = side === 'long' ? Math.min(...(sm.swingLow.length > 0 ? sm.swingLow : [price * 0.99])) : Math.max(...(sm.swingHigh.length > 0 ? sm.swingHigh : [price * 1.01]));
    candidates.push({
      price: side === 'long' ? chochLevel - atr * 0.2 : chochLevel + atr * 0.2,
      type: 'CHoCH Structure',
      strength: 72,
      source: `CHoCH ${sm.choch} level ${chochLevel.toFixed(2)}`,
    });
  }

  // 6. Order book wall sweep
  const avgSize = levels.length > 0 ? levels.reduce((s, l) => s + l.size, 0) / levels.length : 0;
  const wallThreshold = avgSize * 3;
  if (side === 'long') {
    const bidWalls = levels.filter(l => l.isBid && l.size > wallThreshold);
    if (bidWalls.length > 0) {
      const deepest = Math.min(...bidWalls.map(l => l.price));
      candidates.push({ price: deepest - atr * 0.2, type: 'Bid Wall Sweep', strength: 68, source: `Below bid wall ${deepest.toFixed(2)}` });
    }
  } else {
    const askWalls = levels.filter(l => !l.isBid && l.size > wallThreshold);
    if (askWalls.length > 0) {
      const highest = Math.max(...askWalls.map(l => l.price));
      candidates.push({ price: highest + atr * 0.2, type: 'Ask Wall Sweep', strength: 68, source: `Above ask wall ${highest.toFixed(2)}` });
    }
  }

  // 7. ATR Buffer (safety net — never used alone)
  const atrBufferMultiplier = 1.5;
  const atrBufferStop = side === 'long' ? price - atr * atrBufferMultiplier : price + atr * atrBufferMultiplier;
  candidates.push({
    price: atrBufferStop,
    type: 'ATR Buffer',
    strength: 55,
    source: `ATR buffer ${(atrBufferMultiplier).toFixed(1)}x (${atr.toFixed(2)})`,
  });

  // Score and choose best stop
  const scored = candidates
    .map(c => {
      const dist = Math.abs(c.price - price);
      const riskPercent = price > 0 ? (dist / price) * 100 : 0;
      const riskScore = Math.max(0, 100 - riskPercent * 20);
      const totalScore = (c.strength * 0.6 + riskScore * 0.4);
      return { ...c, score: totalScore };
    })
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored.length > 0 ? scored[0] : { price: atrBufferStop, type: 'ATR Buffer', source: 'Default ATR buffer', score: 50 };

  let explanation = `Stop at ${best.price.toFixed(2)} (${best.type}, score: ${Math.round(best.score)})`;
  if (scored.length > 1) {
    explanation += ` | Next: ${scored[1].price.toFixed(2)} (${scored[1].type})`;
  }

  return { price: parseFloat(best.price.toFixed(2)), type: best.type, source: best.source, explanation };
}
