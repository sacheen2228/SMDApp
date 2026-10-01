// Hermes Pro — Type Definitions
// All types, interfaces, and enums for the Hermes orchestration system.

// ── Enums ──────────────────────────────────────────────────────────────

export type MarketStatus =
  | "PRE_MARKET"
  | "MARKET_OPEN"
  | "MARKET_CLOSED"
  | "AFTER_HOURS"
  | "WEEKEND"
  | "HOLIDAY";

export type DataFreshness = "LIVE" | "FRESH" | "DELAYED" | "STALE" | "UNAVAILABLE";

export type Direction = "BULLISH" | "BEARISH" | "NEUTRAL" | "CONFLICTED";

export type OptionSide = "CE" | "PE";

export type OptionPosition = "ITM" | "ATM" | "OTM";

export type MarketRegime =
  | "TRENDING_UP"
  | "TRENDING_DOWN"
  | "RANGE"
  | "COMPRESSION"
  | "EXPANSION"
  | "HIGH_VOLATILITY"
  | "LOW_VOLATILITY"
  | "BREAKOUT"
  | "BREAKDOWN"
  | "UNCERTAIN";

export type TradeGrade = "A" | "B" | "C" | "D" | "F";

export type HermesMode =
  | "QUICK"
  | "RESEARCH"
  | "TRADE"
  | "RISK"
  | "BACKTEST"
  | "EXPLAIN"
  | "DEBUG";

export type ToolStatus =
  | "SUCCESS"
  | "STALE"
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "AUTH_ERROR"
  | "DATA_ERROR"
  | "UNAVAILABLE";

export type Decision = "BUY_CE" | "BUY_PE" | "NO_TRADE" | "RESEARCH_ONLY";

export type FlowBias =
  | "BULLISH_FLOW"
  | "BEARISH_FLOW"
  | "MIXED_FLOW"
  | "NEUTRAL_FLOW";

export type DataProvider =
  | "breeze"
  | "icici-breeze"
  | "moapi"
  | "nse"
  | "nse-api"
  | "bse-api"
  | "motilal-api"
  | "website"
  | "yahoo";

export type ProviderHealthStatus =
  | "UP"
  | "DEGRADED"
  | "DOWN"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "STALE"
  | "UNKNOWN";

// ── Core Data Types ────────────────────────────────────────────────────

export interface FreshData<T> {
  value: T;
  source: DataProvider;
  timestamp: string;
  ageMs: number;
  freshness: DataFreshness;
  status: ToolStatus;
  delayed: boolean;
  fallbackUsed: boolean;
  fallbackReason?: string;
  error?: string;
}

export interface MarketDataResponse<T> {
  data: T;
  provider: DataProvider;
  source: string;
  exchange: string;
  instrument: string;
  timestamp: string;
  ageMs: number;
  freshness: DataFreshness;
  reliability: number;
  delayed: boolean;
  fallbackUsed: boolean;
  fallbackReason?: string;
  error?: string;
}

// ── Option Chain Types ─────────────────────────────────────────────────

export interface OptionStrike {
  strike: number;
  ce: OptionData;
  pe: OptionData;
}

