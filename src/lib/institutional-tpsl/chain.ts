// ═══════════════════════════════════════════════════════════════════
// FOUNDATION — Option Chain Data Contract
// Mirrors the REAL fields the app's option-chain API exposes per leg:
//   ltp, oi, oiChg, volume, iv, delta, gamma, theta, vega, bid, ask
//   + optional `depth` (level-2 market depth) when the feed provides it.
// Also computes chain-wide statistics used by Liquidity / Strike Selection.
// ═══════════════════════════════════════════════════════════════════

import { Candle, OptionType } from './types';

/** Level-2 market depth (captured from NSE `marketDepth` when present). */
export interface MarketDepth {
  bidPrice: number;
  bidQty: number;
  askPrice: number;
  askQty: number;
  totalBuyQty: number;
  totalSellQty: number;
}

/** One option leg (CE or PE) with the real per-leg fields. */
export interface OptionLeg {
  type: OptionType;
  ltp: number;
  oi: number;
  oiChg: number;
  volume: number;
  iv: number;          // percent
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  bid: number;
  ask: number;
  depth?: MarketDepth;
}

export interface ChainStrike {
  strike: number;
  ce: OptionLeg | null;
  pe: OptionLeg | null;
}

export interface UnderlyingContext {
  symbol: string;
  spot: number;
  vix: number;
  candles: Candle[];           // underlying OHLC (structure / price action)
  dailyCandles?: Candle[];     // for ATR
  atr?: number;                // precomputed underlying ATR(14)
}

export interface ChainStats {
  spot: number;
  atmStrike: number;
  callOiShelf: number;         // strike with max call OI (sell-side liquidity shelf)
  putOiShelf: number;          // strike with max put OI (buy-side liquidity shelf)
  maxCallOi: number;
  maxPutOi: number;
  totalCallOi: number;
  totalPutOi: number;
  putCallRatio: number;        // totalPutOi / totalCallOi
  avgVolume: number;
  maxOi: number;
  liquidityPools: number[];    // strikes where BOTH call & put OI are locally elevated
}

export function computeChainStats(strikes: ChainStrike[]): ChainStats {
  if (strikes.length === 0) {
    return {
      spot: 0, atmStrike: 0, callOiShelf: 0, putOiShelf: 0, maxCallOi: 0, maxPutOi: 0,
      totalCallOi: 0, totalPutOi: 0, putCallRatio: 0, avgVolume: 0, maxOi: 0, liquidityPools: [],
    };
  }
  const spot = strikes[0] && (strikes[0].ce?.type ? 0 : 0); // spot supplied separately
  let atmStrike = strikes[0].strike;
  let bestDiff = Infinity;
  let callOiShelf = 0, maxCallOi = 0, putOiShelf = 0, maxPutOi = 0;
  let totalCallOi = 0, totalPutOi = 0, volSum = 0, maxOi = 0;

  for (const s of strikes) {
    const d = Math.abs(s.strike - 0); // spot set later
    const callOi = s.ce?.oi ?? 0;
    const putOi = s.pe?.oi ?? 0;
    totalCallOi += callOi;
    totalPutOi += putOi;
    volSum += (s.ce?.volume ?? 0) + (s.pe?.volume ?? 0);
    maxOi = Math.max(maxOi, callOi, putOi);
    if (callOi > maxCallOi) { maxCallOi = callOi; callOiShelf = s.strike; }
    if (putOi > maxPutOi) { maxPutOi = putOi; putOiShelf = s.strike; }
  }
  // ATM = strike closest to a provided spot; recomputed by caller via setChainSpot
  return {
    spot: 0,
    atmStrike,
    callOiShelf, putOiShelf, maxCallOi, maxPutOi,
    totalCallOi, totalPutOi,
    putCallRatio: totalCallOi > 0 ? totalPutOi / totalCallOi : 0,
    avgVolume: strikes.length ? volSum / (strikes.length * 2) : 0,
    maxOi,
    liquidityPools: [],
  };
}

/** Recompute ATM and liquidity pools given the true spot. */
export function finalizeChainStats(stats: ChainStats, strikes: ChainStrike[], spot: number): ChainStats {
  stats.spot = spot;
  let bestDiff = Infinity;
  for (const s of strikes) {
    const d = Math.abs(s.strike - spot);
    if (d < bestDiff) { bestDiff = d; stats.atmStrike = s.strike; }
  }
  // liquidity pools: strikes where both call & put OI are >= 40% of respective maxes
  const pools: number[] = [];
  for (const s of strikes) {
    const callOi = s.ce?.oi ?? 0;
    const putOi = s.pe?.oi ?? 0;
    if (stats.maxCallOi > 0 && stats.maxPutOi > 0 &&
        callOi >= 0.4 * stats.maxCallOi && putOi >= 0.4 * stats.maxPutOi) {
      pools.push(s.strike);
    }
  }
  stats.liquidityPools = pools;
  return stats;
}
