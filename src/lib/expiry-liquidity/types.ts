// ─── Core Types for Expiry Liquidity Shift Engine ──────────────────────
// Comprehensive type definitions for the CAS + Expiry Liquidity Engine

// ─── Instrument & Market Context ──────────────────────────────────────
export interface ExpiryInstrument {
  symbol: string;
  exchange: 'NSE' | 'BSE';
  segment: 'INDEX' | 'FNO_STOCK';
  lotSize: number;
  tickSize: number;
  expiryDate: string;           // YYYY-MM-DD
  daysToExpiry: number;
  isExpiryDay: boolean;
  expiryType: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY';
}

export interface MarketSnapshot {
  timestamp: number;
  spot: number;
  spotChange: number;
  spotChangePct: number;
  vix: number;
  pcr: number;
  maxPain: number;
  atmStrike: number;
  totalCallOI: number;
  totalPutOI: number;
  callOiChange: number;
  putOiChange: number;
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  sessionMinutes: number;
  minutesToExpiry: number;
  isExpiryDay: boolean;
  atr: number;
  expectedMove: number;
  breadth: MarketBreadth;
  sectorHeatmap: SectorHeatmap[];
  futures: FuturesSnapshot | null;
  optionChain: OptionChainSnapshot | null;
}

export interface MarketBreadth {
  advances: number;
  declines: number;
  unchanged: number;
  advanceDeclineRatio: number;
  pctAboveVWAP: number;
  pctPositive: number;
  pctAccelerating: number;
  breadthScore: number; // 0-100
}

export interface SectorHeatmap {
  name: string;
  changePct: number;
  advanceCount: number;
  declineCount: number;
  volume: number;
  breadth: number;
  strength: 'STRONG' | 'MODERATE' | 'WEAK' | 'NEUTRAL';
}

export interface FuturesSnapshot {
  symbol: string;
  spot: number;
  futuresPrice: number;
  basis: number;
  basisPct: number;
  basisVelocity: number;
  basisAcceleration: number;
  basisChange: number;
  oi: number;
  oiChange: number;
  oiChangePct: number;
  volume: number;
  priceChange: number;
  priceChangePct: number;
  oiState: 'LONG_BUILDUP' | 'SHORT_BUILDUP' | 'SHORT_COVERING' | 'LONG_UNWINDING' | 'NEUTRAL';
}

export interface OptionChainSnapshot {
  symbol: string;
  spot: number;
  atmStrike: number;
  expiry: string;
  strikes: OptionChainStrike[];
  callOiMap: Map<number, number>;
  putOiMap: Map<number, number>;
  callOiChangeMap: Map<number, number>;
  putOiChangeMap: Map<number, number>;
  callVolumeMap: Map<number, number>;
  putVolumeMap: Map<number, number>;
  maxPain: number;
  pcr: number;
  ivRank: number;
  ivPercentile: number;
  atmIV: number;
  ivSkew: number;
}

export interface OptionChainStrike {
  strike: number;
  expiry: string;
  ce: OptionLegMetrics;
  pe: OptionLegMetrics;
}

export interface OptionLegMetrics {
  ltp: number;
  prevLtp: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  volume: number;
  prevVolume: number;
  oi: number;
  prevOi: number;
  oiChange: number;
  oiChangePct: number;
  iv: number;
  prevIv: number;
  ivChange: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  spread: number;
  spreadPct: number;
  premiumVelocity: number;    // LTP change per minute
  premiumAcceleration: number; // velocity change per minute
  ivVelocity: number;         // IV change per minute
  ivAcceleration: number;     // IV velocity change per minute
  volumeVelocity: number;     // volume change per minute
  oiVelocity: number;         // OI change per minute
}

// ─── CAS Reference & Dislocation ──────────────────────────────────────
export interface CASReference {
  referencePrice: number;      // VWAP 15:00-15:15
  referenceVWAP: number;
  referenceVolume: number;
  referenceHigh: number;
  referenceLow: number;
  referenceTimestamp: number;  // end of 15:15
  isValid: boolean;
}

export interface CASDislocation {
  currentIndicativePrice: number;
  dislocation: number;         // current - reference
  dislocationPct: number;      // (current - reference) / reference * 100
  dislocationVelocity: number; // dislocation change per minute
  dislocationAcceleration: number;
  isAboveReference: boolean;
  strength: 'NONE' | 'WEAK' | 'MODERATE' | 'STRONG' | 'EXTREME';
}