export interface OptionData {
  ltp: number;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  quoteQuality: 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';
  volume: number;
  oi: number;
  oiChange: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

export interface OptionChainData {
  symbol: string;
  spot: number;
  atmStrike: number;
  expiry: string;
  daysToExpiry: number;
  strikes: OptionStrike[];
  totalCallOI: number;
  totalPutOI: number;
  callOiChange: number;
  putOiChange: number;
  pcrOI: number;
  pcrVolume: number;
  maxPain: number;
  callWall: number;
  putWall: number;
  gammaWall: number;
  gammaFlip: number;
  expectedMove: number;
  vix: number;
  futuresPrice: number;
}

// ── Market Data Types ──────────────────────────────────────────────────

export interface SpotData {
  price: number;
  change: number;
  changePct: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
}

export interface StructureData {
  trend: "UP" | "DOWN" | "SIDEWAYS";
  swingHigh: number;
  swingLow: number;
  supportLevels: number[];
  resistanceLevels: number[];
  lastEvent: string;
  pdh: number;
  pdl: number;
}

export interface GreeksData {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
}

export interface GammaData {
  detected: boolean;
  confidence: number;
  dealerBias: string;
  squeezePotential: number;
  gammaWallStrike: number;
  gammaWallType: string;
  estimatedGEX: number;
  regime: "POSITIVE" | "NEGATIVE" | "TRANSITION" | "UNKNOWN";
}

export interface VolumeData {
  poc: number;
  vah: number;
  val: number;
  cumulativeDelta: number;
  totalVolume: number;
  avgVolume: number;
  absorptionLevels: any[];
  exhaustionSignals: any[];
}

export interface FIIDIIData {
  fiiNet: number;
  diiNet: number;
  fiiBias: FlowBias;
  dataDate: string;
  publishedAt: string;
  participantOI?: ParticipantOIData;
}

export interface ParticipantOIData {
  date: string;
  fii: { indexLong: number; indexShort: number; stockLong: number; stockShort: number; totalLong: number; totalShort: number };
  dii: { indexLong: number; indexShort: number; stockLong: number; stockShort: number; totalLong: number; totalShort: number };
  pro: { indexLong: number; indexShort: number; stockLong: number; stockShort: number; totalLong: number; totalShort: number };
  client: { indexLong: number; indexShort: number; stockLong: number; stockShort: number; totalLong: number; totalShort: number };
}

export interface NewsData {
  sentiment: string;
  score: number;
  headlines: string[];
  highImpactEvents: string[];
}

export interface RegimeData {
  type: MarketRegime;
  bias: Direction;
  confidence: number;
  factors: Record<string, number>;
}

export interface ExpiryLiquidityData {
  casDirection: string;
  casConfidence: number;
  gammaPressure: number;
  oiShift: number;
}

export interface BacktestData {
  winRate: number;
  profitFactor: number;
  netPnL: number;
  totalTrades: number;
  avgWin: number;
  avgLoss: number;
}

// ── MCX Intelligence Types ──────────────────────────────────────────

export interface MCXIntelligenceData {
  regime: string;
  regimeConfidence: number;
  structureBias: string;
  structureEvent: string;
  oiClassification: string;
  oiDivergence: boolean;
  relativeVolume: number;
  volumeState: string;
  atr: number;
  atrPercent: number;
  volatilityRegime: string;
  ivClassification: string;
  expectedMove: number;
  chainQuality: string;
  bestCandidateDirection: string;
  bestCandidateScore: number;
  bestCandidateRR: number;
  longScore: number;
  shortScore: number;
  dataFreshness: {
    candlesAvailable: boolean;
    candleCount: number;
    optionChainAvailable: boolean;
    quoteAvailable: boolean;
  };
}

// ── Hermes Context ─────────────────────────────────────────────────────

export interface HermesContext {
  timestamp: string;
  symbol: string;
  mode: HermesMode;
  marketStatus: MarketStatus;
  exchange: "NSE" | "MCX" | "BSE";
  instrument: "index" | "fno-stock" | "cash-stock" | "commodity";
  spot: FreshData<SpotData>;
  optionChain: FreshData<OptionChainData>;
  vix: FreshData<number>;
  fiiDII: FreshData<FIIDIIData>;
  news: FreshData<NewsData>;
  regime: FreshData<RegimeData>;
  marketStructure: FreshData<StructureData>;
  greeks: FreshData<GreeksData>;
  gamma: FreshData<GammaData>;
  volume: FreshData<VolumeData>;
  expiryLiquidity: FreshData<ExpiryLiquidityData>;
  backtestResults: FreshData<BacktestData>;
  mcxIntelligence?: FreshData<MCXIntelligenceData>;
  mtf?: FreshData<any>;
}

// ── Trade Candidate ────────────────────────────────────────────────────

export interface TradeCandidate {
  symbol: string;
  exchange: "NSE" | "MCX" | "BSE";
  instrument: string;
  direction: Direction;
  optionSide: OptionSide;
  strike: number;
  position: OptionPosition;
  expiry: string;
  entry: number;
  entryRange: { min: number; max: number };
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  riskReward: number;
  quantity: number;
  lotSize: number;
  riskAmount: number;
  score: number;
  grade: TradeGrade;
  confidence: number;
  reasons: string[];
  risks: string[];
  invalidation: string[];
  dataSources: string[];
  timestamp: string;
}

// ── Hermes Decision ────────────────────────────────────────────────────

export interface HermesDecision {
  decision: Decision;
  candidate?: TradeCandidate;
  explanation: string;
  evidence: EvidencePoint[];
  risks: string[];
  score: number;
  grade: TradeGrade;
  confidence: number;
  marketRegime: MarketRegime;
  dataHealth: number;
  toolsCalled: string[];
  executionTimeMs: number;
  dataQuality: {
    status: string;
    provider: DataProvider;
    ageMs: number;
    freshness: DataFreshness;
  };
  validation: {
    passed: boolean;
    failures: string[];
    warnings: string[];
  };
  scoringProvenance?: {
    scoringEngine: string;
    strategyProfile: string;
    profileVersion: string;
    weightsUsed: Record<string, number>;
    ceScore: number;
    peScore: number;
    conflictStatus: string;
  };
  timestamp: string;
}

// ── Scoring ────────────────────────────────────────────────────────────

export interface ScoreBreakdown {
  factor: string;
  score: number;
  weighted: number;
  weight: number;
  available: boolean;
  reason: string;
  direction: Direction;
}

export interface ScoreResult {
  total: number;
  grade: TradeGrade;
  breakdown: ScoreBreakdown[];
  direction: Direction;
  optionSide: OptionSide;
}

// ── Strike Selection ───────────────────────────────────────────────────

export interface StrikeCandidate {
  strike: number;
  position: OptionPosition;
  side: OptionSide;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  premium: number;
  volume: number;
  oi: number;
  oiChange: number;
  spread: number;
  spreadPct: number;
  liquidity: "HIGH" | "MEDIUM" | "LOW";
  distanceFromSpot: number;
  withinExpectedMove: boolean;
  score: number;
  reasons: string[];
}

// ── Validation ─────────────────────────────────────────────────────────

export interface ValidationResult {
  step: string;
  passed: boolean;
  reason: string;
  severity: "CRITICAL" | "WARNING" | "INFO";
}

// ── No Trade ───────────────────────────────────────────────────────────

export interface NoTradeReason {
  category: string;
  reason: string;
  severity: "CRITICAL" | "WARNING";
  suggestion?: string;
}

// ── Evidence ───────────────────────────────────────────────────────────

export interface EvidencePoint {
  factor: string;
  score: number;
  weight: number;
  evidence: string;
  direction: Direction;
}

// ── Tool Registry ──────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  category: string;
  inputSchema: Record<string, { type: string; required: boolean; default?: any; description: string }>;
  source: string;
  freshnessMaxAge: number;
  reliability: number;
  timeout: number;
  cacheable: boolean;
  cacheTTL: number;
  tags: string[];
}

// ── Task Router ────────────────────────────────────────────────────────

export interface PlanStep {
  tool: string;
  purpose: string;
  required: boolean;
  parallel: boolean;
  dependsOn?: string[];
}

export interface ExecutionPlan {
  intent: string;
  mode: HermesMode;
  steps: PlanStep[];
  estimatedTime: number;
  requiredData: string[];
}
