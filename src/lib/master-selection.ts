// Best Market/Instrument Selection Engine
// Determines the best opportunity across indices, equities, futures, and options

import { IndexSymbol, INDEX_UNIVERSE, INDEX_META } from './index-universe';
import { MarketOpportunityRanking } from './index-comparison';
import { TradeDirection, SignalStrength, SetupType } from './auction-types';
import { analyzeEquityCash, analyzeFno } from './equity-cash-engine';
import { getHistoricalCandles } from './historical-data';

export interface InstrumentOpportunity {
  market: 'INDEX' | 'EQUITY' | 'STOCK_FUTURES' | 'STOCK_OPTIONS' | 'INDEX_FUTURES' | 'INDEX_OPTIONS';
  symbol: string;
  name: string;
  direction: TradeDirection;
  setup: SetupType | null;
  signalStrength: number;
  signalLabel: SignalStrength;
  regime: string;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  rr: number;
  liquidity: number;
  ivState?: string;
  theta?: number;
  gamma?: number;
  expectedMove: number;
  capitalEfficiency: number;
  historicalExpectancy: number;
  totalScore: number;
  riskFactors: string[];
  instrumentReason: string;
}

export interface MasterSelectionResult {
  bestOverall: InstrumentOpportunity | null;
  byMarket: Map<string, InstrumentOpportunity>;
  allOpportunities: InstrumentOpportunity[];
  timestamp: number;
  scanStats: {
    indicesScanned: number;
    equitiesScanned: number;
    stockFuturesScanned: number;
    stockOptionsScanned: number;
    indexFuturesScanned: number;
    indexOptionsScanned: number;
    totalOpportunities: number;
    filteredOut: number;
  };
}

// Scan configuration
export interface ScanConfig {
  equityPriceFilter: number; // default 1000
  minLiquidity: number;
  minSignalStrength: number;
  minRr: number;
  maxOpportunities: number;
  includeIndices: boolean;
  includeEquities: boolean;
  includeStockFutures: boolean;
  includeStockOptions: boolean;
  includeIndexFutures: boolean;
  includeIndexOptions: boolean;
}

const DEFAULT_SCAN_CONFIG: ScanConfig = {
  equityPriceFilter: 1000,
  minLiquidity: 50,
  minSignalStrength: 60,
  minRr: 1.5,
  maxOpportunities: 50,
  includeIndices: true,
  includeEquities: true,
  includeStockFutures: true,
  includeStockOptions: true,
  includeIndexFutures: true,
  includeIndexOptions: true,
};

export async function runMasterSelection(
  config: Partial<ScanConfig> = {}
): Promise<MasterSelectionResult> {
  const cfg = { ...DEFAULT_SCAN_CONFIG, ...config };
  const allOpportunities: InstrumentOpportunity[] = [];
  let indicesScanned = 0, equitiesScanned = 0;
  let stockFuturesScanned = 0, stockOptionsScanned = 0;
  let indexFuturesScanned = 0, indexOptionsScanned = 0;
  let filteredOut = 0;

  // 1. Scan Indices (Index Futures & Options)
  if (cfg.includeIndices) {
    for (const symbol of INDEX_UNIVERSE) {
      const result = await scanIndexInstruments(symbol);
      if (result) {
        indicesScanned++;
        indexFuturesScanned++;
        indexOptionsScanned++;
        allOpportunities.push(...result);
      }
    }
  }

  // 2. Scan Equities (Cash)
  if (cfg.includeEquities) {
    const equityResults = await scanEquityUniverse(cfg.equityPriceFilter);
    equitiesScanned = equityResults.length;
    allOpportunities.push(...equityResults);
  }

  // 3. Scan Stock Futures & Options (F&O stocks)
  if (cfg.includeStockFutures || cfg.includeStockOptions) {
    const fnoResults = await scanStockFnoUniverse(cfg.includeStockFutures, cfg.includeStockOptions);
    stockFuturesScanned = fnoResults.futures.length;
    stockOptionsScanned = fnoResults.options.length;
    allOpportunities.push(...fnoResults.futures, ...fnoResults.options);
  }

  // Filter and rank
  const filtered = filterAndRank(allOpportunities, cfg);
  filteredOut = allOpportunities.length - filtered.length;

  // Group by market
  const byMarket = new Map<string, InstrumentOpportunity>();
  for (const opp of filtered) {
    const existing = byMarket.get(opp.market);
    if (!existing || opp.totalScore > existing.totalScore) {
      byMarket.set(opp.market, opp);
    }
  }

  // Best overall
  const bestOverall = filtered[0] || null;

  return {
    bestOverall,
    byMarket,
    allOpportunities: filtered,
    timestamp: Date.now(),
    scanStats: {
      indicesScanned,
      equitiesScanned,
      stockFuturesScanned,
      stockOptionsScanned,
      indexFuturesScanned,
      indexOptionsScanned,
      totalOpportunities: filtered.length,
      filteredOut,
    },
  };
}

