import type { Candle, OrderBookLevel, OpenInterestData, SmartMoneyData, VolatilityData, RegimeResult } from '@/types/engine';
import type { LiquidityTarget, TargetType, TargetSelection, ScoringWeights, DEFAULT_SCORING_WEIGHTS } from './types';
import { computeVWAP } from '@/indicators/vwap';

function findSessionLevels(candles: Candle[], price: number): LiquidityTarget[] {
  const targets: LiquidityTarget[] = [];
  if (candles.length < 2) return targets;

  const nyStart = 18.5, nyEnd = 27.5;
  const ldnStart = 13.5, ldnEnd = 22.5;
  const tyoStart = 7.5, tyoEnd = 16.5;
  const sydStart = 5.5, sydEnd = 12.5;

  const now = Date.now() / 1000;
  const oneDay = 86400;

  for (const c of candles) {
    const hr = (new Date(c.time * 1000).getUTCHours() + 5.5 + 24) % 24;
    if (hr >= sydStart && hr < sydEnd) {
      targets.push({ price: c.high, type: 'SESSION_HIGH', score: 0, strength: 70, source: 'Sydney session' });
      targets.push({ price: c.low, type: 'SESSION_LOW', score: 0, strength: 70, source: 'Sydney session' });
    }
    if (hr >= tyoStart && hr < tyoEnd) {
      targets.push({ price: c.high, type: 'SESSION_HIGH', score: 0, strength: 75, source: 'Tokyo session' });
      targets.push({ price: c.low, type: 'SESSION_LOW', score: 0, strength: 75, source: 'Tokyo session' });
    }
    if (hr >= ldnStart && hr < ldnEnd) {
      targets.push({ price: c.high, type: 'SESSION_HIGH', score: 0, strength: 80, source: 'London session' });
      targets.push({ price: c.low, type: 'SESSION_LOW', score: 0, strength: 80, source: 'London session' });
    }
    if (hr >= nyStart || hr < nyEnd - 24) {
      targets.push({ price: c.high, type: 'SESSION_HIGH', score: 0, strength: 85, source: 'New York session' });
      targets.push({ price: c.low, type: 'SESSION_LOW', score: 0, strength: 85, source: 'New York session' });
    }
  }

  return dedupeTargets(targets);
}

function findDailyWeeklyMonthlyLevels(candles: Candle[]): LiquidityTarget[] {
  const targets: LiquidityTarget[] = [];
  if (candles.length < 5) return targets;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const dailyHigh = Math.max(...highs);
  const dailyLow = Math.min(...lows);
  targets.push({ price: dailyHigh, type: 'DAILY_HIGH', score: 0, strength: 90, source: 'Daily high' });
  targets.push({ price: dailyLow, type: 'DAILY_LOW', score: 0, strength: 90, source: 'Daily low' });

  const mid = Math.floor(candles.length / 2);
  if (mid > 0) {
    const week1High = Math.max(...highs.slice(0, mid));
    const week1Low = Math.min(...lows.slice(0, mid));
    const week2High = Math.max(...highs.slice(mid));
    const week2Low = Math.min(...lows.slice(mid));
    targets.push({ price: week1High, type: 'WEEKLY_HIGH', score: 0, strength: 80, source: 'Weekly (early)' });
    targets.push({ price: week1Low, type: 'WEEKLY_LOW', score: 0, strength: 80, source: 'Weekly (early)' });
    targets.push({ price: week2High, type: 'WEEKLY_HIGH', score: 0, strength: 80, source: 'Weekly (late)' });
    targets.push({ price: week2Low, type: 'WEEKLY_LOW', score: 0, strength: 80, source: 'Weekly (late)' });
  }

  return dedupeTargets(targets);
}