// ─── OI Classification ────────────────────────────────────────────────
export type OIClassification =
  | 'LONG_BUILDUP'
  | 'SHORT_BUILDUP'
  | 'SHORT_COVERING'
  | 'LONG_UNWINDING'
  | 'OI_ACCUMULATION'
  | 'OI_DISTRIBUTION'
  | 'NEUTRAL';

export interface OIFlowAnalysis {
  classification: OIClassification;
  signal: string;
  strength: number; // 0-100
  oiChange: number;
  oiChangePct: number;
  priceChange: number;
  priceChangePct: number;
  volumeSupport: boolean;      // volume confirms the OI move
  velocity: number;            // OI change per minute
  isRapid: boolean;            // rapid OI change (>10% in 5 min)
  callOIFlow: OILegFlow;
  putOIFlow: OILegFlow;
  netOIFlow: number;           // call OI change - put OI change
}

export interface OILegFlow {
  classification: OIClassification;
  oiChange: number;
  oiChangePct: number;
  volume: number;
  premiumChange: number;
  velocity: number;
}

// ─── Premium Velocity & Acceleration ─────────────────────────────────
export interface PremiumVelocityAnalysis {
  strike: number;
  type: 'CE' | 'PE';
  ltp: number;
  prevLtp: number;
  velocity: number;          // LTP change per minute
  acceleration: number;      // velocity change per minute
  velocityZScore: number;    // vs historical intraday
  accelerationZScore: number;
  isAbnormal: boolean;       // exceeds 2.5 std dev
  direction: 'UP' | 'DOWN' | 'FLAT';
  strength: 'NONE' | 'WEAK' | 'MODERATE' | 'STRONG' | 'EXTREME';
  timeToExpiryMinutes: number;
  thetaDrag: number;         // theta per minute
  premiumGainPerPoint: number; // expected premium gain per 1 point spot move
}

// ─── IV Velocity ──────────────────────────────────────────────────────
export interface IVVelocityAnalysis {
  strike: number;
  type: 'CE' | 'PE';
  iv: number;
  prevIv: number;
  velocity: number;          // IV change per minute
  acceleration: number;      // IV velocity change per minute
  state: 'IV_EXPANSION' | 'IV_CONTRACTION' | 'IV_SHOCK' | 'NORMAL';
  ivRank: number;            // 0-100 percentile of today's IV
  ivPercentile: number;
  isExtreme: boolean;        // IV velocity > 2 std dev
}

// ─── Volume Velocity ──────────────────────────────────────────────────
export interface VolumeVelocityAnalysis {
  strike: number;
  type: 'CE' | 'PE';
  volume: number;
  expectedVolume: number;    // based on intraday baseline
  volumeRatio: number;       // current / expected
  velocity: number;          // volume change per minute
  acceleration: number;
  state: 'NORMAL' | 'HIGH_VOLUME' | 'ABNORMAL_VOLUME' | 'EXTREME_VOLUME';
  isConfirming: boolean;     // volume supports price move
}

// ─── Gamma Pressure ──────────────────────────────────────────────────
export interface GammaPressureAnalysis {
  strike: number;
  type: 'CE' | 'PE';
  gamma: number;
  gammaEfficiency: number;    // gamma * 1000 for ATM, * 200 for OTM
  distanceFromATM: number;
  isATM: boolean;
  nearATM: boolean;
  expiryBoost: number;        // 2.0 on expiry day, 1.5 if <=2 days
  gammaPressureScore: number; // 0-100
  dealerHedgingPressure: 'HIGH' | 'MODERATE' | 'LOW';
  gammaWall: boolean;         // gamma > 2x average
  expectedDealerFlow: 'BUY' | 'SELL' | 'NEUTRAL';
}

// ─── OI Concentration ────────────────────────────────────────────────
export interface OIConcentrationAnalysis {
  highestCallOIStrike: number;
  highestCallOI: number;
  highestPutOIStrike: number;
  highestPutOI: number;
  callOIConcentration: number;   // % of total call OI at top 3 strikes
  putOIConcentration: number;    // % of total put OI at top 3 strikes
  atmOIConcentration: number;    // % of total OI at ATM ± 1 strike
  majorResistanceStrikes: number[];
  majorSupportStrikes: number[];
  resistanceStrength: Map<number, number>; // strike -> strength
  supportStrength: Map<number, number>;
  rapidUnwinding: boolean;       // major OI unwinding rapidly
  unwindingStrikes: number[];
}

