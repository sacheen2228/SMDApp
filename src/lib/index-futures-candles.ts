// index-futures-candles.ts — resolve the nearest index-futures contract and
// fetch REAL intraday OHLCV from Breeze (NFO/BFO productType "futures").
//
// Why: index SPOT cash candles carry volume=0 (verified live) → VWAP/RVOL are
// null on the confirmation panel. Index FUTURES candles carry real volume
// (verified: NIFTY 23-Nov-2026, 297×5m bars, all volume>0). The tech cache
// uses futures for the volume-bearing read; spot stays the price reference
// elsewhere. Never fabricates volume.

import { initSession, getBreezeClient, getSessionState } from "@/lib/icici-breeze/auth";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Breeze cash stock codes — the FUT- master keys use the same codes. */
const FUT_STOCK_CODE: Record<string, string> = {
  NIFTY: "NIFTY",
  BANKNIFTY: "CNXBAN",
  FINNIFTY: "NIFFIN",
  MIDCPNIFTY: "NIFMID",
  SENSEX: "BSESEN",
  BANKEX: "BSESEN",
};

/** NSE indices trade futures on NFO; BSE indices on BFO. */
const FUT_EXCHANGE: Record<string, string> = {
  NIFTY: "NFO",
  BANKNIFTY: "NFO",
  FINNIFTY: "NFO",
  MIDCPNIFTY: "NFO",
  SENSEX: "BFO",
  BANKEX: "BFO",
};

export function isIndexSymbol(symbol: string): boolean {
  return symbol.toUpperCase() in FUT_STOCK_CODE;
}

/** DD-MMM-YYYY ("23-Nov-2026") → ISO "2026-11-23". null when unparseable. */
export function ddmmyyyyToIso(s: string): string | null {
  const m = String(s).match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const mo = months[m[2][0].toUpperCase() + m[2].slice(1, 3).toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${mo}-${m[1]}`;
}

/**
 * Nearest listed futures expiry for the symbol from the Breeze security master
 * (keys `FUT-{code}-{DD-MMM-YYYY}`), on/after `fromMs` (default: now, IST day).
 * Returns ISO date or null when the master has no live future.
 */
export function pickNearestFuturesExpiry(
  masterLists: any[],
  symbol: string,
  fromMs = Date.now(),
): string | null {
  const code = FUT_STOCK_CODE[symbol.toUpperCase()];
  if (!code) return null;
  const prefix = `FUT-${code}-`;
  const istStart = fromMs + 5.5 * 3600 * 1000;
  const dayStart = Math.floor(istStart / DAY_MS) * DAY_MS - 5.5 * 3600 * 1000;
  let bestIso: string | null = null;
  let bestTs = Infinity;
  for (const list of masterLists || []) {
    if (!list || typeof list !== "object") continue;
    for (const key of Object.keys(list)) {
      if (!key.startsWith(prefix)) continue;
      const iso = ddmmyyyyToIso(key.slice(prefix.length));
      if (!iso) continue;
      const ts = Date.parse(iso + "T00:00:00+05:30");
      if (Number.isNaN(ts) || ts < dayStart) continue;
      if (ts < bestTs) { bestTs = ts; bestIso = iso; }
    }
  }
  return bestIso;
}

export interface FuturesCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Fetch intraday index-futures candles (real OHLCV) from Breeze.
 * Resolves the nearest listed future from the master; empty when no contract
 * or the feed returns nothing — callers fall back to spot (honest, no fabricate).
 */
export async function getindexFuturesCandles(
  symbol: string,
  interval: "1minute" | "5minute" | "15minute" = "5minute",
  lookbackDays = 3,
): Promise<{ candles: FuturesCandle[]; expiry: string | null; warning?: string }> {
  const sym = symbol.toUpperCase();
  if (!isIndexSymbol(sym)) return { candles: [], expiry: null, warning: "not an index" };

  try {
    const state = getSessionState();
    if (!state.authenticated) await initSession();
    const breeze = getBreezeClient();

    // Master for the FUT- keys (cached by the SDK after first load).
    let masterLists: any[] = Array.isArray(breeze?.stockScriptDictList) ? breeze.stockScriptDictList : [];
    const hasFut = masterLists.some((l) => l && Object.keys(l).some((k) => k.startsWith("FUT-")));
    if (!hasFut) {
      try { await breeze.getStockScriptList(); } catch { /* keep what we have */ }
      masterLists = Array.isArray(breeze?.stockScriptDictList) ? breeze.stockScriptDictList : [];
    }
    const expiry = pickNearestFuturesExpiry(masterLists, sym);
    if (!expiry) return { candles: [], expiry: null, warning: "no listed futures contract in master" };

    const fmt = (d: Date) => {
      const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
      const p = (n: number) => n.toString().padStart(2, "0");
      return `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())} ${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}:${p(ist.getUTCSeconds())}`;
    };
    const now = new Date();
    const from = new Date(now.getTime() - lookbackDays * DAY_MS);

    const result = await breeze.getHistoricalDatav2({
      interval,
      fromDate: fmt(from),
      toDate: fmt(now),
      stockCode: FUT_STOCK_CODE[sym],
      exchangeCode: FUT_EXCHANGE[sym] || "NFO",
      productType: "futures",
      expiryDate: expiry,
      right: "",
      strikePrice: "",
    });

    if (!result || result.Error || result.Status === 401) {
      return {
        candles: [],
        expiry,
        warning: String(result?.Error || result?.Message || "breeze futures historical failed"),
      };
    }

    const raw = result.Success || result.data || result || [];
    const candles: FuturesCandle[] = [];
    for (const c of Array.isArray(raw) ? raw : []) {
      const timeStr = c.time || c.datetime || c.timestamp;
      if (!timeStr) continue;
      const open = Number(c.open ?? c.o);
      const high = Number(c.high ?? c.h);
      const low = Number(c.low ?? c.l);
      const close = Number(c.close ?? c.c);
      if (!open && !high && !low && !close) continue;
      const t = new Date(String(timeStr).replace(" ", "T") + "+05:30").getTime();
      if (!isNaN(t)) {
        candles.push({ time: t, open, high, low, close, volume: Number(c.volume ?? c.v ?? 0) });
      }
    }
    candles.sort((a, b) => a.time - b.time);
    return { candles, expiry };
  } catch (e: any) {
    return { candles: [], expiry: null, warning: e?.message || String(e) };
  }
}
