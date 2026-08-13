import type { EngineScore, OrderFlowData, Trade } from '@/types/engine';

export function computeOrderFlow(
  trades: Trade[],
  prevTrades: Trade[],
  bidVol: number,
  askVol: number,
): { data: OrderFlowData; score: EngineScore } {
  if (trades.length === 0) {
    return {
      data: {
        cumDelta: 0, deltaPercent: 0, aggressiveBuys: 0, aggressiveSells: 0,
        bidAskRatio: bidVol > 0 && askVol > 0 ? bidVol / askVol : 1,
        stackedBids: 0, stackedAsks: 0, largeOrders: 0, absorption: false, exhaustion: false,
      },
      score: { score: 50, confidence: 0, bullishProb: 33, bearishProb: 33, neutralProb: 34, reasons: ['No trades'] },
    };
  }

  const cumDelta = trades.reduce((s, t) => s + (t.isBuyerMaker ? -t.size : t.size), 0);
  const buyVol = trades.filter(t => !t.isBuyerMaker).reduce((s, t) => s + t.size, 0);
  const sellVol = trades.filter(t => t.isBuyerMaker).reduce((s, t) => s + t.size, 0);
  const totalVol = buyVol + sellVol;
  const deltaPercent = totalVol > 0 ? (cumDelta / totalVol) * 100 : 0;

  const avgSize = trades.reduce((s, t) => s + t.size, 0) / trades.length;
  const largeOrders = trades.filter(t => t.size > avgSize * 3).length;

  const bidAskRatio = askVol > 0 && bidVol > 0 ? bidVol / askVol : 1;

  // Stacked detection: levels where size > 2x average
  const bar = avgSize * 2;

  // Absorption: high volume but delta flattening
  const prevCumDelta = prevTrades.reduce((s, t) => s + (t.isBuyerMaker ? -t.size : t.size), 0);
  const deltaChange = Math.abs(cumDelta - prevCumDelta);
  const absorption = totalVol > 0 && deltaPercent < 5 && Math.abs(cumDelta) < avgSize * 10;

  // Exhaustion: delta diverging from price
  const last10 = trades.slice(0, 10);
  const lastBuy = last10.filter(t => !t.isBuyerMaker).reduce((s, t) => s + t.size, 0);
  const lastSell = last10.filter(t => t.isBuyerMaker).reduce((s, t) => s + t.size, 0);
  const exhaustion = lastBuy > lastSell && cumDelta < 0;

  const reasons: string[] = [];
  let bullish = 0;
  let bearish = 0;

  if (cumDelta > 0) {
    bullish += 30 * Math.min(cumDelta / avgSize, 1);
    reasons.push(`CVD positive: +${cumDelta.toFixed(4)}`);
  } else {
    bearish += 30 * Math.min(Math.abs(cumDelta) / avgSize, 1);
    reasons.push(`CVD negative: ${cumDelta.toFixed(4)}`);
  }

  if (bidAskRatio > 1.1) {
    bullish += 20 * Math.min((bidAskRatio - 1) / 0.5, 1);
    reasons.push(`Bid/ask ratio: ${bidAskRatio.toFixed(2)}x`);
  } else if (bidAskRatio < 0.9) {
    bearish += 20 * Math.min((1 - bidAskRatio) / 0.5, 1);
    reasons.push(`Bid/ask ratio: ${bidAskRatio.toFixed(2)}x`);
  }

  if (absorption) {
    reasons.push('Absorption detected');
    if (cumDelta > 0) bullish += 15;
    else bearish += 15;
  }
  if (exhaustion) reasons.push('Exhaustion detected');

  if (largeOrders > 0) {
    reasons.push(`${largeOrders} large orders`);
    if (cumDelta > 0) bullish += 15;
    else bearish += 15;
  }

  const total = bullish + bearish;
  const bullishPct = total > 0 ? (bullish / total) * 100 : 50;
  const bearishPct = total > 0 ? (bearish / total) * 100 : 50;
  const confidence = Math.min(1, trades.length / 50);

  return {
    data: {
      cumDelta, deltaPercent,
      aggressiveBuys: buyVol, aggressiveSells: sellVol,
      bidAskRatio, stackedBids: 0, stackedAsks: 0, largeOrders,
      absorption, exhaustion,
    },
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
