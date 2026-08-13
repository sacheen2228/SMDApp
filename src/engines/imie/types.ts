import type { Candle, SmartMoneyData, OpenInterestData, OrderFlowData, VolatilityData, RegimeResult } from '@/types/engine';

// ============================================================
// PHASE 1 — MARKET STATE
// ============================================================
export type MarketStateType =
  | 'TRENDING' | 'BALANCED'
  | 'ACCUMULATION' | 'DISTRIBUTION'
  | 'EXPANSION' | 'COMPRESSION';

export interface MarketStateResult {
  state: MarketStateType;
  confidence: number;
  reasons: string[];
}

// ============================================================
// PHASE 2 — AUCTION STATE
// ============================================================
export interface AuctionResult {
  acceptance: boolean;
  rejection: boolean;
  poc: number;
  vah: number;
  val: number;
  hvn: number[];
  lvn: number[];
  developingPOC: number;
  valueMigrating: 'UP' | 'DOWN' | 'SIDEWAYS';

  initialBalance: { high: number; low: number };
  rangeExtension: { up: number; down: number };
  singlePrints: number[];
  poorHigh: boolean;
  poorLow: boolean;
  excess: boolean;
  developingValue: { high: number; low: number };

  confidence: number;
  reason: string;
}

// ============================================================
// PHASE 3 — MARKET INTENT
// ============================================================
export type MarketIntent =
  | 'SEEK_BUY_SIDE_LIQUIDITY'
  | 'SEEK_SELL_SIDE_LIQUIDITY'
  | 'RETURN_TO_VALUE'
  | 'CONTINUE_TREND'
  | 'INVENTORY_REBALANCING'
  | 'SHORT_SQUEEZE'
  | 'LONG_SQUEEZE'
  | 'DISTRIBUTION'
  | 'ACCUMULATION'
  | 'PRICE_DISCOVERY';

export interface IntentResult {
  primary: MarketIntent;
  primaryProbability: number;
  primaryConfidence: number;
  primaryDuration: string;

  secondary: MarketIntent | null;
  secondaryProbability: number;

  failureCondition: string;
  reasons: string[];
}

// ============================================================
// PHASE 4 — LIQUIDITY GRAPH
// ============================================================
export type LiquidityNodeType =
  | 'EQH' | 'EQL'
  | 'SWING_HIGH' | 'SWING_LOW'
  | 'ASIA_HIGH' | 'ASIA_LOW'
  | 'LONDON_HIGH' | 'LONDON_LOW'
  | 'NEW_YORK_HIGH' | 'NEW_YORK_LOW'
  | 'WEEKLY_HIGH' | 'WEEKLY_LOW'
  | 'MONTHLY_HIGH' | 'MONTHLY_LOW'
  | 'ORDER_BLOCK' | 'BREAKER_BLOCK' | 'MITIGATION_BLOCK'
  | 'FAIR_VALUE_GAP' | 'LIQUIDITY_VOID'
  | 'POC' | 'HVN' | 'LVN'
  | 'ROUND_NUMBER'
  | 'OI_CLUSTER'
  | 'LIQUIDATION_CLUSTER'
  | 'DOM_WALL'
  | 'WHALE_ORDER'
  | 'VWAP'
  | 'DEVELOPING_POC';

export interface LiquidityNode {
  id: string;
  price: number;
  type: LiquidityNodeType;
  strength: number;
  age: number;
  volume: number;
  distance: number;
  probability: number;
  expectedReaction: number;
}

export interface LiquidityGraph {
  nodes: LiquidityNode[];
  bullishNodes: LiquidityNode[];
  bearishNodes: LiquidityNode[];
  nearestBullish: LiquidityNode | null;
  nearestBearish: LiquidityNode | null;
  totalNodes: number;
}

// ============================================================
// PHASE 5 — DESTINATION
// ============================================================
export interface Destination {
  node: LiquidityNode;
  price: number;
  probability: number;
  expectedMinutes: number;
  distance: number;
  expectedReaction: 'continuation' | 'reversal' | 'absorption' | 'acceleration' | 'distribution';
  risk: number;
  pathScore: number;
  expectedMove: number;
}

export interface DestinationResult {
  destinations: Destination[];
  topDestination: Destination | null;
}

// ============================================================
// PHASE 6 — PATH
// ============================================================
export interface PathStep {
  price: number;
  label: string;
  description: string;
}

export interface PathResult {
  primary: PathStep[];
  alternative: PathStep[];
  failure: PathStep[];
}

