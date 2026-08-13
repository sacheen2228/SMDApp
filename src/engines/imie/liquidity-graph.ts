import type { Candle, SmartMoneyData, OpenInterestData, OrderFlowData } from '@/types/engine';
import type { LiquidityGraph, LiquidityNode, LiquidityNodeType } from './types';
import { computeVWAP } from '@/indicators/vwap';

const SESSION_WINDOWS: { name: LiquidityNodeType; start: number; end: number }[] = [
  { name: 'ASIA_HIGH' as any, start: 5.5, end: 12.5 },
  { name: 'LONDON_HIGH' as any, start: 13.5, end: 22.5 },
  { name: 'NEW_YORK_HIGH' as any, start: 18.5, end: 27.5 },
];

let nodeCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${nodeCounter++}_${Date.now()}`;
}

export function buildGraph(
  candles: Candle[],
  levels: { price: number; size: number; isBid: boolean }[],
  price: number,
  sm: SmartMoneyData,
  oi: OpenInterestData | null,
  of: OrderFlowData | null,
): LiquidityGraph {
  nodeCounter = 0;
  const nodes: LiquidityNode[] = [];
  const now = Date.now();

  // 1. Session highs/lows
  nodes.push(...sessionNodes(candles, price, now));

  // 2. Swing highs/lows from SM data
  nodes.push(...swingNodes(sm, price, now));

  // 3. Weekly/monthly levels from candle extremes
  nodes.push(...timeframeNodes(candles, price, now));

  // 4. Smart money levels
  nodes.push(...smNodes(sm, price, now));

  // 5. Volume profile nodes (POC, HVN, LVN)
  nodes.push(...volumeNodes(candles, price, now));

  // 6. VWAP
  const vwap = computeVWAP(candles);
  nodes.push(makeNode(vwap, 'VWAP', 80, 0, price, now, 'Daily VWAP'));

  // 7. Round numbers
  const roundNum = Math.round(price / 100) * 100;
  nodes.push(makeNode(roundNum, 'ROUND_NUMBER', 65, 0, price, now, `Round number ${roundNum}`));

  // 8. Order book walls
  nodes.push(...domNodes(levels, price, now));

  // 9. OI clusters
  if (oi?.currentOi) {
    nodes.push(...oiNodes(oi, price, now));
  }

  // 10. Liquidation clusters
  nodes.push(...liqNodes(levels, price, now));

  // 11. Equal highs/lows from SM
  if (sm.equalHigh && sm.swingHigh.length >= 2) {
    const eqh = (sm.swingHigh[sm.swingHigh.length - 1] + sm.swingHigh[sm.swingHigh.length - 2]) / 2;
    nodes.push(makeNode(eqh, 'EQH', 85, 0, price, now, 'Equal highs'));
  }
  if (sm.equalLow && sm.swingLow.length >= 2) {
    const eql = (sm.swingLow[sm.swingLow.length - 1] + sm.swingLow[sm.swingLow.length - 2]) / 2;
    nodes.push(makeNode(eql, 'EQL', 85, 0, price, now, 'Equal lows'));
  }

  // Deduplicate and score
  const deduped = deduplicate(nodes);
  for (const n of deduped) {
    n.distance = Math.abs(n.price - price);
    n.probability = Math.min(90, n.strength);
    n.expectedReaction = estimateReaction(n.strength, n.distance, price);
    n.age = Math.round((now - n.age * 60000) / 60000);
  }

  const sorted = deduped.sort((a, b) => b.strength - a.strength);
  const bullish = sorted.filter(n => n.price > price).sort((a, b) => a.price - b.price);
  const bearish = sorted.filter(n => n.price < price).sort((a, b) => b.price - a.price);

  return {
    nodes: sorted.slice(0, 60),
    bullishNodes: bullish.slice(0, 20),
    bearishNodes: bearish.slice(0, 20),
    nearestBullish: bullish.length > 0 ? bullish[0] : null,
    nearestBearish: bearish.length > 0 ? bearish[0] : null,
    totalNodes: sorted.length,
  };
}

function makeNode(p: number, type: LiquidityNodeType, strength: number, vol: number, current: number, _now: number, source: string): LiquidityNode {
  return {
    id: nextId(type),
    price: p, type, strength, age: 0, volume: vol,
    distance: Math.abs(p - current),
    probability: 0, expectedReaction: 50,
  };
}

// ================================================================
// SESSION NODES
// ================================================================
function sessionNodes(candles: Candle[], price: number, now: number): LiquidityNode[] {
  const nodes: LiquidityNode[] = [];
  if (candles.length < 2) return nodes;

  for (const c of candles) {
    const hr = ((new Date(c.time * 1000).getUTCHours() + 5.5) % 24);
    for (const s of SESSION_WINDOWS) {
      const adjustedHr = s.end > 24 ? (hr < s.end - 24 ? hr + 24 : hr) : hr;
      if (adjustedHr >= s.start && adjustedHr < s.end) {
        const highType = s.name.toString().replace('_HIGH', '_HIGH') as LiquidityNodeType;
        const lowType = s.name.toString().replace('_HIGH', '_LOW') as LiquidityNodeType;
        nodes.push(makeNode(c.high, highType, 70 + (s.name.includes('NEW_YORK') ? 15 : s.name.includes('LONDON') ? 10 : 5), c.volume, price, now, `${s.name} high`));
        nodes.push(makeNode(c.low, lowType, 70 + (s.name.includes('NEW_YORK') ? 15 : s.name.includes('LONDON') ? 10 : 5), c.volume, price, now, `${s.name} low`));
        break;
      }
    }
  }
  return nodes;
}

// ================================================================
// SWING NODES
// ================================================================
function swingNodes(sm: SmartMoneyData, price: number, now: number): LiquidityNode[] {
  const nodes: LiquidityNode[] = [];
  for (const sh of sm.swingHigh) {
    nodes.push(makeNode(sh, 'SWING_HIGH', 75, 0, price, now, 'Swing high'));
  }
  for (const sl of sm.swingLow) {
    nodes.push(makeNode(sl, 'SWING_LOW', 75, 0, price, now, 'Swing low'));
  }
  return nodes;
}

// ================================================================
// TIMEFRAME NODES (weekly/monthly approximations)
// ================================================================
function timeframeNodes(candles: Candle[], price: number, now: number): LiquidityNode[] {
  const nodes: LiquidityNode[] = [];
  if (candles.length < 10) return nodes;

  const mid = Math.floor(candles.length / 2);
  const firstHalf = candles.slice(0, mid);
  const secondHalf = candles.slice(mid);

  // Weekly approximation (split into 2 halves)
  if (firstHalf.length > 0) {
    const wh = Math.max(...firstHalf.map(c => c.high));
    const wl = Math.min(...firstHalf.map(c => c.low));
    nodes.push(makeNode(wh, 'WEEKLY_HIGH', 85, 0, price, now, 'Weekly high (approx)'));
    nodes.push(makeNode(wl, 'WEEKLY_LOW', 85, 0, price, now, 'Weekly low (approx)'));
  }
  if (secondHalf.length > 0) {
    const mh = Math.max(...secondHalf.map(c => c.high));
    const ml = Math.min(...secondHalf.map(c => c.low));
    nodes.push(makeNode(mh, 'MONTHLY_HIGH', 90, 0, price, now, 'Monthly high (approx)'));
    nodes.push(makeNode(ml, 'MONTHLY_LOW', 90, 0, price, now, 'Monthly low (approx)'));
  }

  return nodes;
}

// ================================================================
// SMART MONEY NODES
// ================================================================
function smNodes(sm: SmartMoneyData, price: number, now: number): LiquidityNode[] {
  const nodes: LiquidityNode[] = [];
  if (sm.fvg) {
    const p = sm.fvg.type === 'bullish' ? sm.fvg.lower : sm.fvg.upper;
    nodes.push(makeNode(p, 'FAIR_VALUE_GAP', 80, 0, price, now, `${sm.fvg.type} FVG`));
  }
  if (sm.orderBlock) {
    nodes.push(makeNode(sm.orderBlock.price, 'ORDER_BLOCK', 82, 0, price, now, `${sm.orderBlock.type} OB`));
  }
  if (sm.breakerBlock) {
    nodes.push(makeNode(sm.breakerBlock.price, 'BREAKER_BLOCK', 75, 0, price, now, `${sm.breakerBlock.type} breaker`));
  }
  if (sm.mitigationBlock) {
    nodes.push(makeNode(sm.mitigationBlock.price, 'MITIGATION_BLOCK', 72, 0, price, now, `${sm.mitigationBlock.type} mitigation`));
  }
  return nodes;
}

// ================================================================
// VOLUME PROFILE NODES
// ================================================================
function volumeNodes(candles: Candle[], price: number, now: number): LiquidityNode[] {
  const nodes: LiquidityNode[] = [];
  if (candles.length < 5) return nodes;

  const totalRange = Math.max(...candles.map(c => c.high)) - Math.min(...candles.map(c => c.low));
  const bucketCount = 20;
  const bucketSize = totalRange / bucketCount || 1;
  const minPrice = Math.min(...candles.map(c => c.low));

  const buckets = new Array(bucketCount).fill(0);
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((tp - minPrice) / bucketSize)));
    buckets[idx] += c.volume;
  }

  const maxVol = Math.max(...buckets);
  if (maxVol <= 0) return nodes;

  const pocIdx = buckets.indexOf(maxVol);
  const poc = minPrice + (pocIdx + 0.5) * bucketSize;
  nodes.push(makeNode(poc, 'POC', 85, maxVol, price, now, 'Point of Control'));

  // HVN — buckets > 70% of max
  for (let i = 0; i < bucketCount; i++) {
    if (buckets[i] >= maxVol * 0.7 && i !== pocIdx) {
      const hvnPrice = minPrice + (i + 0.5) * bucketSize;
      nodes.push(makeNode(hvnPrice, 'HVN', 75, buckets[i], price, now, 'High Volume Node'));
    }
  }

  // LVN — buckets within middle 50% with < 20% of max
  for (let i = Math.floor(bucketCount * 0.25); i < Math.ceil(bucketCount * 0.75); i++) {
    if (buckets[i] <= maxVol * 0.2) {
      const lvnPrice = minPrice + (i + 0.5) * bucketSize;
      nodes.push(makeNode(lvnPrice, 'LVN', 60, buckets[i], price, now, 'Low Volume Node (liquidity void)'));
    }
  }

  return nodes;
}

// ================================================================
// DOM WALL NODES
// ================================================================
function domNodes(levels: { price: number; size: number }[], price: number, now: number): LiquidityNode[] {
  const nodes: LiquidityNode[] = [];
  if (levels.length === 0) return nodes;
  const avgSize = levels.reduce((s, l) => s + l.size, 0) / levels.length;
  const threshold = avgSize * 3;
  for (const l of levels) {
    if (l.size > threshold) {
      nodes.push(makeNode(l.price, 'DOM_WALL', Math.min(90, 60 + l.size / avgSize * 5), l.size, price, now, `DOM wall ${l.size.toFixed(1)}`));
    }
  }
  return nodes;
}

// ================================================================
// OI CLUSTER NODES
// ================================================================
function oiNodes(oi: OpenInterestData, price: number, now: number): LiquidityNode[] {
  const nodes: LiquidityNode[] = [];
  const atrApprox = price * 0.01;
  if (oi.oiChange5m !== null && Math.abs(oi.oiChange5m) > 5) {
    const dir = oi.oiChange5m > 0 ? 1 : -1;
    nodes.push(makeNode(price + dir * atrApprox * 2, 'OI_CLUSTER', Math.min(90, Math.abs(oi.oiChange5m) * 5 + 50), 0, price, now, `OI ${oi.oiChange5m > 0 ? 'build-up' : 'unwinding'} ${Math.abs(oi.oiChange5m).toFixed(1)}%`));
  }
  return nodes;
}

// ================================================================
// LIQUIDATION CLUSTER NODES
// ================================================================
function liqNodes(levels: { price: number; size: number }[], price: number, now: number): LiquidityNode[] {
  const nodes: LiquidityNode[] = [];
  if (levels.length < 5) return nodes;
  const clusterDist = price * 0.002;
  const visited = new Set<number>();
  for (let i = 0; i < levels.length; i++) {
    for (let j = i + 1; j < levels.length; j++) {
      if (Math.abs(levels[i].price - levels[j].price) < clusterDist) {
        [i, j].forEach(idx => {
          if (!visited.has(levels[idx].price)) {
            visited.add(levels[idx].price);
            nodes.push(makeNode(levels[idx].price, 'LIQUIDATION_CLUSTER', 65, 0, price, now, 'Liquidation cluster'));
          }
        });
      }
    }
  }
  return nodes;
}

// ================================================================
// DEDUPLICATION
// ================================================================
function deduplicate(nodes: LiquidityNode[]): LiquidityNode[] {
  const map = new Map<string, LiquidityNode>();
  for (const n of nodes) {
    const key = `${n.type}_${n.price.toFixed(2)}`;
    if (!map.has(key) || map.get(key)!.strength < n.strength) {
      map.set(key, n);
    }
  }
  return Array.from(map.values());
}

function estimateReaction(strength: number, distance: number, price: number): number {
  const distPct = distance / price * 100;
  if (strength >= 85 && distPct < 0.5) return 90;
  if (strength >= 75 && distPct < 1) return 80;
  if (strength >= 65) return 65;
  return 50;
}