function findSwingLevels(candles: Candle[], price: number): LiquidityTarget[] {
  const targets: LiquidityTarget[] = [];
  if (candles.length < 6) return targets;

  const highs: number[] = [];
  const lows: number[] = [];

  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    if (c.high > candles[i - 1].high && c.high > candles[i - 2].high &&
        c.high > candles[i + 1].high && c.high > candles[i + 2].high) {
      highs.push(c.high);
    }
    if (c.low < candles[i - 1].low && c.low < candles[i - 2].low &&
        c.low < candles[i + 1].low && c.low < candles[i + 2].low) {
      lows.push(c.low);
    }
  }

  if (highs.length >= 2) {
    const last = highs[highs.length - 1];
    const prev = highs[highs.length - 2];
    if (Math.abs(last - prev) / last < 0.005) {
      targets.push({ price: last, type: 'EQH', score: 0, strength: 85, source: 'Equal highs' });
    }
    targets.push({ price: last, type: 'PREV_HIGH', score: 0, strength: 75, source: 'Previous swing high' });
    if (highs.length >= 3) {
      targets.push({ price: highs[highs.length - 3], type: 'PREV_HIGH', score: 0, strength: 65, source: 'Older swing high' });
    }
  }

  if (lows.length >= 2) {
    const last = lows[lows.length - 1];
    const prev = lows[lows.length - 2];
    if (Math.abs(last - prev) / last < 0.005) {
      targets.push({ price: last, type: 'EQL', score: 0, strength: 85, source: 'Equal lows' });
    }
    targets.push({ price: last, type: 'PREV_LOW', score: 0, strength: 75, source: 'Previous swing low' });
    if (lows.length >= 3) {
      targets.push({ price: lows[lows.length - 3], type: 'PREV_LOW', score: 0, strength: 65, source: 'Older swing low' });
    }
  }

  return dedupeTargets(targets);
}

function findVolumeProfileLevels(candles: Candle[]): LiquidityTarget[] {
  const targets: LiquidityTarget[] = [];
  if (candles.length < 10) return targets;

  const priceRange = Math.max(...candles.map(c => c.high)) - Math.min(...candles.map(c => c.low));
  if (priceRange <= 0) return targets;

  const bucketCount = 20;
  const bucketSize = priceRange / bucketCount;
  const basePrice = Math.min(...candles.map(c => c.low));

  const volumeBuckets = new Array(bucketCount).fill(0);
  const tickBuckets = new Array(bucketCount).fill(0);

  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((tp - basePrice) / bucketSize)));
    volumeBuckets[idx] += c.volume;
    tickBuckets[idx] += 1;
  }

  const maxVol = Math.max(...volumeBuckets);
  if (maxVol <= 0) return targets;

  const pocIdx = volumeBuckets.indexOf(maxVol);
  const pocPrice = basePrice + (pocIdx + 0.5) * bucketSize;
  targets.push({ price: pocPrice, type: 'POC', score: 0, strength: 85, source: 'Point of Control' });

  const totalVol = volumeBuckets.reduce((s, v) => s + v, 0);
  let cumVol = 0;
  let vahIdx = bucketCount - 1;
  let valIdx = 0;

  for (let i = pocIdx; i < bucketCount; i++) {
    cumVol += volumeBuckets[i];
    if (cumVol / totalVol >= 0.7) { vahIdx = i; break; }
  }
  cumVol = 0;
  for (let i = pocIdx; i >= 0; i--) {
    cumVol += volumeBuckets[i];
    if (cumVol / totalVol >= 0.7) { valIdx = i; break; }
  }

  targets.push({ price: basePrice + (vahIdx + 0.5) * bucketSize, type: 'VAH', score: 0, strength: 80, source: 'Value Area High' });
  targets.push({ price: basePrice + (valIdx + 0.5) * bucketSize, type: 'VAL', score: 0, strength: 80, source: 'Value Area Low' });

  const avgVol = totalVol / bucketCount;
  for (let i = 0; i < bucketCount; i++) {
    if (volumeBuckets[i] > maxVol * 0.8 && i !== pocIdx) {
      targets.push({ price: basePrice + (i + 0.5) * bucketSize, type: 'POC', score: 0, strength: 75, source: 'High Volume Node' });
    }
    if (volumeBuckets[i] < avgVol * 0.3 && volumeBuckets[i] > 0) {
      targets.push({ price: basePrice + (i + 0.5) * bucketSize, type: 'POC', score: 0, strength: 40, source: 'Low Volume Node' });
    }
  }

  return dedupeTargets(targets);
}

