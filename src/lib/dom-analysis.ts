// DOM Analysis for NSE Equity Derivatives
// Fetches option chain data for all F&O equities and identifies
// unusual OI buildup, max pain, support/resistance, DOM depth

import { NSEClient } from 'nse-bse-api/nse';

let nseClient: NSEClient | null = null;

function getClient(): NSEClient {
  if (!nseClient) {
    nseClient = new NSEClient('./downloads', { timeout: 20000 });
  }
  return nseClient;
}

export interface DOMStrike {
  strike: number;
  ce: {
    oi: number;
    oiChg: number;
    volume: number;
    ltp: number;
    iv: number;
    bid: number;
    ask: number;
    bidQty: number;
    askQty: number;
    totalBuyQty: number;
    totalSellQty: number;
  } | null;
  pe: {
    oi: number;
    oiChg: number;
    volume: number;
    ltp: number;
    iv: number;
    bid: number;
    ask: number;
    bidQty: number;
    askQty: number;
    totalBuyQty: number;
    totalSellQty: number;
  } | null;
}

export interface DOMSummary {
  symbol: string;
  spot: number;
  atmStrike: number;
  timestamp: string;
  maxPain: number;
  pcr: number;
  totalCallOI: number;
  totalPutOI: number;
  totalCallVol: number;
  totalPutVol: number;
  strikes: DOMStrike[];
  // DOM Analysis
  resistance: number[];  // High CE OI + OI buildup
  support: number[];     // High PE OI + OI buildup
  unusualBuildup: {
    strike: number;
    type: 'CE' | 'PE';
    oiChg: number;
    oi: number;
    interpretation: string;
  }[];
  domDepth: {
    strike: number;
    ceBidQty: number;
    ceAskQty: number;
    peBidQty: number;
    peAskQty: number;
    bidAskRatio: number;
  }[];
}

async function fetchFNOSymbols(): Promise<string[]> {
  const client = getClient();
  const lots = await client.fnoLots();
  // Filter out indices, keep only equities
  const indices = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50'];
  return Object.keys(lots).filter(s => !indices.includes(s));
}

function parseNSEOptionChain(data: any): DOMStrike[] {
  if (!data?.records?.data) return [];
  
  return data.records.data
    .filter((r: any) => r.CE || r.PE)
    .map((r: any) => ({
      strike: r.strikePrice,
      ce: r.CE ? {
        oi: r.CE.openInterest || 0,
        oiChg: r.CE.changeinOpenInterest || 0,
        volume: r.CE.totalTradedVolume || 0,
        ltp: r.CE.lastPrice || 0,
        iv: r.CE.impliedVolatility || 0,
        bid: r.CE.buyPrice1 || 0,
        ask: r.CE.sellPrice1 || 0,
        bidQty: r.CE.buyQuantity1 || 0,
        askQty: r.CE.sellQuantity1 || 0,
        totalBuyQty: r.CE.totalBuyQuantity || 0,
        totalSellQty: r.CE.totalSellQuantity || 0,
      } : null,
      pe: r.PE ? {
        oi: r.PE.openInterest || 0,
        oiChg: r.PE.changeinOpenInterest || 0,
        volume: r.PE.totalTradedVolume || 0,
        ltp: r.PE.lastPrice || 0,
        iv: r.PE.impliedVolatility || 0,
        bid: r.PE.buyPrice1 || 0,
        ask: r.PE.sellPrice1 || 0,
        bidQty: r.PE.buyQuantity1 || 0,
        askQty: r.PE.sellQuantity1 || 0,
        totalBuyQty: r.PE.totalBuyQuantity || 0,
        totalSellQty: r.PE.totalSellQuantity || 0,
      } : null,
    }));
}

