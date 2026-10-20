import { NSEClient } from 'nse-bse-api/nse';
import { reportSessionFailure, classifySourceError } from '@/lib/session-health';
import {
  EXPIRY_UNAVAILABLE,
  expiryUnavailableReason,
  isExpiryExpired,
  isSameExpiry,
  selectNearestLiveExpiry,
  toIsoDate,
  toNseExpiry,
} from '@/lib/data-layer/chains/option-chain';

let nseClient: NSEClient | null = null;

function getNSEClient(): NSEClient {
  if (!nseClient) {
    nseClient = new NSEClient('./downloads', { timeout: 15000 });
  }
  return nseClient;
}

/**
 * Option chain for one CONTRACT.
 *
 * The contract is always resolved explicitly. The SDK defaults to
 * `expiryDates[0]`, and the exchange keeps the contract that just expired as
 * the first entry (live-verified 2026-10-20: NSE listed "19-Oct-2026" — a
 * DEAD contract — ahead of "27-Oct-2026"). Taking it blindly priced a dead
 * contract and every downstream consumer inherited it.
 *
 *   • `expiry` given  → that contract (must exist in the exchange's list).
 *   • `expiry` absent → the NEAREST contract that is still trading.
 *
 * Throws `EXPIRY_UNAVAILABLE: …` when a requested contract does not exist.
 */
export async function getNSEOptionChain(symbol: string, expiry?: string) {
  const client = getNSEClient();
  // SENSEX is on BSE, try BSE type first
  const isBSE = symbol.toUpperCase() === 'SENSEX' || symbol.toUpperCase() === 'BANKEX';
  const type = isBSE ? 'BSE' : 'Indices';

  const requestedIso = expiry ? toIsoDate(expiry) : null;
  if (expiry && !requestedIso) {
    throw new Error(`${EXPIRY_UNAVAILABLE}: "${expiry}" is not a valid expiry date`);
  }

  // The exchange's contract list (needed to pick and to validate).
  let expiries: string[] = [];
  try {
    expiries = (await client.getExpiryDatesV3(symbol)) || [];
  } catch {
    expiries = [];
  }

  let exp: string | undefined;
  if (requestedIso) {
    const match = expiries.find((e) => isSameExpiry(e, requestedIso));
    if (expiries.length) {
      if (!match) {
        // The exchange does not carry that contract — an explicit failure.
        throw new Error(expiryUnavailableReason(symbol, expiry!, expiries));
      }
      exp = match;
    } else {
      // The contract list is unavailable (cookie/network) — pass the caller's
      // contract through and let the exchange answer.
      exp = toNseExpiry(requestedIso) ?? undefined;
    }
  } else {
    // Nearest contract that is still trading — never expiryDates[0].
    exp = selectNearestLiveExpiry(expiries) ?? undefined;
  }

  const fetchChain = async (expiryArg?: string) =>
    client.optionChainV3({ symbol, type, ...(expiryArg ? { expiry: expiryArg } : {}) } as any);

  let data: any;
  try {
    data = await fetchChain(exp);
  } catch (err: any) {
    // Fallback: try as Indices for all — keeping the resolved contract when we
    // have one. The SDK's default (expiryDates[0]) can be a DEAD contract, so
    // it is only used when no contract could be resolved at all (the payload's
    // own contract list then drives the live-contract correction below).
    try {
      data = exp
        ? await client.optionChainV3({ symbol, type: 'Indices', expiry: exp } as any)
        : await client.optionChainV3({ symbol, type: 'Indices' } as any);
    } catch (err2: any) {
      console.error('[NSE API] Option chain error:', err2.message);
      // NSE has no token auth — a failure here is availability/cookie/block, never
      // session expiry (session-health enforces that: nse never classifies SESSION_EXPIRED).
      reportSessionFailure("nse", classifySourceError("nse", String(err2?.message || err2)), String(err2?.message || err2));
      return null;
    }
  }

  if (!data?.records?.data?.length) return data;

  // Which contract is this payload for?
  const payloadExpiries: string[] = Array.isArray(data?.records?.expiryDates) ? data.records.expiryDates : [];
  const rowExpiry: string | null =
    (data?.records?.data ?? []).find((r: any) => r?.expiryDates)?.expiryDates ?? null;
  let effective = rowExpiry ?? payloadExpiries[0] ?? null;

  // The contract list was unreachable and the SDK fell back to expiryDates[0],
  // which can be a DEAD contract. Re-fetch the nearest live one.
  if (!requestedIso && effective && isExpiryExpired(effective) && payloadExpiries.length) {
    const live = selectNearestLiveExpiry(payloadExpiries);
    if (live && !isSameExpiry(live, effective)) {
      try {
        const retry = await fetchChain(live);
        if (retry?.records?.data?.length) {
          data = retry;
          effective = live;
        }
      } catch { /* keep the payload we have */ }
    }
  }

  return stampContract(data, effective);
}

