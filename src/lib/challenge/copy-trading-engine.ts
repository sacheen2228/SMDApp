// ═══════════════════════════════════════════════════════════════════════════
// Copy Trading Engine — 3 modes: PAPER COPY, SEMI-AUTO COPY, LIVE COPY
// Risk-based position sizing (NOT 1:1 quantity copying)
// Trade states: SIGNAL → PENDING → APPROVED → COPIED → OPEN → CLOSED
// ═══════════════════════════════════════════════════════════════════════════

import { calculateEquityPosition, calculateFOPosition, DEFAULT_CAPITAL_CONFIG } from "./capital-manager";
import { executeTrade, closeTradeExecution, getTradeLog, type ExecutionMode } from "./auto-executor";

// ── Copy Trading Modes ──
export type CopyMode = "PAPER_COPY" | "SEMI_AUTO" | "LIVE_COPY";
export type CopyTradeState = "SIGNAL" | "PENDING" | "APPROVED" | "REJECTED" | "COPIED" | "OPEN" | "CLOSED" | "EXPIRED";

export interface CopyTrade {
  id: string;
  signalId: string;           // Original signal ID
  source: string;             // "CHALLENGE" | "AI_AGENT" | "MANUAL"
  symbol: string;
  strategy: string;
  instrument: string;
  direction: string;
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  score: number;
  state: CopyTradeState;
  mode: CopyMode;

  // User's own sizing (NOT copied from source)
  quantity: number;
  lotSize: number;
  lots: number;
  maxLoss: number;
  riskAmount: number;

  // Execution
  orderId?: string;
  exitPrice?: number;
  exitReason?: string;
  pnl?: number;

  // Timing
  createdAt: string;
  copiedAt?: string;
  closedAt?: string;

  // Approval (for SEMI_AUTO)
  approvedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;

  // Audit trail
  history: Array<{ timestamp: string; from: CopyTradeState; to: CopyTradeState; reason: string }>;
}

export interface CopyConfig {
  mode: CopyMode;
  enabled: boolean;
  maxRiskPerTradePct: number;
  maxDailyCopyCount: number;
  maxDailyRiskPct: number;
  minScore: number;
  autoApproveScore: number;     // Above this score, auto-approve in SEMI_AUTO
  allowNegativeDirection: boolean;
  capital: number;
}

const DEFAULT_COPY_CONFIG: CopyConfig = {
  mode: "PAPER_COPY",
  enabled: false,
  maxRiskPerTradePct: 5,
  maxDailyCopyCount: 10,
  maxDailyRiskPct: 20,
  minScore: 60,
  autoApproveScore: 80,
  allowNegativeDirection: true,
  capital: 15000,
};

// ── In-memory state ──
let copyConfig: CopyConfig = { ...DEFAULT_COPY_CONFIG };
let copyTrades: CopyTrade[] = [];
let dailyCopies = 0;
let dailyRiskUsed = 0;
let lastResetDate = "";
let tradeCounter = 0;

function generateCopyId(): string {
  tradeCounter++;
  return `CT${Date.now().toString(36)}${tradeCounter}`;
}

// ── Reset daily counters ──
function checkDailyReset() {
  const today = new Date().toISOString().split("T")[0];
  if (today !== lastResetDate) {
    dailyCopies = 0;
    dailyRiskUsed = 0;
    lastResetDate = today;
  }
}

// ── Get/Set config ──
export function getCopyConfig(): CopyConfig {
  return { ...copyConfig };
}

export function updateCopyConfig(updates: Partial<CopyConfig>): CopyConfig {
  copyConfig = { ...copyConfig, ...updates };
  return copyConfig;
}

// ── Size a copy trade (FIXED: risk-based, not 1:1) ──
function sizeCopyTrade(signal: {
  symbol: string;
  entry: number;
  stopLoss: number;
  instrument: string;
  score: number;
}): { quantity: number; lotSize: number; lots: number; maxLoss: number; canTrade: boolean; reason?: string } {
  const riskAmount = copyConfig.capital * (copyConfig.maxRiskPerTradePct / 100);
  const riskPerShare = Math.abs(signal.entry - signal.stopLoss);

  if (riskPerShare <= 0) return { quantity: 0, lotSize: 1, lots: 0, maxLoss: 0, canTrade: false, reason: "No valid risk distance" };

  const isFO = ["CALL", "PUT", "FUTURES"].includes(signal.instrument);

  if (isFO) {
    const sizing = calculateFOPosition(copyConfig.capital, signal.entry, signal.stopLoss, signal.symbol, signal.instrument !== "FUTURES", DEFAULT_CAPITAL_CONFIG);
    return { quantity: sizing.quantity, lotSize: sizing.lotSize, lots: sizing.lots, maxLoss: sizing.maxLoss, canTrade: sizing.canTrade, reason: sizing.reason };
  } else {
    const sizing = calculateEquityPosition(copyConfig.capital, signal.entry, signal.stopLoss, DEFAULT_CAPITAL_CONFIG);
    return { quantity: sizing.quantity, lotSize: 1, lots: sizing.quantity, maxLoss: sizing.maxLoss, canTrade: sizing.canTrade, reason: sizing.reason };
  }
}

