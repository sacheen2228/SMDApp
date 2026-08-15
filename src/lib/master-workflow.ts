// Master Trading Workflow Orchestrator
// Coordinates the complete workflow from market universe to final trade decision

import {
  Candle, TradeDirection, SignalStrength, SetupType,
  MarketRegime, AuctionState, VolumeProfile, SessionProfile
} from './auction-types';
import {
  IndexSymbol, INDEX_UNIVERSE, INDEX_META
} from './index-universe';
import { analyzeEquityCash } from './equity-cash-engine';
import { analyzeFno } from './fno-engine';
import { analyzeAllIndices, MarketOpportunityRanking } from './index-comparison';
import { runMasterSelection, MasterSelectionResult, InstrumentOpportunity } from './master-selection';
import { getHistoricalCandles } from './historical-data';

export interface WorkflowInput {
  // Universe selection
  scanIndices?: boolean;
  scanEquities?: boolean;
  scanStockFutures?: boolean;
  scanStockOptions?: boolean;
  scanIndexFutures?: boolean;
  scanIndexOptions?: boolean;

  // Filters
  equityPriceFilter?: number;
  minSignalStrength?: number;
  minLiquidity?: number;
  minRr?: number;

  // Timeframe
  interval?: string;
  limit?: number;
}

export interface WorkflowOutput {
  // Market Universe Analysis
  universe: {
    indices: IndexAnalysis[];
    equities: EquityAnalysis[];
    indexDerivatives: IndexDerivativeAnalysis[];
    stockDerivatives: StockDerivativeAnalysis[];
  };

  // Regime Analysis
  regimeAnalysis: RegimeAnalysis;

  // Auction Analysis
  auctionAnalysis: AuctionAnalysis;

  // Volume Profile Analysis
  volumeProfileAnalysis: VolumeProfileAnalysis;

  // Liquidity Analysis
  liquidityAnalysis: LiquidityAnalysis;

  // Market Structure Analysis
  structureAnalysis: StructureAnalysis;

  // Volume/VWAP Analysis
  vwapAnalysis: VwapAnalysis;

  // F&O Positioning Analysis
  fnoPositioningAnalysis: FnoPositioningAnalysis;

  // IV/Greeks Analysis
  ivGreeksAnalysis: IvGreeksAnalysis;

  // Risk Engine Output
  riskEngine: RiskEngineOutput;

  // Instrument Selection
  instrumentSelection: InstrumentSelectionOutput;

  // Final Trade Setups
  finalSetups: FinalTradeSetup[];

  // Master Ranking
  marketRanking: MarketOpportunityRanking[];

  // Final Decision
  finalDecision: {
    action: TradeDirection;
    symbol: string;
    market: string;
    reasoning: string;
    confidence: number;
  };

  // Metadata
  timestamp: number;
  scanStats: any;
}

export interface IndexAnalysis {
  symbol: IndexSymbol;
  name: string;
  price: number;
  change: number;
  changePct: number;
  regime: MarketRegime;
  regimeBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  auctionState: AuctionState;
  poc: number;
  vah: number;
  val: number;
  volume: number;
  relativeVolume: number;
  signalStrength: number;
  signalLabel: SignalStrength;
}

export interface EquityAnalysis {
  symbol: string;
  price: number;
  changePct: number;
  regime: MarketRegime;
  signalStrength: number;
  signalLabel: SignalStrength;
  setup: SetupType | null;
  priceFilterPassed: boolean;
}

export interface IndexDerivativeAnalysis {
  symbol: IndexSymbol;
  futures: FuturesAnalysis | null;
  options: OptionsAnalysis | null;
  spotPrice: number;
}

export interface StockDerivativeAnalysis {
  symbol: string;
  futures: FuturesAnalysis | null;
  options: OptionsAnalysis | null;
  spotPrice: number;
}

export interface FuturesAnalysis {
  price: number;
  basis: number;
  basisPct: number;
  volume: number;
  oi: number;
  oiChange: number;
  oiState: string;
  priceChange: number;
  priceChangePct: number;
}