/**
 * Put the contract this payload is for FIRST in `records.expiryDates` and
 * record it as `records.selectedExpiry`.
 *
 * Every consumer of the raw payload reads `records.expiryDates[0]` (the
 * option-chain route, the SDM-signal route, the F&O snapshot mapper). With
 * the live contract now fetched, the list must lead with that contract —
 * otherwise the rows and the label disagree and the mapper filters every
 * strike away. The full list is preserved.
 */
function stampContract(payload: any, effective: string | null) {
  if (!payload?.records) return payload;
  const list: string[] = Array.isArray(payload.records.expiryDates) ? payload.records.expiryDates : [];
  if (effective && !isSameExpiry(list[0], effective)) {
    payload.records.expiryDates = [effective, ...list.filter((e) => !isSameExpiry(e, effective))];
  }
  payload.records.selectedExpiry = effective;
  return payload;
}

// Equity (stock) option chain, normalized for strike pickers. Optional
// enrichment (BestTradesNow option rows) — deliberately SILENT on failure:
// reporting would spam session-health episodes for a non-critical extra, and
// NSE failures here are cookie/block availability, never session expiry.
export async function getNSEEquityOptionChain(symbol: string): Promise<{
  rows: Array<{ strike: number; ceLtp?: number; peLtp?: number }>;
  expiry?: string;
  spot?: number;
} | null> {
  const client = getNSEClient();
  try {
    // Resolve the contract explicitly — the SDK's default (expiryDates[0])
    // can be the contract that just expired.
    let expiries: string[] = [];
    try {
      expiries = (await client.getExpiryDatesV3(symbol)) || [];
    } catch {
      expiries = [];
    }
    const exp = selectNearestLiveExpiry(expiries) ?? undefined;
    const data: any = await client.optionChainV3({ symbol, type: "Equity", ...(exp ? { expiry: exp } : {}) } as any);
    const rec = data?.records || data;
    const src = Array.isArray(rec?.data) ? rec.data : null;
    if (!src?.length) return null;
    const rows = src
      .map((row: any) => ({
        strike: parseFloat(row?.strikePrice),
        ceLtp: row?.CE?.lastPrice != null ? parseFloat(row.CE.lastPrice) : undefined,
        peLtp: row?.PE?.lastPrice != null ? parseFloat(row.PE.lastPrice) : undefined,
      }))
      .filter((r: any) => Number.isFinite(r.strike) && r.strike > 0);
    if (!rows.length) return null;
    const spot = parseFloat(rec?.underlyingValue);
    // The contract the rows are dated to (never expiryDates[0]).
    const rowExpiry = (rec?.data ?? []).find((r: any) => r?.expiryDates)?.expiryDates ?? null;
    const expiry = rowExpiry ?? exp ?? rec?.expiryDates?.[0];
    return { rows, expiry: expiry || undefined, spot: Number.isFinite(spot) ? spot : undefined };
  } catch {
    return null;
  }
}

export async function getNSEMarketStatus() {
  const client = getNSEClient();
  try {
    const status = await client.market.getStatus();
    return status;
  } catch (err: any) {
    console.error('[NSE API] Market status error:', err.message);
    return null;
  }
}

export async function getNSEHistoricalData(symbol: string, from: Date, to: Date) {
  const client = getNSEClient();
  try {
    // nse-bse-api requires Date objects (validateDateRange/splitDateRange call
    // from.getFullYear()) — ISO strings used to crash with
    // "from.getFullYear is not a function" and every caller got null.
    const data = await client.fetch_equity_historical_data({
      symbol,
      from_date: from,
      to_date: to,
    });
    return data;
  } catch (err: any) {
    console.error('[NSE API] Historical data error:', err.message);
    return null;
  }
}

