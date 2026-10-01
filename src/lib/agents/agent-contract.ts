// ═══════════════════════════════════════════════════════════════════════════
// Agent Contract — Canonical types for all 30 specialist research agents
// Every agent MUST implement this interface and return structured output
// ═══════════════════════════════════════════════════════════════════════════

import type { OptionChain } from '../jarvis/types';

// ─── Agent Identity ───────────────────────────────────────────────

export type AgentId =
  | 'MARKET_REGIME' | 'FII_DII' | 'GLOBAL_MARKET' | 'INDIA_VIX'
  | 'MARKET_BREADTH' | 'SECTOR_ROTATION' | 'OI_PCR' | 'OI_CLASSIFICATION'
  | 'GREEKS' | 'GAMMA' | 'IV_HV' | 'OPTION_ACCELERATION'
  | 'BUYER_CONFLUENCE' | 'STRIKE_SELECTION' | 'EXPIRY_THETA' | 'ZERO_HERO'
  | 'CAS' | 'MARKET_STRUCTURE' | 'SUPPORT_RESISTANCE' | 'VWAP'
  | 'VOLUME' | 'BREAKOUT' | 'MTF_CONFIRMATION' | 'MOMENTUM'
  | 'ATR' | 'NEWS' | 'EVENT_RISK' | 'SENTIMENT' | 'BTST' | 'COMMODITY_MCX';

export type AgentCategory =
  | 'MARKET' | 'FLOW' | 'CONTEXT' | 'VOLATILITY' | 'OPTIONS'
  | 'STRUCTURE' | 'SIGNALS' | 'RISK' | 'EQUITY' | 'MCX' | 'VOLUME';

export type DataFreshnessLevel = 'FRESH' | 'STALE' | 'MISSING' | 'ERROR';

export type AgentBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'CONFLICTED' | 'NO_DATA';

export type AgentRecommendation = 'TRADE' | 'WAIT' | 'NO_TRADE' | 'RESEARCH_ONLY';

export type SupportedInstrument = 'INDEX' | 'STOCK_OPTION' | 'STOCK_EQUITY' | 'FUTURES' | 'MCX' | 'ALL';

// ─── Agent Research Output (what every agent returns) ─────────────

export interface AgentResearchOutput {
  agentId: AgentId;
  agentName: string;
  category: AgentCategory;
  timestamp: string;
  symbol: string;
  timeframe: string;
  dataFreshness: DataFreshnessLevel;

  // Core analysis
  observation: string;           // Plain English what this agent sees
  bias: AgentBias;               // Directional bias
  confidence: number;            // 0-100
  evidence: string[];            // Supporting evidence points
  riskFlags: string[];           // Risks this agent identifies
  conflicts: string[];           // Contradictions with other data

  // Recommendation context
  recommendationContext: AgentRecommendation;
  recommendationReason: string;

  // Supporting data (agent-specific, optional)
  data?: Record<string, any>;
}

// ─── Agent Definition (what the registry holds) ───────────────────

export interface AgentDefinition {
  id: AgentId;
  name: string;
  category: AgentCategory;
  description: string;
  supportedInstruments: SupportedInstrument[];
  dataSources: string[];         // What APIs/modules it calls
  requiredInputs: string[];      // What data it needs from the context
  analysisFn: (ctx: AgentContext) => Promise<AgentResearchOutput>;
}

// ─── Agent Context (what gets passed to each agent) ───────────────

export interface AgentContext {
  symbol: string;
  timeframe: string;
  exchange: 'NSE' | 'MCX' | 'BSE';
  instrument: 'index' | 'fno-stock' | 'cash-stock' | 'commodity';

  // Market data (from Hermes context or direct)
  spot: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;

  // Option chain
  optionChain: any;              // OptionChainData from hermes/types
  strikes: any[];                // OptionStrike[]

  // VIX
  vix: number;
  vixChange: number;

