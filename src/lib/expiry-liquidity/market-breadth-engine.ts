// ─── Market Breadth Engine ────────────────────────────────────────────
// Calculates comprehensive market breadth metrics from stock universe

import { MarketBreadthAnalysis } from './types';

interface MarketBreadthConfig {
  universe: string[];           // symbols to include
  emaPeriods: number[];         // [20, 50, 200]
  vwapDeviationThreshold: number; // % from VWAP
}

class MarketBreadthEngine {
  private config: MarketBreadthConfig = {
    universe: [],
    emaPeriods: [20, 50, 200],
    vwapDeviationThreshold: 0.5, // 0.5%
  };

  // ─── Calculate Breadth from Stock Data ──────────────────────────────
  calculate(stocks: Array<{
    symbol: string;
    ltp: number;
    changePct: number;
    volume: number;
    prevClose: number;
    dayHigh: number;
    dayLow: number;
    weekHigh52: number;
    weekLow52: number;
    ema20?: number;
    ema50?: number;
    ema200?: number;
    vwap?: number;
    sector: string;
  }>): any {
    if (stocks.length === 0) {
      return this.emptyResult();
    }

    const total = stocks.length;
    const advances = stocks.filter(s => s.changePct > 0).length;
    const declines = stocks.filter(s => s.changePct < 0).length;
    const unchanged = total - advances - declines;

    const adRatio = declines > 0 ? advances / declines : advances > 0 ? 100 : 1;

    // New 52W Highs/Lows
    const newHighs = stocks.filter(s => s.weekHigh52 > 0 && s.ltp >= s.weekHigh52 * 0.995).length;
    const newLows = stocks.filter(s => s.weekLow52 > 0 && s.ltp <= s.weekLow52 * 1.005).length;

    // Volume advancing/declining
    const volAdvancing = stocks.filter(s => s.changePct > 0).reduce((sum, s) => sum + s.volume, 0);
    const volDeclining = stocks.filter(s => s.changePct < 0).reduce((sum, s) => sum + s.volume, 0);
    const volRatio = volDeclining > 0 ? volAdvancing / volDeclining : volAdvancing > 0 ? 100 : 1;

    // % above EMAs
    const aboveEMA20 = stocks.filter(s => s.ema20 && s.ltp > s.ema20).length;
    const aboveEMA50 = stocks.filter(s => s.ema50 && s.ltp > s.ema50).length;
    const aboveEMA200 = stocks.filter(s => s.ema200 && s.ltp > s.ema200).length;

    // % above VWAP
    const aboveVWAP = stocks.filter(s => s.vwap && s.ltp > s.vwap).length;

    // Fresh day highs/lows
    const freshDayHighs = stocks.filter(s => Math.abs(s.ltp - s.dayHigh) / s.dayHigh < 0.003).length;
    const freshDayLows = stocks.filter(s => Math.abs(s.ltp - s.dayLow) / s.dayLow < 0.003).length;

    // Sector breadth
    const sectorMap = new Map<string, { advances: number; declines: number; total: number }>();
    for (const s of stocks) {
      if (!sectorMap.has(s.sector)) sectorMap.set(s.sector, { advances: 0, declines: 0, total: 0 });
      const sec = sectorMap.get(s.sector)!;
      sec.total++;
      if (s.changePct > 0) sec.advances++;
      else if (s.changePct < 0) sec.declines++;
    }

    // Breadth score
    const adScore = Math.min(100, Math.round((adRatio / 3) * 100));
    const volScore = volDeclining > 0 ? Math.min(100, Math.round((volAdvancing / volDeclining) * 50)) : 50;
    const emaScore = total > 0 ? Math.round(((aboveEMA20 + aboveEMA50 + aboveEMA200) / (3 * total)) * 100) : 50;
    const vwapScore = total > 0 ? Math.round((aboveVWAP / total) * 100) : 50;
    const highLowScore = total > 0 ? Math.round(((newHighs - newLows + total) / (2 * total)) * 100) : 50;

    const breadthScore = Math.round(
      adScore * 0.3 +
      volScore * 0.2 +
      emaScore * 0.2 +
      vwapScore * 0.15 +
      highLowScore * 0.15
    );

    // Label
    let label: 'STRONG_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONG_BEARISH';
    if (breadthScore >= 75) label = 'STRONG_BULLISH';
    else if (breadthScore >= 60) label = 'BULLISH';
    else if (breadthScore >= 40) label = 'NEUTRAL';
    else if (breadthScore >= 25) label = 'BEARISH';
    else label = 'STRONG_BEARISH';

    // Top movers
    const sorted = [...stocks].sort((a, b) => b.changePct - a.changePct);
    const topGainers = sorted.slice(0, 5).map(s => ({
      symbol: s.symbol,
      changePct: s.changePct,
      ltp: s.ltp,
    }));
    const topLosers = sorted.slice(-5).reverse().map(s => ({
      symbol: s.symbol,
      changePct: s.changePct,
      ltp: s.ltp,
    }));

    return {
      advances,
      declines,
      unchanged,
      total,
      adRatio: Math.round(adRatio * 100) / 100,
      newHighs,
      newLows,
      volAdvancing,
      volDeclining,
      volRatio: Math.round(volRatio * 100) / 100,
      aboveEMA20,
      aboveEMA50,
      aboveEMA200,
      aboveEMA20Pct: total > 0 ? Math.round((aboveEMA20 / total) * 10000) / 100 : 0,
      aboveEMA50Pct: total > 0 ? Math.round((aboveEMA50 / total) * 10000) / 100 : 0,
      aboveEMA200Pct: total > 0 ? Math.round((aboveEMA200 / total) * 10000) / 100 : 0,
      aboveVWAP,
      aboveVWAPPct: total > 0 ? Math.round((aboveVWAP / total) * 10000) / 100 : 0,
      freshDayHighs,
      freshDayLows,
      volAdvancing,
      volDeclining,
      breadthScore,
      label,
      adScore,
      volScore,
      emaScore,
      vwapScore,
      highLowScore,
      topGainers,
      topLosers,
      sectorBreadth: Array.from(sectorMap.entries()).map(([name, data]) => ({
        sector: name,
        advances: data.advances,
        declines: data.declines,
        total: data.total,
        breadth: data.total > 0 ? ((data.advances - data.declines) / data.total) * 100 : 0,
      })),
      timestamp: Date.now(),
    };
  }