function calculateMaxPain(strikes: DOMStrike[]): number {
  let maxPain = 0;
  let minLoss = Infinity;
  
  for (const s of strikes) {
    let totalLoss = 0;
    for (const k of strikes) {
      if (k.ce) totalLoss += k.ce.oi * Math.max(0, k.strike - s.strike);
      if (k.pe) totalLoss += k.pe.oi * Math.max(0, s.strike - k.strike);
    }
    if (totalLoss < minLoss) {
      minLoss = totalLoss;
      maxPain = s.strike;
    }
  }
  return maxPain;
}

function calculatePCR(strikes: DOMStrike[]): number {
  const totalCallOI = strikes.reduce((sum, s) => sum + (s.ce?.oi || 0), 0);
  const totalPutOI = strikes.reduce((sum, s) => sum + (s.pe?.oi || 0), 0);
  return totalCallOI > 0 ? totalPutOI / totalCallOI : 1;
}

function findResistanceSupport(strikes: DOMStrike[], spot: number): { resistance: number[]; support: number[] } {
  const resistance: number[] = [];
  const support: number[] = [];
  
  // Resistance: strikes above spot with high CE OI + positive OI change (call writing)
  const ceStrikes = strikes
    .filter(s => s.strike > spot && s.ce && s.ce.oi > 0)
    .sort((a, b) => (b.ce?.oi || 0) + (b.ce?.oiChg || 0) - (a.ce?.oi || 0) - (a.ce?.oiChg || 0))
    .slice(0, 3)
    .map(s => s.strike);
  
  // Support: strikes below spot with high PE OI + positive OI change (put writing)
  const peStrikes = strikes
    .filter(s => s.strike < spot && s.pe && s.pe.oi > 0)
    .sort((a, b) => (b.pe?.oi || 0) + (b.pe?.oiChg || 0) - (a.pe?.oi || 0) - (a.pe?.oiChg || 0))
    .slice(0, 3)
    .map(s => s.strike);
  
  return { resistance: ceStrikes, support: peStrikes };
}

function findUnusualBuildup(strikes: DOMStrike[], spot: number): DOMSummary['unusualBuildup'] {
  const results: DOMSummary['unusualBuildup'] = [];
  const threshold = 5000; // Minimum OI change to flag
  
  for (const s of strikes) {
    // Call writing (resistance): CE OI increase
    if (s.ce && s.ce.oiChg > threshold) {
      results.push({
        strike: s.strike,
        type: 'CE',
        oiChg: s.ce.oiChg,
        oi: s.ce.oi,
        interpretation: s.strike > spot ? 'Call writing (resistance)' : 'Call unwinding / Short covering',
      });
    }
    // Put writing (support): PE OI increase
    if (s.pe && s.pe.oiChg > threshold) {
      results.push({
        strike: s.strike,
        type: 'PE',
        oiChg: s.pe.oiChg,
        oi: s.pe.oi,
        interpretation: s.strike < spot ? 'Put writing (support)' : 'Put unwinding / Short covering',
      });
    }
    // Call unwinding (bearish): CE OI decrease with price up
    if (s.ce && s.ce.oiChg < -threshold) {
      results.push({
        strike: s.strike,
        type: 'CE',
        oiChg: s.ce.oiChg,
        oi: s.ce.oi,
        interpretation: 'Call unwinding (short covering / bearish)',
      });
    }
    // Put unwinding (bullish): PE OI decrease with price down
    if (s.pe && s.pe.oiChg < -threshold) {
      results.push({
        strike: s.strike,
        type: 'PE',
        oiChg: s.pe.oiChg,
        oi: s.pe.oi,
        interpretation: 'Put unwinding (short covering / bullish)',
      });
    }
  }
  
  return results.sort((a, b) => Math.abs(b.oiChg) - Math.abs(a.oiChg)).slice(0, 10);
}

