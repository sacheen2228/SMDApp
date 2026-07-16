// Real per-instrument ATR(14) from Yahoo daily candles.
//
// Option 1 of the Zero Hero SL/TP fix: replaces the IV-derived expected-move
// (a VIX-proxy) with the instrument's OWN realized volatility. Used by
// evaluateZeroHeroCandidate (ProTradeEngine.ts) when an `atr` value is passed
// in — the engine still falls back to the IV approximation if ATR is absent.
//
// Source: Yahoo Finance v8 chart API (interval=1d, range=3mo). No auth.
// NOTE: do NOT set a User-Agent header — Yahoo rate-limits Node requests with
// custom UA (see yahoo-finance-api.ts).

import { calculateATR } from "@/lib/orca-strategy";
import { YAHOO_SYMBOL_MAP } from "@/lib/yahoo-finance-api";
import { getDailyCandles } from "@/lib/breeze-historical";

// In-memory TTL cache so repeated scans / polls don't hammer the data sources.
const atrCache = new Map<string, { atr: number; ts: number }>();
const ATR_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Priority for real per-instrument ATR:
//   1. Breeze daily candles (broker-authoritative, no rate limit) when session valid
//   2. Yahoo daily candles (free, no key) as fallback
export async function getDailyATR(ourSymbol: string): Promise<number | null> {
  if (!ourSymbol) return null;
  const cached = atrCache.get(ourSymbol);
  if (cached && Date.now() - cached.ts < ATR_TTL_MS) return cached.atr;

  // ── 1) Breeze (real broker data) ──
  try {
    const { candles } = await getDailyCandles(ourSymbol, 100);
    if (candles.length >= 15) {
      const atr = calculateATR(candles, 14);
      if (atr > 0) {
        atrCache.set(ourSymbol, { atr, ts: Date.now() });
        console.log(`[ATR] ${ourSymbol} = ${atr.toFixed(2)} (source: breeze)`);
        return atr;
      }
    }
  } catch (e) {
    console.warn(`[ATR] Breeze daily failed for ${ourSymbol}:`, (e as Error).message);
  }

  // ── 2) Yahoo (free fallback) ──
  const upper = ourSymbol.toUpperCase();
  const yahooSym = YAHOO_SYMBOL_MAP[upper] ?? `${upper}.NS`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=3mo&interval=1d`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      console.warn(`[ATR] Yahoo ${res.status} for ${ourSymbol} (${yahooSym})`);
      return cached?.atr ?? null;
    }
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    const closes = quote?.close ?? [];
    const highs = quote?.high ?? [];
    const lows = quote?.low ?? [];
    const candles: { high: number; low: number; close: number }[] = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] == null || highs[i] == null || lows[i] == null) continue;
      candles.push({ high: highs[i], low: lows[i], close: closes[i] });
    }
    if (candles.length < 15) {
      console.warn(`[ATR] insufficient candles (${candles.length}) for ${ourSymbol}`);
      return cached?.atr ?? null;
    }
    const atr = calculateATR(candles, 14);
    if (atr > 0) {
      atrCache.set(ourSymbol, { atr, ts: Date.now() });
      console.log(`[ATR] ${ourSymbol} = ${atr.toFixed(2)} (source: yahoo)`);
      return atr;
    }
    return cached?.atr ?? null;
  } catch (e) {
    console.warn(`[ATR] fetch failed for ${ourSymbol}:`, (e as Error).message);
    return cached?.atr ?? null;
  }
}
