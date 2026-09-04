// Shared stock data fetcher for all NIFTY 50 stocks.
// Tier 1: Moneycontrol priceapi (per-stock, batches of 5)
// Tier 2: Yahoo Finance batch quote (all missing stocks in one call via v7/finance/quote)
// Tier 3: Yahoo Finance per-stock chart (final fallback for stragglers)
// Returns whatever data was successfully fetched — never throws.

import { fetchWithFallback, FallbackSource } from "./fetch-with-fallback";

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

// ─── TIER 2: Yahoo Finance batch quote (all stocks in one call) ───
// Uses v7/finance/quote with crumb auth — same approach as github.com/0xramm/Indian-Stock-Market-API
const YF_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
let yfCrumbCache: { crumb: string; cookie: string; expiresAt: number } | null = null;

async function getYFCrumb(): Promise<{ crumb: string; cookie: string }> {
  if (yfCrumbCache && Date.now() < yfCrumbCache.expiresAt) {
    return { crumb: yfCrumbCache.crumb, cookie: yfCrumbCache.cookie };
  }
  const cookieRes = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": YF_UA },
    signal: AbortSignal.timeout(5000),
  });
  const setCookie = cookieRes.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0] || "";
  const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": YF_UA, Cookie: cookie },
    signal: AbortSignal.timeout(5000),
  });
  const crumb = (await crumbRes.text()).trim();
  yfCrumbCache = { crumb, cookie, expiresAt: Date.now() + 50 * 60 * 1000 };
  return { crumb, cookie };
}

async function fetchYahooBatch(symbols: string[]): Promise<Map<string, NSEStockQuote>> {
  const result = new Map<string, NSEStockQuote>();
  if (symbols.length === 0) return result;

  try {
    const { crumb, cookie } = await getYFCrumb();
    const tickers = symbols.map(s => `${s}.NS`).join(",");
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(tickers)}&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": YF_UA, Cookie: cookie },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      // Retry with fresh crumb
      yfCrumbCache = null;
      const { crumb: c2, cookie: ck2 } = await getYFCrumb();
      const res2 = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(tickers)}&crumb=${encodeURIComponent(c2)}`,
        { headers: { "User-Agent": YF_UA, Cookie: ck2 }, signal: AbortSignal.timeout(12000) },
      );
      if (!res2.ok) return result;
      const data2 = await res2.json();
      return parseYahooBatch(data2, symbols);
    }
    const data = await res.json();
    return parseYahooBatch(data, symbols);
  } catch {
    return result;
  }
}

function parseYahooBatch(data: any, symbols: string[]): Map<string, NSEStockQuote> {
  const result = new Map<string, NSEStockQuote>();
  for (const q of data?.quoteResponse?.result || []) {
    const raw = q.symbol?.replace(".NS", "");
    if (!raw || !symbols.includes(raw)) continue;
    const ltp = q.regularMarketPrice;
    if (!ltp) continue;
    const prev = q.regularMarketPreviousClose || ltp;
    // Yahoo batch has 5-day change % in fiftyDayAverage and other fields
    // We'll use regularMarketChangePercent for daily, and calculate weekly from chart data
    result.set(raw, {
      symbol: raw,
      name: NAME_MAP[raw] || q.shortName || q.longName || raw,
      ltp,
      change: parseFloat((q.regularMarketChange ?? (ltp - prev)).toFixed(2)),
      changePct: parseFloat((q.regularMarketChangePercent ?? ((ltp - prev) / prev) * 100).toFixed(2)),
      weeklyChangePct: 0, // Will be populated by fetchWeeklyData
      volume: q.regularMarketVolume || 0,
      avgVolume: q.averageDailyVolume3Month || q.averageDailyVolume10Day || 0,
      prevClose: prev,
      dayHigh: q.regularMarketDayHigh || ltp,
      dayLow: q.regularMarketDayLow || ltp,
      weekHigh52: q.fiftyTwoWeekHigh || 0,
      weekLow52: q.fiftyTwoWeekLow || 0,
      sector: SECTOR_MAP[raw] || "Other",
    });
  }
  return result;
}

// ─── TIER 3: Yahoo Finance per-stock chart (final fallback) ───
async function fetchFromYahooChart(symbol: string): Promise<NSEStockQuote | null> {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.NS?range=1d&interval=1d`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) return null;
  const ltp = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose || meta.regularMarketPrice;
  return {
    symbol, name: NAME_MAP[symbol] || symbol, ltp,
    change: parseFloat((ltp - prev).toFixed(2)),
    changePct: parseFloat((((ltp - prev) / prev) * 100).toFixed(2)),
    volume: meta.regularMarketVolume || 0, prevClose: prev,
    dayHigh: meta.regularMarketDayHigh || ltp, dayLow: meta.regularMarketDayLow || ltp,
    weekHigh52: meta.fiftyTwoWeekHigh || 0, weekLow52: meta.fiftyTwoWeekLow || 0,
    sector: SECTOR_MAP[symbol] || "Other",
  };
}

