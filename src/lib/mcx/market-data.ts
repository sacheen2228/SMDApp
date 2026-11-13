// MCX Commodity Module — Market Data Fetcher
// Primary: Motilal Oswal API → Secondary: Yahoo Finance
// Critical: Never fabricate data. Return null/UNAVAILABLE when unavailable.

import { getLTP, getMultiLTP, getScrips, getSessionToken } from '@/lib/motilal/auth';
import { getLTP as fetchLTP, getMultiLTP as fetchMultiLTP } from '@/lib/motilal/market';
import type { MCXCommodity, MCXQuote, MCXMarketData, MCXDataStatus, MCXTick } from './types';
import { MCX_APPROVED_CONTRACTS } from './types';
import { loadMCXInstruments, getMCXContractSpec, MCX_CONTRACT_SPECS } from './instrument-master';
import { getMCXSession, getMCXSessionLabel } from './session';
import { scrapeMCXPrices } from './nse-commodity-scraper';

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



// ── Map an MCX-India website scraped price onto a quote ──
function buildWebsiteQuote(
  sym: MCXCommodity,
  price: { ltp: number; open?: number; high?: number; low?: number; prevClose?: number; change?: number; changePct?: number; volume?: number; oi?: number; timestamp: string }
): MCXQuote {
  const spec = MCX_CONTRACT_SPECS[sym];
  return {
    symbol: sym,
    exchange: 'MCX',
    assetClass: 'COMMODITY',
    ltp: price.ltp,
    open: price.open || null,
    high: price.high || null,
    low: price.low || null,
    previousClose: price.prevClose || null,
    change: price.change || null,
    changePercent: price.changePct || null,
    volume: price.volume || null,
    openInterest: price.oi || null,
    changeInOI: null,
    bid: null,
    ask: null,
    bidQty: null,
    askQty: null,
    timestamp: price.timestamp,
    dataStatus: 'LIVE',
    dataSource: 'MCX_WEBSITE', // real provenance — NOT Motilal
    lotSize: spec?.lotSize || 0,
    tickSize: spec?.tickSize || 1,
    expiry: '',
  };
}

// ── Create unavailable quote ──
function createUnavailableQuote(symbol: MCXCommodity, source: MCXQuote['dataSource']): MCXQuote {
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

  // Tier 2: MCX India website scraper (free, no auth needed)
  if (uncachedSymbols.length > 0) {
    try {
      const scraped = await scrapeMCXPrices();
      for (const price of scraped) {
        const sym = price.symbol as MCXCommodity;
        if (uncachedSymbols.includes(sym) && price.ltp > 0) {
          const quote = buildWebsiteQuote(sym, price);
          cachedQuotes.set(sym, quote);
          quoteCache.set(sym, { quote, ts: now });
        }
      }
      uncachedSymbols = uncachedSymbols.filter(s => !cachedQuotes.has(s));
    } catch {
      // MCX scraper failed — no more tiers; missing symbols go to DATA_UNAVAILABLE below
    }
  }

  // After tiers, fill any MCX-approved symbols still missing with NONE (no made-up data).
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

  // Calculate data health — based on ACTUAL data sources, not token existence
  const allQuotes = [...quotes.values()];
  const moapiQuotes = allQuotes.filter(q => q.dataSource === 'MOAPI' && q.dataStatus === 'LIVE');
  const websiteQuotes = allQuotes.filter(q => q.dataSource === 'MCX_WEBSITE' && q.dataStatus === 'LIVE');
  const liveQuotes = allQuotes.filter(q => q.dataStatus === 'LIVE');
  const lastQuote = allQuotes.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
  const lastTickAge = lastQuote ? (now - new Date(lastQuote.timestamp).getTime()) / 1000 : Infinity;

  // Determine primary source based on what's actually providing data
  const primarySource = moapiQuotes.length > 0 ? 'MOAPI'
    : websiteQuotes.length > 0 ? 'MCX_WEBSITE'
    : 'NONE';

  const dataHealth: MCXMarketData['dataHealth'] = {
    moapi: moapiQuotes.length > 0 ? `CONNECTED (${moapiQuotes.length}/${allQuotes.length})` : 'NO_DATA',
    mcxWebsite: websiteQuotes.length > 0 ? `CONNECTED (${websiteQuotes.length}/${allQuotes.length})` : 'NO_DATA',
    breeze: 'DISCONNECTED',
    breezeNote: 'Breeze has no MCX instrument support',
    websocket: 'DISCONNECTED', // no MCX streaming wired yet
    primarySource,
    lastTickAge: Number.isFinite(lastTickAge) ? Math.round(lastTickAge) : -1,
    status: liveQuotes.length > 0 ? 'LIVE'
      : lastTickAge < 300 ? 'DELAYED'
      : lastTickAge < 600 ? 'STALE'
      : 'DATA_UNAVAILABLE',
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

  // Tier 2: MCX India website scraper (same tier the batch path uses)
  try {
    const scraped = await scrapeMCXPrices();
    const price = scraped.find(p => p.symbol === symbol);
    if (price && price.ltp > 0) {
      const quote = buildWebsiteQuote(symbol, price);
      quoteCache.set(symbol, { quote, ts: Date.now() });
      return quote;
    }
  } catch {
    // website scrape failed — no more tiers
  }

  return createUnavailableQuote(symbol, 'NONE');
}