  // FII/DII
  fiiNet: number;
  diiNet: number;
  fiiBias: string;
  participantOI: any;
  institutional?: any;

  // Regime
  regime: string;
  regimeBias: string;
  regimeConfidence: number;

  // Structure
  trend: string;
  swingHigh: number;
  swingLow: number;
  supportLevels: number[];
  resistanceLevels: number[];
  pdh: number;
  pdl: number;
  lastEvent: string;

  // Greeks (ATM)
  atmDelta: number;
  atmGamma: number;
  atmTheta: number;
  atmVega: number;
  atmIV: number;

  // Volume
  totalVolume: number;
  poc: number;
  vah: number;
  val: number;

  // Gamma
  gammaDetected: boolean;
  gammaWallStrike: number;
  gammaFlip: number;
  dealerBias: string;

  // News
  newsSentiment: string;
  newsScore: number;
  headlines: string[];

  // Market status
  marketStatus: string;
  daysToExpiry: number;
  expiry: string;

  // Freshness
  dataTimestamp: string;
  spotFreshness: DataFreshnessLevel;
  chainFreshness: DataFreshnessLevel;

  // ONE snapshot timestamp for the whole cycle (v2 §21).
  // Every agent's dataFreshness derives from this single ISO timestamp —
  // agents never report independent freshness opinions.
  fetchedAtIso?: string;

  // Jarvis-format chain — PURE mapping of the same snapshot fetch (v2 §2),
  // so agents wrap src/lib/jarvis/ scoring/greeks/levels instead of
  // running parallel OI/Greeks math. Never fetched separately.
  jarvisChain?: OptionChain;

  // Raw context (for agents that need specific data)
  rawContext?: any;
}

// ─── Freshness from the single snapshot timestamp (v2 §21) ─────────────
// Thresholds: <90s FRESH, <10min STALE, older/absent/unparsable MISSING.
// 'ERROR' is reserved for callers that caught a fetch failure.

export function freshnessFromIso(
  fetchedAtIso?: string,
  now: Date = new Date()
): DataFreshnessLevel {
  if (!fetchedAtIso) return 'MISSING';
  const ts = Date.parse(fetchedAtIso);
  if (Number.isNaN(ts)) return 'MISSING';
  const ageMs = now.getTime() - ts;
  if (ageMs <= 90_000) return 'FRESH';
  if (ageMs < 600_000) return 'STALE';
  return 'MISSING';
}

// ─── Cross-Confluence Input ───────────────────────────────────────

export interface CrossConfluenceInput {
  symbol: string;
  agentOutputs: AgentResearchOutput[];
  timestamp: string;
}

// ─── Cross-Confluence Output ──────────────────────────────────────

export interface CrossConfluenceOutput {
  symbol: string;
  timestamp: string;

  // Aggregated analysis
  bullishEvidence: string[];
  bearishEvidence: string[];
  neutralEvidence: string[];
  conflicts: string[];

  // Scoring
  bullishScore: number;          // Weighted sum of bullish agents
  bearishScore: number;          // Weighted sum of bearish agents
  totalConfidence: number;       // Average confidence of contributing agents
  confluenceCount: number;       // How many agents agree

  // Regime
  regimeAlignment: boolean;      // Do agents align with market regime?

  // Recommendation
  recommendation: AgentRecommendation;
  recommendationReason: string;

  // Risk
  riskFlags: string[];

  // Engine routing
  routeToEngine: 'OPTION' | 'CASH_FUTURES' | 'NONE';
}

// ─── Grok Supervisor Output ───────────────────────────────────────

export interface GrokDecision {
  symbol: string;
  timestamp: string;

  // Research synthesis
  marketRegime: string;
  bullishEvidence: string[];
  bearishEvidence: string[];
  neutralEvidence: string[];
  conflicts: string[];

  // Consensus
  consensus: AgentBias;
  consensusConfidence: number;