// ============================================================
// PHASE 7 — TARGET TYPES (Enhanced)
// ============================================================
export type EntryType = 'MARKET' | 'LIMIT' | 'CONFIRMATION';

export interface EntryPoint {
  type: EntryType;
  price: number;
  confidence: number;
  source: string;
  liquidityNode?: string;
}

export type StopType = 'technical' | 'aggressive' | 'conservative';

export interface StopLoss {
  technical: number;
  aggressive: number;
  conservative: number;
  invalidationPrice: number;
  liquidationDistance: number;
  reason: string;
  sources: string[];
}

export type TargetSource =
  | 'LIQUIDITY'
  | 'HVN'
  | 'LVN'
  | 'POC'
  | 'FVG'
  | 'ORDER_BLOCK'
  | 'OI_CLUSTER'
  | 'SESSION_HIGH'
  | 'SESSION_LOW'
  | 'WEEKLY_HIGH'
  | 'WEEKLY_LOW'
  | 'MONTHLY_HIGH'
  | 'MONTHLY_LOW'
  | 'DEVELOPING_POC'
  | 'VWAP'
  | 'ROUND_NUMBER'
  | 'DOM_WALL'
  | 'LIQUIDATION_CLUSTER'
  | 'BREAKER_BLOCK'
  | 'MITIGATION_BLOCK';

export interface TargetScore {
  liquidity: number;
  auction: number;
  volumeProfile: number;
  orderFlow: number;
  openInterest: number;
  smartMoney: number;
  expectedMove: number;
  riskReward: number;
  total: number;
}

export interface Target {
  price: number;
  probability: number;
  rr: number;
  score: TargetScore;
  source: TargetSource;
  destinationNodeId: string;
  expectedMinutes: number;
  distance: number;
  expectedReaction: 'continuation' | 'reversal' | 'absorption' | 'acceleration' | 'distribution';
}

export interface TradeManagement {
  trailingStop: number;
  breakEven: number;
  partialExits: { price: number; size: number }[];
  positionReduction: { price: number; reduction: number }[];
  timeStop: number;
  timeStopMinutes: number;
}

export interface TargetPlan {
  direction: 'long' | 'short';
  entry: EntryPoint;
  stop: StopLoss;
  targets: Target[];
  management: TradeManagement;
  riskReward: number;
  maxRisk: number;
  positionSize: number;
  confidence: number;
  explanation: string;
  marketObjective: string;
  expectedAuctionPath: string[];
  reasons: string[];
  warnings: string[];
}

// ============================================================
// PHASE 8 — VALIDATION
// ============================================================
export interface ValidationResult {
  approved: boolean;
  aiScore: number;
  confidence: number;
  rr: number;
  destinationProbability: number;
  dataQuality: number;
  rejectReasons: string[];
}

// ============================================================
// PHASE 9 — MARKET MEMORY
// ============================================================
export interface MemoryEntry {
  date: string;
  time: string;
  marketState: MarketStateType;
  auctionState: string;
  intent: MarketIntent;
  destination: Destination;
  tradeEntry: number;
  tradeStop: number;
  tradeTargets: number[];
  pnl: number;
  mfe: number;
  mae: number;
  success: boolean;
  failure: boolean;
  duration: number;
}

export interface MemoryStats {
  totalTrades: number;
  winRate: number;
  avgPnl: number;
  avgMfe: number;
  avgMae: number;
  bestIntents: { intent: MarketIntent; winRate: number; count: number }[];
  bestDestinations: { type: LiquidityNodeType; winRate: number; count: number }[];
}

export interface MemoryResult {
  entries: MemoryEntry[];
  stats: MemoryStats;
}

// ============================================================
// PHASE 10 — MARKET PLAYBOOK (ORCHESTRATOR OUTPUT)
// ============================================================
export interface MarketPlaybook {
  timestamp: number;
  pair: string;
  price: number;

  aiScore: number;
  confidence: number;

  marketState: MarketStateResult;
  auction: AuctionResult;
  intent: IntentResult;
  graph: LiquidityGraph;
  destinations: DestinationResult;
  path: PathResult;
  plan: TargetPlan | null;
  validation: ValidationResult;
  memory: MemoryResult;

  summary: {
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
    conviction: 'STRONG' | 'MODERATE' | 'WEAK' | 'AVOID';
    playbook: string[];
    expectedPath: string[];
    failureCondition: string;
    estimatedWindow: string;
  };
}