function findVWAPLevels(candles: Candle[]): LiquidityTarget[] {
  const targets: LiquidityTarget[] = [];
  if (candles.length < 10) return targets;

  const vwap = computeVWAP(candles);
  targets.push({ price: vwap, type: 'VWAP', score: 0, strength: 80, source: 'Daily VWAP' });

  const mid = Math.floor(candles.length / 2);
  if (mid >= 10) {
    const vwap1 = computeVWAP(candles.slice(0, mid));
    const vwap2 = computeVWAP(candles.slice(mid));
    targets.push({ price: vwap1, type: 'VWAP_WEEKLY', score: 0, strength: 70, source: 'Weekly VWAP (early)' });
    targets.push({ price: vwap2, type: 'VWAP_WEEKLY', score: 0, strength: 70, source: 'Weekly VWAP (late)' });
  }

  return dedupeTargets(targets);
}

function findOrderBookLevels(levels: OrderBookLevel[], price: number, atr: number): LiquidityTarget[] {
  const targets: LiquidityTarget[] = [];
  if (levels.length === 0) return targets;

  const avgSize = levels.reduce((s, l) => s + l.size, 0) / levels.length;
  const wallThreshold = avgSize * 3;

  const bidWalls = levels.filter(l => l.isBid && l.size > wallThreshold);
  const askWalls = levels.filter(l => !l.isBid && l.size > wallThreshold);

  for (const w of bidWalls) {
    const dist = Math.abs(w.price - price);
    if (dist < atr * 5) {
      targets.push({ price: w.price, type: 'BID_WALL', score: 0, strength: Math.min(100, 60 + w.size / avgSize * 5), source: `Bid wall ${w.size.toFixed(1)}` });
    }
  }
  for (const w of askWalls) {
    const dist = Math.abs(w.price - price);
    if (dist < atr * 5) {
      targets.push({ price: w.price, type: 'ASK_WALL', score: 0, strength: Math.min(100, 60 + w.size / avgSize * 5), source: `Ask wall ${w.size.toFixed(1)}` });
    }
  }

  return dedupeTargets(targets);
}

function findSMLevels(sm: SmartMoneyData, price: number, atr: number): LiquidityTarget[] {
  const targets: LiquidityTarget[] = [];

  if (sm.fvg) {
    const dist = Math.abs(sm.fvg.upper - price);
    if (dist < atr * 10) {
      targets.push({ price: sm.fvg.type === 'bullish' ? sm.fvg.upper : sm.fvg.lower, type: 'FVG', score: 0, strength: 75, source: `${sm.fvg.type === 'bullish' ? 'Bullish' : 'Bearish'} FVG` });
    }
  }

  if (sm.orderBlock) {
    const dist = Math.abs(sm.orderBlock.price - price);
    if (dist < atr * 8) {
      targets.push({ price: sm.orderBlock.price, type: 'ORDER_BLOCK', score: 0, strength: 80, source: `${sm.orderBlock.type === 'bullish' ? 'Bullish' : 'Bearish'} OB` });
    }
  }

  if (sm.breakerBlock) {
    const dist = Math.abs(sm.breakerBlock.price - price);
    if (dist < atr * 8) {
      targets.push({ price: sm.breakerBlock.price, type: 'BREAKER_BLOCK', score: 0, strength: 70, source: `${sm.breakerBlock.type === 'bullish' ? 'Bullish' : 'Bearish'} breaker` });
    }
  }

  if (sm.mitigationBlock) {
    const dist = Math.abs(sm.mitigationBlock.price - price);
    if (dist < atr * 8) {
      targets.push({ price: sm.mitigationBlock.price, type: 'MITIGATION_BLOCK', score: 0, strength: 65, source: `${sm.mitigationBlock.type === 'bullish' ? 'Bullish' : 'Bearish'} mitigation` });
    }
  }

  return dedupeTargets(targets);
}