export async function getNSEGainers() {
  // Free NSE quotes for the NIFTY 50 universe, sorted by change % (Yahoo is not
  // a data source in this project).
  const viaQuotes = await nseTopMovers("gainers");
  if (viaQuotes.length > 0) return viaQuotes;
  const client = getNSEClient();
  try {
    const data = await client.listEquityStocksByIndex('NIFTY 50');
    const stocks = Array.isArray(data) ? data : [];
    return stocks.sort((a: any, b: any) => (b.pChange || 0) - (a.pChange || 0)).slice(0, 10);
  } catch (err: any) {
    console.error('[NSE API] Gainers error:', err.message);
    return [];
  }
}

/** NIFTY 50 top movers from the free NSE batch quote endpoint. */
async function nseTopMovers(dir: "gainers" | "losers"): Promise<Array<{ symbol: string; name: string; ltp: number; change: number; changePct: number }>> {
  try {
    const { fetchNIFTY50Stocks } = await import("./nse-stock-data");
    const stocks = await fetchNIFTY50Stocks();
    const rows = stocks
      .filter((s: any) => Number(s.ltp) > 0 && Number(s.changePct) !== 0)
      .map((s: any) => ({ symbol: s.symbol, name: s.name || s.symbol, ltp: Number(s.ltp), change: Number(s.change) || 0, changePct: Number(s.changePct) || 0 }));
    rows.sort((a: any, b: any) => (dir === "gainers" ? b.changePct - a.changePct : a.changePct - b.changePct));
    return rows.slice(0, 10);
  } catch { return []; }
}

export async function getNSELosers() {
  const viaQuotes = await nseTopMovers("losers");
  if (viaQuotes.length > 0) return viaQuotes;
  const client = getNSEClient();
  try {
    const data = await client.listEquityStocksByIndex('NIFTY 50');
    const stocks = Array.isArray(data) ? data : [];
    return stocks.sort((a: any, b: any) => (a.pChange || 0) - (b.pChange || 0)).slice(0, 10);
  } catch (err: any) {
    console.error('[NSE API] Losers error:', err.message);
    return [];
  }
}

// ─── Yahoo Finance top movers (NIFTY 50) ──────────────────────────
// NSE's equity-stockIndices endpoint returns 404, so gainers/losers are
// derived from real Yahoo Finance quotes (same source the Scanner uses).
const yahooTopMoversCache = new Map<string, { data: any[]; ts: number }>();
const YAHOO_MOVERS_TTL = 30_000;


export async function getNSEFnoLots() {
  const client = getNSEClient();
  try {
    return await client.fnoLots();
  } catch (err: any) {
    console.error('[NSE API] F&O lots error:', err.message);
    return {};
  }
}

export function cleanupNSE() {
  if (nseClient) {
    nseClient.exit();
    nseClient = null;
  }
}

// ─── NSE India direct API helpers (for VIX, indices) ───

const NSE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
let nseCookieCache: { cookie: string; expiresAt: number } | null = null;

async function getNSECookie(): Promise<string> {
  if (nseCookieCache && Date.now() < nseCookieCache.expiresAt) return nseCookieCache.cookie;
  try {
    const res = await fetch("https://www.nseindia.com", {
      headers: { "User-Agent": NSE_UA, Accept: "text/html" },
      signal: AbortSignal.timeout(8000),
    });
    const cookie = res.headers.get("set-cookie")?.split(";")[0] || "";
    nseCookieCache = { cookie, expiresAt: Date.now() + 5 * 60 * 1000 };
    return cookie;
  } catch { return ""; }
}

