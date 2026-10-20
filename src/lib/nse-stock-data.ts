// Shared stock data fetcher for all NIFTY 50 stocks.
// Tier 0: NSE India API (single call, fast, all stocks at once)
// Tier 1: Moneycontrol priceapi (per-stock, batches of 5)
// Free sources only: NSE index-constituent lists (live quotes) and Moneycontrol.
// Returns whatever data was successfully fetched — never throws.

import { fetchWithFallback, FallbackSource } from "./fetch-with-fallback";
import { isIndexSymbol } from "./nse-api";

const NSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface NSEStockQuote {
  symbol: string;
  name: string;
  ltp: number;
  change: number;
  changePct: number;
  weeklyChangePct: number; // 5-day change %
  volume: number;
  avgVolume: number; // 20-day average volume
  prevClose: number;
  dayHigh: number;
  dayLow: number;
  weekHigh52: number;
  weekLow52: number;
  sector: string;
}

const SECTOR_MAP: Record<string, string> = {
  RELIANCE: "Energy", TCS: "IT", HDFCBANK: "Banking", INFY: "IT",
  ICICIBANK: "Banking", HINDUNILVR: "FMCG", ITC: "FMCG", SBIN: "Banking",
  BHARTIARTL: "Telecom", KOTAKBANK: "Banking", LT: "Infrastructure",
  AXISBANK: "Banking", BAJFINANCE: "NBFC", ASIANPAINT: "Consumer",
  MARUTI: "Auto", SUNPHARMA: "Pharma", TITAN: "Consumer", ULTRACEMCO: "Cement",
  NESTLEIND: "FMCG", TATAMOTORS: "Auto", WIPRO: "IT", "M&M": "Auto",
  HCLTECH: "IT", POWERGRID: "Power", NTPC: "Power", ONGC: "Energy",
  TATASTEEL: "Metal", JSWSTEEL: "Metal", ADANIENT: "Conglomerate",
  ADANIPORTS: "Infrastructure", TECHM: "IT", HDFCLIFE: "Insurance",
  SBILIFE: "Insurance", BRITANNIA: "FMCG", CIPLA: "Pharma",
  DRREDDY: "Pharma", DIVISLAB: "Pharma", EICHERMOT: "Auto",
  GRASIM: "Cement", HEROMOTOCO: "Auto", HINDALCO: "Metal",
  INDUSINDBK: "Banking", BAJAJFINSV: "NBFC", COALINDIA: "Mining",
  BPCL: "Energy", TRENT: "Retail", APOLLOHOSP: "Healthcare",
  LTIM: "IT", HDFCAMC: "Finance", PIDILITIND: "Chemical",
};

const NAME_MAP: Record<string, string> = {
  RELIANCE: "Reliance", TCS: "TCS", HDFCBANK: "HDFC Bank", INFY: "Infosys",
  ICICIBANK: "ICICI Bank", HINDUNILVR: "HUL", ITC: "ITC", SBIN: "SBI",
  BHARTIARTL: "Bharti Airtel", KOTAKBANK: "Kotak Bank", LT: "L&T",
  AXISBANK: "Axis Bank", BAJFINANCE: "Bajaj Finance", ASIANPAINT: "Asian Paints",
  MARUTI: "Maruti", SUNPHARMA: "Sun Pharma", TITAN: "Titan", ULTRACEMCO: "UltraTech",
  NESTLEIND: "Nestle", TATAMOTORS: "Tata Motors", WIPRO: "Wipro", "M&M": "M&M",
  HCLTECH: "HCL Tech", POWERGRID: "Power Grid", NTPC: "NTPC", ONGC: "ONGC",
  TATASTEEL: "Tata Steel", JSWSTEEL: "JSW Steel", ADANIENT: "Adani Ent",
  ADANIPORTS: "Adani Ports", TECHM: "Tech Mahindra", HDFCLIFE: "HDFC Life",
  SBILIFE: "SBI Life", BRITANNIA: "Britannia", CIPLA: "Cipla", DRREDDY: "Dr Reddy",
  DIVISLAB: "Divi's Lab", EICHERMOT: "Eicher", GRASIM: "Grasim",
  HEROMOTOCO: "Hero Moto", HINDALCO: "Hindalco", INDUSINDBK: "IndusInd",
  BAJAJFINSV: "Bajaj Finserv", COALINDIA: "Coal India", BPCL: "BPCL",
  TRENT: "Trent", APOLLOHOSP: "Apollo Hospital", LTIM: "LTIM", HDFCAMC: "HDFC AMC",
  PIDILITIND: "Pidilite",
};