function findOIClusters(oiData: OpenInterestData | null, price: number, atr: number): LiquidityTarget[] {
  const targets: LiquidityTarget[] = [];
  if (!oiData?.currentOi) return targets;

  if (oiData.oiChange5m !== null && Math.abs(oiData.oiChange5m) > 5) {
    const dir = oiData.oiChange5m > 0 ? 1 : -1;
    targets.push({
      price: price + dir * atr * 2,
      type: 'OI_CLUSTER',
      score: 0,
      strength: Math.min(100, Math.abs(oiData.oiChange5m) * 5 + 50),
      source: `OI ${oiData.oiChange5m > 0 ? 'build-up' : 'unwinding'} ${Math.abs(oiData.oiChange5m).toFixed(1)}%`,
    });
  }

  if (oiData.oiMomentum !== null && Math.abs(oiData.oiMomentum) > 3) {
    targets.push({
      price: price + (oiData.oiMomentum > 0 ? 1 : -1) * atr * 1.5,
      type: 'OI_CLUSTER',
      score: 0,
      strength: 60,
      source: `OI momentum: ${oiData.oiMomentum.toFixed(1)}%`,
    });
  }

  return dedupeTargets(targets);
}

function findLiquidationClusters(levels: OrderBookLevel[], price: number, atr: number, oiData: OpenInterestData | null): LiquidityTarget[] {
  const targets: LiquidityTarget[] = [];
  if (levels.length < 5) return targets;

  const clustered: number[] = [];
  const clusterSize = atr * 0.5;

  for (let i = 0; i < levels.length; i++) {
    for (let j = i + 1; j < levels.length; j++) {
      if (Math.abs(levels[i].price - levels[j].price) < clusterSize) {
        if (!clustered.includes(levels[i].price)) clustered.push(levels[i].price);
        if (!clustered.includes(levels[j].price)) clustered.push(levels[j].price);
      }
    }
  }

  for (const p of clustered) {
    const clusterLevels = levels.filter(l => Math.abs(l.price - p) < clusterSize);
    const totalSize = clusterLevels.reduce((s, l) => s + l.size, 0);
    if (totalSize > 0) {
      const side = clusterLevels[0]?.isBid ? 'bid' : 'ask';
      targets.push({
        price: p,
        type: 'LIQUIDATION_CLUSTER',
        score: 0,
        strength: Math.min(100, 50 + totalSize * 10),
        source: `Liquidation cluster ${side} ${clusterLevels.length} levels`,
      });
    }
  }

  return dedupeTargets(targets);
}

function dedupeTargets(targets: LiquidityTarget[]): LiquidityTarget[] {
  const unique = new Map<string, LiquidityTarget>();
  for (const t of targets) {
    const key = `${t.type}_${t.price.toFixed(4)}`;
    if (!unique.has(key) || unique.get(key)!.strength < t.strength) {
      unique.set(key, t);
    }
  }
  return Array.from(unique.values());
}