  // Engine selection
  selectedEngine: 'OPTION' | 'CASH_FUTURES' | 'NONE';
  engineReason: string;

  // Trade direction
  direction: 'BUY_CE' | 'BUY_PE' | 'BUY' | 'SELL' | 'NO_TRADE';
  directionReason: string;

  // Candidate (if direction is not NO_TRADE)
  candidate?: {
    symbol: string;
    direction: string;
    optionSide?: 'CE' | 'PE';
    strike?: number;
    entry: number;
    stopLoss: number;
    tp1: number;
    tp2: number;
    tp3?: number;
    confidence: number;
    grade: string;
    reasons: string[];
    risks: string[];
  };

  // Validation
  validation: {
    passed: boolean;
    failures: string[];
    warnings: string[];
  };

  // Evidence quality
  evidenceQuality: {
    totalAgents: number;
    activeAgents: number;
    freshData: number;
    staleData: number;
    missingData: number;
  };
}

// ─── Trade Monitor Types ──────────────────────────────────────────

export type TradeMonitorStatus =
  | 'OPEN'
  | 'TP1_HIT'
  | 'TP2_HIT'
  | 'TP3_HIT'
  | 'SL_HIT'
  | 'CLOSED'
  | 'CANCELLED'
  | 'ERROR';

export interface TradeMonitorState {
  tradeId: string;
  symbol: string;
  exchange: string;
  instrument: 'CALL' | 'PUT' | 'FUTURES' | 'EQUITY';
  side: 'BUY' | 'SELL';
  strike?: number;
  entry: number;
  currentLTP: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3?: number;
  trailingSL?: number;
  status: TradeMonitorStatus;
  pnl: number;
  pnlPct: number;
  mfe: number;   // Maximum Favorable Excursion
  mae: number;   // Maximum Adverse Excursion
  entryTime: string;
  lastCheckedAt: string;
  quantity?: number;

  // Alert state (prevents duplicate alerts)
  tp1AlertSent: boolean;
  tp2AlertSent: boolean;
  tp3AlertSent: boolean;
  slAlertSent: boolean;

  // Outcome
  exitPrice?: number;
  exitTime?: string;
  exitReason?: string;
}

// ─── TP/SL Alert Types ───────────────────────────────────────────

export type TPSLAlertType = 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'SL_HIT';

export interface TPSLAlert {
  alertId: string;
  tradeId: string;
  alertType: TPSLAlertType;
  symbol: string;
  side: 'BUY' | 'SELL';
  instrument: 'CALL' | 'PUT' | 'FUTURES' | 'EQUITY';
  strike?: number;
  entry: number;
  currentLTP: number;
  triggerPrice: number;
  sl?: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
  pnl: number;
  pnlPct: number;
  timestamp: string;
  message: string;
  sent: boolean;
  sentAt?: string;
  retryCount: number;
  lastError?: string;
}

// ─── Learning Record Types ────────────────────────────────────────

export interface TradeDecisionRecord {
  id: string;
  symbol: string;
  timestamp: string;

  // Research snapshot
  agentsUsed: AgentId[];
  agentOutputs: AgentResearchOutput[];
  crossConfluence: CrossConfluenceOutput;
  grokDecision: GrokDecision;

  // Trade details
  direction: string;
  optionSide?: 'CE' | 'PE';
  strike?: number;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  confidence: number;
  grade: string;

  // Market context at entry
  regime: string;
  vix: number;
  pcr: number;
  fiiNet: number;
  diiNet: number;

  // Outcome
  outcome?: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'EXPIRED' | 'CANCELLED';
  exitPrice?: number;
  exitTime?: string;
  pnl?: number;
  mfe?: number;
  mae?: number;
  rMultiple?: number;

  // Agent performance tracking
  agentPerformance?: Record<AgentId, {
    bias: AgentBias;
    confidence: number;
    wasCorrect: boolean;
  }>;
}