  private emptyResult(): any {
    return {
      advances: 0, declines: 0, unchanged: 0, total: 0,
      adRatio: 0, newHighs: 0, newLows: 0,
      volAdvancing: 0, volDeclining: 0, volRatio: 0,
      aboveEMA20: 0, aboveEMA50: 0, aboveEMA200: 0,
      aboveEMA20Pct: 0, aboveEMA50Pct: 0, aboveEMA200Pct: 0,
      aboveVWAP: 0, aboveVWAPPct: 0,
      freshDayHighs: 0, freshDayLows: 0,
      volAdvancing: 0, volDeclining: 0,
      breadthScore: 50, label: 'NEUTRAL',
      adScore: 50, volScore: 50, emaScore: 50, vwapScore: 50, highLowScore: 50,
      topGainers: [], topLosers: [],
      sectorBreadth: [],
      timestamp: Date.now(),
    };
  }

  // ─── Configure ──────────────────────────────────────────────────────
  configure(config: Partial<{ universe: string[]; emaPeriods: number[]; vwapDeviationThreshold: number }>): void {
    if (config.universe) this.config.universe = config.universe;
    if (config.emaPeriods) this.config.emaPeriods = config.emaPeriods;
    if (config.vwapDeviationThreshold) this.config.vwapDeviationThreshold = config.vwapDeviationThreshold;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────
let marketBreadthEngineInstance: MarketBreadthEngine | null = null;

export function getMarketBreadthEngine(): MarketBreadthEngine {
  if (!marketBreadthEngineInstance) {
    marketBreadthEngineInstance = new MarketBreadthEngine();
  }
  return marketBreadthEngineInstance;
}