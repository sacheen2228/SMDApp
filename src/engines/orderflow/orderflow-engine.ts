import type { EngineScore, OrderFlowData, Trade } from '@/types/engine';

export interface CvdProxyCandle {
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  oi?: number;
}

export type FlowBuildup = "LONG_BUILDUP" | "SHORT_BUILDUP" | "SHORT_COVERING" | "LONG_UNWINDING" | "NEUTRAL";

export type FlowDivergence =
  | "PRICE_UP_OI_UP"
  | "PRICE_DOWN_OI_UP"
  | "PRICE_UP_OI_DOWN"
  | "PRICE_DOWN_OI_DOWN"
  | "NEUTRAL";

/**
 * The ONE price/OI classifier. Three copies used to exist (this engine,
 * unified-engine/derivatives.ts, expiry-liquidity/futures-dislocation-engine.ts);
 * the other two now delegate here.
 */
export function classifyFlowBuildup(
  priceChange: number | null,
  oiChange: number | null,
): FlowBuildup | null {
  if (priceChange == null || oiChange == null) return null;
  if (priceChange > 0 && oiChange > 0) return "LONG_BUILDUP";
  if (priceChange < 0 && oiChange > 0) return "SHORT_BUILDUP";
  if (priceChange > 0 && oiChange < 0) return "SHORT_COVERING";
  if (priceChange < 0 && oiChange < 0) return "LONG_UNWINDING";
  return "NEUTRAL";
}

export function classifyFlowDivergence(
  priceChange: number | null,
  oiChange: number | null,
): FlowDivergence | null {
  if (priceChange == null || oiChange == null) return null;
  if (priceChange > 0 && oiChange > 0) return "PRICE_UP_OI_UP";
  if (priceChange < 0 && oiChange > 0) return "PRICE_DOWN_OI_UP";
  if (priceChange > 0 && oiChange < 0) return "PRICE_UP_OI_DOWN";
  if (priceChange < 0 && oiChange < 0) return "PRICE_DOWN_OI_DOWN";
  return "NEUTRAL";
}

export interface CvdProxyPoint {
  time: number | string;
  cvd: number;
  delta: number;
  volume: number;
  price: number;
}

export type CvdProxyVerdict =
  | "BULLISH"
  | "BEARISH"
  | "BULLISH_DIVERGENCE"
  | "BEARISH_DIVERGENCE"
  | "NEUTRAL"
  | "UNAVAILABLE";

export type CvdProxyMode = "CANDLE_PROXY" | "FUTURES_CANDLE_SIGN";

export interface CvdProxyResult {
  mode: CvdProxyMode;
  available: boolean;
  bars: number;
  windowBars: number;
  cumulative: number;
  deltaPercent: number;
  estimatedBuyVolume: number;
  estimatedSellVolume: number;
  totalVolume: number;
  priceChangePercent: number;
  cvdChange: number;
  verdict: CvdProxyVerdict;
  points: CvdProxyPoint[];
  source?: string;
  contract?: string;
  oiFirst?: number;
  oiLast?: number;
  oiChange?: number;
  oiChangePct?: number;
  buildup?: FlowBuildup | null;
  divergence?: FlowDivergence | null;
  note?: string;
}

/**
 * Session OI read from the candles' open-interest field. Feeds that carry no
 * OI (index spot bars) leave every field unknown — never a fabricated zero.
 */
function readOiChange(
  candles: CvdProxyCandle[],
  priceChangePercent: number,
): { oiFirst?: number; oiLast?: number; oiChange?: number; oiChangePct?: number; buildup?: FlowBuildup | null; divergence?: FlowDivergence | null } {
  const withOi = candles.filter((c) => Number.isFinite(c.oi) && Number(c.oi) > 0);
  if (withOi.length < 2) {
    return { buildup: null, divergence: null };
  }
  const oiFirst = Number(withOi[0].oi);
  const oiLast = Number(withOi[withOi.length - 1].oi);
  const oiChange = oiLast - oiFirst;
  const oiChangePct = oiFirst > 0 ? (oiChange / oiFirst) * 100 : undefined;
  const priceChange = priceChangePercent;
  return {
    oiFirst,
    oiLast,
    oiChange,
    oiChangePct,
    buildup: classifyFlowBuildup(priceChange, oiChange),
    divergence: classifyFlowDivergence(priceChange, oiChange),
  };
}

