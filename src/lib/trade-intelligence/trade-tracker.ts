// ═══════════════════════════════════════════════════════════════════════════
// Trade Tracking Lifecycle
// Tracks every high-conviction setup through its lifecycle:
//   WATCH → SETUP → TRIGGERED → ACTIVE → TARGET_1 → TARGET_2 → STOPPED
//   → INVALIDATED → EXHAUSTED
// Auto-invalidates when supporting conditions disappear.
// ═══════════════════════════════════════════════════════════════════════════

import type { UnifiedTradeSetup } from "./unified-ranking";

// ── Types ──
export type TradeStage =
  | "WATCH"
  | "SETUP"
  | "TRIGGERED"
  | "ACTIVE"
  | "TARGET_1"
  | "TARGET_2"
  | "STOPPED"
  | "INVALIDATED"
  | "EXHAUSTED";

export interface TrackedTrade {
  id: string;
  symbol: string;
  mode: string;
  direction: string;
  stage: TradeStage;
  score: number;
  confidence: number;
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  riskReward: number;
  maxRisk: string;
  reasoning: string[];
  stageHistory: Array<{ stage: TradeStage; timestamp: string; reason: string }>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  isActive: boolean;
  mfe: number; // Maximum Favorable Excursion
  mae: number; // Maximum Adverse Excursion
  holdingPeriod: string;
  invalidation: string;
}

// ── In-memory trade tracker ──
const trackedTrades = new Map<string, TrackedTrade>();
const MAX_TRADES = 50;
const TRADE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Generate unique ID ──
function generateId(symbol: string, mode: string, direction: string): string {
  return `${symbol}-${mode}-${direction}-${Date.now().toString(36)}`;
}

// ── Check if trade already tracked ──
function findExistingTrade(symbol: string, mode: string): TrackedTrade | undefined {
  for (const trade of trackedTrades.values()) {
    if (trade.symbol === symbol && trade.mode === mode && trade.isActive) {
      return trade;
    }
  }
  return undefined;
}

// ── Register a new trade ──
export function registerTrade(
  setup: UnifiedTradeSetup,
  currentPrice: number
): TrackedTrade {
  // Check if already tracked
  const existing = findExistingTrade(setup.symbol, setup.mode);
  if (existing) {
    // Update score if higher
    if (setup.score > existing.score) {
      existing.score = setup.score;
      existing.confidence = setup.confidence;
      existing.updatedAt = new Date().toISOString();
    }
    return existing;
  }

  const id = generateId(setup.symbol, setup.mode, setup.direction);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TRADE_TTL_MS).toISOString();

  const trade: TrackedTrade = {
    id,
    symbol: setup.symbol,
    mode: setup.mode,
    direction: setup.direction,
    stage: setup.score >= 80 ? "SETUP" : "WATCH",
    score: setup.score,
    confidence: setup.confidence,
    entry: setup.entry,
    stopLoss: setup.stopLoss,
    target1: setup.target1,
    target2: setup.target2,
    currentPrice,
    unrealizedPnL: 0,
    unrealizedPnLPercent: 0,
    riskReward: setup.riskReward,
    maxRisk: setup.maxRisk,
    reasoning: setup.reasoning,
    stageHistory: [
      { stage: setup.score >= 80 ? "SETUP" : "WATCH", timestamp: now, reason: "Initial registration" },
    ],
    createdAt: now,
    updatedAt: now,
    expiresAt,
    isActive: true,
    mfe: 0,
    mae: 0,
    holdingPeriod: setup.holdingPeriod,
    invalidation: setup.invalidation,
  };

  // Evict old trades if at capacity
  if (trackedTrades.size >= MAX_TRADES) {
    const oldest = Array.from(trackedTrades.values())
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())[0];
    if (oldest) {
      oldest.isActive = false;
      oldest.stage = "EXHAUSTED";
      trackedTrades.delete(oldest.id);
    }
  }

  trackedTrades.set(id, trade);
  return trade;
}