// ── Receive a signal and decide whether to copy ──
export function receiveSignal(signal: {
  signalId: string;
  source: string;
  symbol: string;
  strategy: string;
  instrument: string;
  direction: string;
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  score: number;
}): CopyTrade | null {
  checkDailyReset();

  if (!copyConfig.enabled) return null;
  if (signal.score < copyConfig.minScore) return null;
  if (dailyCopies >= copyConfig.maxDailyCopyCount) return null;

  const sizing = sizeCopyTrade(signal);
  if (!sizing.canTrade) return null;

  const id = generateCopyId();
  let initialState: CopyTradeState = "SIGNAL";

  if (copyConfig.mode === "PAPER_COPY") {
    initialState = "COPIED"; // Auto-execute
  } else if (copyConfig.mode === "SEMI_AUTO") {
    initialState = signal.score >= copyConfig.autoApproveScore ? "APPROVED" : "PENDING";
  } else {
    initialState = "PENDING"; // LIVE_COPY requires explicit approval
  }

  const trade: CopyTrade = {
    id,
    signalId: signal.signalId,
    source: signal.source,
    symbol: signal.symbol,
    strategy: signal.strategy,
    instrument: signal.instrument,
    direction: signal.direction,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    target1: signal.target1,
    target2: signal.target2,
    riskReward: signal.riskReward,
    score: signal.score,
    state: initialState,
    mode: copyConfig.mode,
    quantity: sizing.quantity,
    lotSize: sizing.lotSize,
    lots: sizing.lots,
    maxLoss: sizing.maxLoss,
    riskAmount: Math.round(sizing.maxLoss),
    createdAt: new Date().toISOString(),
    history: [{ timestamp: new Date().toISOString(), from: "SIGNAL", to: initialState, reason: `Signal received via ${copyConfig.mode}` }],
  };

  copyTrades.unshift(trade);
  if (copyTrades.length > 500) copyTrades = copyTrades.slice(0, 500);

  // Auto-execute PAPER_COPY
  if (initialState === "COPIED") {
    executeCopyTrade(id);
  }
  // Auto-approve high scores in SEMI_AUTO
  if (initialState === "APPROVED" && copyConfig.mode === "SEMI_AUTO") {
    trade.approvedAt = new Date().toISOString();
    trade.state = "COPIED";
    trade.history.push({ timestamp: new Date().toISOString(), from: "APPROVED", to: "COPIED", reason: "Auto-approved (score above threshold)" });
    executeCopyTrade(id);
  }

  return trade;
}

// ── Approve a pending copy trade ──
export function approveCopyTrade(tradeId: string): CopyTrade | null {
  const trade = copyTrades.find(t => t.id === tradeId && (t.state === "PENDING" || t.state === "SIGNAL"));
  if (!trade) return null;

  trade.state = "APPROVED";
  trade.approvedAt = new Date().toISOString();
  trade.history.push({ timestamp: new Date().toISOString(), from: "PENDING", to: "APPROVED", reason: "User approved" });

  // Auto-execute on approval
  trade.state = "COPIED";
  trade.copiedAt = new Date().toISOString();
  trade.history.push({ timestamp: new Date().toISOString(), from: "APPROVED", to: "COPIED", reason: "Approved — auto-executing" });

  executeCopyTrade(tradeId);
  return trade;
}

// ── Reject a pending copy trade ──
export function rejectCopyTrade(tradeId: string, reason: string): CopyTrade | null {
  const trade = copyTrades.find(t => t.id === tradeId && t.state === "PENDING");
  if (!trade) return null;

  trade.state = "REJECTED";
  trade.rejectedAt = new Date().toISOString();
  trade.rejectionReason = reason;
  trade.history.push({ timestamp: new Date().toISOString(), from: "PENDING", to: "REJECTED", reason });
  return trade;
}