export async function getNSEIndiaVIX(): Promise<{ value: number; change: number } | null> {
  try {
    const cookie = await getNSECookie();
    const res = await fetch("https://www.nseindia.com/api/allIndices", {
      headers: { "User-Agent": NSE_UA, Cookie: cookie, Referer: "https://www.nseindia.com/market-data/live-equity-market" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const vix = (json?.data || []).find((i: any) => i.index === "INDIA VIX");
    if (!vix) return null;
    // No fabricated fallback: without a real last price there is no VIX.
    // (The old `|| 15` turned a missing INDIA VIX row into a real-looking
    // "calm market" reading on every card that consumes it.)
    const last = parseFloat(vix.last);
    if (!Number.isFinite(last) || last <= 0) return null;
    const change = parseFloat(vix.percentChange);
    return {
      value: parseFloat(last.toFixed(2)),
      change: Number.isFinite(change) ? parseFloat(change.toFixed(2)) : 0,
    };
  } catch { return null; }
}

export async function getNSEIndices(): Promise<Array<{ key: string; name: string; ltp: number; change: number; changePct: number; prevClose: number }>> {
  try {
    const cookie = await getNSECookie();
    const res = await fetch("https://www.nseindia.com/api/allIndices", {
      headers: { "User-Agent": NSE_UA, Cookie: cookie, Referer: "https://www.nseindia.com/market-data/live-equity-market" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return mapNSEIndices(json?.data || []);
  } catch { return []; }
}

// Pure mapping for /api/allIndices rows → app index keys.
// Live 2026-10-01: NSE sends "NIFTY BANK" (all caps); the old filter matched
// only "NIFTY Bank" so BANKNIFTY was silently dropped (count=1). Accept both
// casings; SENSEX is BSE-only but kept defensively.
export function mapNSEIndices(data: any): Array<{ key: string; name: string; ltp: number; change: number; changePct: number; prevClose: number }> {
  if (!Array.isArray(data)) return [];
  const WANTED: Record<string, { key: string; name: string }> = {
    "NIFTY 50": { key: "NIFTY", name: "NIFTY 50" },
    "NIFTY BANK": { key: "BANKNIFTY", name: "BANK NIFTY" },
    "NIFTY Bank": { key: "BANKNIFTY", name: "BANK NIFTY" },
    "SENSEX": { key: "SENSEX", name: "SENSEX" },
  };
  return data
    .filter((i: any) => i && WANTED[i.index])
    .map((i: any) => {
      const want = WANTED[i.index];
      const ltp = i.last || 0;
      const prevClose = i.previousClose || i.last || 0;
      const pct = parseFloat(i.percentChange);
      return {
        key: want.key,
        name: want.name,
        ltp,
        change: parseFloat((ltp - prevClose).toFixed(2)),
        changePct: isNaN(pct) ? parseFloat((((ltp - prevClose) / (prevClose || 1)) * 100).toFixed(2)) : pct,
        prevClose,
      };
    });
}

// ─── NSE intraday index chart (/api/chart-databyindex) ───
// VERIFIED (live probes, 2026-09-27): the query param is `index=` (with `indices=true`);
// `symbol=` returns the error body "Missing index.". Response envelope:
//   { closePrice, grapthData: [...], identifier, name }  — auth OK (200 with warmed cookie).
// grapthData was EMPTY on a Sunday for every variant, so the point shape is unverified
// until a trading session; parsed defensively for the common shapes
// ({x,y} close-only, [t,c], [t,o,h,l,c,v], {date,open,...}).
// INDEX-ONLY: callers must never pass stock symbols (enforced by the candle chain allowlist).
// Serves the current session only — historical dates are not available here.
export interface NSEChartPoint {
  time: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
}

function parseNSEChartPoint(raw: any): NSEChartPoint | null {
  if (Array.isArray(raw)) {
    const t = raw[0];
    if (t == null) return null;
    const ms = typeof t === "number" && t < 1e12 ? t * 1000 : Number(t);
    const time = new Date(ms);
    if (isNaN(time.getTime())) return null;
    if (raw.length >= 6) {
      return { time: time.toISOString(), open: Number(raw[1]), high: Number(raw[2]), low: Number(raw[3]), close: Number(raw[4]), volume: Number(raw[5] ?? 0) };
    }
    if (raw.length >= 5) {
      return { time: time.toISOString(), open: Number(raw[1]), high: Number(raw[2]), low: Number(raw[3]), close: Number(raw[4]) };
    }
    const close = Number(raw[1]);
    return isFinite(close) ? { time: time.toISOString(), close } : null;
  }
  if (raw && typeof raw === "object") {
    const t = raw.x ?? raw.time ?? raw.timestamp ?? raw.date;
    if (t == null) return null;
    const ms = typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
    const time = new Date(ms);
    if (isNaN(time.getTime())) return null;
    const close = Number(raw.y ?? raw.close ?? raw.c);
    if (!isFinite(close)) return null;
    const out: NSEChartPoint = { time: time.toISOString(), close };
    if (raw.open != null || raw.o != null) out.open = Number(raw.open ?? raw.o);
    if (raw.high != null || raw.h != null) out.high = Number(raw.high ?? raw.h);
    if (raw.low != null || raw.l != null) out.low = Number(raw.low ?? raw.l);
    if (raw.volume != null || raw.v != null) out.volume = Number(raw.volume ?? raw.v);
    return out;
  }
  return null;
}

// Throws on HTTP/shape failures with a human-readable message so the candle chain
// can classify the failure (NSE failures are never session expiry).
export async function getNSEIndexChart(indexName: string): Promise<NSEChartPoint[]> {
  const cookie = await getNSECookie();
  const url =
    "https://www.nseindia.com/api/chart-databyindex?index=" +
    encodeURIComponent(indexName) +
    "&indices=true";
  const res = await fetch(url, {
    headers: {
      "User-Agent": NSE_UA,
      Cookie: cookie,
      Referer: "https://www.nseindia.com/market-data/live-market-indices",
      Accept: "application/json, text/plain, */*",
    },
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* fallthrough */ }
  if (!json || !Array.isArray(json.grapthData)) {
    throw new Error(`NSE chart index=${indexName} HTTP ${res.status}: ${(text || "empty body").slice(0, 120)}`);
  }
  return json.grapthData.map(parseNSEChartPoint).filter(Boolean) as NSEChartPoint[];
}


// ── Index symbol registry (exchange-side; the Yahoo module re-exports it) ──
export const INDEX_SYMBOL_KEYS: Record<string, string> = {
  NIFTY: "NIFTY 50",
  BANKNIFTY: "NIFTY BANK",
  FINNIFTY: "NIFTY MIDCAP 50",
  MIDCPNIFTY: "NIFTY MIDCAP 50",
  NIFTYNXT50: "NIFTY NEXT 50",
  SENSEX: "S&P BSE SENSEX",
  BANKEX: "S&P BSE BANKEX",
  INDIAVIX: "INDIA VIX",
};

/** True when the symbol is one of the exchange indices. */
export function isIndexSymbol(symbol: string): boolean {
  return !!INDEX_SYMBOL_KEYS[String(symbol || "").trim().toUpperCase()];
}

// ── Free NSE ATR14 + prev close (replaces the Yahoo helpers) ──────────
const atrCacheNSE = new Map<string, { atr: number; at: number }>();

/** ATR(14) from the exchange's own daily history — no Yahoo, no VIX estimate. */
export async function getNSEATR14(symbol: string, fallback: number): Promise<{ atr: number; source: "real" | "vix-estimate" }> {
  const sym = String(symbol || "NIFTY").toUpperCase();
  const cached = atrCacheNSE.get(sym);
  if (cached && Date.now() - cached.at < 15 * 60_000) return { atr: cached.atr, source: "real" };
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 60 * 86_400_000);
    const bars = (await getNSEHistoricalData(sym, from, to)) || [];
    if (bars.length >= 15) {
      let sum = 0;
      for (let i = bars.length - 14; i < bars.length; i++) {
        const c = bars[i];
        const prev = bars[i - 1];
        sum += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
      }
      const atr = Math.round((sum / 14) * 100) / 100;
      if (atr > 0) {
        atrCacheNSE.set(sym, { atr, at: Date.now() });
        return { atr, source: "real" };
      }
    }
  } catch { /* fall through to the caller's estimate */ }
  return { atr: fallback, source: "vix-estimate" };
}

/** One index quote from the free NSE index list (Yahoo-shaped payload, NSE source). */
export async function getNSEIndexQuote(symbol: string): Promise<{
  symbol: string; name: string; regularMarketPrice: number; previousClose: number;
  change: number; changePct: number;
} | null> {
  const sym = String(symbol || "").toUpperCase();
  const idx = await getNSEIndices();
  const row = idx?.find(
    (i: any) => String(i.key).toUpperCase() === sym || String(i.name).toUpperCase() === sym || String(i.name).toUpperCase().startsWith(sym),
  );
  if (!row?.ltp) return null;
  return {
    symbol: sym,
    name: row.name,
    regularMarketPrice: row.ltp,
    previousClose: row.prevClose,
    change: row.change,
    changePct: row.changePct,
  };
}

/** Previous close from the exchange index list (indices) or the option chain. */
export async function getNSEPrevClose(symbol: string): Promise<number | null> {
  const sym = String(symbol || "").toUpperCase();
  try {
    const idx = await getNSEIndices();
    const row = idx?.find((i: any) => String(i.key).toUpperCase() === sym || String(i.name).toUpperCase() === sym);
    if (row?.prevClose) return row.prevClose;
  } catch { /* try the chain below */ }
  try {
    const chain = await getNSEOptionChain(sym);
    const pc = Number((chain as any)?.priceInfo?.previousClose || (chain as any)?.priceInfo?.prevClose || 0);
    return pc > 0 ? pc : null;
  } catch { return null; }
}
