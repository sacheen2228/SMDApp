// Shared stock data fetcher for all NIFTY 50 stocks.
// Primary: Moneycontrol priceapi (fast, no rate limiting).
// Fallback: Yahoo Finance for stocks not found on Moneycontrol.
// Single function called by all market APIs — replaces per-stock Yahoo calls.

export interface NSEStockQuote {
  symbol: string;
  name: string;
  ltp: number;
  change: number;
  changePct: number;
  volume: number;
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
// Verified: all return correct NSEID and pricecurrent from priceapi
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

// Stocks not found on Moneycontrol — use Yahoo Finance fallback
const YAHOO_FALLBACK = ["TATAMOTORS", "LTIM"];

interface MCResponse {
  data: {
    pricecurrent: string;
    pricechange: string;
    pricepercentchange: string;
    priceprevclose: string;
    LP: string;
    HP: string;
    VOL: string;
    "52H": string;
    "52L": string;
    NSEID: string;
    SC_FULLNM: string;
  };
}

async function fetchOneStockMC(mcId: string, fallbackSymbol: string): Promise<NSEStockQuote | null> {
  try {
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
    const sym = d.NSEID || fallbackSymbol;
    return {
      symbol: sym,
      name: NAME_MAP[sym] || d.SC_FULLNM || sym,
      ltp, change: Math.round(change * 100) / 100, changePct: Math.round(changePct * 100) / 100,
      volume: parseInt(d.VOL) || 0, prevClose: Math.round(prevClose * 100) / 100,
      dayHigh: parseFloat(d.HP) || ltp, dayLow: parseFloat(d.LP) || ltp,
      weekHigh52: parseFloat(d["52H"]) || 0, weekLow52: parseFloat(d["52L"]) || 0,
      sector: SECTOR_MAP[sym] || "Other",
    };
  } catch { return null; }
}

async function fetchOneStockYahoo(symbol: string): Promise<NSEStockQuote | null> {
  try {
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
  } catch { return null; }
}

let cache: { data: NSEStockQuote[]; ts: number } | null = null;
const CACHE_TTL = 60_000;

async function batchFetch<T>(items: T[], fn: (item: T) => Promise<NSEStockQuote | null>, concurrency: number): Promise<NSEStockQuote[]> {
  const results: NSEStockQuote[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    for (const r of batchResults) {
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    }
    if (i + concurrency < items.length) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

export async function fetchNIFTY50Stocks(): Promise<NSEStockQuote[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL) return cache.data;

  try {
    // Fetch all stocks from Moneycontrol in batches of 5 (Render free tier limits concurrent connections)
    const mcEntries = Object.entries(MC_ID_MAP).filter(([, id]) => id);
    const mcStocks = await batchFetch(
      mcEntries,
      ([symbol, mcId]) => fetchOneStockMC(mcId, symbol),
      5,
    );

    // Fetch fallback stocks from Yahoo Finance
    const yahooStocks = await batchFetch(
      YAHOO_FALLBACK,
      (sym) => fetchOneStockYahoo(sym),
      3,
    );

    const allStocks = [...mcStocks, ...yahooStocks];
    if (allStocks.length > 0) {
      cache = { data: allStocks, ts: Date.now() };
    }
    return allStocks;
  } catch (err: any) {
    console.error("[Stock Data] Fetch failed:", err.message);
    if (cache) return cache.data;
    return [];
  }
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