// ── Update trade with new price data ──
export function updateTrade(
  tradeId: string,
  currentPrice: number,
  marketConditions?: {
    score?: number;
    confidence?: number;
    reasoning?: string[];
  }
): TrackedTrade | null {
  const trade = trackedTrades.get(tradeId);
  if (!trade || !trade.isActive) return null;

  const now = new Date().toISOString();
  trade.currentPrice = currentPrice;
  trade.updatedAt = now;

  // Calculate P&L
  if (trade.direction === "LONG" || trade.direction === "BUY" || trade.direction === "CALL" || trade.direction === "BUY_CE") {
    trade.unrealizedPnL = currentPrice - trade.entry;
  } else {
    trade.unrealizedPnL = trade.entry - currentPrice;
  }
  trade.unrealizedPnLPercent = trade.entry > 0 ? (trade.unrealizedPnL / trade.entry) * 100 : 0;

  // Update MFE/MAE
  if (trade.unrealizedPnL > trade.mfe) trade.mfe = trade.unrealizedPnL;
  if (trade.unrealizedPnL < -trade.mae) trade.mae = Math.abs(trade.unrealizedPnL);

  // Stage transitions
  if (trade.stage === "WATCH" || trade.stage === "SETUP") {
    // Check if triggered (price crosses entry)
    const isBullish = trade.direction === "LONG" || trade.direction === "BUY" || trade.direction === "CALL" || trade.direction === "BUY_CE";
    const isTriggered = isBullish
      ? currentPrice >= trade.entry
      : currentPrice <= trade.entry;

    if (isTriggered && trade.stage === "SETUP") {
      trade.stage = "TRIGGERED";
      trade.stageHistory.push({ stage: "TRIGGERED", timestamp: now, reason: "Price crossed entry" });
    }
  }

  if (trade.stage === "TRIGGERED") {
    trade.stage = "ACTIVE";
    trade.stageHistory.push({ stage: "ACTIVE", timestamp: now, reason: "Position active" });
  }

  // Check TP/SL
  if (trade.stage === "ACTIVE" || trade.stage === "TRIGGERED") {
    const isBullish = trade.direction === "LONG" || trade.direction === "BUY" || trade.direction === "CALL" || trade.direction === "BUY_CE";

    // Target 1 hit
    if (isBullish && currentPrice >= trade.target1) {
      trade.stage = "TARGET_1";
      trade.stageHistory.push({ stage: "TARGET_1", timestamp: now, reason: `Target 1 hit at ${trade.target1}` });
    } else if (!isBullish && currentPrice <= trade.target1) {
      trade.stage = "TARGET_1";
      trade.stageHistory.push({ stage: "TARGET_1", timestamp: now, reason: `Target 1 hit at ${trade.target1}` });
    }

    // Stop loss hit
    if (isBullish && currentPrice <= trade.stopLoss) {
      trade.stage = "STOPPED";
      trade.isActive = false;
      trade.stageHistory.push({ stage: "STOPPED", timestamp: now, reason: `Stop loss hit at ${trade.stopLoss}` });
    } else if (!isBullish && currentPrice >= trade.stopLoss) {
      trade.stage = "STOPPED";
      trade.isActive = false;
      trade.stageHistory.push({ stage: "STOPPED", timestamp: now, reason: `Stop loss hit at ${trade.stopLoss}` });
    }
  }

  // Target 2 after Target 1
  if (trade.stage === "TARGET_1") {
    const isBullish = trade.direction === "LONG" || trade.direction === "BUY" || trade.direction === "CALL" || trade.direction === "BUY_CE";
    if (isBullish && currentPrice >= trade.target2) {
      trade.stage = "TARGET_2";
      trade.isActive = false;
      trade.stageHistory.push({ stage: "TARGET_2", timestamp: now, reason: `Target 2 hit at ${trade.target2}` });
    } else if (!isBullish && currentPrice <= trade.target2) {
      trade.stage = "TARGET_2";
      trade.isActive = false;
      trade.stageHistory.push({ stage: "TARGET_2", timestamp: now, reason: `Target 2 hit at ${trade.target2}` });
    }
  }

  // Update market conditions
  if (marketConditions) {
    if (marketConditions.score !== undefined) trade.score = marketConditions.score;
    if (marketConditions.confidence !== undefined) trade.confidence = marketConditions.confidence;
    if (marketConditions.reasoning) trade.reasoning = marketConditions.reasoning;

    // Auto-invalidate if confidence drops below threshold
    if (trade.confidence < 50 && trade.stage !== "STOPPED" && trade.stage !== "TARGET_2") {
      trade.stage = "INVALIDATED";
      trade.isActive = false;
      trade.stageHistory.push({
        stage: "INVALIDATED",
        timestamp: now,
        reason: `Confidence dropped to ${trade.confidence}% — conditions weakened`,
      });
    }
  }

  // Auto-expire
  if (new Date() > new Date(trade.expiresAt)) {
    trade.stage = "EXHAUSTED";
    trade.isActive = false;
    trade.stageHistory.push({ stage: "EXHAUSTED", timestamp: now, reason: "Trade expired (24h TTL)" });
  }

  return trade;
}

// ── Get all active trades ──
export function getActiveTrades(): TrackedTrade[] {
  return Array.from(trackedTrades.values())
    .filter(t => t.isActive)
    .sort((a, b) => b.score - a.score);
}

// ── Get trade by ID ──
export function getTrade(tradeId: string): TrackedTrade | null {
  return trackedTrades.get(tradeId) || null;
}

// ── Get all trades (including inactive) ──
export function getAllTrades(): TrackedTrade[] {
  return Array.from(trackedTrades.values())
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

// ── Cleanup expired trades ──
export function cleanupTrades(): number {
  let removed = 0;
  const now = new Date();
  for (const [id, trade] of trackedTrades) {
    if (now > new Date(trade.expiresAt) || !trade.isActive) {
      trackedTrades.delete(id);
      removed++;
    }
  }
  return removed;
}

// ── Get tracking stats ──
export function getTrackingStats(): {
  active: number;
  total: number;
  byStage: Record<TradeStage, number>;
  byMode: Record<string, number>;
  avgScore: number;
} {
  const trades = Array.from(trackedTrades.values());
  const active = trades.filter(t => t.isActive);
  const byStage = {} as Record<TradeStage, number>;
  const byMode: Record<string, number> = {};

  for (const t of trades) {
    byStage[t.stage] = (byStage[t.stage] || 0) + 1;
    byMode[t.mode] = (byMode[t.mode] || 0) + 1;
  }

  return {
    active: active.length,
    total: trades.length,
    byStage,
    byMode,
    avgScore: active.length > 0
      ? Math.round(active.reduce((sum, t) => sum + t.score, 0) / active.length)
      : 0,
  };
}
