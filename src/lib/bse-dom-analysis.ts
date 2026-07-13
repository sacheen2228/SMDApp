// BSE DOM Analysis for SENSEX, BANKEX
// Fetches option chain data from BSE API and analyzes OI buildup

import { getBSEOptionChain, getBSEExpiryDates, getBSEIndexData, isBSEIndex } from '@/lib/bse-api';

export interface BSEDOMStrike {
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
  } | null;
}

export interface BSEDOMSummary {
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
  strikes: BSEDOMStrike[];
  resistance: number[];
  support: number[];
  unusualBuildup: {
    strike: number;
    type: 'CE' | 'PE';
    oiChg: number;
    volume: number;
    ltp: number;
    interpretation: string;
  }[];
}

function parseNSEOptionChain(data: any): BSEDOMStrike[] {
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
      } : null,
    }));
}

function calculateMaxPain(strikes: BSEDOMStrike[]): number {
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

function calculatePCR(strikes: BSEDOMStrike[]): number {
  const totalCallOI = strikes.reduce((sum, s) => sum + (s.ce?.oi || 0), 0);
  const totalPutOI = strikes.reduce((sum, s) => sum + (s.pe?.oi || 0), 0);
  return totalCallOI > 0 ? totalPutOI / totalCallOI : 1;
}

function findResistanceSupport(strikes: BSEDOMStrike[], spot: number): { resistance: number[]; support: number[] } {
  const resistance = strikes
    .filter(s => s.strike > spot && s.ce && s.ce.oi > 0)
    .sort((a, b) => (b.ce?.oi || 0) - (a.ce?.oi || 0))
    .slice(0, 5)
    .map(s => s.strike);
  
  const support = strikes
    .filter(s => s.strike < spot && s.pe && s.pe.oi > 0)
    .sort((a, b) => (b.pe?.oi || 0) - (a.pe?.oi || 0))
    .slice(0, 5)
    .map(s => s.strike);
  
  return { resistance, support };
}

function findUnusualBuildup(strikes: BSEDOMStrike[], spot: number): BSEDOMSummary['unusualBuildup'] {
  const results: BSEDOMSummary['unusualBuildup'] = [];
  const threshold = 50000;
  
  for (const s of strikes) {
    if (s.ce && s.ce.oiChg > threshold) {
      results.push({
        strike: s.strike,
        type: 'CE',
        oiChg: s.ce.oiChg,
        volume: s.ce.volume,
        ltp: s.ce.ltp,
        interpretation: s.strike > spot ? 'Call Writing (Resistance)' : 'Call Unwinding',
      });
    }
    if (s.pe && s.pe.oiChg > threshold) {
      results.push({
        strike: s.strike,
        type: 'PE',
        oiChg: s.pe.oiChg,
        volume: s.pe.volume,
        ltp: s.pe.ltp,
        interpretation: s.strike < spot ? 'Put Writing (Support)' : 'Put Unwinding',
      });
    }
    if (s.ce && s.ce.oiChg < -threshold) {
      results.push({
        strike: s.strike,
        type: 'CE',
        oiChg: s.ce.oiChg,
        volume: s.ce.volume,
        ltp: s.ce.ltp,
        interpretation: 'Call Unwinding (Short Covering)',
      });
    }
    if (s.pe && s.pe.oiChg < -threshold) {
      results.push({
        strike: s.strike,
        type: 'PE',
        oiChg: s.pe.oiChg,
        volume: s.pe.volume,
        ltp: s.pe.ltp,
        interpretation: 'Put Unwinding (Short Covering)',
      });
    }
  }
  
  return results.sort((a, b) => Math.abs(b.oiChg) - Math.abs(a.oiChg)).slice(0, 15);
}

export async function runBSEDOMAnalysis(): Promise<BSEDOMSummary[]> {
  const indices = ['SENSEX', 'BANKEX'];
  const results: BSEDOMSummary[] = [];
  
  for (const symbol of indices) {
    try {
      const expiries = await getBSEExpiryDates(symbol);
      if (!expiries.length) continue;
      
      const nearestExpiry = expiries[0];
      const bseData = await getBSEOptionChain(symbol, nearestExpiry);
      if (!bseData?.data?.length) continue;
      
      // Also get spot price from index data
      const indexData = await getBSEIndexData(symbol);
      const spot = indexData?.spotPrice || bseData.spotPrice;
      
      // Convert BSE data to our format
      const strikes: BSEDOMStrike[] = bseData.data.map(row => ({
        strike: row.strike,
        ce: row.ce ? {
          oi: row.ce.oi || 0,
          oiChg: row.ce.oiChg || 0,
          volume: row.ce.volume || 0,
          ltp: row.ce.ltp || 0,
          iv: row.ce.iv || 0,
          bid: row.ce.bid || 0,
          ask: row.ce.ask || 0,
          bidQty: row.ce.bid || 0, // BSE doesn't provide separate bid qty
          askQty: row.ce.ask || 0,
        } : null,
        pe: row.pe ? {
          oi: row.pe.oi || 0,
          oiChg: row.pe.oiChg || 0,
          volume: row.pe.volume || 0,
          ltp: row.pe.ltp || 0,
          iv: row.pe.iv || 0,
          bid: row.pe.bid || 0,
          ask: row.pe.ask || 0,
          bidQty: row.pe.bid || 0,
          askQty: row.pe.ask || 0,
        } : null,
      }));
      
      const { resistance, support } = findResistanceSupport(strikes, spot);
      const unusualBuildup = findUnusualBuildup(strikes, spot);
      const maxPain = calculateMaxPain(strikes);
      const pcr = calculatePCR(strikes);
      
      const totalCallOI = strikes.reduce((sum, s) => sum + (s.ce?.oi || 0), 0);
      const totalPutOI = strikes.reduce((sum, s) => sum + (s.pe?.oi || 0), 0);
      const totalCallVol = strikes.reduce((sum, s) => sum + (s.ce?.volume || 0), 0);
      const totalPutVol = strikes.reduce((sum, s) => sum + (s.pe?.volume || 0), 0);
      
      // Find ATM
      const allStrikes = [...new Set(strikes.map(s => s.strike))].sort((a, b) => a - b);
      let atmStrike = allStrikes[0];
      let minDiff = Infinity;
      for (const s of allStrikes) {
        const diff = Math.abs(s - spot);
        if (diff < minDiff) { minDiff = diff; atmStrike = s; }
      }
      
      results.push({
        symbol,
        spot,
        atmStrike,
        timestamp: new Date().toISOString(),
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
      });
      
    } catch (e: any) {
      console.error(`[BSE DOM] Error for ${symbol}:`, e.message);
    }
  }
  
  return results;
}

export async function getSingleBSEDOM(symbol: string): Promise<BSEDOMSummary | null> {
  if (!isBSEIndex(symbol)) return null;
  
  try {
    const expiries = await getBSEExpiryDates(symbol);
    if (!expiries.length) return null;
    
    const nearestExpiry = expiries[0];
    const bseData = await getBSEOptionChain(symbol, nearestExpiry);
    if (!bseData?.data?.length) return null;
    
    const indexData = await getBSEIndexData(symbol);
    const spot = indexData?.spotPrice || bseData.spotPrice;
    
    const strikes: BSEDOMStrike[] = bseData.data.map(row => ({
      strike: row.strike,
      ce: row.ce ? {
        oi: row.ce.oi || 0,
        oiChg: row.ce.oiChg || 0,
        volume: row.ce.volume || 0,
        ltp: row.ce.ltp || 0,
        iv: row.ce.iv || 0,
        bid: row.ce.bid || 0,
        ask: row.ce.ask || 0,
        bidQty: row.ce.bid || 0,
        askQty: row.ce.ask || 0,
      } : null,
      pe: row.pe ? {
        oi: row.pe.oi || 0,
        oiChg: row.pe.oiChg || 0,
        volume: row.pe.volume || 0,
        ltp: row.pe.ltp || 0,
        iv: row.pe.iv || 0,
        bid: row.pe.bid || 0,
        ask: row.pe.ask || 0,
        bidQty: row.pe.bid || 0,
        askQty: row.pe.ask || 0,
      } : null,
    }));
    
    const { resistance, support } = findResistanceSupport(strikes, spot);
    const unusualBuildup = findUnusualBuildup(strikes, spot);
    const maxPain = calculateMaxPain(strikes);
    const pcr = calculatePCR(strikes);
    
    const totalCallOI = strikes.reduce((sum, s) => sum + (s.ce?.oi || 0), 0);
    const totalPutOI = strikes.reduce((sum, s) => sum + (s.pe?.oi || 0), 0);
    const totalCallVol = strikes.reduce((sum, s) => sum + (s.ce?.volume || 0), 0);
    const totalPutVol = strikes.reduce((sum, s) => sum + (s.pe?.volume || 0), 0);
    
    const allStrikes = [...new Set(strikes.map(s => s.strike))].sort((a, b) => a - b);
    let atmStrike = allStrikes[0];
    let minDiff = Infinity;
    for (const s of allStrikes) {
      const diff = Math.abs(s - spot);
      if (diff < minDiff) { minDiff = diff; atmStrike = s; }
    }
    
    return {
      symbol,
      spot,
      atmStrike,
      timestamp: new Date().toISOString(),
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
    };
  } catch (e: any) {
    console.error(`[BSE DOM] Error for ${symbol}:`, e.message);
    return null;
  }
}