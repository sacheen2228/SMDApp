import { NSEClient } from 'nse-bse-api/nse';

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
      return null;
    }
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
    const data = await client.fetch_equity_historical_data({
      symbol,
      from_date: from.toISOString().split('T')[0],
      to_date: to.toISOString().split('T')[0],
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
