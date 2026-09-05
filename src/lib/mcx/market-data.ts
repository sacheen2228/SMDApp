// MCX Commodity Module — Market Data Fetcher
// Primary: Motilal Oswal API → Secondary: Yahoo Finance
// Critical: Never fabricate data. Return null/UNAVAILABLE when unavailable.

import { getLTP, getMultiLTP, getScrips, getSessionToken } from '@/lib/motilal/auth';
import { getLTP as fetchLTP, getMultiLTP as fetchMultiLTP } from '@/lib/motilal/market';
import type { MCXCommodity, MCXQuote, MCXMarketData, MCXDataStatus, MCXTick } from './types';
import { MCX_APPROVED_CONTRACTS } from './types';
import { loadMCXInstruments, getMCXContractSpec, MCX_CONTRACT_SPECS } from './instrument-master';
import { getMCXSession, getMCXSessionLabel } from './session';

// ── Cache ──
const quoteCache = new Map<MCXCommodity, { quote: MCXQuote; ts: number }>();
const QUOTE_CACHE_TTL = 5000; // 5 seconds
let lastMarketData: MCXMarketData | null = null;
let lastMarketDataTs = 0;

// ── Fetch single MCX quote from Motilal ──
async function fetchMCXQuoteFromMotilal(
  symbol: MCXCommodity,
  token: string
): Promise<MCXQuote | null> {
  const instruments = await loadMCXInstruments();
  const instrument = instruments.get(symbol);
  if (!instrument || instrument.token === 0) {
    return createUnavailableQuote(symbol, 'MOAPI');
  }

  try {
    const ltpData = await fetchLTP('MCX', instrument.token, token);
    if (!ltpData) {
      return createUnavailableQuote(symbol, 'MOAPI');
    }

    const spec = MCX_CONTRACT_SPECS[symbol];
    const prevClose = ltpData.ltp - ltpData.change;
    const changePercent = prevClose > 0 ? (ltpData.change / prevClose) * 100 : 0;

    return {
      symbol,
      exchange: 'MCX',
      assetClass: 'COMMODITY',
      ltp: ltpData.ltp || null,
      open: null, // Motilal LTP endpoint doesn't provide OHLC
      high: null,
      low: null,
      previousClose: prevClose || null,
      change: ltpData.change || null,
      changePercent: changePercent || null,
      volume: null,
      openInterest: null,
      changeInOI: null,
      bid: null,
      ask: null,
      bidQty: null,
      askQty: null,
      timestamp: new Date().toISOString(),
      dataStatus: ltpData.ltp > 0 ? 'LIVE' : 'DATA_UNAVAILABLE',
      dataSource: 'MOAPI',
      lotSize: instrument.lotSize || spec?.lotSize || 0,
      tickSize: spec?.tickSize || 1,
      expiry: instrument.expiry,
    };
  } catch {
    return createUnavailableQuote(symbol, 'MOAPI');
  }
}

// ── Fetch batch MCX quotes from Motilal ──
async function fetchMCXBatchFromMotilal(
  symbols: MCXCommodity[],
  token: string
): Promise<Map<MCXCommodity, MCXQuote>> {
  const results = new Map<MCXCommodity, MCXQuote>();
  const instruments = await loadMCXInstruments();

  // Build scrip list for multi-LTP
  const scrips: Array<{ exchange: string; scripcode: number }> = [];
  const symbolByToken = new Map<number, MCXCommodity>();

  for (const sym of symbols) {
    const inst = instruments.get(sym);
    if (inst && inst.token > 0) {
      scrips.push({ exchange: 'MCX', scripcode: inst.token });
      symbolByToken.set(inst.token, sym);
    }
  }

  if (scrips.length === 0) return results;

  try {
    const ltpMap = await fetchMultiLTP(scrips, token);

    for (const [scripcode, ltpData] of ltpMap) {
      const sym = symbolByToken.get(scripcode);
      if (!sym) continue;

      const spec = MCX_CONTRACT_SPECS[sym];
      const inst = instruments.get(sym);
      const prevClose = ltpData.ltp - ltpData.change;
      const changePercent = prevClose > 0 ? (ltpData.change / prevClose) * 100 : 0;

      results.set(sym, {
        symbol: sym,
        exchange: 'MCX',
        assetClass: 'COMMODITY',
        ltp: ltpData.ltp || null,
        open: null,
        high: null,
        low: null,
        previousClose: prevClose || null,
        change: ltpData.change || null,
        changePercent: changePercent || null,
        volume: null,
        openInterest: null,
        changeInOI: null,
        bid: null,
        ask: null,
        bidQty: null,
        askQty: null,
        timestamp: new Date().toISOString(),
        dataStatus: ltpData.ltp > 0 ? 'LIVE' : 'DATA_UNAVAILABLE',
        dataSource: 'MOAPI',
        lotSize: inst?.lotSize || spec?.lotSize || 0,
        tickSize: spec?.tickSize || 1,
        expiry: inst?.expiry || '',
      });
    }
  } catch {
    // Motilal batch failed — return unavailable quotes
  }

  // Fill in missing symbols with unavailable
  for (const sym of symbols) {
    if (!results.has(sym)) {
      results.set(sym, createUnavailableQuote(sym, 'MOAPI'));
    }
  }

  return results;
}