// Moneycontrol priceapi display IDs for NIFTY 50 stocks
const MC_ID_MAP: Record<string, string> = {
  RELIANCE: "RI", TCS: "TCS", HDFCBANK: "HDF01", INFY: "IT",
  ICICIBANK: "ICI02", HINDUNILVR: "HL", ITC: "ITC", SBIN: "SBI",
  BHARTIARTL: "BTV", KOTAKBANK: "KMF", LT: "LT",
  AXISBANK: "UTI10", BAJFINANCE: "BAF", ASIANPAINT: "API",
  MARUTI: "MU01", SUNPHARMA: "SPI", TITAN: "TI01", ULTRACEMCO: "UTC",
  NESTLEIND: "NI", TATAMOTORS: "", WIPRO: "W", "M&M": "MM",
  HCLTECH: "HCL02", POWERGRID: "PGC", NTPC: "NTP", ONGC: "ONG",
  TATASTEEL: "TIS", JSWSTEEL: "JVS", ADANIENT: "AE01",
  ADANIPORTS: "MPS", TECHM: "TM4", HDFCLIFE: "HSL01",
  SBILIFE: "SLI03", BRITANNIA: "BI", CIPLA: "C", DRREDDY: "DRL",
  DIVISLAB: "DL03", EICHERMOT: "EM", GRASIM: "GI01",
  HEROMOTOCO: "HHM", HINDALCO: "H", INDUSINDBK: "IIB",
  BAJAJFINSV: "BF04", COALINDIA: "CI29", BPCL: "BPC",
  TRENT: "L", APOLLOHOSP: "AHE", LTIM: "", HDFCAMC: "HAM02", PIDILITIND: "PI11",
};

const NIFTY50 = [
  "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "HINDUNILVR", "ITC", "SBIN",
  "BHARTIARTL", "KOTAKBANK", "LT", "AXISBANK", "BAJFINANCE", "ASIANPAINT", "MARUTI",
  "SUNPHARMA", "TITAN", "ULTRACEMCO", "NESTLEIND", "TATAMOTORS", "WIPRO", "M&M",
  "HCLTECH", "POWERGRID", "NTPC", "ONGC", "TATASTEEL", "JSWSTEEL", "ADANIENT",
  "ADANIPORTS", "TECHM", "HDFCLIFE", "SBILIFE", "BRITANNIA", "CIPLA", "DRREDDY",
  "DIVISLAB", "EICHERMOT", "GRASIM", "HEROMOTOCO", "HINDALCO", "INDUSINDBK",
  "BAJAJFINSV", "COALINDIA", "BPCL", "TRENT", "APOLLOHOSP", "LTIM", "HDFCAMC", "PIDILITIND",
];

// ─── TIER 0: NSE India API (single call, all NIFTY 50 stocks) ───
let nseCookieCache: { cookie: string; expiresAt: number } | null = null;

