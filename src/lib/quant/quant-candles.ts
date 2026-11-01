// quant-candles.ts — the ONLY quant module allowed to import the candle
// chain (whitelisted in tests/candle-chain.test.ts import scan). Kept a
// one-function module on purpose so the whitelist surface stays minimal.
// ISOLATION: live-capture chain only — no backtest path, no substitution.

import { fetchCandlesWithFallback, normalizeInterval, type CandleChainResult } from "@/lib/market/candle-chain";

/** Thin passthrough — the quant layer adds provenance/freshness in quant-data.ts. */
export async function quantFetchCandles(
  symbol: string,
  date: string,
  interval: string,
): Promise<CandleChainResult> {
  return fetchCandlesWithFallback(symbol, date, interval);
}

/** Re-exported so no other quant module needs to import the chain. */
export { normalizeInterval };