// ─── Support/Resistance ───────────────────────────────────────────────
export interface SupportResistanceLevel {
  price: number;
  type: 'OI_WALL' | 'VOLUME_PROFILE' | 'VWAP' | 'PDH' | 'PDL' | 'PWH' | 'PWL' | 'SWING_HIGH' | 'SWING_LOW' | 'OPENING_RANGE' | 'MAX_PAIN' | 'ATM_STRIKE';
  strength: number; // 0-100
  touches: number;
  isActive: boolean; // price near level
  source: string;    // which engine detected it
}

export interface SupportResistanceAnalysis {
  levels: SupportResistanceLevel[];
  nearestResistance: SupportResistanceLevel | null;
  nearestSupport: SupportResistanceLevel | null;
  currentPrice: number;
  distanceToResistancePct: number;
  distanceToSupportPct: number;
  inValueArea: boolean;
  valueAreaHigh: number;
  valueAreaLow: number;
  poc: number;
}

// ─── Auction Theory ───────────────────────────────────────────────────
export type AuctionState =
  | 'BALANCE'
  | 'IMBALANCE'
  | 'ACCEPTANCE'
  | 'REJECTION'
  | 'VALUE_MIGRATION_HIGHER'
  | 'VALUE_MIGRATION_LOWER'
  | 'VALUE_EXPANSION'
  | 'VALUE_CONTRACTION'
  | 'FAILED_AUCTION'
  | 'BREAKOUT'
  | 'BREAKDOWN'
  | 'INITIATIVE_BUYING'
  | 'INITIATIVE_SELLING';

export interface AuctionTheoryAnalysis {
  state: AuctionState;
  poc: number;
  vah: number;
  val: number;
  pocMigration: number;       // vs previous session
  vahMigration: number;
  valMigration: number;
  valueAreaExpanded: boolean;
  valueAreaContracted: boolean;
  priceLocation: 'ABOVE_VAH' | 'INSIDE_VALUE' | 'BELOW_VAL';
  acceptanceType: 'ACCEPTANCE' | 'REJECTION' | 'NEUTRAL';
  rejectionStrength: number; // if rejected
  initiativeBuying: boolean;
  initiativeSelling: boolean;
  failedAuction: boolean;
  balance: boolean;
}

// ─── Market Breadth ──────────────────────────────────────────────────
export interface MarketBreadthAnalysis {
  advances: number;
  declines: number;
  unchanged: number;
  advanceDeclineRatio: number;
  pctAboveVWAP: number;
  pctAboveEMA20: number;
  pctAboveEMA50: number;
  pctAboveEMA200: number;
  new52WeekHighs: number;
  new52WeekLows: number;
  freshDayHighs: number;
  freshDayLows: number;
  volumeAdvancing: number;
  volumeDeclining: number;
  volumeRatio: number;
  breadthScore: number; // 0-100
  label: 'STRONG_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONG_BEARISH';
}

// ─── Heatmap Confirmation ────────────────────────────────────────────
export interface HeatmapConfirmation {
  sectorStrength: Map<string, number>; // sector -> strength
  sectorLeaders: string[];
  sectorLaggards: string[];
  breadthExpansion: boolean;
  breadthContraction: boolean;
  leadership: 'ROTATING' | 'CONCENTRATED' | 'BROAD' | 'NARROW';
  heatmapAlignment: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'DIVERGING';
}

// ─── Liquidity Event State Machine ────────────────────────────────────
export type LiquidityEventState =
  | 'NORMAL'
  | 'BUILDING'
  | 'LIQUIDITY_SHIFT'
  | 'BREAKOUT'
  | 'ACCELERATION'
  | 'EXHAUSTION'
  | 'REVERSAL'
  | 'FAILED_BREAKOUT'
  | 'FAILED_BREAKDOWN';

export interface LiquidityEventAnalysis {
  state: LiquidityEventState;
  previousState: LiquidityEventState;
  stateDuration: number; // minutes in current state
  transitionReason: string;
  confidence: number; // 0-100
  nextExpectedState: LiquidityEventState | null;
}

// ─── Exhaustion & Reversal Detection ─────────────────────────────────
export interface ExhaustionAnalysis {
  isExhausted: boolean;
  type: 'MOMENTUM' | 'VOLUME' | 'IV' | 'OI' | 'PRICE' | 'COMPOSITE';
  signals: ExhaustionSignal[];
  exhaustionScore: number; // 0-100
  timeToExhaustion: number; // estimated minutes
}

