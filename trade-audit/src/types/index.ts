/**
 * Core domain types for the Trade Recorder & Backtest Verification Engine.
 *
 * Design note: high-cardinality / rarely-filtered context (Greeks, SMC
 * structure, option-chain snapshot, etc.) is stored as a single JSON blob
 * per trade rather than one column each. This keeps the table sane while
 * still capturing the full institutional snapshot the spec calls for.
 * Everything you'd actually filter or aggregate on (strategy, symbol,
 * status, confidence, session, dates, R-multiple, pnl) is a real indexed
 * column — see db/index.ts.
 */

// A known set of strategy IDs, but the field stays a free string so new
// strategy modules can start recording without a code change here.
export const KNOWN_STRATEGY_IDS = [
  "SMC",
  "ZERO_HERO_AI",
  "BREAKOUT",
  "MOMENTUM",
  "OI_GREEKS",
  "OPTION_CHAIN",
  "VOLUME_PROFILE",
  "VWAP",
  "EMA",
  "BTST",
] as const;

export type KnownStrategyId = (typeof KNOWN_STRATEGY_IDS)[number];
export type StrategyId = KnownStrategyId | (string & {});

export type InstrumentType = "EQUITY" | "FUTURES" | "OPTIONS" | "INDEX";
export type OptionType = "CE" | "PE" | null;
export type TrendDirection = "BULLISH" | "BEARISH" | "NEUTRAL";
export type MarketSession =
  | "PRE_OPEN"
  | "OPENING"
  | "MORNING"
  | "MIDDAY"
  | "AFTERNOON"
  | "CLOSING"
  | "POST_CLOSE";

export type TradeStatus = "open" | "closed";
export type ExitReason =
  | "tp1"
  | "tp2"
  | "tp3"
  | "stop_loss"
  | "trailing_stop"
  | "manual"
  | "time_exit"
  | "btst_square_off";

/** Full market-context snapshot captured at the moment a signal fires. */
export interface MarketContext {
  niftyLevel?: number;
  bankNiftyLevel?: number;
  indiaVix?: number;
  marketBreadth?: number;
  sectorStrength?: number;
  relativeStrength?: number;
  volumeRatio?: number;
  deliveryPct?: number;
  atr?: number;
  vwap?: number;
  emaAlignment?: string; // e.g. "9>21>50 bullish stack"
  supertrend?: "BUY" | "SELL" | null;
  rsi?: number;
  adx?: number;
  pcr?: number;
  oiBuildup?: "LONG_BUILDUP" | "SHORT_BUILDUP" | "LONG_UNWINDING" | "SHORT_COVERING" | null;
  callWriting?: number;
  putWriting?: number;
  maxPain?: number;
  iv?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  liquidityScore?: number;
  smcStatus?: string;
  bos?: boolean; // Break of Structure
  choch?: boolean; // Change of Character
  fvg?: boolean; // Fair Value Gap present
  orderBlock?: string | null;
  demandSupplyZone?: string | null;
  [extra: string]: unknown; // future-proof: strategies can attach extra context
}

/** Payload a strategy module sends the moment it generates a signal. */
export interface NewSignalInput {
  tradeId?: string; // optional idempotency key; server generates one if absent
  strategyId: StrategyId;
  strategyVersion: string;
  symbol: string;
  exchange: string;
  instrumentType: InstrumentType;
  spotPrice: number;
  strikePrice?: number | null;
  expiry?: string | null; // ISO date
  optionType?: OptionType;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2?: number | null;
  tp3?: number | null;
  signalConfidence: number; // 0-100
  aiConfidence?: number | null; // 0-100
  probabilityScore?: number | null; // 0-1
  trendDirection: TrendDirection;
  signalReason: string;
  marketSession: MarketSession;
  userAccount?: string | null;
  marketContext: MarketContext;
  /** signal generation timestamp; defaults to now (IST) if omitted */
  signalTimeIst?: string;
}

/** A row as stored/returned by the API — signal fields + full lifecycle state. */
export interface TradeRecord {
  id: string;
  strategyId: string;
  strategyVersion: string;
  createdAtIst: string;
  symbol: string;
  exchange: string;
  instrumentType: InstrumentType;
  spotPrice: number;
  strikePrice: number | null;
  expiry: string | null;
  optionType: OptionType;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number | null;
  tp3: number | null;
  riskRewardRatio: number;
  signalConfidence: number;
  aiConfidence: number | null;
  probabilityScore: number | null;
  trendDirection: TrendDirection;
  signalReason: string;
  marketSession: MarketSession;
  userAccount: string | null;
  marketContext: MarketContext;

  // live tracking
  status: TradeStatus;
  entryFilled: boolean;
  highestPrice: number | null;
  lowestPrice: number | null;
  mfe: number | null; // max favourable excursion, in price points
  mae: number | null; // max adverse excursion, in price points
  tp1Hit: boolean;
  tp1HitAt: string | null;
  tp2Hit: boolean;
  tp2HitAt: string | null;
  tp3Hit: boolean;
  tp3HitAt: string | null;
  slHit: boolean;
  trailingStop: number | null;
  trailingStopHit: boolean;
  lastPrice: number | null;
  lastUpdateAt: string | null;

  // exit
  exitPrice: number | null;
  exitTime: string | null;
  exitReason: ExitReason | null;
  grossPnl: number | null;
  fees: number;
  netPnl: number | null;
  roiPct: number | null;
  rMultiple: number | null;
  timeInTradeSec: number | null;

  // verification (populated once closed)
  verification: TradeVerification | null;
}

export interface TradeVerification {
  win: boolean;
  entryQuality: "good" | "late" | "early" | "unknown";
  slAssessment: "appropriate" | "too_tight" | "too_wide" | "unknown";
  tpAssessment: "appropriate" | "too_conservative" | "unreached" | "unknown";
  notes: string[];
}

export interface PriceUpdateInput {
  price: number;
  timestampIst?: string;
}

export interface CloseTradeInput {
  exitPrice: number;
  exitReason: ExitReason;
  exitTimeIst?: string;
  fees?: number;
}

export interface TradeFilters {
  strategyId?: string;
  symbol?: string;
  instrumentType?: InstrumentType;
  status?: TradeStatus;
  outcome?: "win" | "loss";
  marketSession?: MarketSession;
  minConfidence?: number;
  maxConfidence?: number;
  dateFrom?: string; // ISO date
  dateTo?: string; // ISO date
  page?: number;
  pageSize?: number;
}

export interface AggregateStats {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  todaysTrades: number;
  wins: number;
  losses: number;
  winRate: number; // %
  avgR: number;
  expectancy: number; // avg net pnl per trade
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null; // grossProfit / abs(grossLoss)
  netPnl: number;
  maxDrawdown: number; // in cumulative net pnl terms
  maxDrawdownPct: number | null;
  bestStrategy: { strategyId: string; netPnl: number } | null;
  worstStrategy: { strategyId: string; netPnl: number } | null;
  byStrategy: StrategyBreakdown[];
  bySymbol: SymbolBreakdown[];
  byMarketSession: SessionBreakdown[];
}

export interface StrategyBreakdown {
  strategyId: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number;
  netPnl: number;
  profitFactor: number | null;
}

export interface SymbolBreakdown {
  symbol: string;
  trades: number;
  winRate: number;
  netPnl: number;
}

export interface SessionBreakdown {
  marketSession: string;
  trades: number;
  winRate: number;
  netPnl: number;
}
