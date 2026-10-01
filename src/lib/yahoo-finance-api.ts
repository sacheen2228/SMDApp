// Yahoo Finance Integration - Real-time index data fallback
// Uses Yahoo Finance v8 chart API (no auth required)
// NOTE: Do NOT set User-Agent header - Yahoo Finance rate-limits Node.js requests with custom headers

interface YahooIndexData {
  symbol: string;
  name: string;
  regularMarketPrice: number;
  previousClose: number;
  change: number;
  changePct: number;
  open: number;
  dayHigh: number;
  dayLow: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  volume: number;
}

// Map our symbols to Yahoo Finance symbols
const YAHOO_SYMBOL_MAP: Record<string, string> = {
  'NIFTY': '^NSEI',
  'BANKNIFTY': '^NSEBANK',
  'FINNIFTY': '^NSEMIDCAP',
  'MIDCPNIFTY': '^NSEMIDCAP',
  'NIFTYNXT50': '^NSENXT50',
  'SENSEX': '^BSESN',
  'BANKEX': '^BSEBANK',
  'INDIAVIX': '^INDIAVIX',
  'GIFTNIFTY': '^NSEI', // SGXNIFTY.NS is dead (SGX→GIFTC merger). Use NIFTY 50 spot as proxy
};

// Cache for Yahoo data (2 minutes)
let yahooCache: Map<string, { data: YahooIndexData; timestamp: number }> = new Map();
const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes

// Separate cache for prev close (1 hour — doesn't change during the day)
let prevCloseCache: Map<string, { value: number; timestamp: number }> = new Map();
const PREV_CLOSE_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

// Rate limiter: max 1 request per 2 seconds
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 2000; // 2 seconds

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
  }
  lastRequestTime = Date.now();
  
  // Don't set User-Agent - Yahoo Finance rate-limits Node.js with custom UA
  return fetch(url, {
    signal: AbortSignal.timeout(10000),
  });
}

