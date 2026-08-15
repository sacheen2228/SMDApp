// Core types for Auction Market Theory + Volume Profile engine
// Used by both Equity Cash and F&O algorithms

export type MarketRegime =
  | 'TRENDING_UP'
  | 'TRENDING_DOWN'
  | 'BALANCED'
  | 'RANGING'
  | 'BREAKOUT'
  | 'FAILED_BREAKOUT'
  | 'REVERSAL'
  | 'ACCUMULATION'
  | 'DISTRIBUTION'
  | 'HIGH_VOLATILITY'
  | 'LOW_VOLATILITY'
  | 'TRANSITION';

export type AuctionState =
  | 'PRICE_ABOVE_VALUE'
  | 'PRICE_INSIDE_VALUE'
  | 'PRICE_BELOW_VALUE';

export type AcceptanceType =
  | 'ACCEPTANCE'
  | 'REJECTION'
  | 'VALUE_MIGRATION_HIGHER'
  | 'VALUE_MIGRATION_LOWER'
  | 'BALANCE'
  | 'IMBALANCE'
  | 'VALUE_EXPANSION'
  | 'VALUE_CONTRACTION';

export type GapType =
  | 'GAP_UP'
  | 'GAP_DOWN'
  | 'PARTIAL_GAP_UP'
  | 'PARTIAL_GAP_DOWN'
  | 'FULL_GAP_UP'
  | 'FULL_GAP_DOWN'
  | 'GAP_FILL'
  | 'GAP_AND_GO'
  | 'GAP_AND_FAIL'
  | 'GAP_REVERSAL';

export type LiquidityEvent =
  | 'LIQUIDITY_SWEEP_HIGH'
  | 'LIQUIDITY_SWEEP_LOW'
  | 'FAILED_BREAKOUT'
  | 'FAILED_BREAKDOWN'
  | 'EQUAL_HIGHS_SWEEP'
  | 'EQUAL_LOWS_SWEEP';

export type MarketStructureEvent =
  | 'HH' | 'HL' | 'LH' | 'LL'
  | 'BOS_BULLISH' | 'BOS_BEARISH'
  | 'CHOCH_BULLISH' | 'CHOCH_BEARISH'
  | 'STRUCTURAL_FAILURE_BULLISH' | 'STRUCTURAL_FAILURE_BEARISH'
  | 'DISPLACEMENT_UP' | 'DISPLACEMENT_DOWN';

export type VWAPState =
  | 'VWAP_RECLAIM'
  | 'VWAP_REJECTION'
  | 'VWAP_ACCEPTANCE'
  | 'VWAP_FAILURE'
  | 'ABOVE_VWAP'
  | 'BELOW_VWAP';

export type FuturesOIState =
  | 'LONG_BUILDUP'
  | 'SHORT_BUILDUP'
  | 'SHORT_COVERING'
  | 'LONG_UNWINDING'
  | 'NEUTRAL';

export type IVState = 'LOW_IV' | 'NORMAL_IV' | 'HIGH_IV' | 'EXTREME_IV';

export type SignalStrength = 'A+' | 'A' | 'B' | 'WATCH' | 'NO_TRADE';

export type TradeDirection = 'LONG' | 'SHORT' | 'NO_TRADE';

export type SetupType =
  // Equity Cash
  | 'VAL_RECLAIM'
  | 'PREV_LOW_SWEEP_RECLAIM'
  | 'VWAP_RECLAIM'
  | 'OPENING_RANGE_BREAKOUT'
  | 'LVN_BREAKOUT'
  | 'HVN_REJECTION_BULLISH'
  | 'FAILED_BREAKDOWN'
  | 'GAP_REVERSAL'
  | 'POC_RECLAIM'
  | 'VAH_REJECTION'
  | 'PREV_HIGH_SWEEP_REJECTION'
  | 'VWAP_REJECTION'
  | 'OPENING_RANGE_BREAKDOWN'
  | 'LVN_BREAKDOWN'
  | 'HVN_REJECTION_BEARISH'
  | 'FAILED_BREAKOUT'
  | 'GAP_FAILURE'
  | 'POC_REJECTION'
  // F&O
  | 'VAL_RECLAIM_FO'
  | 'VAH_REJECTION_FO'
  | 'POC_RECLAIM_FO'
  | 'LVN_BREAKOUT_FO'
  | 'HVN_REJECTION_FO'
  | 'OPENING_RANGE_BREAKOUT_FO'
  | 'OPENING_RANGE_FAILURE_FO'
  | 'LIQUIDITY_SWEEP_FO'
  | 'FAILED_BREAKOUT_FO'
  | 'CVD_DELTA_CONFIRMATION'
  | 'FUTURES_OI_CONFIRMATION'
  | 'OPTION_CHAIN_CONFIRMATION';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  deliveryVolume?: number;
  deliveryPct?: number;
}

export interface VolumeProfileLevel {
  price: number;
  volume: number;
  buyVolume?: number;
  sellVolume?: number;
  delta?: number;
  percentage: number;
}

export interface VolumeProfile {
  poc: number;
  vah: number;
  val: number;
  hvn: number[];
  lvn: number[];
  nakedPoc: number[];
  volumeGaps: { start: number; end: number }[];
  levels: VolumeProfileLevel[];
  totalVolume: number;
  valueAreaVolume: number;
  developingPoc?: number;
  developingVah?: number;
  developingVal?: number;
}

export interface SessionProfile extends VolumeProfile {
  date: string;
  sessionHigh: number;
  sessionLow: number;
  openingRange: { high: number; low: number; time: number };
  initialBalance: { high: number; low: number };
  first15mRange: { high: number; low: number };
  first30mRange: { high: number; low: number };
  sessionVwap: number;
  prevDayHigh: number;
  prevDayLow: number;
  prevWeekHigh: number;
  prevWeekLow: number;
}