function analyzeDOMDepth(strikes: DOMStrike[], spot: number): DOMSummary['domDepth'] {
  return strikes
    .filter(s => Math.abs(s.strike - spot) <= 500) // Within ~500 points of spot
    .map(s => ({
      strike: s.strike,
      ceBidQty: s.ce?.totalBuyQty || 0,
      ceAskQty: s.ce?.totalSellQty || 0,
      peBidQty: s.pe?.totalBuyQty || 0,
      peAskQty: s.pe?.totalSellQty || 0,
      bidAskRatio: s.ce && s.pe 
        ? (s.ce.totalBuyQty + s.pe.totalBuyQty) / Math.max(1, s.ce.totalSellQty + s.pe.totalSellQty)
        : 0,
    }))
    .sort((a, b) => b.bidAskRatio - a.bidAskRatio)
    .slice(0, 10);
}

export async function runDOMAnalysis(): Promise<DOMSummary[]> {
  const client = getClient();
  const symbols = await fetchFNOSymbols();
  const results: DOMSummary[] = [];
  
  // Process in batches to avoid rate limits
  const batchSize = 5;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    await Promise.all(batch.map(async (symbol) => {
      try {
        const data = await client.optionChainV3({ symbol, type: 'Equity' });
        if (!data?.records?.data?.length) return;
        
        const strikes = parseNSEOptionChain(data);
        const spot = data.records.underlyingValue;
        const atmStrike = data.records.strikePrices?.find((s: number) => s >= spot) || spot;
        
        const { resistance, support } = findResistanceSupport(strikes, spot);
        const unusualBuildup = findUnusualBuildup(strikes, spot);
        const domDepth = analyzeDOMDepth(strikes, spot);
        const maxPain = calculateMaxPain(strikes);
        const pcr = calculatePCR(strikes);
        
        const totalCallOI = strikes.reduce((sum, s) => sum + (s.ce?.oi || 0), 0);
        const totalPutOI = strikes.reduce((sum, s) => sum + (s.pe?.oi || 0), 0);
        const totalCallVol = strikes.reduce((sum, s) => sum + (s.ce?.volume || 0), 0);
        const totalPutVol = strikes.reduce((sum, s) => sum + (s.pe?.volume || 0), 0);
        
        results.push({
          symbol,
          spot,
          atmStrike,
          timestamp: data.records.timestamp,
          maxPain,
          pcr,
          totalCallOI,
          totalPutOI,
          totalCallVol,
          totalPutVol,
          strikes,
          resistance,
          support,
          unusualBuildup,
          domDepth,
        });
      } catch (e: any) {
        console.error(`[DOM] Error for ${symbol}:`, e.message);
      }
    }));
    
    // Small delay between batches
    if (i + batchSize < symbols.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  return results;
}

export async function getSingleStockDOM(symbol: string): Promise<DOMSummary | null> {
  const client = getClient();
  try {
    const data = await client.optionChainV3({ symbol, type: 'Equity' });
    if (!data?.records?.data?.length) return null;
    
    const strikes = parseNSEOptionChain(data);
    const spot = data.records.underlyingValue;
    const atmStrike = data.records.strikePrices?.find((s: number) => s >= spot) || spot;
    
    const { resistance, support } = findResistanceSupport(strikes, spot);
    const unusualBuildup = findUnusualBuildup(strikes, spot);
    const domDepth = analyzeDOMDepth(strikes, spot);
    const maxPain = calculateMaxPain(strikes);
    const pcr = calculatePCR(strikes);
    
    const totalCallOI = strikes.reduce((sum, s) => sum + (s.ce?.oi || 0), 0);
    const totalPutOI = strikes.reduce((sum, s) => sum + (s.pe?.oi || 0), 0);
    const totalCallVol = strikes.reduce((sum, s) => sum + (s.ce?.volume || 0), 0);
    const totalPutVol = strikes.reduce((sum, s) => sum + (s.pe?.volume || 0), 0);
    
    return {
      symbol,
      spot,
      atmStrike,
      timestamp: data.records.timestamp,
      maxPain,
      pcr,
      totalCallOI,
      totalPutOI,
      totalCallVol,
      totalPutVol,
      strikes,
      resistance,
      support,
      unusualBuildup,
      domDepth,
    };
  } catch (e: any) {
    console.error(`[DOM] Error for ${symbol}:`, e.message);
    return null;
  }
}