export async function fetchYahooIndexData(ourSymbol: string): Promise<YahooIndexData | null> {
  try {
    // Check cache
    const cached = yahooCache.get(ourSymbol);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return cached.data;
    }

    const yahooSymbol = YAHOO_SYMBOL_MAP[ourSymbol];
    if (!yahooSymbol) return null;

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1d`;

    console.log(`[Yahoo] Fetching ${ourSymbol} (${yahooSymbol})...`);

    const response = await rateLimitedFetch(url);

    if (!response.ok) {
      console.warn(`[Yahoo] API returned ${response.status} for ${ourSymbol}`);
      return cached?.data || null;
    }

    const data = await response.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;

    if (!meta || !meta.regularMarketPrice) {
      console.warn(`[Yahoo] No data for ${ourSymbol}`);
      return cached?.data || null;
    }

    const indexData: YahooIndexData = {
      symbol: ourSymbol,
      name: meta.shortName || meta.longName || ourSymbol,
      regularMarketPrice: meta.regularMarketPrice,
      previousClose: meta.chartPreviousClose || meta.regularMarketPrice,
      change: meta.regularMarketPrice - (meta.chartPreviousClose || meta.regularMarketPrice),
      changePct: meta.chartPreviousClose 
        ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100 
        : 0,
      open: meta.regularMarketPrice - (meta.regularMarketPrice - (meta.chartPreviousClose || meta.regularMarketPrice)) * 0.3,
      dayHigh: meta.regularMarketDayHigh || meta.regularMarketPrice,
      dayLow: meta.regularMarketDayLow || meta.regularMarketPrice,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || meta.regularMarketPrice,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow || meta.regularMarketPrice,
      volume: meta.regularMarketVolume || 0,
    };

    // Update cache
    yahooCache.set(ourSymbol, { data: indexData, timestamp: Date.now() });

    console.log(`[Yahoo] ${ourSymbol}: ${indexData.regularMarketPrice} (${indexData.change >= 0 ? '+' : ''}${indexData.change.toFixed(2)})`);

    return indexData;
  } catch (error) {
    console.error(`[Yahoo] Error fetching ${ourSymbol}:`, error);
    const cached = yahooCache.get(ourSymbol);
    return cached?.data || null;
  }
}

// Fetch India VIX — NSE primary, Yahoo fallback
export async function fetchIndiaVIX(): Promise<{ value: number; change: number } | null> {
  // Try NSE API first (no rate limit)
  try {
    const res = await fetch('https://www.nseindia.com/api/allIndices', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.nseindia.com/market-data/live-equity-market',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      const vix = data?.data?.find((i: any) => i.index === 'INDIA VIX');
      if (vix) {
        return { value: vix.last || vix.percChange || 0, change: vix.percChange || 0 };
      }
    }
  } catch {}

  // Yahoo fallback
  try {
    const vixData = await fetchYahooIndexData('INDIAVIX');
    if (vixData) {
      return {
        value: vixData.regularMarketPrice,
        change: vixData.change,
      };
    }
    return null;
  } catch (error) {
    console.error('[Yahoo] Error fetching India VIX:', error);
    return null;
  }
}

// Fetch previous close with 1-hour cache (doesn't change during the day)
export async function fetchPrevClose(symbol: string): Promise<number | null> {
  const cached = prevCloseCache.get(symbol);
  if (cached && Date.now() - cached.timestamp < PREV_CLOSE_CACHE_DURATION) {
    return cached.value;
  }

  try {
    const data = await fetchYahooIndexData(symbol);
    if (data?.previousClose) {
      prevCloseCache.set(symbol, { value: data.previousClose, timestamp: Date.now() });
      return data.previousClose;
    }
  } catch {}

  return null;
}

// Fetch daily candles for ATR calculations (real data, no auth needed)
export async function fetchYahooDailyCandles(symbol: string, limit = 30): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>> {
  try {
    let yahooSymbol = YAHOO_SYMBOL_MAP[symbol] || symbol;
    // NSE equities need .NS suffix on Yahoo (e.g. RELIANCE → RELIANCE.NS)
    if (!YAHOO_SYMBOL_MAP[symbol] && !symbol.includes(".") && !symbol.startsWith("^")) {
      yahooSymbol = `${symbol}.NS`;
    }
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1mo&interval=1d`;
    const response = await rateLimitedFetch(url);
    if (!response.ok && yahooSymbol.endsWith(".NS")) {
      // Retry bare symbol if .NS failed (already-suffixed or non-NSE tickers)
      const bare = symbol.includes(".") || symbol.startsWith("^") ? symbol : symbol;
      const retry = await rateLimitedFetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(bare)}?range=1mo&interval=1d`
      );
      if (!retry.ok) return [];
      return parseYahooDailyBars(await retry.json(), limit);
    }
    if (!response.ok) return [];
    return parseYahooDailyBars(await response.json(), limit);
  } catch {
    return [];
  }
}

function parseYahooDailyBars(
  data: any,
  limit: number
): Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> {
  const result = data?.chart?.result?.[0];
  const ts: number[] = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0];
  if (!quote || ts.length === 0) return [];

  const candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  for (let i = 0; i < ts.length; i++) {
    const o = quote.open?.[i], h = quote.high?.[i], l = quote.low?.[i], c = quote.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({ time: ts[i] * 1000, open: o, high: h, low: l, close: c, volume: quote.volume?.[i] || 0 });
  }
  return candles.slice(-limit);
}

// Real 14-period ATR from daily candles, cached per symbol for 1 hour
// (daily candles are stable intraday — avoids refetching Yahoo every request)
const atrCache: Map<string, { atr: number; timestamp: number }> = new Map();
const ATR_CACHE_DURATION = 60 * 60 * 1000;

export async function getRealATR14(symbol: string, fallback: number): Promise<{ atr: number; source: "real" | "vix-estimate" }> {
  const cached = atrCache.get(symbol);
  if (cached && Date.now() - cached.timestamp < ATR_CACHE_DURATION) {
    return { atr: cached.atr, source: "real" };
  }

  try {
    const candles = await fetchYahooDailyCandles(symbol, 30);
    if (candles.length >= 15) {
      let sum = 0;
      for (let i = candles.length - 14; i < candles.length; i++) {
        const c = candles[i];
        const prev = candles[i - 1];
        sum += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
      }
      const realATR = sum / 14;
      if (realATR > 0) {
        const atr = Math.round(realATR * 100) / 100;
        atrCache.set(symbol, { atr, timestamp: Date.now() });
        return { atr, source: "real" };
      }
    }
  } catch {}

  return { atr: fallback, source: "vix-estimate" };
}