// ─── Main fetcher with 3-tier fallback ───
let cache: { data: NSEStockQuote[]; ts: number } | null = null;
const CACHE_TTL = 60_000;

export async function fetchNIFTY50Stocks(): Promise<NSEStockQuote[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL) return cache.data;

  try {
    const resultMap = new Map<string, NSEStockQuote>();

    // ── Tier 1: Moneycontrol (batches of 5) ──
    const mcEntries = NIFTY50.filter(s => MC_ID_MAP[s]);
    for (let i = 0; i < mcEntries.length; i += 5) {
      const batch = mcEntries.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(sym => fetchFromMoneycontrol(MC_ID_MAP[sym])),
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) resultMap.set(r.value.symbol, r.value);
      }
      if (i + 5 < mcEntries.length) await new Promise(r => setTimeout(r, 200));
    }

    // ── Tier 2: Yahoo Finance batch (for stocks Moneycontrol missed) ──
    const missing = NIFTY50.filter(s => !resultMap.has(s));
    if (missing.length > 0) {
      const yahooBatch = await fetchYahooBatch(missing);
      for (const [sym, quote] of yahooBatch) {
        resultMap.set(sym, quote);
      }
    }

    // ── Tier 3: Yahoo Finance per-stock chart (for any still missing) ──
    const stillMissing = NIFTY50.filter(s => !resultMap.has(s));
    if (stillMissing.length > 0 && stillMissing.length <= 10) {
      const results = await Promise.allSettled(stillMissing.map(fetchFromYahooChart));
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) resultMap.set(r.value.symbol, r.value);
      }
    }

    const results = NIFTY50.map(s => resultMap.get(s)).filter(Boolean) as NSEStockQuote[];
    if (results.length > 0) {
      // Fetch weekly data for all stocks
      const weeklyData = await fetchWeeklyData(results.map(s => s.symbol));
      for (const stock of results) {
        stock.weeklyChangePct = weeklyData.get(stock.symbol) || 0;
      }
      cache = { data: results, ts: Date.now() };
    }
    return results;
  } catch (err: any) {
    console.error("[Stock Data] Fetch failed:", err.message);
    if (cache) return cache.data;
    return [];
  }
}

// Fetch 5-day change % for all stocks using Yahoo Finance chart API (batches of 10)
async function fetchWeeklyData(symbols: string[]): Promise<Map<string, number>> {
  const weeklyMap = new Map<string, number>();
  if (symbols.length === 0) return weeklyMap;

  try {
    // Fetch 5-day chart data for each stock in parallel batches of 10
    for (let i = 0; i < symbols.length; i += 10) {
      const batch = symbols.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(async (sym) => {
          try {
            const res = await fetch(
              `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.NS?range=5d&interval=1d`,
              { signal: AbortSignal.timeout(8000) }
            );
            if (!res.ok) return null;
            const data = await res.json();
            const candles = data?.chart?.result?.[0]?.indicators?.quote?.[0];
            if (!candles?.close) return null;
            const closes = candles.close.filter((c: number | null) => c != null) as number[];
            if (closes.length < 2) return null;
            const first = closes[0];
            const last = closes[closes.length - 1];
            if (first > 0) {
              return { symbol: sym, change: parseFloat(((last - first) / first * 100).toFixed(2)) };
            }
          } catch {}
          return null;
        })
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) {
          weeklyMap.set(r.value.symbol, r.value.change);
        }
      }
      // Small delay between batches to avoid rate limiting
      if (i + 10 < symbols.length) await new Promise(r => setTimeout(r, 300));
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