// ── Execute a copy trade (paper or live) ──
async function executeCopyTrade(tradeId: string): Promise<void> {
  const trade = copyTrades.find(t => t.id === tradeId && t.state === "COPIED");
  if (!trade) return;

  try {
    const execMode: ExecutionMode = copyConfig.mode === "LIVE_COPY" ? "LIVE" : "PAPER";

    // Build a mock opportunity for the auto-executor
    const opp = {
      rank: 0,
      symbol: trade.symbol,
      name: trade.symbol,
      instrument: trade.instrument as any,
      strategy: trade.strategy,
      score: trade.score,
      confidence: trade.score,
      direction: trade.direction,
      entry: trade.entry,
      stopLoss: trade.stopLoss,
      target1: trade.target1,
      target2: trade.target2,
      riskReward: trade.riskReward,
      volume: 0,
      relativeVolume: 1,
      sector: "COPY",
      near52WHigh: false,
      near52WLow: false,
      reasoning: ["Copy trade"],
      factors: {},
      position: { quantity: trade.quantity, lotSize: trade.lotSize, lots: trade.lots, totalCost: trade.quantity * trade.entry, maxLoss: trade.maxLoss, maxLossPct: 5, riskAmount: trade.riskAmount, canTrade: true },
      data: { ltp: trade.entry, changePct: 0, weekHigh52: 0, weekLow52: 0 },
    };

    const result = await executeTrade(opp as any, execMode);

    if (result.success) {
      trade.state = "OPEN";
      trade.orderId = result.orderId;
      trade.copiedAt = new Date().toISOString();
      trade.history.push({ timestamp: new Date().toISOString(), from: "COPIED", to: "OPEN", reason: `Executed ${execMode}: ${result.message}` });
      dailyCopies++;
      dailyRiskUsed += trade.maxLoss;
    } else {
      trade.state = "CLOSED";
      trade.exitReason = "EXECUTION_FAILED";
      trade.closedAt = new Date().toISOString();
      trade.history.push({ timestamp: new Date().toISOString(), from: "COPIED", to: "CLOSED", reason: `Execution failed: ${result.message}` });
    }
  } catch (e: any) {
    trade.state = "CLOSED";
    trade.exitReason = "EXECUTION_ERROR";
    trade.closedAt = new Date().toISOString();
    trade.history.push({ timestamp: new Date().toISOString(), from: "COPIED", to: "CLOSED", reason: `Error: ${e.message}` });
  }
}

// ── Close a copy trade ──
export async function closeCopyTrade(
  tradeId: string,
  exitPrice: number,
  exitReason: string,
): Promise<CopyTrade | null> {
  const trade = copyTrades.find(t => t.id === tradeId && t.state === "OPEN");
  if (!trade) return null;

  const isLong = trade.direction.includes("BUY") || trade.direction === "LONG";
  const pnlPerShare = isLong ? exitPrice - trade.entry : trade.entry - exitPrice;
  const pnl = Math.round(pnlPerShare * trade.quantity);

  trade.exitPrice = exitPrice;
  trade.exitReason = exitReason;
  trade.pnl = pnl;
  trade.state = "CLOSED";
  trade.closedAt = new Date().toISOString();
  trade.history.push({ timestamp: new Date().toISOString(), from: "OPEN", to: "CLOSED", reason: `${exitReason}: P&L ₹${pnl}` });

  // Also close in auto-executor if it has an orderId
  if (trade.orderId) {
    try { await closeTradeExecution(trade.orderId, exitPrice, exitReason); } catch {}
  }

  return trade;
}

// ── Get copy trades ──
export function getCopyTrades(filter?: { state?: CopyTradeState; mode?: CopyMode }): CopyTrade[] {
  let trades = copyTrades;
  if (filter?.state) trades = trades.filter(t => t.state === filter.state);
  if (filter?.mode) trades = trades.filter(t => t.mode === filter.mode);
  return trades;
}

// ── Get pending approvals ──
export function getPendingApprovals(): CopyTrade[] {
  return copyTrades.filter(t => t.state === "PENDING");
}

// ── Get copy trade stats ──
export function getCopyStats() {
  const closed = copyTrades.filter(t => t.state === "CLOSED");
  const wins = closed.filter(t => (t.pnl ?? 0) > 0);
  const losses = closed.filter(t => (t.pnl ?? 0) < 0);
  const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);

  return {
    total: copyTrades.length,
    open: copyTrades.filter(t => t.state === "OPEN").length,
    pending: copyTrades.filter(t => t.state === "PENDING").length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : 0,
    totalPnl,
    avgPnl: closed.length > 0 ? Math.round(totalPnl / closed.length) : 0,
    todayCopies: dailyCopies,
    todayRiskUsed: dailyRiskUsed,
    mode: copyConfig.mode,
    enabled: copyConfig.enabled,
  };
}