async function scanIndexInstruments(symbol: IndexSymbol): Promise<InstrumentOpportunity[]> {
  // Would call the actual F&O engine with real option chain data
  // For now, return mock opportunities based on index analysis
  const candles = await getHistoricalCandles(symbol, '5m', 200);
  if (candles.length < 50) return [];

  const meta = INDEX_META[symbol];
  const spot = candles[candles.length - 1]?.close || 0;

  // Generate mock opportunities for both futures and options
  const opportunities: InstrumentOpportunity[] = [
    {
      market: 'INDEX_FUTURES',
      symbol: `${symbol}FUT`,
      name: `${meta.name} Futures`,
      direction: 'LONG',
      setup: 'VAL_RECLAIM_FO',
      signalStrength: 75,
      signalLabel: 'B',
      regime: 'TRENDING_UP',
      entry: spot,
      sl: spot * 0.99,
      tp1: spot * 1.01,
      tp2: spot * 1.02,
      tp3: spot * 1.03,
      rr: 2.0,
      liquidity: 90,
      expectedMove: spot * 0.015,
      capitalEfficiency: 0.8,
      historicalExpectancy: 0.45,
      totalScore: 78,
      riskFactors: [],
      instrumentReason: 'Index futures - high liquidity, defined risk',
    },
    {
      market: 'INDEX_OPTIONS',
      symbol: `${symbol}OPT`,
      name: `${meta.name} Options`,
      direction: 'LONG',
      setup: 'CALL_SPREAD',
      signalStrength: 72,
      signalLabel: 'B',
      regime: 'TRENDING_UP',
      entry: spot,
      sl: spot * 0.985,
      tp1: spot * 1.01,
      tp2: spot * 1.025,
      tp3: spot * 1.04,
      rr: 2.5,
      liquidity: 85,
      ivState: 'NORMAL_IV',
      theta: -15,
      gamma: 0.02,
      expectedMove: spot * 0.02,
      capitalEfficiency: 0.9,
      historicalExpectancy: 0.38,
      totalScore: 76,
      riskFactors: ['Theta decay'],
      instrumentReason: 'Defined risk call spread - limited downside',
    },
  ];

  return opportunities;
}