export interface CompositeProfile extends VolumeProfile {
  weeks: number;
  profiles: SessionProfile[];
}

export interface SwingPoint {
  time: number;
  price: number;
  type: 'HIGH' | 'LOW';
  strength: number;
  volume: number;
}

export interface StructurePoint {
  swing: SwingPoint;
  isValid: boolean;
  displaced: boolean;
}

export interface VwapAnchor {
  price: number;
  time: number;
  type: 'SESSION' | 'WEEKLY' | 'MONTHLY' | 'ANCHORED';
  anchorTime: number;
}

export interface RelativeVolume {
  current: number;
  average: number;
  ratio: number;
  percentile: number;
  acceleration: number;
}

export interface VolumeAtPrice {
  price: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  cumulativeDelta: number;
}

export interface GapInfo {
  type: GapType;
  gapSize: number;
  gapPercent: number;
  openedAbove: boolean;
  filled: boolean;
  fillTime?: number;
  fillPrice?: number;
  gapAndGo: boolean;
}

export interface LiquidityLevel {
  price: number;
  type: 'PDH' | 'PDL' | 'PWH' | 'PWL' | 'SESSION_HIGH' | 'SESSION_LOW' | 'SWING_HIGH' | 'SWING_LOW' | 'EQUAL_HIGH' | 'EQUAL_LOW' | 'RANGE_HIGH' | 'RANGE_LOW' | 'STRIKE';
  strength: number;
  touches: number;
  lastTouch: number;
  swept: boolean;
  sweepTime?: number;
}

export interface OptionChainStrike {
  strike: number;
  expiry: string;
  ce: OptionMetrics;
  pe: OptionMetrics;
}

export interface OptionMetrics {
  ltp: number;
  volume: number;
  oi: number;
  oiChange: number;
  iv: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  spread: number;
  spreadPct: number;
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

export interface FuturesData {
  symbol: string;
  spot: number;
  futures: number;
  basis: number;
  basisPct: number;
  volume: number;
  oi: number;
  oiChange: number;
  oiChangePct: number;
  priceChange: number;
  priceChangePct: number;
  oiState: FuturesOIState;
}

export interface MarketData {
  symbol: string;
  candles: Candle[];
  sessionProfile: SessionProfile;
  compositeProfile: CompositeProfile;
  swings: SwingPoint[];
  structure: StructurePoint[];
  vwapAnchors: VwapAnchor[];
  relativeVolume: RelativeVolume;
  volumeAtPrice: VolumeAtPrice[];
  gaps: GapInfo[];
  liquidityLevels: LiquidityLevel[];
  optionChain?: OptionChainSnapshot;
  futures?: FuturesData;
  regime: MarketRegime;
  auctionState: AuctionState;
  acceptance: AcceptanceType;
  valueMigration: 'HIGHER' | 'LOWER' | 'NEUTRAL';
}

export interface SignalScore {
  auctionStructure: number;
  volumeProfile: number;
  liquidity: number;
  marketStructure: number;
  volume: number;
  vwap: number;
  marketRegime: number;
  futuresOI?: number;
  optionChain?: number;
  ivGreeks?: number;
  total: number;
  strength: SignalStrength;
}

export interface EntryPlan {
  aggressive: number;
  confirmation: number;
  retest: number;
}

export interface StopLoss {
  price: number;
  type: 'SWING' | 'LIQUIDITY' | 'VALUE_AREA' | 'VWAP' | 'PROFILE_LEVEL';
  reason: string;
}

export interface Target {
  price: number;
  type: 'LIQUIDITY' | 'PREV_HIGH_LOW' | 'POC' | 'VAH' | 'VAL' | 'HVN' | 'LVN';
  rr: number;
}

export interface TradePlan {
  symbol: string;
  direction: TradeDirection;
  setup: SetupType;
  entry: EntryPlan;
  stopLoss: StopLoss;
  targets: Target[];
  maxLoss: number;
  maxProfit: number;
  breakeven: number;
  riskReward: number;
  signalScore: SignalScore;
  historicalExpectancy: number;
  finalDecision: TradeDirection;
}

export interface BacktestMetrics {
  winRate: number;
  profitFactor: number;
  expectancy: number;
  averageR: number;
  maxDrawdown: number;
  mae: number;
  mfe: number;
  longPerformance: { winRate: number; profitFactor: number; expectancy: number };
  shortPerformance: { winRate: number; profitFactor: number; expectancy: number };
  setupPerformance: Map<SetupType, { winRate: number; profitFactor: number; expectancy: number }>;
  stockPerformance: Map<string, { winRate: number; profitFactor: number; expectancy: number }>;
  sectorPerformance: Map<string, { winRate: number; profitFactor: number; expectancy: number }>;
  sessionPerformance: Map<string, { winRate: number; profitFactor: number; expectancy: number }>;
}

export interface CostModel {
  brokerage: number;
  stt: number;
  exchangeCharges: number;
  gst: number;
  stampDuty: number;
  sebiCharges: number;
  slippage: number;
}

export interface FinalAnalysis {
  symbol: string;
  regime: MarketRegime;
  auctionState: AuctionState;
  valueLocation: 'ABOVE_VAH' | 'INSIDE_VALUE' | 'BELOW_VAL';
  poc: number;
  vah: number;
  val: number;
  liquidityEvent: LiquidityEvent | null;
  structure: MarketStructureEvent | null;
  volumeState: string;
  vwapState: VWAPState;
  setup: SetupType | null;
  longScore: number;
  shortScore: number;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  rr: number;
  signalStrength: SignalStrength;
  historicalExpectancy: number;
  finalDecision: TradeDirection;
  tradePlan?: TradePlan;
}