// ── Yahoo Finance mapping: which MCX symbols share which Yahoo ticker ──
const MCX_TO_YAHOO: Record<MCXCommodity, string> = {
  CRUDEOIL: 'CL=F', CRUDEOILM: 'CL=F',
  NATURALGAS: 'NG=F', NATGASMINI: 'NG=F',
  GOLD: 'GC=F', GOLDM: 'GC=F', GOLDGUINEA: 'GC=F',
  SILVER: 'SI=F', SILVERM: 'SI=F', SILVERMIC: 'SI=F',
};

// Reverse map: Yahoo ticker → MCX symbols
const YAHOO_TO_MCX: Record<string, MCXCommodity[]> = {};
for (const [mcx, yahoo] of Object.entries(MCX_TO_YAHOO)) {
  if (!YAHOO_TO_MCX[yahoo]) YAHOO_TO_MCX[yahoo] = [];
  YAHOO_TO_MCX[yahoo].push(mcx as MCXCommodity);
}

// ── Batch fetch ALL MCX quotes from Yahoo in ONE request ──
async function fetchAllMCXFromYahoo(): Promise<Map<MCXCommodity, MCXQuote>> {
  const results = new Map<MCXCommodity, MCXQuote>();
  const uniqueYahooTickers = [...new Set(Object.values(MCX_TO_YAHOO))]; // CL=F, NG=F, GC=F, SI=F

  // Fetch each unique ticker via v8/chart endpoint (4 requests total)
  const fetchPromises = uniqueYahooTickers.map(async (yahooSym) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=1d&interval=1d`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) return { yahooSym, data: null };
      const json = await res.json();
      return { yahooSym, data: json?.chart?.result?.[0] || null };
    } catch {
      return { yahooSym, data: null };
    }
  });

  const fetched = await Promise.all(fetchPromises);

  for (const { yahooSym, data } of fetched) {
    if (!data?.meta?.regularMarketPrice) continue;
    const meta = data.meta;
    const ltp = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || ltp;
    const change = ltp - prevClose;
    const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
    const mcxSymbols = YAHOO_TO_MCX[yahooSym] || [];

    for (const mcxSym of mcxSymbols) {
      const spec = MCX_CONTRACT_SPECS[mcxSym];
      const q = data.indicators?.quote?.[0];
      results.set(mcxSym, {
        symbol: mcxSym,
        exchange: 'MCX',
        assetClass: 'COMMODITY',
        ltp,
        open: q?.open?.[0] ?? null,
        high: q?.high?.[0] ?? null,
        low: q?.low?.[0] ?? null,
        previousClose: prevClose,
        change,
        changePercent,
        volume: meta.regularMarketVolume ?? q?.volume?.[0] ?? null,
        openInterest: null,
        changeInOI: null,
        bid: null,
        ask: null,
        bidQty: null,
        askQty: null,
        timestamp: new Date().toISOString(),
        dataStatus: 'DELAYED',
        dataSource: 'YAHOO',
        lotSize: spec?.lotSize || 0,
        tickSize: spec?.tickSize || 1,
        expiry: '',
      });
    }
  }

  return results;
}

// ── Fallback: single-symbol Yahoo fetch (kept for edge cases) ──
async function fetchMCXFromYahoo(
  symbol: MCXCommodity
): Promise<MCXQuote | null> {
  const yahooSym = MCX_TO_YAHOO[symbol];
  if (!yahooSym) return null;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=1d&interval=1d`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result?.meta?.regularMarketPrice) return null;

    const meta = result.meta;
    const ltp = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || ltp;
    const spec = MCX_CONTRACT_SPECS[symbol];

    return {
      symbol,
      exchange: 'MCX',
      assetClass: 'COMMODITY',
      ltp,
      open: result.indicators?.quote?.[0]?.open?.[0] ?? null,
      high: result.indicators?.quote?.[0]?.high?.[0] ?? null,
      low: result.indicators?.quote?.[0]?.low?.[0] ?? null,
      previousClose: prevClose,
      change: ltp - prevClose,
      changePercent: prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : 0,
      volume: meta.regularMarketVolume ?? null,
      openInterest: null,
      changeInOI: null,
      bid: null,
      ask: null,
      bidQty: null,
      askQty: null,
      timestamp: new Date().toISOString(),
      dataStatus: 'DELAYED',
      dataSource: 'YAHOO',
      lotSize: spec?.lotSize || 0,
      tickSize: spec?.tickSize || 1,
      expiry: '',
    };
  } catch {
    return null;
  }
}

