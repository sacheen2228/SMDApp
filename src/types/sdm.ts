// SDM (Smart Decision Making) Types
// Core types for the SDM Options Intelligence Engine

import type { DataHealthReport } from "../lib/data-health";

export type TradeDirection = "CALL" | "PUT" | "SELL_CALL" | "SELL_PUT" | "WAIT";
export type ExpiryWindow = "gamma" | "theta" | "danger" | "normal";
export type DayMode = "SCALPER" | "SWING";

// ─── OHLCV Candle Data ───────────────────────────────────────────
export interface CandleData {
  time: number;      // epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Market Regime ───────────────────────────────────────────────
export type MarketRegime =
  | "trending"
  | "ranging"
  | "breakout"
  | "mean_reversion"
  | "high_volatility"
  | "low_volatility"
  | "expiry_day"
  | "event_day";

// ─── Smart Entry ─────────────────────────────────────────────────
export type SmartEntryAction =
  | "ENTER_NOW"
  | "WAIT_BREAKOUT"
  | "WAIT_PULLBACK"
  | "WAIT_RETEST"
  | "WAIT_ABOVE_VWAP"
  | "WAIT_BELOW_VWAP"
  | "WAIT_VOLUME_CONFIRMATION";

// ─── Smart Exit ──────────────────────────────────────────────────
export type SmartExitAction =
  | "HOLD"
  | "EXIT"
  | "BOOK_25"
  | "BOOK_50"
  | "BOOK_FULL"
  | "MOVE_STOP_TO_COST"
  | "TRAIL_STOP";

// ─── Trade Grade ─────────────────────────────────────────────────
export type TradeGrade = "A+" | "A" | "B" | "C" | "D";

// ─── Scores ──────────────────────────────────────────────────────
export interface SDMScores {
  sellerStopLoss: number;
  expiryGammaTheta: number;
  pcr: number;
  oiConcentration: number;
  oiChange: number;
  delta: number;
  iv: number;
  volume: number;
  maxPain: number;
  liquidity: number;
}

// ─── Seller SL Zone ──────────────────────────────────────────────
export interface SellerSLZone {
  ceSellerSL: number;
  peSellerSL: number;
  ceSellerOI: number;
  peSellerOI: number;
  nearestSL: "CE" | "PE";
  distanceToSL: number;
  sellerExhaustion: boolean;
}

// ─── Gamma Blast ─────────────────────────────────────────────────
export interface GammaBlastSignals {
  lowVix: boolean;
  flatThenBreakout: boolean;
  volumeSpike: boolean;
  ivSpike: boolean;
  extremePCR: boolean;
}

export interface GammaThetaData {
  gammaExposure: number;
  thetaDecayRate: number;
  premiumDecayPercent: number;
  ivSkew: number;
  gammaBlastDetected: boolean;
  gammaBlastSignals: GammaBlastSignals;
  vixLevel: number;
}

// ─── Market Context ──────────────────────────────────────────────
export interface MarketContext {
  spot: number;
  change: number;
  changePercent: number;
  pcr: number;
  maxPain: number;
  vix: number;
  trend: "bullish" | "bearish" | "sideways";
  regime: MarketRegime;
  atr?: number;
}

// ─── Premium Fair Value ──────────────────────────────────────────
export interface PremiumFairValue {
  marketPrice: number;
  theoreticalPrice: number;
  difference: number;
  differencePercent: number;
  status: "undervalued" | "fair" | "overpriced";
  reason: string;
}

// ─── Live Probability ────────────────────────────────────────────
export interface LiveProbability {
  tp1: number;
  tp2: number;
  tp3: number;
  sl: number;
  expiryITM: number;
  expiryOTM: number;
}

// ─── Data Health ─────────────────────────────────────────────────
export interface DataHealth {
  score: number;
  latency: number;
  lastUpdate: string;
  status: "LIVE" | "STALE" | "OFFLINE";
  source: string;
  missingFields: string[];
}

// ─── Risk Config ─────────────────────────────────────────────────
export interface RiskConfig {
  capital: number;
  riskPerTradePercent: number;
  maxDailyLoss: number;
  maxWeeklyLoss: number;
  maxMonthlyLoss: number;
  maxPositionSize: number;
  maxConcurrentTrades: number;
}

// ─── Position Sizing ─────────────────────────────────────────────
export interface PositionSizing {
  lots: number;
  quantity: number;
  riskAmount: number;
  positionValue: number;
  maxLoss: number;
}

// ─── Watch List ──────────────────────────────────────────────────
export interface WatchListItem {
  type: "CE_SELLER_TRAP" | "PE_SELLER_TRAP" | "OI_SUPPORT" | "OI_RESISTANCE";
  strike: number;
  oi: number;
  distance: number;
  description: string;
}

// ─── Why This Trade ──────────────────────────────────────────────
export interface WhyThisTradeItem {
  signal: string;
  type: "positive" | "warning" | "negative";
  label?: string;
  detail?: string;
}

// ─── Trade Record ────────────────────────────────────────────────
export interface TradeRecord {
  id: string;
  time: string;
  direction: "CALL" | "PUT" | "SELL_CALL" | "SELL_PUT";
  strike: number;
  lotSize: number;
  entry: number;
  tp1: number;
  tp2: number;
  tp3: number;
  sl: number;
  status: "active" | "tp_hit" | "sl_hit" | "expired" | "partial_exit";
  pnl: number;
  grade: TradeGrade;
  confidence: number;
  reason: string;
  exitReason?: string;
  holdingTime?: number;
  entryMs: number;
  partialExits: { time: string; percent: number; price: number; pnl: number }[];
}

// ─── SDM Recommendation ─────────────────────────────────────────
export interface SDMRecommendation {
  direction: TradeDirection;
  strike: number;
  strikeType: "ATM" | "ITM" | "OTM";
  entry: number;
  tp1: number;
  tp2: number;
  tp3: number;
  sl: number;
  confidence: number;
  riskReward: number;
  isExpiryDay: boolean;
  daysToExpiry: number;
  currentWindow: ExpiryWindow;
  windowTimeRemaining: string;
  tradesTakenToday: number;
  tradesRemaining: number;
  mode: DayMode;
  sellerSLZone: SellerSLZone;
  gammaThetaData: GammaThetaData;
  marketContext: MarketContext;
  watchList: WatchListItem[];
  whyThisTrade: WhyThisTradeItem[];
  sdmScores: SDMScores;
  reason: string;
  timeSensitiveNote: string;
  // New fields
  smartEntry: SmartEntryAction;
  smartExit: SmartExitAction;
  premiumFairValue: PremiumFairValue;
  probabilities: LiveProbability;
  tradeGrade: TradeGrade;
  dataHealth: DataHealth;
  positionSizing: PositionSizing;
  marketRegime: MarketRegime;
  holdingTimeEstimate: string;
  expectedMove: number;
  // V2 enriched fields
  consensus?: ConsensusResult;
  qualityScore?: QualityScore;
  smartEntryResult?: SmartEntryResult;
  smartExitResult?: SmartExitResult;
  marketStructure?: MarketStructure;
  // Market session info
  session?: {
    label: string;
    description: string;
    confidenceMultiplier: number;
    notes: string[];
  };
}

// ─── Score Object ────────────────────────────────────────────────
export interface ScoreObject {
  score: number;
  direction: "CALL" | "PUT" | "NEUTRAL";
  details: string;
}

// ─── Option Chain Strike ─────────────────────────────────────────
export interface SDMOptionStrike {
  strike: number;
  ce: {
    ltp: number;
    oi: number;
    oiChg: number;
    volume: number;
    iv: number;
    delta: number;
    theta: number;
    gamma: number;
    vega: number;
    bid?: number;
    ask?: number;
  } | null;
  pe: {
    ltp: number;
    oi: number;
    oiChg: number;
    volume: number;
    iv: number;
    delta: number;
    theta: number;
    gamma: number;
    vega: number;
    bid?: number;
    ask?: number;
  } | null;
}

// ─── GEX Engine Types ─────────────────────────────────────────────
export interface GEXStrike {
  strike: number;
  callGEX: number;
  putGEX: number;
  netGEX: number;
}

export interface GammaWall {
  strike: number;
  type: 'CE' | 'PE';
  gex: number;
  oi: number;
}

export interface GEXResult {
  gexProfile: GEXStrike[];
  totalGEX: number;
  gammaFlip: number;
  gammaWalls: GammaWall[];
  dealerRegime: 'LONG_GAMMA' | 'SHORT_GAMMA';
  dealerBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  status: 'OK' | 'DEGRADED';
}

// ─── Market Structure Types ───────────────────────────────────────
export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

export interface StructureEvent {
  type: 'BOS' | 'CHoCH' | 'LIQUIDITY_GRAB';
  direction: 'BULLISH' | 'BEARISH';
  price: number;
  time: number;
  swingHigh?: number;
  swingLow?: number;
}

export interface MarketStructure {
  trend: 'UPTREND' | 'DOWNTREND' | 'RANGING';
  swingPoints: SwingPoint[];
  lastSwingHigh: number;
  lastSwingLow: number;
  structureEvent: StructureEvent | null;
  supportLevels: number[];
  resistanceLevels: number[];
  status: 'OK' | 'DEGRADED';
}

// ─── Multi-Timeframe Types ────────────────────────────────────────
export interface TimeframeResult {
  tf: string;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  ema9: number;
  ema21: number;
  emaSlope: number;
  structureTrend: string;
  volumeConfirm: boolean;
  candleCount: number;
}

export interface ConsensusResult {
  timeframes: TimeframeResult[];
  consensus: number;  // -1 to +1
  overallBias: 'STRONG_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONG_BEARISH';
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  status: 'OK' | 'DEGRADED';
}

// ─── Volume Analysis Types ────────────────────────────────────────
export interface VolumeProfileLevel {
  price: number;
  volume: number;
  buyVolume: number;   // estimated
  sellVolume: number;  // estimated
}

export interface AbsorptionLevel {
  price: number;
  side: 'BUY' | 'SELL';
  volume: number;
  priceRange: number;
}

export interface ExhaustionSignal {
  price: number;
  time: number;
  type: 'BUY_EXHAUSTION' | 'SELL_EXHAUSTION';
  volume: number;
}

export interface VolumeAnalysis {
  poc: number;
  vah: number;
  val: number;
  cumulativeDelta: number;
  volumeProfile: VolumeProfileLevel[];
  absorptionLevels: AbsorptionLevel[];
  exhaustionSignals: ExhaustionSignal[];
  totalVolume: number;
  avgVolume: number;
  status: 'OK' | 'DEGRADED';
}

// ─── OI Analysis Types ────────────────────────────────────────────
export type OIPattern = 'LONG_BUILDUP' | 'SHORT_BUILDUP' | 'LONG_UNWINDING' | 'SHORT_COVERING';

export interface OIClassification {
  strike: number;
  callPattern: OIPattern | null;
  putPattern: OIPattern | null;
}

export interface FreshWritingSignal {
  strike: number;
  side: 'CE' | 'PE';
  type: 'FRESH_CALL_WRITING' | 'FRESH_PUT_WRITING';
  oiChange: number;
  oiPercentChange: number;
  ltpDirection: 'UP' | 'DOWN' | 'FLAT';
}

export interface OITrap {
  strike: number;
  type: 'CE_TRAP' | 'PE_TRAP';
  trappedOI: number;
  spotVsStrike: number;
}

export interface SRLines {
  resistance: { strike: number; oi: number; weight: number }[];
  support: { strike: number; oi: number; weight: number }[];
}

export interface OIMigration {
  side: 'CE' | 'PE';
  fromStrike: number;
  toStrike: number;
  oiLost: number;
  oiGained: number;
}

export interface OIAnalysis {
  classifications: OIClassification[];
  freshWriting: FreshWritingSignal[];
  traps: OITrap[];
  supportResistance: SRLines;
  migration: OIMigration[];
  pcrOI: number;
  pcrVolume: number;
  maxPain: number;
  status: 'OK' | 'DEGRADED';
}

// ─── Quality Score Types ──────────────────────────────────────────
export interface QualityScoreFactor {
  name: string;
  score: number;       // 0-100
  weight: number;      // decimal (0.15 = 15%)
  weightedScore: number;
  detail: string;
  source: string;
  direction: 'CALL' | 'PUT' | 'NEUTRAL';
}

export interface QualityScore {
  overall: number;     // 0-100
  grade: TradeGrade;
  factors: QualityScoreFactor[];
  bullishFactors: number;
  bearishFactors: number;
  status: 'OK' | 'DEGRADED';
}

export interface QualityScoreInput {
  spot: number;
  candles: Record<string, CandleData[]>;
  optionChain: SDMOptionStrike[];
  gexResult: GEXResult;
  marketStructure: MarketStructure;
  consensus: ConsensusResult;
  volumeAnalysis: VolumeAnalysis;
  oiAnalysis: OIAnalysis;
  vix: number;
  currentWindow: ExpiryWindow;
  tradeDirection: 'CALL' | 'PUT';
  entryPrice: number;
  stopLoss: number;
  target1: number;
}

// ─── Seller SL Types ──────────────────────────────────────────────
export interface SellerSLLevel {
  level: number;
  type: 'CALL_WRITER_SL' | 'PUT_WRITER_SL';
  score: number;
  status: 'ACTIVE' | 'INACTIVE';
  contributingFactors: string[];
  stopHuntZone: boolean;
  distanceFromSpot: number;
}

export interface SellerSLResult {
  levels: SellerSLLevel[];
  nearestCESL: SellerSLLevel | null;
  nearestPESL: SellerSLLevel | null;
  status: 'OK' | 'DEGRADED';
}

// ─── Smart Entry Types ────────────────────────────────────────────
export interface SmartEntryResult {
  action: SmartEntryAction;
  reason: string;
  currentPrice: number;
  referenceLevel: number;
  atr: number;
  distanceFromLevel: number;
  volumeRatio: number;
  status: 'OK' | 'DEGRADED';
}

// ─── Smart Exit Types ─────────────────────────────────────────────
export interface SmartExitResult {
  action: SmartExitAction;
  newStopLoss?: number;
  reason: string;
  unrealizedPnLPercent: number;
  targetHit: number;        // 0=none, 1=T1, 2=T2, 3=T3
  gexRegimeFlipped: boolean;
  structureReversal: boolean;
  status: 'OK' | 'DEGRADED';
}

// ─── Validation Gate Types ────────────────────────────────────────
export interface ValidationInput {
  healthReport: DataHealthReport;
  qualityGrade: TradeGrade;
  qualityScore: number;
  optionChain: SDMOptionStrike[];
  selectedStrike: number;
  entryPrice: number;
  spot: number;
  riskState: RiskState;
  direction?: 'CALL' | 'PUT';
}

export interface RiskState {
  dailyPnL: number;
  weeklyPnL: number;
  monthlyPnL: number;
  openPositions: number;
  canTrade: boolean;
  blockReason?: string;
  maxDailyLoss: number;
  maxWeeklyLoss: number;
  maxMonthlyLoss: number;
  maxPositionSize: number;
  maxConcurrentTrades: number;
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
}

export interface ValidationResult {
  passed: boolean;
  failedChecks: ValidationCheck[];
  action: 'PROCEED' | 'WAIT' | 'NO_TRADE';
  reason: string;
}

// ─── Risk Management Types ────────────────────────────────────────
export interface PositionSizeInput {
  capital: number;
  riskPerTradePercent: number;
  entryPremium: number;
  stopLossPremium: number;
  lotSize: number;
  maxPositionSize: number;
}

export interface PositionSizeResult {
  lots: number;
  quantity: number;
  riskAmount: number;
  positionValue: number;
  maxLoss: number;
  maxProfit: number;
  target1Premium: number;
}

export interface RiskCheckResult {
  canTrade: boolean;
  blockedBy: string[];
  dailyLossRemaining: number;
  weeklyLossRemaining: number;
  monthlyLossRemaining: number;
  concurrentSlotsRemaining: number;
}

// ─── Self-Learning Types ──────────────────────────────────────────
export interface TradeAnalysis {
  tradeId: string;
  outcome: 'WIN' | 'LOSS';
  validReasons: string[];
  failedReasons: string[];
  entryTiming: 'EARLY' | 'OPTIMAL' | 'LATE';
  exitQuality: 'GOOD' | 'POOR' | 'OPTIMAL';
  holdingTimeMinutes: number;
  maxFavorableExcursion: number;  // max % gain during trade
  maxAdverseExcursion: number;    // max % loss during trade
}

export interface WeightSuggestion {
  factorName: string;
  currentWeight: number;
  suggestedWeight: number;
  rationale: string;
  sampleSize: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface FactorPerformance {
  factorName: string;
  timesPresent: number;
  winRateWhenPresent: number;
  falsePositiveRate: number;
  truePositiveRate: number;
}
