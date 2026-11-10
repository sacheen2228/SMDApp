// quant-candles.ts — the quant layer reads candles ONLY through the sanctioned
// accessor in market/capture.ts. The candle chain itself may be imported by that
// module alone (architecture test: tests/candle-chain.test.ts import scan).
// ISOLATION: no direct chain import, no backtest path, no substitution.

import { getLiveCandles, normalizeInterval } from "@/lib/market/capture";

type LiveCandles = Awaited<ReturnType<typeof getLiveCandles>>;

/** Thin passthrough — the quant layer adds provenance/freshness in quant-data.ts. */
export async function quantFetchCandles(
  symbol: string,
  date: string,
  interval: string,
): Promise<LiveCandles> {
  return getLiveCandles(symbol, interval, date);
}

/** Re-exported so no other quant module needs to import the chain. */
export { normalizeInterval };
