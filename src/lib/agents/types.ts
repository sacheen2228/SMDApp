// ═══════════════════════════════════════════════════════════════════════════
// Agent System Types — Canonical definitions for SMDApp Agent Infrastructure
// ═══════════════════════════════════════════════════════════════════════════

// ─── Agent Identity ───────────────────────────────────────────────
export type AgentType =
  | 'HERMES'
  | 'SMDAPP_ENGINE'
  | 'MARKET_RESEARCH'
  | 'OPTION_ENGINE'
  | 'CHART_ENGINE'
  | 'EXTERNAL_AGENT'
  | 'HUMAN'
  | 'SYSTEM';

export type AgentStatus = 'ACTIVE' | 'IDLE' | 'BUSY' | 'DEGRADED' | 'OFFLINE' | 'ERROR';

export interface AgentCapabilities {
  marketSnapshot: boolean;
  optionChain: boolean;
  oiAnalysis: boolean;
  sellerMap: boolean;
  greeks: boolean;
  gamma: boolean;
  frvp: boolean;
  liquidity: boolean;
  chartVision: boolean;
  fiiDii: boolean;
  breadth: boolean;
  cas: boolean;
  globalMarkets: boolean;
  news: boolean;
  tradeResearch: boolean;
  signalPublishing: boolean;
  tradeExecution: boolean; // External agents default to false
}

export interface Agent {
  id: string;
  name: string;
  type: AgentType;
  version: string;
  status: AgentStatus;
  capabilities: AgentCapabilities;
  description: string;
  createdAt: string;
  lastHeartbeatAt: string | null;
  lastTaskAt: string | null;
  lastSignalAt: string | null;
  healthStatus: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
  metadata: Record<string, any>;
}

// ─── Agent Heartbeat ──────────────────────────────────────────────
export interface AgentHeartbeat {
  agentId: string;
  timestamp: string;
  status: AgentStatus;
  currentTask: string | null;
  currentMarket: string | null;
  currentUnderlying: string | null;
  currentStrategy: string | null;
  lastSuccessfulToolCall: string | null;
  lastError: string | null;
  latencyMs: number;
  dataFreshness: string | null;
}

// ─── Agent Task ───────────────────────────────────────────────────
export type TaskType =
  | 'MARKET_SCAN'
  | 'OPTION_SCAN'
  | 'CE_PE_COMPARISON'
  | 'EXPIRY_RESEARCH'
  | 'OI_RESEARCH'
  | 'SELLER_RESEARCH'
  | 'CHART_ANALYSIS'
  | 'GLOBAL_RESEARCH'
  | 'NEWS_RESEARCH'
  | 'TRADE_REVIEW'
  | 'ACTIVE_TRADE_MONITOR'
  | 'POST_TRADE_REVIEW';

export type TaskStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';