async function scanEquityUniverse(priceFilter: number): Promise<InstrumentOpportunity[]> {
  // In production, fetch from NSE/BSE equity master
  // Filter by CMP <= priceFilter (default 1000)
  // Only for CASH equity swing scanner

  const mockEquities = [
    'RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'INFY',
    'HINDUNILVR', 'ITC', 'SBIN', 'BHARTIARTL', 'BAJFINANCE',
  ];

  const opportunities: InstrumentOpportunity[] = [];

  for (const symbol of mockEquities) {
    const candles = await getHistoricalCandles(symbol, '5m', 200);
    if (candles.length < 50) continue;

    const spot = candles[candles.length - 1]?.close || 0;
    if (spot > priceFilter) {
      filteredOut++;
      continue;
    }

    // Simplified equity analysis result
    opportunities.push({
      market: 'EQUITY',
      symbol,
      name: symbol,
      direction: 'LONG',
      setup: 'VAL_RECLAIM',
      signalStrength: 70 + Math.random() * 20,
      signalLabel: 'B',
      regime: 'ACCUMULATION',
      entry: spot,
      sl: spot * 0.98,
      tp1: spot * 1.02,
      tp2: spot * 1.04,
      tp3: spot * 1.06,
      rr: 2.5,
      liquidity: 70 + Math.random() * 20,
      expectedMove: spot * 0.03,
      capitalEfficiency: 0.7,
      historicalExpectancy: 0.35,
      totalScore: 72,
      riskFactors: [],
      instrumentReason: 'Cash equity - no expiry, no theta decay',
    });
  }

  return opportunities;
}

let filteredOut = 0;

async function scanStockFnoUniverse(includeFutures: boolean, includeOptions: boolean): Promise<{
  futures: InstrumentOpportunity[];
  options: InstrumentOpportunity[];
}> {
  // In production, fetch F&O stock list from exchange
  const fnoStocks = ['RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'INFY'];

  const futures: InstrumentOpportunity[] = [];
  const options: InstrumentOpportunity[] = [];

  for (const symbol of fnoStocks) {
    const candles = await getHistoricalCandles(symbol, '5m', 200);
    if (candles.length < 50) continue;

    const spot = candles[candles.length - 1]?.close || 0;

    if (includeFutures) {
      futures.push({
        market: 'STOCK_FUTURES',
        symbol: `${symbol}FUT`,
        name: `${symbol} Futures`,
        direction: 'LONG',
        setup: 'VAL_RECLAIM_FO',
        signalStrength: 65 + Math.random() * 20,
        signalLabel: 'B',
        regime: 'TRENDING_UP',
        entry: spot,
        sl: spot * 0.985,
        tp1: spot * 1.015,
        tp2: spot * 1.03,
        tp3: spot * 1.045,
        rr: 2.2,
        liquidity: 75,
        expectedMove: spot * 0.02,
        capitalEfficiency: 0.75,
        historicalExpectancy: 0.4,
        totalScore: 70,
        riskFactors: ['Stock-specific risk'],
        instrumentReason: 'Stock futures - leverage with single stock exposure',
      });
    }

    if (includeOptions) {
      options.push({
        market: 'STOCK_OPTIONS',
        symbol: `${symbol}OPT`,
        name: `${symbol} Options`,
        direction: 'LONG',
        setup: 'CALL_SPREAD',
        signalStrength: 60 + Math.random() * 20,
        signalLabel: 'B',
        regime: 'TRENDING_UP',
        entry: spot,
        sl: spot * 0.98,
        tp1: spot * 1.02,
        tp2: spot * 1.035,
        tp3: spot * 1.05,
        rr: 2.8,
        liquidity: 65,
        ivState: 'NORMAL_IV',
        theta: -20,
        gamma: 0.03,
        expectedMove: spot * 0.025,
        capitalEfficiency: 0.85,
        historicalExpectancy: 0.35,
        totalScore: 68,
        riskFactors: ['Theta decay', 'Stock-specific risk'],
        instrumentReason: 'Defined risk call spread on F&O stock',
      });
    }
  }

  return { futures, options };
}

function filterAndRank(
  opportunities: InstrumentOpportunity[],
  config: ScanConfig
): InstrumentOpportunity[] {
  return opportunities
    .filter(o => o.liquidity >= config.minLiquidity)
    .filter(o => o.signalStrength >= config.minSignalStrength)
    .filter(o => o.rr >= config.minRr)
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, config.maxOpportunities);
}