import { NSEClient } from 'nse-bse-api/nse';
import { reportSessionFailure, classifySourceError } from '@/lib/session-health';

let nseClient: NSEClient | null = null;

function getNSEClient(): NSEClient {
  if (!nseClient) {
    nseClient = new NSEClient('./downloads', { timeout: 15000 });
  }
  return nseClient;
}

export async function getNSEOptionChain(symbol: string) {
  const client = getNSEClient();
  try {
    // SENSEX is on BSE, try BSE type first
    const isBSE = symbol.toUpperCase() === 'SENSEX' || symbol.toUpperCase() === 'BANKEX';
    const data = await client.optionChainV3({
      symbol,
      type: isBSE ? 'BSE' : 'Indices',
    });
    return data;
  } catch (err: any) {
    // Fallback: try as Indices for all
    try {
      const data = await client.optionChainV3({ symbol, type: 'Indices' });
      return data;
    } catch (err2: any) {
      console.error('[NSE API] Option chain error:', err2.message);
      // NSE has no token auth — a failure here is availability/cookie/block, never
      // session expiry (session-health enforces that: nse never classifies SESSION_EXPIRED).
      reportSessionFailure("nse", classifySourceError("nse", String(err2?.message || err2)), String(err2?.message || err2));
      return null;
    }
  }
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
    const data: any = await client.optionChainV3({ symbol, type: "Equity" });
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
    const expiry = rec?.expiryDates?.[0];
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
  // NSE's equity-stockIndices endpoint is dead (404). Fall back to real
  // Yahoo Finance quotes for the NIFTY 50 universe, sorted by change %.
  try {
    const stocks = await fetchYahooTopMovers("gainers");
    if (stocks.length > 0) return stocks;
  } catch {}
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

export async function getNSELosers() {
  try {
    const stocks = await fetchYahooTopMovers("losers");
    if (stocks.length > 0) return stocks;
  } catch {}
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

async function fetchYahooTopMovers(kind: "gainers" | "losers"): Promise<any[]> {
  const cacheKey = `yahoo-${kind}`;
  const cached = yahooTopMoversCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < YAHOO_MOVERS_TTL) return cached.data;

  const { NIFTY50_STOCKS } = await import('@/lib/intraday-scanner');
  const CONCURRENCY = 10;
  const DEADLINE = Date.now() + 25_000;
  const rows: { symbol: string; ltp: number; change: number; pChange: number; volume: number }[] = [];

  const fetchOne = async (sym: string) => {
    const yahooSym = `${sym}.NS`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=1d&interval=1d`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return;
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) return;
      const prevClose = meta.chartPreviousClose || meta.regularMarketPrice;
      const price = meta.regularMarketPrice;
      const change = price - prevClose;
      const pChange = prevClose > 0 ? (change / prevClose) * 100 : 0;
      rows.push({
        symbol: sym,
        ltp: Math.round(price * 100) / 100,
        change: Math.round(change * 100) / 100,
        pChange: Math.round(pChange * 100) / 100,
        volume: meta.regularMarketVolume || 0,
      });
    } catch {
      // skip unavailable symbol rather than fabricate data
    }
  };

  // Probe one stock first. If Yahoo is unreachable, bail in ~4s.
  await fetchOne(NIFTY50_STOCKS[0].symbol);
  if (rows.length === 0) return [];

  for (let i = 0; i < NIFTY50_STOCKS.length && Date.now() < DEADLINE; i += CONCURRENCY) {
    const batch = NIFTY50_STOCKS.slice(i, i + CONCURRENCY).map((s) => s.symbol);
    await Promise.all(batch.map(fetchOne));
  }

  rows.sort((a, b) => (kind === "gainers" ? b.pChange - a.pChange : a.pChange - b.pChange));
  const top = rows.slice(0, 10);
  yahooTopMoversCache.set(cacheKey, { data: top, ts: Date.now() });
  return top;
}

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
    return {
      value: parseFloat((vix.last || vix.percentChange || 15).toFixed(2)),
      change: parseFloat((vix.percentChange || 0).toFixed(2)),
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