export interface OptionsAnalysis {
  atmStrike: number;
  pcr: number;
  ivRank: number;
  ivPercentile: number;
  atmIV: number;
  ivSkew: number;
  maxPain: number;
  callOI: number;
  putOI: number;
}

export interface RegimeAnalysis {
  overall: MarketRegime;
  byIndex: Map<IndexSymbol, MarketRegime>;
  characteristics: Map<MarketRegime, any>;
  transitionRisk: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface AuctionAnalysis {
  byIndex: Map<IndexSymbol, {
    state: AuctionState;
    poc: number;
    vah: number;
    val: number;
    valueMigration: 'HIGHER' | 'LOWER' | 'NEUTRAL';
    acceptance: string;
  }>;
  overall: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

export interface VolumeProfileAnalysis {
  byIndex: Map<IndexSymbol, {
    poc: number;
    vah: number;
    val: number;
    hvn: number[];
    lvn: number[];
    nakedPoc: number[];
    volumeGaps: { start: number; end: number }[];
    distribution: 'NORMAL' | 'SKEWED_HIGH' | 'SKEWED_LOW' | 'BIMODAL';
  }>;
  compositeProfile: any;
}

export interface LiquidityAnalysis {
  byIndex: Map<IndexSymbol, {
    keyLevels: any[];
    sweeps: any[];
    failedBreakouts: any[];
    failedBreakdowns: any[];
  }>;
  overall: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface StructureAnalysis {
  byIndex: Map<IndexSymbol, {
    trend: 'UP' | 'DOWN' | 'SIDEWAYS';
    hh: number;
    hl: number;
    lh: number;
    ll: number;
    bos: number;
    choch: number;
    displacements: number;
  }>;
  overallTrend: 'UP' | 'DOWN' | 'SIDEWAYS';
}

export interface VwapAnalysis {
  byIndex: Map<IndexSymbol, {
    sessionVwap: number;
    anchoredVwaps: any[];
    state: string;
    distance: number;
    reclaim: boolean;
    rejection: boolean;
  }>;
  overall: 'ABOVE' | 'BELOW' | 'AT';
}

export interface FnoPositioningAnalysis {
  byIndex: Map<IndexSymbol, {
    futures: {
      oiState: string;
      basis: number;
      volume: number;
      oi: number;
      oiChange: number;
    };
    options: {
      pcr: number;
      callOI: number;
      putOI: number;
      callOIChange: number;
      putOIChange: number;
      maxPain: number;
    };
  }>;
  overallBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

export interface IvGreeksAnalysis {
  byIndex: Map<IndexSymbol, {
    ivState: string;
    ivRank: number;
    ivPercentile: number;
    atmIV: number;
    ivSkew: number;
    portfolioGreeks: {
      delta: number;
      gamma: number;
      theta: number;
      vega: number;
    };
  }>;
  portfolioSummary: {
    totalDelta: number;
    totalGamma: number;
    totalTheta: number;
    totalVega: number;
  };
}

export interface RiskEngineOutput {
  maxPositionSize: number;
  maxDrawdown: number;
  var95: number;
  maxCorrelatedRisk: number;
  sectorExposure: Map<string, number>;
  indexExposure: Map<string, number>;
  approved: boolean;
  warnings: string[];
}

export interface InstrumentSelectionOutput {
  bestByMarket: Map<string, any>;
  bestOverall: any;
  ranking: MarketOpportunityRanking[];
  reasoning: string;
}

export interface FinalTradeSetup {
  symbol: string;
  market: string;
  direction: TradeDirection;
  setup: SetupType;
  signalStrength: number;
  signalLabel: SignalStrength;
  entry: { aggressive: number; confirmation: number; retest: number };
  stopLoss: { price: number; type: string; reason: string };
  targets: { price: number; type: string; rr: number }[];
  maxLoss: number;
  maxProfit: number;
  breakeven: number;
  riskReward: number;
  signalScore: any;
  historicalExpectancy: number;
  riskFactors: string[];
  instrumentReason: string;
  approved: boolean;
  approvalReason: string;
}

const DEFAULT_WORKFLOW_CONFIG = {
  scanIndices: true,
  scanEquities: true,
  scanStockFutures: true,
  scanStockOptions: true,
  scanIndexFutures: true,
  scanIndexOptions: true,
  equityPriceFilter: 1000,
  minSignalStrength: 60,
  minLiquidity: 50,
  minRr: 1.5,
  interval: '5m',
  limit: 300,
};

export async function runMasterTradingWorkflow(
  config: Partial<typeof DEFAULT_WORKFLOW_CONFIG> = {}
): Promise<WorkflowOutput> {
  const cfg = { ...DEFAULT_WORKFLOW_CONFIG, ...config };

  // ============ STAGE 1: MARKET UNIVERSE ============
  console.log('[Workflow] Stage 1: Scanning Market Universe...');

  const universe = await scanMarketUniverse(cfg);
  console.log(`[Workflow] Universe: ${universe.indices.length} indices, ${universe.equities.length} equities`);

  // ============ STAGE 2: MARKET REGIME ============
  console.log('[Workflow] Stage 2: Analyzing Market Regime...');
  const regimeAnalysis = analyzeRegime(universe.indices);

  // ============ STAGE 3: AUCTION ENGINE ============
  console.log('[Workflow] Stage 3: Running Auction Engine...');
  const auctionAnalysis = analyzeAuction(universe.indices);

  // ============ STAGE 4: VOLUME PROFILE ============
  console.log('[Workflow] Stage 4: Building Volume Profiles...');
  const volumeProfileAnalysis = await analyzeVolumeProfiles(universe.indices, cfg.interval, cfg.limit);

  // ============ STAGE 5: LIQUIDITY ENGINE ============
  console.log('[Workflow] Stage 5: Analyzing Liquidity...');
  const liquidityAnalysis = analyzeLiquidity(universe.indices);

  // ============ STAGE 6: MARKET STRUCTURE ============
  console.log('[Workflow] Stage 6: Analyzing Market Structure...');
  const structureAnalysis = analyzeStructure(universe.indices);

  // ============ STAGE 7: VOLUME / VWAP ============
  console.log('[Workflow] Stage 7: VWAP & Volume Analysis...');
  const vwapAnalysis = analyzeVwap(universe.indices);

  // ============ STAGE 8: F&O POSITIONING ============
  console.log('[Workflow] Stage 8: F&O Positioning...');
  const fnoPositioningAnalysis = analyzeFnoPositioning(universe.indexDerivatives);

  // ============ STAGE 9: IV / GREEKS ============
  console.log('[Workflow] Stage 9: IV & Greeks...');
  const ivGreeksAnalysis = analyzeIvGreeks(universe.indexDerivatives);

  // ============ STAGE 10: RISK ENGINE ============
  console.log('[Workflow] Stage 10: Risk Engine...');
  const riskEngine = runRiskEngine(universe);

  // ============ STAGE 11: INSTRUMENT SELECTION ============
  console.log('[Workflow] Stage 11: Instrument Selection...');
  const instrumentSelection = await runInstrumentSelection(universe, cfg);

  // ============ STAGE 12: FINAL SETUPS ============
  console.log('[Workflow] Stage 12: Generating Final Setups...');
  const finalSetups = generateFinalSetups(instrumentSelection);

  // ============ STAGE 13: MASTER RANKING ============
  console.log('[Workflow] Stage 13: Master Market Ranking...');
  const { ranking } = await analyzeAllIndices(cfg.interval, cfg.limit);

  // ============ STAGE 14: FINAL DECISION ============
  console.log('[Workflow] Stage 14: Final Decision...');
  const finalDecision = makeFinalDecision(finalSetups, ranking);

  return {
    universe,
    regimeAnalysis,
    auctionAnalysis,
    volumeProfileAnalysis,
    liquidityAnalysis,
    structureAnalysis,
    vwapAnalysis,
    fnoPositioningAnalysis,
    ivGreeksAnalysis,
    riskEngine,
    instrumentSelection,
    finalSetups,
    marketRanking: ranking,
    finalDecision,
    timestamp: Date.now(),
    scanStats: {
      indicesAnalyzed: universe.indices.length,
      equitiesAnalyzed: universe.equities.length,
      indexDerivativesAnalyzed: universe.indexDerivatives.length,
      stockDerivativesAnalyzed: universe.stockDerivatives.length,
      totalSetupsGenerated: finalSetups.length,
      approvedSetups: finalSetups.filter(s => s.approved).length,
    },
  };
}

// ============ HELPER FUNCTIONS ============

async function scanMarketUniverse(cfg: typeof DEFAULT_WORKFLOW_CONFIG): Promise<WorkflowOutput['universe']> {
  // This would call actual data sources in production
  // For now, return structured mock data matching the interface
  return {
    indices: INDEX_UNIVERSE.map(symbol => ({
      symbol,
      name: INDEX_META[symbol].name,
      price: 0,
      change: 0,
      changePct: 0,
      regime: 'TRANSITION' as MarketRegime,
      regimeBias: 'NEUTRAL' as const,
      auctionState: 'PRICE_INSIDE_VALUE' as AuctionState,
      poc: 0, vah: 0, val: 0,
      volume: 0,
      relativeVolume: 1,
      signalStrength: 0,
      signalLabel: 'NO_TRADE' as SignalStrength,
    })),
    equities: [],
    indexDerivatives: INDEX_UNIVERSE.map(symbol => ({
      symbol,
      futures: null,
      options: null,
      spotPrice: 0,
    })),
    stockDerivatives: [],
  };
}

function analyzeRegime(indices: IndexAnalysis[]): RegimeAnalysis {
  const byIndex = new Map<IndexSymbol, MarketRegime>();
  for (const idx of indices) {
    byIndex.set(idx.symbol, idx.regime);
  }

  // Determine overall regime from majority
  const regimeCounts = new Map<MarketRegime, number>();
  for (const r of byIndex.values()) {
    regimeCounts.set(r, (regimeCounts.get(r) || 0) + 1);
  }

  let overall = 'TRANSITION';
  let maxCount = 0;
  for (const [regime, count] of regimeCounts) {
    if (count > maxCount) {
      maxCount = count;
      overall = regime;
    }
  }

  return {
    overall,
    byIndex,
    characteristics: new Map(), // would be populated
    transitionRisk: 'MEDIUM',
  };
}

function analyzeAuction(indices: IndexAnalysis[]): AuctionAnalysis {
  const byIndex = new Map();
  let bullishCount = 0, bearishCount = 0;

  for (const idx of indices) {
    byIndex.set(idx.symbol, {
      state: idx.auctionState,
      poc: 0, vah: 0, val: 0,
      valueMigration: 'NEUTRAL',
      acceptance: 'BALANCE',
    });
    if (idx.auctionState === 'PRICE_ABOVE_VALUE') bullishCount++;
    else if (idx.auctionState === 'PRICE_BELOW_VALUE') bearishCount++;
  }

  return {
    byIndex,
    overall: bullishCount > bearishCount ? 'BULLISH' : bearishCount > bullishCount ? 'BEARISH' : 'NEUTRAL',
  };
}

async function analyzeVolumeProfiles(
  indices: IndexAnalysis[],
  interval: string,
  limit: number
): Promise<VolumeProfileAnalysis> {
  // Would call actual volume profile engine
  const byIndex = new Map();
  for (const idx of indices) {
    byIndex.set(idx.symbol, {
      poc: 0, vah: 0, val: 0,
      hvn: [], lvn: [], nakedPoc: [],
      volumeGaps: [],
      distribution: 'NORMAL',
    });
  }
  return { byIndex, compositeProfile: null };
}

function analyzeLiquidity(indices: IndexAnalysis[]): LiquidityAnalysis {
  const byIndex = new Map();
  for (const idx of indices) {
    byIndex.set(idx.symbol, {
      keyLevels: [],
      sweeps: [],
      failedBreakouts: [],
      failedBreakdowns: [],
    });
  }
  return { byIndex, overall: 'MEDIUM' };
}

function analyzeStructure(indices: IndexAnalysis[]): StructureAnalysis {
  const byIndex = new Map();
  for (const idx of indices) {
    byIndex.set(idx.symbol, {
      trend: 'SIDEWAYS',
      hh: 0, hl: 0, lh: 0, ll: 0,
      bos: 0, choch: 0, displacements: 0,
    });
  }
  return { byIndex, overallTrend: 'SIDEWAYS' };
}

function analyzeVwap(indices: IndexAnalysis[]): VwapAnalysis {
  const byIndex = new Map();
  for (const idx of indices) {
    byIndex.set(idx.symbol, {
      sessionVwap: 0,
      anchoredVwaps: [],
      state: 'AT',
      distance: 0,
      reclaim: false,
      rejection: false,
    });
  }
  return { byIndex, overall: 'AT' };
}

function analyzeFnoPositioning(derivatives: any[]): FnoPositioningAnalysis {
  const byIndex = new Map();
  for (const d of derivatives) {
    byIndex.set(d.symbol, {
      futures: { oiState: 'NEUTRAL', basis: 0, volume: 0, oi: 0, oiChange: 0 },
      options: { pcr: 1, callOI: 0, putOI: 0, callOIChange: 0, putOIChange: 0, maxPain: 0 },
    });
  }
  return { byIndex, overallBias: 'NEUTRAL' };
}

function analyzeIvGreeks(derivatives: any[]): IvGreeksAnalysis {
  const byIndex = new Map();
  for (const d of derivatives) {
    byIndex.set(d.symbol, {
      ivState: 'NORMAL_IV',
      ivRank: 50,
      ivPercentile: 50,
      atmIV: 15,
      ivSkew: 0,
      portfolioGreeks: { delta: 0, gamma: 0, theta: 0, vega: 0 },
    });
  }
  return { byIndex, portfolioSummary: { totalDelta: 0, totalGamma: 0, totalTheta: 0, totalVega: 0 } };
}

function runRiskEngine(universe: any): RiskEngineOutput {
  return {
    maxPositionSize: 1000000,
    maxDrawdown: 0.15,
    var95: 50000,
    maxCorrelatedRisk: 0.3,
    sectorExposure: new Map(),
    indexExposure: new Map(),
    approved: true,
    warnings: [],
  };
}

async function runInstrumentSelection(universe: any, cfg: any): Promise<InstrumentSelectionOutput> {
  const selection = await runMasterSelection({
    minSignalStrength: cfg.minSignalStrength,
    minLiquidity: cfg.minLiquidity,
    minRr: cfg.minRr,
    equityPriceFilter: cfg.equityPriceFilter,
  });

  return {
    bestByMarket: selection.byMarket,
    bestOverall: selection.bestOverall,
    ranking: selection.allOpportunities.slice(0, 10).map((o, i) => ({
      rank: i + 1,
      symbol: o.symbol,
      name: o.name,
      signalStrength: o.signalStrength,
      signalLabel: o.signalLabel,
      regime: o.regime,
      bestInstrument: o.market,
      instrumentReason: o.instrumentReason,
      liquidity: o.liquidity,
      rr: o.rr,
      expectedMove: o.expectedMove,
      capitalEfficiency: o.capitalEfficiency,
      historicalExpectancy: o.historicalExpectancy,
      totalScore: o.totalScore,
    })),
    reasoning: selection.bestOverall
      ? `Best opportunity: ${selection.bestOverall.symbol} (${selection.bestOverall.market}) with ${selection.bestOverall.signalLabel} signal`
      : 'No qualified opportunities found',
  };
}

function generateFinalSetups(selection: InstrumentSelectionOutput): FinalTradeSetup[] {
  // Would convert instrument selection to final trade setups
  return [];
}

function makeFinalDecision(
  setups: FinalTradeSetup[],
  ranking: MarketOpportunityRanking[]
): WorkflowOutput['finalDecision'] {
  // Logic: pick the highest-ranked approved setup
  const approved = ranking.filter(r => r.signalStrength >= 70);
  if (approved.length === 0) {
    return {
      action: 'NO_TRADE',
      symbol: '',
      market: '',
      reasoning: 'No setups meet minimum signal strength (70)',
      confidence: 0,
    };
  }

  const best = approved[0];
  return {
    action: 'LONG', // would be determined from setup
    symbol: best.symbol,
    market: best.bestInstrument,
    reasoning: `Highest ranked opportunity: ${best.name} (${best.signalLabel} signal, ${best.regime} regime)`,
    confidence: best.signalStrength / 100,
  };
}