function scoreTarget(
  target: LiquidityTarget,
  price: number,
  atr: number,
  expectedMove: number,
  sm: SmartMoneyData,
  oiData: OpenInterestData | null,
  candles: Candle[],
  levels: OrderBookLevel[],
  regime: RegimeResult,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
  side: 'long' | 'short',
): number {
  let score = 0;
  const isBullishTarget = target.price > price;

  // 1. Liquidity pool strength (25%)
  let liqScore = target.strength;
  if (regime.regime === 'trending' || regime.regime === 'strong_trend') {
    liqScore += 10;
  }
  const wallNearby = levels.some(l => Math.abs(l.price - target.price) / price < 0.003 && l.size > levels.reduce((s, l) => s + l.size, 0) / levels.length * 2);
  if (wallNearby) liqScore += 10;
  score += (liqScore / 100) * (weights.liquidityStrength / 100) * 100;

  // 2. Volume Profile (15%)
  const volBuckets = estimateVolumeProfile(candles, target.price);
  let volScore = 50;
  if (volBuckets > 75) volScore = 80;
  else if (volBuckets > 50) volScore = 65;
  else if (volBuckets > 25) volScore = 50;
  else volScore = 35;
  score += (volScore / 100) * (weights.volumeProfile / 100) * 100;

  // 3. Smart Money structure (20%)
  let smScore = 50;
  if (sm.bos && ((isBullishTarget && sm.bos === 'bullish') || (!isBullishTarget && sm.bos === 'bearish'))) {
    smScore += 20;
  }
  if (sm.fvg) {
    const fvgDist = Math.abs(target.price - (sm.fvg.type === 'bullish' ? sm.fvg.upper : sm.fvg.lower));
    if (fvgDist / price < 0.01) smScore += 15;
  }
  if (sm.orderBlock) {
    const obDist = Math.abs(target.price - sm.orderBlock.price);
    if (obDist / price < 0.005) smScore += 15;
  }
  if (sm.choch && ((isBullishTarget && sm.choch === 'bullish') || (!isBullishTarget && sm.choch === 'bearish'))) {
    smScore += 10;
  }
  score += (Math.min(100, smScore) / 100) * (weights.smartMoney / 100) * 100;

  // 4. Open Interest / Liquidation cluster (15%)
  let oiScore = 50;
  if (oiData?.currentOi) {
    if (isBullishTarget && oiData.oiTrend === 'rising' && oiData.longBuildUp) oiScore += 25;
    else if (!isBullishTarget && oiData.oiTrend === 'rising' && oiData.shortBuildUp) oiScore += 25;
    else if (isBullishTarget && oiData.oiTrend === 'falling' && oiData.shortCovering) oiScore += 20;
    else if (!isBullishTarget && oiData.oiTrend === 'falling' && oiData.longUnwinding) oiScore += 20;
    if (oiData.oiMomentum !== null && Math.abs(oiData.oiMomentum) > 5) oiScore += 10;
  }
  score += (Math.min(100, oiScore) / 100) * (weights.openInterest / 100) * 100;

  // 5. Expected Move reaches target (15%)
  const moveRequired = Math.abs(target.price - price);
  let emScore = 0;
  if (moveRequired <= expectedMove * 1.5) emScore = 90;
  else if (moveRequired <= expectedMove * 2) emScore = 70;
  else if (moveRequired <= expectedMove * 3) emScore = 50;
  else emScore = 20;
  score += (emScore / 100) * (weights.expectedMove / 100) * 100;

  // 6. Risk:Reward (10%)
  const stopDistance = atr * 1.5;
  const rr = stopDistance > 0 ? moveRequired / stopDistance : 0;
  let rrScore = 0;
  if (rr >= 3) rrScore = 90;
  else if (rr >= 2) rrScore = 75;
  else if (rr >= 1.5) rrScore = 60;
  else rrScore = 20;
  score += (rrScore / 100) * (weights.riskReward / 100) * 100;

  return Math.round(Math.min(100, Math.max(0, score)));
}

