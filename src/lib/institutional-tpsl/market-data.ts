// ═══════════════════════════════════════════════════════════════════
// MODULE 5 — MARKET DATA ENGINE
// Summarizes the macro regime from spot, VIX and the chain's put/call
// ratio (breadth) — the "is the environment tradable?" gate that feeds
// every downstream decision.
// ═══════════════════════════════════════════════════════════════════

import { ChainStats } from './chain';

export interface MarketDataReport {
  regime: string;            // BULLISH / BEARISH / NEUTRAL
  putCallRatio: number;
  breadth: string;           // LIQUIDITY_BIAS / RISK_OFF / BALANCED
  volRegime: string;         // from VIX
  note: string;
}

export function summarizeMarketData(spot: number, vix: number, stats: ChainStats): MarketDataReport {
  const pcr = stats.putCallRatio;
  const breadth =
    pcr > 1.2 ? 'RISK_OFF (put-heavy)' :
    pcr < 0.8 ? 'LIQUIDITY_BIAS (call-heavy)' : 'BALANCED';
  const regime =
    pcr > 1.2 ? 'BEARISH' : pcr < 0.8 ? 'BULLISH' : 'NEUTRAL';
  const volRegime = vix < 11 ? 'LOW' : vix < 17 ? 'NORMAL' : vix < 25 ? 'HIGH' : 'EXTREME';
  return {
    regime, putCallRatio: pcr, breadth, volRegime,
    note: `PCR ${pcr.toFixed(2)} → ${breadth}; VIX ${vix.toFixed(1)} (${volRegime})`,
  };
}