export function computeCandleCvdProxy(
  candles: CvdProxyCandle[],
  opts: {
    windowBars?: number;
    mode?: CvdProxyMode;
    source?: string;
    contract?: string;
  } = {},
): CvdProxyResult {
  const bars = candles.length;
  const windowBars = Math.max(1, Math.min(opts.windowBars ?? 3, bars || 1));
  const points: CvdProxyPoint[] = [];
  let cumulative = 0;
  let estimatedBuyVolume = 0;
  let estimatedSellVolume = 0;
  let totalVolume = 0;

  for (const c of candles) {
    const rawVolume = c.volume ?? 0;
    const volume = Number.isFinite(rawVolume) ? Math.max(0, rawVolume) : 0;
    const open = Number(c.open);
    const close = Number(c.close);
    const delta = close > open ? volume : close < open ? -volume : 0;
    cumulative += delta;
    totalVolume += volume;
    if (delta > 0) estimatedBuyVolume += volume;
    if (delta < 0) estimatedSellVolume += volume;
    points.push({ time: c.time, cvd: cumulative, delta, volume, price: close });
  }

  const available = bars > 0 && totalVolume > 0;
  const deltaPercent = totalVolume > 0 ? (cumulative / totalVolume) * 100 : 0;

  if (!available) {
    return {
      mode: opts.mode ?? "CANDLE_PROXY",
      source: opts.source,
      contract: opts.contract,
      available: false,
      bars,
      windowBars,
      cumulative: 0,
      deltaPercent: 0,
      estimatedBuyVolume: 0,
      estimatedSellVolume: 0,
      totalVolume,
      priceChangePercent: 0,
      cvdChange: 0,
      verdict: "UNAVAILABLE",
      points,
    };
  }

  const windowStart = Math.max(0, bars - windowBars);
  const cvdBeforeWindow = windowStart > 0 ? points[windowStart - 1].cvd : 0;
  const cvdChange = cumulative - cvdBeforeWindow;
  const baseline = windowStart > 0 ? candles[windowStart - 1].close : candles[0].open;
  const lastClose = candles[bars - 1].close;
  const priceChangePercent = baseline > 0 ? ((lastClose - baseline) / baseline) * 100 : 0;

  const avgVolume = totalVolume / bars;
  const priceEpsilon = 0.01;
  const cvdEpsilon = avgVolume * 0.25;
  const priceUp = priceChangePercent > priceEpsilon;
  const priceDown = priceChangePercent < -priceEpsilon;
  const cvdUp = cvdChange > cvdEpsilon;
  const cvdDown = cvdChange < -cvdEpsilon;

  let verdict: CvdProxyVerdict = "NEUTRAL";
  if (priceUp && cvdUp) verdict = "BULLISH";
  else if (priceDown && cvdDown) verdict = "BEARISH";
  else if (priceUp && cvdDown) verdict = "BEARISH_DIVERGENCE";
  else if (priceDown && cvdUp) verdict = "BULLISH_DIVERGENCE";

  const sessionPriceChangePercent =
    candles[0].open > 0 ? ((lastClose - candles[0].open) / candles[0].open) * 100 : 0;
  const oiRead = readOiChange(candles, sessionPriceChangePercent);

  return {
    mode: opts.mode ?? "CANDLE_PROXY",
    source: opts.source,
    contract: opts.contract,
    available: true,
    bars,
    windowBars,
    cumulative,
    deltaPercent,
    estimatedBuyVolume,
    estimatedSellVolume,
    totalVolume,
    priceChangePercent,
    cvdChange,
    verdict,
    points,
    ...oiRead,
  };
}

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
