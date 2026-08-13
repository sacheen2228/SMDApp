import type { EngineScore, LiquidityData, OrderBookLevel } from '@/types/engine';

export function evaluateLiquidity(
  levels: OrderBookLevel[],
  trades: { price: number; size: number; isBuyerMaker: boolean }[],
  price: number,
): { data: LiquidityData; score: EngineScore } {
  if (levels.length === 0) {
    return {
      data: { domImbalance: 0, bidWalls: 0, askWalls: 0, largestBid: 0, largestAsk: 0, sweepDetected: false, liquidityVoid: false },
      score: { score: 50, confidence: 0, bullishProb: 33, bearishProb: 33, neutralProb: 34, reasons: ['No order book data'] },
    };
  }

  const bids = levels.filter(l => l.isBid);
  const asks = levels.filter(l => !l.isBid);

  const bidVol = bids.reduce((s, l) => s + l.size, 0);
  const askVol = asks.reduce((s, l) => s + l.size, 0);
  const domImbalance = bidVol > 0 && askVol > 0 ? (bidVol - askVol) / (bidVol + askVol) : 0;

  const avgSize = levels.reduce((s, l) => s + l.size, 0) / (levels.length || 1);
  const wallThreshold = avgSize * 3;

  const bidWalls = bids.filter(l => l.size > wallThreshold).length;
  const askWalls = asks.filter(l => l.size > wallThreshold).length;
  const largestBid = bids.length > 0 ? Math.max(...bids.map(l => l.size)) : 0;
  const largestAsk = asks.length > 0 ? Math.max(...asks.map(l => l.size)) : 0;

  // Sweep detection: trade passing through a wall
  const sweepDetected = trades.some(t => {
    const nearBids = bids.filter(l => Math.abs(l.price - t.price) / price < 0.002);
    const nearAsks = asks.filter(l => Math.abs(l.price - t.price) / price < 0.002);
    return (nearBids.length > 0 && t.isBuyerMaker) || (nearAsks.length > 0 && !t.isBuyerMaker);
  });

  // Liquidity void: gap between best bid and ask
  const bestBid = bids.length > 0 ? Math.max(...bids.map(l => l.price)) : 0;
  const bestAsk = asks.length > 0 ? Math.min(...asks.map(l => l.price)) : Infinity;
  const spread = bestAsk > bestBid ? (bestAsk - bestBid) / price * 100 : 0;
  const liquidityVoid = spread > 0.5;

  const reasons: string[] = [];
  let bullish = 50;
  let bearish = 50;

  if (domImbalance > 0.2) {
    bullish += 15;
    reasons.push(`DOM imbalance bullish: ${(domImbalance * 100).toFixed(0)}%`);
  } else if (domImbalance < -0.2) {
    bearish += 15;
    reasons.push(`DOM imbalance bearish: ${(domImbalance * 100).toFixed(0)}%`);
  }

  if (bidWalls > askWalls) {
    bullish += 10;
    reasons.push(`${bidWalls} bid walls vs ${askWalls} ask walls`);
  } else if (askWalls > bidWalls) {
    bearish += 10;
    reasons.push(`${askWalls} ask walls vs ${bidWalls} bid walls`);
  }

  if (sweepDetected) {
    reasons.push('Liquidity sweep detected');
    bullish += 15;
  }

  if (liquidityVoid) {
    reasons.push(`Liquidity void (spread: ${spread.toFixed(2)}%)`);
  }

  const total = bullish + bearish;
  const bullishPct = total > 0 ? (bullish / total) * 100 : 50;
  const bearishPct = total > 0 ? (bearish / total) * 100 : 50;
  const confidence = Math.min(1, levels.length / 20);

  return {
    data: { domImbalance, bidWalls, askWalls, largestBid, largestAsk, sweepDetected, liquidityVoid },
    score: {
      score: Math.max(0, Math.min(100, bullish)),
      confidence,
      bullishProb: Math.round(bullishPct),
      bearishProb: Math.round(bearishPct),
      neutralProb: Math.round(Math.max(0, 100 - bullishPct - bearishPct)),
      reasons,
    },
  };
}