export interface ExhaustionSignal {
  type: 'PRICE_ACCELERATION_DROP' | 'VOLUME_DIVERGENCE' | 'PREMIUM_ACCELERATION_DROP' | 'IV_SPIKE' | 'OI_STOPS_CONFIRMING' | 'BREADTH_DETERIORATION' | 'PRICE_RETURNS_TO_VWAP';
  strength: 'WEAK' | 'MODERATE' | 'STRONG';
  description: string;
}

export interface ReversalAnalysis {
  reversalRisk: 'NONE' | 'LOW' | 'MODERATE' | 'HIGH' | 'IMMINENT';
  type: 'BULLISH_TO_BEARISH' | 'BEARISH_TO_BULLISH' | 'NONE';
  signals: ReversalSignal[];
  reversalScore: number; // 0-100
  invalidationLevel: number;
}

export interface ReversalSignal {
  type: 'CAS_DISLOCATION_REVERSAL' | 'FUTURES_REVERSAL' | 'OI_REVERSAL' | 'PREMIUM_REVERSAL' | 'VOLUME_DIVERGENCE' | 'BREADTH_DIVERGENCE';
  strength: 'WEAK' | 'MODERATE' | 'STRONG';
  description: string;
  confirmingIndicators: string[];
}

// ─── Expiry Liquidity Score ──────────────────────────────────────────
export interface ExpiryLiquidityScore {
  totalScore: number; // 0-100
  level: 'NO_EVENT' | 'WATCH' | 'DEVELOPING' | 'STRONG' | 'HIGH_CONVICTION' | 'EXTREME_LIQUIDITY_EVENT';
  components: ScoreComponent[];
  bullishScore: number;
  bearishScore: number;
  direction: 'BULLISH' | 'BEARISH' | 'NO_DIRECTION';
  confidence: number; // 0-100
}

export interface ScoreComponent {
  name: string;
  weight: number; // percentage
  score: number; // 0-100
  weightedScore: number;
  description: string;
}

// ─── Direction Engine ────────────────────────────────────────────────
export interface DirectionAnalysis {
  bullishScore: number; // 0-100
  bearishScore: number; // 0-100
  direction: 'BULLISH' | 'BEARISH' | 'NO_DIRECTION';
  netScore: number; // bullish - bearish
  confirmingFactors: string[];
  divergingFactors: string[];
}

// ─── Trade Signal ────────────────────────────────────────────────────
export type TradeSignalType =
  | 'LONG_CALL'
  | 'LONG_PUT'
  | 'CALL_SHORT_COVERING'
  | 'PUT_SHORT_COVERING'
  | 'FUTURES_LONG'
  | 'FUTURES_SHORT'
  | 'NO_TRADE'
  | 'WATCH';

export interface TradeSignal {
  type: TradeSignalType;
  symbol: string;
  expiry: string;
  strike: number;
  optionType: 'CE' | 'PE' | 'FUTURES';
  direction: 'BULLISH' | 'BEARISH';
  score: number; // 0-100
  confidence: 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW';
  entryTrigger: EntryTrigger;
  entry: EntryZone;
  stopLoss: StopLossPlan;
  targets: TargetPlan[];
  riskReward: number;
  reason: string[];
  risks: string[];
  invalidation: InvalidationPlan;
  status: 'WAITING' | 'CONFIRMING' | 'CONFIRMED' | 'TRIGGERED' | 'ACTIVE' | 'EXHAUSTED' | 'INVALIDATED';
  timestamp: number;
  dataQuality: number; // 0-100
}

export interface EntryTrigger {
  condition: string;
  waitingFor: string[];
  confirmed: boolean;
  triggerPrice: number | null;
}

export interface EntryZone {
  preferred: number;
  range: { low: number; high: number };
  maxSlippage: number;
  chaseRisk: boolean;
  chaseRiskReason: string | null;
}

export interface StopLossPlan {
  price: number;
  type: 'SWING' | 'LIQUIDITY' | 'VALUE_AREA' | 'VWAP' | 'CAS_REFERENCE' | 'STRUCTURE' | 'ATR';
  reason: string;
  atrBased: number;
  structureBased: number;
  selected: number;
  buffer: number;
}

export interface TargetPlan {
  price: number;
  type: 'OI_WALL' | 'VOLUME_PROFILE' | 'HVN' | 'LVN' | 'PREV_HIGH_LOW' | 'ATR' | 'FUTURES_LEVEL' | 'OPTION_CHAIN';
  rr: number;
  probability: number;
  description: string;
}

export interface InvalidationPlan {
  condition: string;
  price: number;
  reason: string;
}