export interface AgentTask {
  id: string;
  agentId: string;
  taskType: TaskType;
  underlying: string;
  strategy: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: TaskStatus;
  input: Record<string, any>;
  output: Record<string, any> | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

// ─── Agent Signal ─────────────────────────────────────────────────
export type SignalType = 'RESEARCH' | 'WATCH' | 'CANDIDATE' | 'FINAL' | 'ENTRY' | 'EXIT' | 'POST_TRADE' | 'EXTERNAL';
export type SignalDirection = 'BUY_CE' | 'BUY_PE' | 'WAIT' | 'EXIT';
export type SignalLifecycle = 'RESEARCH' | 'CANDIDATE' | 'VALIDATING' | 'VALIDATED' | 'FINAL' | 'ACTIVE' | 'TP1' | 'TP2' | 'EXIT' | 'SL' | 'CLOSED' | 'POST_TRADE_REVIEW';

export interface SignalEvidence {
  priceStructure: string | null;
  vwap: string | null;
  volume: string | null;
  callOI: string | null;
  putOI: string | null;
  oiMigration: string | null;
  sellerMap: string | null;
  delta: string | null;
  gamma: string | null;
  iv: string | null;
  vix: string | null;
  frvp: string | null;
  poc: string | null;
  vah: string | null;
  val: string | null;
  liquidity: string | null;
  absorption: string | null;
  cas: string | null;
  breadth: string | null;
  fiiDii: string | null;
  global: string | null;
  news: string | null;
}

export interface SignalProvenance {
  source: string;
  marketDataSource: string;
  optionChainSource: string;
  fiiDiiSource: string;
  vixSource: string;
  generatedAt: string;
  snapshotAt: string;
  freshnessMs: number;
}

export interface AgentSignal {
  id: string;
  agentId: string;
  timestamp: string;
  market: string;
  exchange: string;
  underlying: string;
  signalType: SignalType;
  direction: SignalDirection;
  optionType: 'CE' | 'PE' | null;
  strike: number | null;
  expiry: string | null;
  entryPrice: number | null;
  stopLoss: number | null;
  target1: number | null;
  target2: number | null;
  confidence: number;
  thesis: string;
  evidence: SignalEvidence;
  marketSnapshotId: string | null;
  canonicalSnapshotTimestamp: string | null;
  dataSource: string;
  dataFreshness: string;
  validationStatus: 'PENDING' | 'VALIDATED' | 'REJECTED' | 'STALE';
  executionStatus: 'NONE' | 'READY' | 'EXECUTED' | 'BLOCKED';
  lifecycle: SignalLifecycle;
  expiresAt: string | null;
}

// ─── External Signal ──────────────────────────────────────────────
export interface ExternalSignal {
  id: string;
  agentId: string;
  timestamp: string;
  underlying: string;
  exchange: string;
  direction: SignalDirection;
  optionType: 'CE' | 'PE' | null;
  strike: number | null;
  expiry: string | null;
  entryPrice: number | null;
  confidence: number;
  thesis: string;
  rawPayload: Record<string, any>;
  normalizedAt: string;
  validationStatus: 'PENDING' | 'VALIDATED' | 'REJECTED';
  rejectionReason: string | null;
}

// ─── Agent Performance ────────────────────────────────────────────
export interface AgentPerformance {
  agentId: string;
  period: string;
  totalSignals: number;
  validSignals: number;
  closedTrades: number;
  winners: number;
  losers: number;
  totalR: number;
  averageR: number;
  maxDrawdown: number;
  staleSignals: number;
  invalidSignals: number;
  conflicts: number;
}

// ─── Agent Event ──────────────────────────────────────────────────
export type EventType =
  | 'AGENT_REGISTERED'
  | 'AGENT_HEARTBEAT'
  | 'TASK_CREATED'
  | 'TASK_STARTED'
  | 'TASK_COMPLETED'
  | 'TASK_FAILED'
  | 'SIGNAL_CREATED'
  | 'SIGNAL_VALIDATED'
  | 'SIGNAL_REJECTED'
  | 'SIGNAL_ACTIVATED'
  | 'TRADE_ENTRY'
  | 'T1_HIT'
  | 'T2_HIT'
  | 'SL_HIT'
  | 'TRADE_EXIT'
  | 'TRADE_CANCELLED'
  | 'TRADE_EXPIRED'
  | 'TRADE_LOCKED'
  | 'TRADE_UNLOCKED'
  | 'EXTERNAL_SIGNAL_RECEIVED'
  | 'EXTERNAL_SIGNAL_REJECTED'
  | 'DATA_STALE'
  | 'DATA_RECOVERED';

export interface AgentEvent {
  eventId: string;
  eventType: EventType;
  agentId: string;
  timestamp: string;
  data: Record<string, any>;
  idempotencyKey: string;
}

// ─── Notification Delivery ────────────────────────────────────────
export type NotificationChannel = 'TELEGRAM' | 'WEBSOCKET' | 'UI';
export type NotificationStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'RETRYING';

export interface NotificationDelivery {
  id: string;
  eventId: string;
  channel: NotificationChannel;
  telegramMessageId: string | null;
  status: NotificationStatus;
  attempts: number;
  sentAt: string | null;
  lastError: string | null;
}

// ─── Feature Flags ────────────────────────────────────────────────
export interface FeatureFlags {
  AGENT_SYSTEM_ENABLED: boolean;
  EXTERNAL_AGENT_ENABLED: boolean;
  AI_TRADER_ENABLED: boolean;
  AGENT_WEBSOCKET_ENABLED: boolean;
  AGENT_SIGNAL_FEED_ENABLED: boolean;
  AGENT_PERFORMANCE_ENABLED: boolean;
}

// ─── Default Capabilities ─────────────────────────────────────────
export const INTERNAL_CAPABILITIES: AgentCapabilities = {
  marketSnapshot: true,
  optionChain: true,
  oiAnalysis: true,
  sellerMap: true,
  greeks: true,
  gamma: true,
  frvp: true,
  liquidity: true,
  chartVision: true,
  fiiDii: true,
  breadth: true,
  cas: true,
  globalMarkets: true,
  news: true,
  tradeResearch: true,
  signalPublishing: true,
  tradeExecution: true,
};

export const EXTERNAL_CAPABILITIES: AgentCapabilities = {
  marketSnapshot: false,
  optionChain: false,
  oiAnalysis: false,
  sellerMap: false,
  greeks: false,
  gamma: false,
  frvp: false,
  liquidity: false,
  chartVision: false,
  fiiDii: false,
  breadth: false,
  cas: false,
  globalMarkets: false,
  news: false,
  tradeResearch: true,
  signalPublishing: true,
  tradeExecution: false, // NEVER for external agents
};