function estimateVolumeProfile(candles: Candle[], targetPrice: number): number {
  if (candles.length < 5) return 50;

  const priceRange = Math.max(...candles.map(c => c.high)) - Math.min(...candles.map(c => c.low));
  if (priceRange <= 0) return 50;

  const bucketCount = 20;
  const bucketSize = priceRange / bucketCount;
  const basePrice = Math.min(...candles.map(c => c.low));
  const idx = Math.floor((targetPrice - basePrice) / bucketSize);

  if (idx < 0 || idx >= bucketCount) return 30;

  const volumeBuckets = new Array(bucketCount).fill(0);
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    const bi = Math.min(bucketCount - 1, Math.max(0, Math.floor((tp - basePrice) / bucketSize)));
    volumeBuckets[bi] += c.volume;
  }

  const maxVol = Math.max(...volumeBuckets);
  if (maxVol <= 0) return 50;
  return (volumeBuckets[idx] / maxVol) * 100;
}

const DEFAULT_SCORING_WEIGHTS = { liquidityStrength: 25, volumeProfile: 15, smartMoney: 20, openInterest: 15, expectedMove: 15, riskReward: 10 };

export function generateTargets(
  candles: Candle[],
  levels: OrderBookLevel[],
  price: number,
  side: 'long' | 'short',
  sm: SmartMoneyData,
  oiData: OpenInterestData | null,
  atr: number,
  expectedMove: number,
  regime: RegimeResult,
  weights?: ScoringWeights,
): TargetSelection {
  const w = weights || DEFAULT_SCORING_WEIGHTS;
  if (side === 'wait' || candles.length < 5) {
    return { tp1: null, tp2: null, tp3: null, entry: price, stop: 0, riskReward: 0, expectedWinRate: 0, explanation: 'No clear direction' };
  }

  const allTargets: LiquidityTarget[] = [
    ...findSessionLevels(candles, price),
    ...findDailyWeeklyMonthlyLevels(candles),
    ...findSwingLevels(candles, price),
    ...findVolumeProfileLevels(candles),
    ...findVWAPLevels(candles),
    ...findOrderBookLevels(levels, price, atr),
    ...findSMLevels(sm, price, atr),
    ...findOIClusters(oiData, price, atr),
    ...findLiquidationClusters(levels, price, atr, oiData),
  ];

  const directionTargets = allTargets.filter(t =>
    side === 'long' ? t.price > price : t.price < price,
  );

  const stopDistance = atr * 1.5;
  const entry = price;

  const scored = directionTargets
    .map(t => {
      const s = scoreTarget(t, price, atr, expectedMove, sm, oiData, candles, levels, regime, w, side);
      const moveDist = Math.abs(t.price - entry);
      const rr = stopDistance > 0 ? moveDist / stopDistance : 0;
      return { ...t, score: s, riskReward: rr };
    })
    .filter(t => t.score >= 70 && t.riskReward >= 1.5)
    .sort((a, b) => b.score - a.score);

  const tp1 = scored.length > 0 ? scored[0] : null;
  const tp2 = scored.length > 1 ? scored[1] : null;
  const tp3 = scored.length > 2 ? scored[2] : null;

  const rr = tp1 && stopDistance > 0 ? Math.abs(tp1.price - entry) / stopDistance : 0;
  const winRate = scored.length > 0 ? Math.min(90, Math.round(scored.reduce((s, t) => s + t.score, 0) / scored.length)) : 0;

  let explanation = '';
  if (tp1) {
    explanation = `TP1 at ${tp1.price.toFixed(2)} (${tp1.type}, score: ${tp1.score}, source: ${tp1.source})`;
    if (tp2) explanation += ` | TP2 at ${tp2.price.toFixed(2)} (${tp2.type}, score: ${tp2.score}, source: ${tp2.source})`;
    if (tp3) explanation += ` | TP3 at ${tp3.price.toFixed(2)} (${tp3.type}, score: ${tp3.score}, source: ${tp3.source})`;
  } else {
    explanation = 'No valid targets found — all candidates failed validation';
  }

  return { tp1, tp2, tp3, entry, stop: 0, riskReward: parseFloat(rr.toFixed(2)), expectedWinRate: winRate, explanation };
}