// ─── Entry Trigger Engine ────────────────────────────────────────────
export interface EntryConfirmationWindow {
  isOpen: boolean;
  openedAt: number | null;
  closesAt: number | null;
  conditions: ConfirmationCondition[];
  allConfirmed: boolean;
  confirmedCount: number;
  requiredCount: number;
}

export interface ConfirmationCondition {
  name: string;
  description: string;
  confirmed: boolean;
  confirmedAt: number | null;
  required: boolean;
}

// ─── False Breakout Protection ───────────────────────────────────────
export interface FalseBreakoutProtection {
  isProtected: boolean;
  risk: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
  reasons: string[];
  confirmationWindow: number; // minutes
  retestRequired: boolean;
  acceptanceRequired: boolean;
}

// ─── Risk/Reward & Target Engine ─────────────────────────────────────
export interface RiskRewardAnalysis {
  riskReward: number;
  minAcceptable: number; // configurable
  isAcceptable: boolean;
  risk: number;
  reward: number;
  riskPct: number;
  rewardPct: number;
}

export interface TargetZone {
  price: number;
  type: string;
  rr: number;
  probability: number;
  distanceFromEntryPct: number;
  isStructureLevel: boolean;
}

// ─── Time Decay / Expiry Risk ────────────────────────────────────────
export interface ExpiryRiskAnalysis {
  minutesToExpiry: number;
  thetaRisk: number; // 0-100
  premiumDecayRisk: number;
  ivRisk: number;
  liquidityRisk: number;
  overallRisk: 'LOW' | 'MODERATE' | 'HIGH' | 'EXTREME';
  maxHoldMinutes: number;
  recommendedExitBefore: number; // minutes before expiry
  thetaDragPerMinute: number;
  premiumAtRisk: number;
}

// ─── CAS Expiry Mode ─────────────────────────────────────────────────
export interface CASExpiryModeState {
  isActive: boolean;
  casStartTime: number;     // 15:15
  casEndTime: number;       // 15:35
  foEndTime: number;        // 15:40
  timeRemainingCas: number; // minutes
  timeRemainingFo: number;  // minutes
  phase: 'REFERENCE' | 'TRANSITION' | 'ORDER_ENTRY' | 'LIMIT_ONLY' | 'MATCHING' | 'DERIVATIVES_ONLY' | 'INACTIVE';
  countdownLabel: string;
}

// ─── Margin / Calendar Spread Risk ───────────────────────────────────
export interface MarginRiskAnalysis {
  score: number; // 0-100
  level: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  factors: MarginRiskFactor[];
  calendarSpreadExposure: boolean;
  rapidPositionReduction: boolean;
  oiConcentrationRisk: number;
  futuresOptionsDislocation: number;
}

export interface MarginRiskFactor {
  name: string;
  value: number;
  threshold: number;
  isTriggered: boolean;
  weight: number;
}

// ─── Signal Card / Explanation ───────────────────────────────────────
export interface SignalExplanation {
  signal: TradeSignal;
  why: string[];       // confirming factors
  risks: string[];     // risk factors
  dataQuality: number; // 0-100
  missingData: string[];
  assumptions: string[];
}

// ─── Configuration ───────────────────────────────────────────────────
export interface ExpiryLiquidityConfig {
  // Scoring weights (must sum to 100)
  weights: {
    casDislocation: number;
    futuresConfirmation: number;
    oiFlow: number;
    premiumVelocity: number;
    volumeAcceleration: number;
    ivBehaviour: number;
    gammaExpiryPressure: number;
    volumeProfile: number;
    auctionTheory: number;
    marketBreadth: number;
    heatmap: number;
  };

  // Signal thresholds
  thresholds: {
    minimumExpiryScore: number;
    minimumVolumeRatio: number;
    minimumCASDislocation: number;
    minimumOIVelocity: number;
    minimumRiskReward: number;
    confirmationWindowMinutes: number;
    premiumChaseThreshold: number; // max premium expansion %
    maxSpreadPct: number;
    minLiquidityVolume: number;
    minOI: number;
  };

  // Risk management
  risk: {
    maxPremiumRisk: number;
    maxSlippage: number;
    maxSpread: number;
    maxDailyLoss: number;
    maxOpenPositions: number;
    maxExposure: number;
    positionSizePct: number;
  };

  // CAS settings
  cas: {
    referenceWindowStart: string; // "15:00"
    referenceWindowEnd: string;   // "15:15"
    dislocationThreshold: number;
    confirmationWindowMinutes: number;
  };

