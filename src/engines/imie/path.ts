import type { Candle, SmartMoneyData, OrderFlowData, VolatilityData } from '@/types/engine';
import type { PathStep, PathResult, Destination, LiquidityGraph, MarketIntent } from './types';
import { computeVWAP } from '@/indicators/vwap';

export function predictPath(
  destination: Destination,
  graph: LiquidityGraph,
  price: number,
  candles: Candle[],
  sm: SmartMoneyData,
  of: OrderFlowData | null,
  vol: VolatilityData | null,
  intent: MarketIntent,
): PathResult {
  const vwap = computeVWAP(candles);
  const isBull = destination.price > price;
  const destPrice = destination.price;

  // ================================================================
  // Collect intermediate nodes along the route
  // ================================================================
  const routeNodes = graph.nodes
    .filter(n => (isBull ? n.price > price && n.price < destPrice : n.price < price && n.price > destPrice))
    .sort((a, b) => isBull ? a.price - b.price : b.price - a.price);

  const uniqueTypes = new Set<string>();
  const filtered: typeof routeNodes = [];
  for (const n of routeNodes) {
    if (!uniqueTypes.has(n.type) && filtered.length < 4) {
      uniqueTypes.add(n.type);
      filtered.push(n);
    }
  }

  // ================================================================
  // PRIMARY PATH
  // ================================================================
  const primary: PathStep[] = [];
  primary.push({ price, label: 'Current Price', description: `Starting point at ${price.toFixed(2)}` });

  // Intermediate legs
  const midPrices: { price: number; label: string; desc: string }[] = [];

  // Liquidity sweep (nearest opposite-side liquidity)
  if (isBull && graph.nearestBearish) {
    midPrices.push({ price: graph.nearestBearish.price, label: `${graph.nearestBearish.type} Sweep`, desc: `Sweep ${graph.nearestBearish.source}` });
  } else if (!isBull && graph.nearestBullish) {
    midPrices.push({ price: graph.nearestBullish.price, label: `${graph.nearestBullish.type} Sweep`, desc: `Sweep ${graph.nearestBullish.source}` });
  }

  // VWAP retest
  if (isBull && vwap > price && vwap < destPrice) {
    midPrices.push({ price: vwap, label: 'VWAP Retest', desc: `Retest VWAP at ${vwap.toFixed(2)}` });
  } else if (!isBull && vwap < price && vwap > destPrice) {
    midPrices.push({ price: vwap, label: 'VWAP Retest', desc: `Retest VWAP at ${vwap.toFixed(2)}` });
  }

  // Intermediate nodes
  for (const n of filtered) {
    midPrices.push({ price: n.price, label: n.type, desc: `${n.type} — ${n.source}` });
  }

  // Destination
  midPrices.push({ price: destPrice, label: 'Destination', desc: `${destination.node.type} target at ${destPrice.toFixed(2)}` });

  // Sort by price for the direction
  if (isBull) midPrices.sort((a, b) => a.price - b.price);
  else midPrices.sort((a, b) => b.price - a.price);

  for (const mp of midPrices) {
    if (Math.abs(mp.price - primary[primary.length - 1].price) / price > 0.0005) {
      primary.push({ price: mp.price, label: mp.label, description: mp.desc });
    }
  }

  // ================================================================
  // ALTERNATIVE PATH — bypass VWAP, take different intermediate nodes
  // ================================================================
  const alt: PathStep[] = [{ price, label: 'Current Price', description: 'Starting point' }];
  const nonVwapNodes = filtered.filter(n => n.type !== 'VWAP');
  for (const n of nonVwapNodes) {
    alt.push({ price: n.price, label: n.type, description: `${n.type} — alternative route` });
  }
  if (alt[alt.length - 1].price !== destPrice) {
    alt.push({ price: destPrice, label: 'Destination', description: 'Alternative path destination' });
  }

  // ================================================================
  // FAILURE PATH — price goes opposite direction
  // ================================================================
  const failure: PathStep[] = [{ price, label: 'Current Price', description: 'Starting point' }];
  if (isBull) {
    // Failure means going down
    const failTargets = graph.bearishNodes.slice(0, 3).sort((a, b) => b.price - a.price);
    for (const t of failTargets) {
      failure.push({ price: t.price, label: `Failure: ${t.type}`, description: `Invalidation: ${t.source}` });
    }
    if (graph.nearestBearish) {
      failure.push({ price: graph.nearestBearish.price, label: 'Failure: Sweep', description: 'Full invalidation — sweep opposite liquidity' });
    }
  } else {
    const failTargets = graph.bullishNodes.slice(0, 3).sort((a, b) => a.price - b.price);
    for (const t of failTargets) {
      failure.push({ price: t.price, label: `Failure: ${t.type}`, description: `Invalidation: ${t.source}` });
    }
    if (graph.nearestBullish) {
      failure.push({ price: graph.nearestBullish.price, label: 'Failure: Sweep', description: 'Full invalidation — sweep opposite liquidity' });
    }
  }

  return { primary, alternative: alt, failure };
}