async function getNSECookie(): Promise<string> {
  if (nseCookieCache && Date.now() < nseCookieCache.expiresAt) return nseCookieCache.cookie;
  try {
    const res = await fetch("https://www.nseindia.com", {
      headers: NSE_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    const setCookie = res.headers.get("set-cookie") || "";
    const cookie = setCookie.split(";")[0] || "";
    nseCookieCache = { cookie, expiresAt: Date.now() + 5 * 60 * 1000 };
    return cookie;
  } catch {
    return "";
  }
}

/** Free NSE index-constituent list — each row carries a full quote (ltp, change, OHLC). */
const NSE_INDEX_LISTS = ["NIFTY 50", "NIFTY NEXT 50", "NIFTY MIDCAP 100", "NIFTY BANK", "NIFTY IT", "NIFTY AUTO"];

async function fetchFromNSEIndexList(indexName = "NIFTY 50"): Promise<NSEStockQuote[]> {
  try {
    const cookie = await getNSECookie();
    const res = await fetch("https://www.nseindia.com/api/equity-stockIndices?index=" + encodeURIComponent(indexName), {
      headers: { ...NSE_HEADERS, Cookie: cookie, Referer: "https://www.nseindia.com/market-data/live-equity-market" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    const data = json?.data || [];
    return data
      .filter((d: any) => d.symbol && d.lastPrice > 0)
      .map((d: any) => ({
        symbol: d.symbol,
        name: NAME_MAP[d.symbol] || d.meta?.companyName || d.symbol,
        ltp: d.lastPrice,
        // absolute change from the real previous close (NSE's pChange is a % of
        // the current price, so back-computing it drifts by a few paise)
        change: d.previousClose ? parseFloat((d.lastPrice - d.previousClose).toFixed(2)) : parseFloat(((d.lastPrice * (d.pChange || 0)) / 100).toFixed(2)),
        changePct: parseFloat((d.pChange || 0).toFixed(2)),
        weeklyChangePct: 0,
        volume: d.totalTradedVolume || 0,
        avgVolume: d.averageDailyVolume || 0,
        prevClose: d.previousClose || d.lastPrice,
        dayHigh: d.high || d.lastPrice,
        dayLow: d.low || d.lastPrice,
        weekHigh52: d.high52 || 0,
        weekLow52: d.low52 || 0,
        sector: SECTOR_MAP[d.symbol] || "Other",
      }));
  } catch {
    return [];
  }
}

// ─── TIER 1: Moneycontrol priceapi (per-stock) ───
async function fetchFromMoneycontrol(mcId: string): Promise<NSEStockQuote | null> {
  const res = await fetch(`https://priceapi.moneycontrol.com/pricefeed/nse/equitycash/${mcId}`, {
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (json.code !== "200" || !json.data) return null;
  const d = json.data;
  const ltp = parseFloat(d.pricecurrent) || 0;
  if (!ltp) return null;
  const prevClose = parseFloat(d.priceprevclose) || ltp;
  const change = parseFloat(d.pricechange) || (ltp - prevClose);
  const changePct = parseFloat(d.pricepercentchange) || (prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : 0);
  const sym = d.NSEID || "";
  return {
    symbol: sym, name: NAME_MAP[sym] || d.SC_FULLNM || sym,
    ltp, change: Math.round(change * 100) / 100, changePct: Math.round(changePct * 100) / 100,
    volume: parseInt(d.VOL) || 0, prevClose: Math.round(prevClose * 100) / 100,
    dayHigh: parseFloat(d.HP) || ltp, dayLow: parseFloat(d.LP) || ltp,
    weekHigh52: parseFloat(d["52H"]) || 0, weekLow52: parseFloat(d["52L"]) || 0,
    sector: SECTOR_MAP[sym] || "Other",
  };
}

let cache: { data: NSEStockQuote[]; ts: number } | null = null;
const CACHE_TTL = 60_000;

// Honest provenance of the last fetch — which free tier supplied most rows + when.
let stockProvenance: {
  source: "nse" | "moneycontrol" | "cache" | "none";
  retrievedAt: number;
  nseCount: number;
  mcCount: number;
  yahooCount: number;
} = { source: "none", retrievedAt: 0, nseCount: 0, mcCount: 0, yahooCount: 0 };

export function getStockQuoteProvenance() {
  const ageMs = stockProvenance.retrievedAt ? Date.now() - stockProvenance.retrievedAt : -1;
  const freshness =
    ageMs < 0 ? "UNAVAILABLE"
    : ageMs < 60_000 ? "LIVE"
    : ageMs < 300_000 ? "FRESH"
    : ageMs < 900_000 ? "DELAYED"
    : "STALE";
  return {
    source: stockProvenance.source,
    retrievedAt: new Date(stockProvenance.retrievedAt || Date.now()).toISOString(),
    ageMs,
    freshness,
    isLive: freshness === "LIVE",
    fallbackUsed: stockProvenance.source !== "nse" && stockProvenance.source !== "cache",
    counts: {
      nse: stockProvenance.nseCount,
      moneycontrol: stockProvenance.mcCount,
      yahoo: stockProvenance.yahooCount,
    },
  };
}

export async function fetchNIFTY50Stocks(): Promise<NSEStockQuote[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL) return cache.data;

  try {
    const resultMap = new Map<string, NSEStockQuote>();

    // ── Tier 0: NSE India API (single call, fast) ──
    const nseStocks = await fetchFromNSEIndexList("NIFTY 50");
    for (const s of nseStocks) {
      if (NIFTY50.includes(s.symbol)) resultMap.set(s.symbol, s);
    }

    // ── Tier 1: Moneycontrol (batches of 5) — only for stocks NSE missed ──
    const mcProvided = new Set<string>();
    const mcEntries = NIFTY50.filter(s => !resultMap.has(s) && MC_ID_MAP[s]);
    for (let i = 0; i < mcEntries.length; i += 5) {
      const batch = mcEntries.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(sym => fetchFromMoneycontrol(MC_ID_MAP[sym])),
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) {
          resultMap.set(r.value.symbol, r.value);
          mcProvided.add(r.value.symbol);
        }
      }
      if (i + 5 < mcEntries.length) await new Promise(r => setTimeout(r, 200));
    }

    // ── Tier 2: free NSE index lists (covers the whole NIFTY 50 universe) ──
    const missing = NIFTY50.filter(s => !resultMap.has(s));
    if (missing.length > 0) {
      const viaLists = await fetchFreeNSEQuotes(missing);
      for (const [sym, quote] of viaLists) resultMap.set(sym, quote);
    }

    const results = NIFTY50.map(s => resultMap.get(s)).filter(Boolean) as NSEStockQuote[];
    if (results.length > 0) {
      // Fetch weekly data from Yahoo (slow — skip if NSE was primary source for speed)
      const nseSourced = resultMap.has("RELIANCE") && resultMap.has("TCS") && resultMap.has("HDFCBANK");
      if (!nseSourced) {
        const weeklyData = await fetchWeeklyData(results.map(s => s.symbol));
        for (const stock of results) {
          stock.weeklyChangePct = weeklyData.get(stock.symbol) || 0;
        }
      }
      const nseCount = nseStocks.length;
      const mcCount = results.filter(s => mcProvided.has(s.symbol)).length;
      const yahooCount = results.length - nseCount - mcCount;
      const source = nseCount >= results.length / 2 ? "nse" : "moneycontrol";
      stockProvenance = { source, retrievedAt: Date.now(), nseCount, mcCount, yahooCount: 0 };
      cache = { data: results, ts: Date.now() };
    }
    return results;
  } catch (err: any) {
    console.error("[Stock Data] Fetch failed:", err.message);
    if (cache) return cache.data;
    return [];
  }
}

// Fetch 5-day change % from the exchange's own daily history (free NSE).
async function fetchWeeklyData(symbols: string[]): Promise<Map<string, number>> {
  const weeklyMap = new Map<string, number>();
  if (!symbols.length) return weeklyMap;
  try {
    const { getNSEHistoricalData } = await import("./nse-api");
    const to = new Date();
    const from = new Date(to.getTime() - 12 * 86_400_000);
    const results = await Promise.allSettled(
      symbols.map(async (sym) => {
        try {
          const bars = (await getNSEHistoricalData(sym, from, to)) || [];
          const closes = bars.map((b: any) => Number(b.close)).filter((c: number) => Number.isFinite(c) && c > 0);
          if (closes.length < 2) return null;
          const first = closes[0];
          const last = closes[closes.length - 1];
          if (first > 0) return { symbol: sym, change: parseFloat(((last - first) / first * 100).toFixed(2)) };
        } catch { /* no free history for this symbol */ }
        return null;
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) weeklyMap.set(r.value.symbol, r.value.change);
    }
  } catch {}
  return weeklyMap;
}

export async function getSectorAverages(): Promise<Record<string, number>> {
  const stocks = await fetchNIFTY50Stocks();
  const sectorMap: Record<string, { sum: number; count: number }> = {};
  for (const s of stocks) {
    if (!sectorMap[s.sector]) sectorMap[s.sector] = { sum: 0, count: 0 };
    sectorMap[s.sector].sum += s.changePct;
    sectorMap[s.sector].count++;
  }
  const avg: Record<string, number> = {};
  for (const [sec, { sum, count }] of Object.entries(sectorMap)) {
    avg[sec] = Math.round((sum / count) * 100) / 100;
  }
  return avg;
}

export async function getBreadthData(): Promise<{
  advances: number; declines: number; unchanged: number; total: number;
  newHighs: number; newLows: number;
  volAdvancing: number; volDeclining: number;
  topGainers: NSEStockQuote[]; topLosers: NSEStockQuote[];
}> {
  const stocks = await fetchNIFTY50Stocks();
  const advances = stocks.filter(s => s.changePct > 0).length;
  const declines = stocks.filter(s => s.changePct < 0).length;
  const unchanged = stocks.length - advances - declines;
  const newHighs = stocks.filter(s => s.weekHigh52 > 0 && s.ltp >= s.weekHigh52 * 0.99).length;
  const newLows = stocks.filter(s => s.weekLow52 > 0 && s.ltp <= s.weekLow52 * 1.01).length;
  const volAdvancing = stocks.filter(s => s.changePct > 0).reduce((sum, s) => sum + s.volume, 0);
  const volDeclining = stocks.filter(s => s.changePct < 0).reduce((sum, s) => sum + s.volume, 0);
  const sorted = [...stocks].sort((a, b) => b.changePct - a.changePct);
  return {
    advances, declines, unchanged, total: stocks.length, newHighs, newLows,
    volAdvancing, volDeclining,
    topGainers: sorted.slice(0, 5), topLosers: sorted.slice(-5).reverse(),
  };
}

// ─── Arbitrary-symbol quotes (watchlist / single names) ─────────────────
// Indices resolve via the free NSE index list (own 2min cache + rate
// limit); equities via the yahoo v7 batch above, per-stock chart fallback.
export interface QuoteRow {
  symbol: string;
  name: string;
  ltp: number;
  change: number;
  changePct: number;
}

// Uppercase/trim/dedupe NSE-style codes; drop junk, traversal and junk
// tokens; cap at 40 symbols per request.
export function sanitizeQuoteSymbols(raw: string[]): string[] {
  const out: string[] = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    const t = String(s ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9&-]{1,20}$/.test(t)) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= 40) break;
  }
  return out;
}

const round2 = (n: number) => Math.round((n || 0) * 100) / 100;

const freeQuoteCache = new Map<string, { at: number; map: Map<string, NSEStockQuote> }>();
const FREE_QUOTE_TTL = 60_000;

/**
 * Free NSE quotes for arbitrary symbols: the exchange's own index-constituent
 * lists (NIFTY 50 / NEXT 50 / MIDCAP 100 / BANK / IT / AUTO), each row carrying
 * ltp, change, change %, OHLC and volume. Cached for 60s.
 */
export async function fetchFreeNSEQuotes(symbols: string[]): Promise<Map<string, NSEStockQuote>> {
  const want = new Set(symbols.map((s) => s.toUpperCase()));
  const out = new Map<string, NSEStockQuote>();
  const missing = new Set(want);
  for (const list of NSE_INDEX_LISTS) {
    if (!missing.size) break;
    const key = list;
    let cached = freeQuoteCache.get(key);
    if (!cached || Date.now() - cached.at > FREE_QUOTE_TTL) {
      const rows = await fetchFromNSEIndexList(list);
      cached = { at: Date.now(), map: new Map(rows.map((r) => [r.symbol.toUpperCase(), r])) };
      freeQuoteCache.set(key, cached);
    }
    for (const sym of [...missing]) {
      const row = cached.map.get(sym);
      if (row) { out.set(sym, row); missing.delete(sym); }
    }
  }
  // Moneycontrol for the mapped names NSE did not cover
  for (const sym of [...missing]) {
    const mcId = MC_ID_MAP[sym];
    if (!mcId) continue;
    const row = await fetchFromMoneycontrol(mcId);
    if (row) { out.set(sym, { ...row, symbol: sym }); missing.delete(sym); }
  }
  return out;
}

export async function fetchStockQuotes(rawSymbols: string[]): Promise<Record<string, QuoteRow>> {
  const out: Record<string, QuoteRow> = {};
  const symbols = sanitizeQuoteSymbols(rawSymbols);
  if (!symbols.length) return out;

  const indices = symbols.filter(isIndexSymbol);
  const equities = symbols.filter((s) => !isIndexSymbol(s));

  if (indices.length) {
    // Free NSE index quotes (the exchange is the source; Yahoo is not used).
    const { getNSEIndices } = await import("@/lib/nse-api");
    const nseIdx = await getNSEIndices();
    for (const s of indices) {
      const row = nseIdx?.find(
        (i: any) => String(i.key).toUpperCase() === s.toUpperCase() || String(i.name).toUpperCase() === s.toUpperCase(),
      );
      if (row?.ltp) {
        out[s] = { symbol: s, name: row.name || s, ltp: row.ltp, change: round2(row.change), changePct: round2(row.changePct) };
      }
    }
  }

  if (equities.length) {
    // Free NSE data only (index-constituent lists + Moneycontrol). A symbol that
    // is not in any free list is simply absent — never a Yahoo quote.
    const batch = await fetchFreeNSEQuotes(equities);
    for (const [sym, q] of batch) {
      out[sym] = { symbol: sym, name: q.name || sym, ltp: q.ltp, change: q.change, changePct: q.changePct };
    }
  }

  return out;
}