  // Alert settings
  alerts: {
    cooldownMinutes: number;
    enabledAlerts: string[];
  };
}

export const DEFAULT_EXPIRY_LIQUIDITY_CONFIG: ExpiryLiquidityConfig = {
  weights: {
    casDislocation: 15,
    futuresConfirmation: 15,
    oiFlow: 15,
    premiumVelocity: 10,
    volumeAcceleration: 10,
    ivBehaviour: 5,
    gammaExpiryPressure: 10,
    volumeProfile: 5,
    auctionTheory: 5,
    marketBreadth: 5,
    heatmap: 5,
  },
  thresholds: {
    minimumExpiryScore: 50,
    minimumVolumeRatio: 1.5,
    minimumCASDislocation: 0.2, // %
    minimumOIVelocity: 0.05, // 5% per 5 min
    minimumRiskReward: 1.5,
    confirmationWindowMinutes: 5,
    premiumChaseThreshold: 30, // %
    maxSpreadPct: 5,
    minLiquidityVolume: 1000,
    minOI: 500,
  },
  risk: {
    maxPremiumRisk: 5000,
    maxSlippage: 2,
    maxSpread: 3,
    maxDailyLoss: 10000,
    maxOpenPositions: 5,
    maxExposure: 50000,
    positionSizePct: 2,
  },
  cas: {
    referenceWindowStart: '15:00',
    referenceWindowEnd: '15:15',
    dislocationThreshold: 0.2,
    confirmationWindowMinutes: 5,
  },
  alerts: {
    cooldownMinutes: 15,
    enabledAlerts: [
      'EXPIRY_EVENT_DETECTED',
      'CAS_DISLOCATION',
      'OI_UNWINDING',
      'SHORT_COVERING',
      'PREMIUM_ACCELERATION',
      'IV_SHOCK',
      'FUTURES_CONFIRMATION',
      'BREAKOUT_CONFIRMED',
      'BREAKDOWN_CONFIRMED',
      'MOMENTUM_EXHAUSTION',
      'REVERSAL_RISK',
    ],
  },
};

// ─── Data Quality ────────────────────────────────────────────────────
export interface DataQualityReport {
  score: number; // 0-100
  isUsable: boolean;
  issues: DataQualityIssue[];
  staleFields: string[];
  missingFields: string[];
  latencyMs: number;
}

export interface DataQualityIssue {
  field: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  description: string;
  impact: string;
}

// ─── Final Engine Output ────────────────────────────────────────────
export interface ExpiryLiquidityEngineOutput {
  symbol: string;
  timestamp: number;
  isExpiryDay: boolean;
  casActive: boolean;
  casReferencePrice: number;
  currentPrice: number;
  casDislocationPct: number;
  futuresPrice: number;
  futuresConfirmed: boolean;
  atmStrike: number;
  bullishScore: number;
  bearishScore: number;
  expiryScore: number;
  direction: 'BULLISH' | 'BEARISH' | 'NO_DIRECTION';
  optionFlow: 'LONG_BUILDUP' | 'SHORT_BUILDUP' | 'SHORT_COVERING' | 'LONG_UNWINDING' | 'NEUTRAL';
  volumeRatio: number;
  ivState: 'IV_EXPANSION' | 'IV_CONTRACTION' | 'IV_SHOCK' | 'NORMAL';
  auctionState: string;
  volumeProfileState: string;
  liquidityState: string;
  signal: TradeSignalType;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  target3: number;
  riskReward: number;
  dataQuality: number;
  status: 'WAITING_CONFIRMATION' | 'CONFIRMING' | 'CONFIRMED' | 'TRIGGERED' | 'ACTIVE' | 'EXHAUSTED' | 'INVALIDATED' | 'WAITING';
  explainability: SignalExplanation;
  casExpiryMode: CASExpiryModeState;
  marginRisk: MarginRiskAnalysis;
  liquidityEvent: LiquidityEventAnalysis;
  exhaustion: ExhaustionAnalysis;
  reversal: ReversalAnalysis;
}

export interface SignalExplanation {
  signal: TradeSignalType;
  why: string[];
  risks: string[];
  dataQuality: number;
  missingData: string[];
  assumptions: string[];
}

// Re-export from auction-types for consistency
export type {
  FuturesOIState,
  MarketRegime,
  AuctionState,
  AcceptanceType,
  VWAPState,
  SignalStrength,
  TradeDirection,
  SetupType,
} from '@/lib/auction-types';