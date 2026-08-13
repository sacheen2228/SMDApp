import type { Candle, SmartMoneyData, OrderFlowData, VolatilityData, RegimeResult, OpenInterestData } from '@/types/engine';
import type { LiquidityGraph, LiquidityNode, Destination, DestinationResult } from './types';

export function calculateDestinationScore(node: LiquidityNode): number {
  return (
    node.strength * 0.30 +
    node.probability * 0.25 +
    node.expectedReaction * 0.20 +
    Math.max(0, 100 - node.age) * 0.10 +
    15
  );
}

export function rankDestinations(nodes: LiquidityNode[]): { node: LiquidityNode; score: number }[] {
  return nodes
    .map(n => ({ node: n, score: calculateDestinationScore(n) }))
    .sort((a, b) => b.score - a.score);
}

export function findDestinations(
  graph: LiquidityGraph,
  candles: Candle[],
  price: number,
  sm: SmartMoneyData,
  of: OrderFlowData | null,
  vol: VolatilityData | null,
  regime: RegimeResult | null,
  oi: OpenInterestData | null,
): DestinationResult {
  const atr = vol?.atr || price * 0.01;
  const expectedMove = atr * 1.5;

  const ranked = rankDestinations(graph.nodes);
  const destinations: Destination[] = [];

  for (const { node, score } of ranked) {
    const dist = Math.abs(node.price - price);
    if (dist < price * 0.0005) continue;

    const isBull = node.price > price;

    // Base probability from score
    let prob = Math.min(90, Math.max(5, score));

    // Adjust for SM alignment
    if (sm.bos === 'bullish' && isBull) prob += 8;
    if (sm.bos === 'bearish' && !isBull) prob += 8;

    // Adjust for regime
    if (regime) {
      if ((regime.regime === 'trending' || regime.regime === 'strong_trend') && prob >= 60) prob += 5;
      if (regime.regime === 'compression') prob -= 5;
    }

    // Distance check — destinations beyond 3x expected move are unlikely
    if (dist > expectedMove * 3) prob *= 0.5;

    // Risk = inverse of probability
    const risk = Math.round(100 - prob);

    // Expected reaction
    const expectedReaction = prob > 75 ? 'acceleration' as const : prob > 60 ? 'continuation' as const : prob > 45 ? 'absorption' as const : 'reversal' as const;

    // Time estimate (no ATR — use volume regime)
    const estMins = estimateTime(dist, vol);

    destinations.push({
      node,
      price: node.price,
      probability: Math.round(prob),
      expectedMinutes: estMins,
      distance: parseFloat(dist.toFixed(2)),
      expectedReaction,
      risk,
      pathScore: score,
      expectedMove: parseFloat(expectedMove.toFixed(2)),
    });

    if (destinations.length >= 10) break;
  }

  return {
    destinations,
    topDestination: destinations.length > 0 ? destinations[0] : null,
  };
}

function estimateTime(dist: number, vol: VolatilityData | null): number {
  const atr = vol?.atr || 0;
  if (atr <= 0) return 30;
  const barsNeeded = Math.ceil(dist / atr);
  const minsPerBar = vol?.atrRegime === 'high' || vol?.atrRegime === 'extreme' ? 5 : 15;
  return Math.max(15, barsNeeded * minsPerBar);
}
