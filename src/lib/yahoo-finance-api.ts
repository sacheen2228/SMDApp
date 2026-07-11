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
  'SENSEX': '^BSESN',
  'INDIAVIX': '^INDIAVIX',
  'GIFTNIFTY': 'SGXNIFTY.NS',
};

// Cache for Yahoo data (2 minutes)
let yahooCache: Map<string, { data: YahooIndexData; timestamp: number }> = new Map();
const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes

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

// Fetch India VIX
export async function fetchIndiaVIX(): Promise<{ value: number; change: number } | null> {
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