// ── Create unavailable quote ──
function createUnavailableQuote(symbol: MCXCommodity, source: 'MOAPI' | 'BREEZE' | 'YAHOO'): MCXQuote {
  const spec = MCX_CONTRACT_SPECS[symbol];
  return {
    symbol,
    exchange: 'MCX',
    assetClass: 'COMMODITY',
    ltp: null,
    open: null,
    high: null,
    low: null,
    previousClose: null,
    change: null,
    changePercent: null,
    volume: null,
    openInterest: null,
    changeInOI: null,
    bid: null,
    ask: null,
    bidQty: null,
    askQty: null,
    timestamp: new Date().toISOString(),
    dataStatus: 'DATA_UNAVAILABLE',
    dataSource: source,
    lotSize: spec?.lotSize || 0,
    tickSize: spec?.tickSize || 1,
    expiry: '',
  };
}

// ── Main: Fetch all MCX quotes (Motilal → Yahoo fallback) ──
export async function fetchAllMCXQuotes(): Promise<Map<MCXCommodity, MCXQuote>> {
  const now = Date.now();

  // Check cache freshness
  const cachedQuotes = new Map<MCXCommodity, MCXQuote>();
  let uncachedSymbols: MCXCommodity[] = [];

  for (const sym of MCX_APPROVED_CONTRACTS) {
    const cached = quoteCache.get(sym);
    if (cached && now - cached.ts < QUOTE_CACHE_TTL) {
      cachedQuotes.set(sym, cached.quote);
    } else {
      uncachedSymbols.push(sym);
    }
  }

  if (cachedQuotes.size === MCX_APPROVED_CONTRACTS.length) {
    return cachedQuotes;
  }

  // Try Motilal API first
  const token = getSessionToken();
  if (token && uncachedSymbols.length > 0) {
    const motilalQuotes = await fetchMCXBatchFromMotilal(uncachedSymbols, token);
    for (const [sym, quote] of motilalQuotes) {
      if (quote.dataStatus !== 'DATA_UNAVAILABLE') {
        cachedQuotes.set(sym, quote);
        quoteCache.set(sym, { quote, ts: now });
      }
    }
    uncachedSymbols = uncachedSymbols.filter(s => !cachedQuotes.has(s));
  }

  // Yahoo fallback: fetch ALL 4 unique tickers in ONE batch request
  if (uncachedSymbols.length > 0) {
    const yahooQuotes = await fetchAllMCXFromYahoo();
    for (const [sym, quote] of yahooQuotes) {
      if (uncachedSymbols.includes(sym)) {
        cachedQuotes.set(sym, quote);
        quoteCache.set(sym, { quote, ts: now });
      }
    }
  }

  // Fill any remaining with unavailable
  for (const sym of MCX_APPROVED_CONTRACTS) {
    if (!cachedQuotes.has(sym)) {
      const unavailable = createUnavailableQuote(sym, 'NONE');
      cachedQuotes.set(sym, unavailable);
    }
  }

  return cachedQuotes;
}

// ── Get full MCX market data (quotes + instruments + session + health) ──
export async function fetchMCXMarketData(): Promise<MCXMarketData> {
  const now = Date.now();
  if (lastMarketData && now - lastMarketDataTs < QUOTE_CACHE_TTL) {
    return lastMarketData;
  }

  const [quotes, instruments] = await Promise.all([
    fetchAllMCXQuotes(),
    loadMCXInstruments(),
  ]);

  const session = getMCXSession();

  // Calculate data health
  const moapiQuotes = [...quotes.values()].filter(q => q.dataSource === 'MOAPI' && q.dataStatus === 'LIVE');
  const lastQuote = [...quotes.values()].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
  const lastTickAge = lastQuote ? (now - new Date(lastQuote.timestamp).getTime()) / 1000 : Infinity;

  const dataHealth: MCXMarketData['dataHealth'] = {
    moapi: getSessionToken() ? 'CONNECTED' : 'DISCONNECTED',
    breeze: 'DISCONNECTED', // Breeze doesn't support MCX
    websocket: 'DISCONNECTED', // TODO: implement WebSocket streaming
    lastTickAge: Math.round(lastTickAge),
    status: lastTickAge < 30 ? 'LIVE' : lastTickAge < 300 ? 'DELAYED' : lastTickAge < 600 ? 'STALE' : 'DATA_UNAVAILABLE',
  };

  lastMarketData = {
    quotes,
    instruments,
    session: session.state,
    lastUpdate: new Date().toISOString(),
    dataHealth,
  };
  lastMarketDataTs = now;

  return lastMarketData;
}

// ── Get single MCX quote ──
export async function fetchMCXQuote(symbol: MCXCommodity): Promise<MCXQuote> {
  const cached = quoteCache.get(symbol);
  if (cached && Date.now() - cached.ts < QUOTE_CACHE_TTL) {
    return cached.quote;
  }

  const token = getSessionToken();
  if (token) {
    const quote = await fetchMCXQuoteFromMotilal(symbol, token);
    if (quote && quote.dataStatus !== 'DATA_UNAVAILABLE') {
      quoteCache.set(symbol, { quote, ts: Date.now() });
      return quote;
    }
  }

  const yahooQuote = await fetchMCXFromYahoo(symbol);
  if (yahooQuote) {
    quoteCache.set(symbol, { quote: yahooQuote, ts: Date.now() });
    return yahooQuote;
  }

  return createUnavailableQuote(symbol, 'NONE');
}
