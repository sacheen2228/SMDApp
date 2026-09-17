// lib/mcx/nse-commodity-scraper.ts
//
// NSE India commodity derivatives scraper.
// NSE hosts MCX commodity data for reference at:
//   https://www.nseindia.com/api/market-data-pre-open?key=ALL
// But MCX commodities are NOT on NSE — they trade on MCX exchange.
// 
// This module scrapes MCX India website directly for live INR prices.
// MCX website: https://www.mcxindia.com/market-data/stock-derivatives
// MCX API: https://www.mcxindia.com/market-data/pre-open-market

const MCX_BASE = "https://www.mcxindia.com";
const MCX_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.mcxindia.com/market-data/stock-derivatives",
};

// MCX commodity to NSE-like mapping for reference
const MCX_COMMODITY_MAP: Record<string, { name: string; lotSize: number; tickSize: number }> = {
  CRUDEOIL: { name: "Crude Oil", lotSize: 100, tickSize: 1 },
  CRUDEOILM: { name: "Crude Oil Mini", lotSize: 10, tickSize: 1 },
  NATURALGAS: { name: "Natural Gas", lotSize: 1250, tickSize: 0.1 },
  NATGASMINI: { name: "Natural Gas Mini", lotSize: 250, tickSize: 0.1 },
  GOLD: { name: "Gold", lotSize: 1, tickSize: 1 },
  GOLDM: { name: "Gold Petal", lotSize: 100, tickSize: 1 },
  GOLDGUINEA: { name: "Gold Guinea", lotSize: 1, tickSize: 10 },
  SILVER: { name: "Silver", lotSize: 30, tickSize: 1 },
  SILVERM: { name: "Silver Mini", lotSize: 5, tickSize: 1 },
  SILVERMIC: { name: "Silver Micro", lotSize: 1, tickSize: 1 },
};

interface MCXLivePrice {
  symbol: string;
  name: string;
  ltp: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  oi: number;
  timestamp: string;
  source: "MCX_WEBSITE";
}

// Fetch MCX market data page to get session cookies
async function getMCXSession(): Promise<string | null> {
  try {
    const res = await fetch(MCX_BASE, {
      headers: MCX_HEADERS,
      signal: AbortSignal.timeout(10000),
      redirect: "follow",
    });
    const cookies = res.headers.getSetCookie?.() || [];
    const cookieStr = cookies.map(c => c.split(";")[0]).join("; ");
    return cookieStr || null;
  } catch {
    return null;
  }
}

// Scrape MCX live commodity prices from website API
export async function scrapeMCXPrices(): Promise<MCXLivePrice[]> {
  const results: MCXLivePrice[] = [];
  
  try {
    // MCX has a market data API endpoint
    const res = await fetch(`${MCX_BASE}/api/market-data/pre-open-market`, {
      headers: {
        ...MCX_HEADERS,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.warn(`[MCX Scraper] HTTP ${res.status} from MCX website`);
      return results;
    }

    const data = await res.json();
    
    // Parse MCX response format
    const commodities = data?.data || data?.commodities || data?.result || [];
    
    for (const item of commodities) {
      const symbol = (item.symbol || item.commodityName || "").toUpperCase();
      if (!MCX_COMMODITY_MAP[symbol]) continue;
      
      const ltp = parseFloat(item.lastPrice || item.ltp || item.close || "0");
      if (!ltp) continue;
      
      results.push({
        symbol,
        name: MCX_COMMODITY_MAP[symbol].name,
        ltp,
        change: parseFloat(item.change || item.priceChange || "0"),
        changePct: parseFloat(item.changePercent || item.percChange || "0"),
        open: parseFloat(item.open || item.openPrice || "0"),
        high: parseFloat(item.high || item.highPrice || "0"),
        low: parseFloat(item.low || item.lowPrice || "0"),
        prevClose: parseFloat(item.previousClose || item.prevClose || "0"),
        volume: parseInt(item.volume || item.totalTradedVolume || "0"),
        oi: parseInt(item.openInterest || item.oi || "0"),
        timestamp: new Date().toISOString(),
        source: "MCX_WEBSITE",
      });
    }
    
    console.log(`[MCX Scraper] Scraped ${results.length} commodities from MCX website`);
  } catch (err: any) {
    console.warn(`[MCX Scraper] Failed: ${err.message}`);
  }

  return results;
}

// Alternative: Scrape MCX contract-wise live data
export async function scrapeMCXContractData(symbol: string): Promise<MCXLivePrice | null> {
  try {
    const res = await fetch(`${MCX_BASE}/api/quote/${symbol}`, {
      headers: MCX_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const item = data?.data || data;
    
    const ltp = parseFloat(item.lastPrice || item.ltp || "0");
    if (!ltp) return null;

    return {
      symbol: symbol.toUpperCase(),
      name: MCX_COMMODITY_MAP[symbol.toUpperCase()]?.name || symbol,
      ltp,
      change: parseFloat(item.change || "0"),
      changePct: parseFloat(item.changePercent || "0"),
      open: parseFloat(item.open || "0"),
      high: parseFloat(item.high || "0"),
      low: parseFloat(item.low || "0"),
      prevClose: parseFloat(item.previousClose || "0"),
      volume: parseInt(item.volume || "0"),
      oi: parseInt(item.openInterest || "0"),
      timestamp: new Date().toISOString(),
      source: "MCX_WEBSITE",
    };
  } catch {
    return null;
  }
}

// Scrape multiple MCX commodities
export async function scrapeMCXSymbols(symbols: string[]): Promise<Map<string, MCXLivePrice>> {
  const results = new Map<string, MCXLivePrice>();
  
  // Try batch endpoint first
  const batch = await scrapeMCXPrices();
  for (const price of batch) {
    if (symbols.includes(price.symbol)) {
      results.set(price.symbol, price);
    }
  }
  
  // Fill missing with individual scrapes
  for (const sym of symbols) {
    if (!results.has(sym)) {
      const price = await scrapeMCXContractData(sym);
      if (price) {
        results.set(sym, price);
      }
    }
  }
  
  return results;
}

export { MCX_COMMODITY_MAP };
