// ═══════════════════════════════════════════════════════════════════════════
// Auto-Executor — Places real Breeze orders for Challenge Engine
// FIXED: expiry on Thursday, unique trade IDs, audit close, square-off
// ═══════════════════════════════════════════════════════════════════════════

import { placeOrder } from "@/lib/icici-breeze/orders";
import { getBreezeClient } from "@/lib/icici-breeze/auth";
import { recordSignal, closeTrade as auditClose } from "@/lib/trade-audit-client";
import type { ChallengeOpportunity } from "./challenge-engine";

export type ExecutionMode = "LIVE" | "PAPER";

export interface ExecutionResult {
  success: boolean;
  mode: ExecutionMode;
  tradeId: string;
  orderId?: string;
  symbol: string;
  strategy: string;
  direction: string;
  instrument: string;
  entry: number;
  stopLoss: number;
  target: number;
  quantity: number;
  lotSize: number;
  maxLoss: number;
  score: number;
  timestamp: string;
  message: string;
  error?: string;
}

// ── Trade log with unique IDs ──
interface TradeLogEntry {
  id: string;
  timestamp: string;
  mode: ExecutionMode;
  symbol: string;
  strategy: string;
  direction: string;
  instrument: string;
  entry: number;
  exit?: number;
  stopLoss: number;
  target: number;
  quantity: number;
  lotSize: number;
  pnl?: number;
  score: number;
  status: "OPEN" | "WIN" | "LOSS" | "BREAKEVEN" | "EXPIRED";
  exitReason?: string;
  orderId?: string;
}

const tradeLog: TradeLogEntry[] = [];
const MAX_LOG_SIZE = 200;
let tradeCounter = 0;

function generateUniqueId(prefix: string): string {
  tradeCounter++;
  return `${prefix}-${Date.now().toString(36)}-${tradeCounter}`;
}

function addTrade(entry: TradeLogEntry) {
  tradeLog.unshift(entry);
  if (tradeLog.length > MAX_LOG_SIZE) tradeLog.pop();
}

// ── Check if Breeze is available ──
async function isBreezeAvailable(): Promise<boolean> {
  try {
    const client = getBreezeClient();
    return !!client;
  } catch {
    return false;
  }
}

// ── Get lot size for symbol ──
function getLotSize(symbol: string): number {
  const lots: Record<string, number> = {
    NIFTY: 25, BANKNIFTY: 15, FINNIFTY: 40, MIDCPNIFTY: 50, SENSEX: 15,
  };
  return lots[symbol] || 1;
}

// ── Get expiry date (FIXED: handles Thursday correctly) ──
function getWeeklyExpiry(): string {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 4=Thu
  let daysUntilThu: number;
  if (day === 4) {
    // Thursday — use today's expiry (market closes at 15:30, we trade before then)
    const hour = now.getHours();
    if (hour < 15) {
      daysUntilThu = 0; // Use today
    } else {
      daysUntilThu = 7; // After market hours, use next Thursday
    }
  } else {
    daysUntilThu = (4 - day + 7) % 7;
  }
  const thu = new Date(now);
  thu.setDate(now.getDate() + daysUntilThu);
  const dd = String(thu.getDate()).padStart(2, "0");
  const mm = String(thu.getMonth() + 1).padStart(2, "0");
  const yyyy = thu.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// ── Execute a paper trade (simulated) ──
function executePaper(opp: ChallengeOpportunity): ExecutionResult {
  const tradeId = generateUniqueId("PAPER");
  const entry: TradeLogEntry = {
    id: tradeId,
    timestamp: new Date().toISOString(),
    mode: "PAPER",
    symbol: opp.symbol,
    strategy: opp.strategy,
    direction: opp.direction,
    instrument: opp.instrument,
    entry: opp.entry,
    stopLoss: opp.stopLoss,
    target: opp.target1,
    quantity: opp.position.quantity,
    lotSize: opp.position.lotSize,
    score: opp.score,
    status: "OPEN",
  };
  addTrade(entry);

  return {
    success: true,
    mode: "PAPER",
    tradeId,
    symbol: opp.symbol,
    strategy: opp.strategy,
    direction: opp.direction,
    instrument: opp.instrument,
    entry: opp.entry,
    stopLoss: opp.stopLoss,
    target: opp.target1,
    quantity: opp.position.quantity,
    lotSize: opp.position.lotSize,
    maxLoss: opp.position.maxLoss,
    score: opp.score,
    timestamp: entry.timestamp,
    message: `Paper trade: ${opp.direction} ${opp.position.quantity} ${opp.symbol} @ ₹${opp.entry}`,
  };
}

// ── Execute a live trade (real Breeze order) ──
async function executeLive(opp: ChallengeOpportunity): Promise<ExecutionResult> {
  const timestamp = new Date().toISOString();

  const breezeAvailable = await isBreezeAvailable();
  if (!breezeAvailable) {
    const paper = executePaper(opp);
    paper.message = "Breeze unavailable — fell back to paper trade";
    return paper;
  }

  try {
    const isIndex = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"].includes(opp.symbol);
    const isOption = opp.instrument === "CALL" || opp.instrument === "PUT";
    const isFuture = opp.instrument === "FUTURES";
    const isEquity = opp.instrument === "EQUITY";

    let exchangeCode: "NSE" | "NFO" = isEquity ? "NSE" : "NFO";
    let product = "MIS";
    let action: "BUY" | "SELL" = opp.direction.includes("BUY") || opp.direction === "LONG" || opp.direction === "CALL" ? "BUY" : "SELL";
    let quantity = String(opp.position.quantity);
    let price = "0";
    let expiryDate = "";
    let right: "call" | "put" | "others" = "others";
    let strikePrice = "0";

    if (isOption) {
      expiryDate = getWeeklyExpiry();
      right = opp.instrument === "CALL" ? "call" : "put";
      quantity = String(opp.position.lots * getLotSize(opp.symbol));
    } else if (isFuture) {
      expiryDate = getWeeklyExpiry();
      quantity = String(opp.position.lots * getLotSize(opp.symbol));
    }

    const result = await placeOrder({
      stockCode: opp.symbol,
      exchangeCode,
      product,
      action,
      orderType: "market" as any,
      quantity,
      price,
      validity: "ioc" as any,
      expiryDate,
      right,
      strikePrice,
      userRemark: `Challenge #Auto | Score ${opp.score} | ${opp.strategy}`,
    });

    const orderId = result.orderId;
    const tradeId = generateUniqueId("LIVE");

    // Record to Trade Audit sidecar
    try {
      await recordSignal({
        strategyId: "CHALLENGE_AUTO",
        symbol: opp.symbol,
        direction: action === "BUY" ? "LONG" : "SHORT",
        entry: opp.entry,
        stopLoss: opp.stopLoss,
        tp1: opp.target1,
        tp2: opp.target2,
        confidence: opp.score,
        qualityScore: opp.score,
        marketContext: {
          spot: opp.data.ltp,
          regime: "CHALLENGE",
          vix: 0,
          sessionPhase: "AUTO",
          dataQuality: "REAL",
        },
      });
    } catch {}

    const entry: TradeLogEntry = {
      id: tradeId,
      timestamp,
      mode: "LIVE",
      symbol: opp.symbol,
      strategy: opp.strategy,
      direction: action,
      instrument: opp.instrument,
      entry: opp.entry,
      stopLoss: opp.stopLoss,
      target: opp.target1,
      quantity: parseInt(quantity),
      lotSize: getLotSize(opp.symbol),
      score: opp.score,
      status: "OPEN",
      orderId,
    };
    addTrade(entry);

    // Telegram alert
    try {
      const msg = `🟢 CHALLENGE AUTO-TRADE\n${action} ${quantity} ${opp.symbol} @ ₹${opp.entry}\nStrategy: ${opp.strategy} | Score: ${opp.score}/100\nSL: ₹${opp.stopLoss} | TP: ₹${opp.target1}\nR:R 1:${opp.riskReward.toFixed(1)}\nOrder ID: ${orderId}`;
      await fetch(`http://localhost:3000/api/telegram`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      }).catch(() => {});
    } catch {}

    return {
      success: true,
      mode: "LIVE",
      tradeId,
      orderId,
      symbol: opp.symbol,
      strategy: opp.strategy,
      direction: action,
      instrument: opp.instrument,
      entry: opp.entry,
      stopLoss: opp.stopLoss,
      target: opp.target1,
      quantity: parseInt(quantity),
      lotSize: getLotSize(opp.symbol),
      maxLoss: opp.position.maxLoss,
      score: opp.score,
      timestamp,
      message: `LIVE order placed: ${action} ${quantity} ${opp.symbol} | Order #${orderId}`,
    };
  } catch (e: any) {
    const paper = executePaper(opp);
    paper.message = `Live execution failed (${e.message}) — fell back to paper`;
    paper.error = e.message;
    return paper;
  }
}

// ── Main execute function ──
export async function executeTrade(
  opp: ChallengeOpportunity,
  mode: ExecutionMode = "PAPER",
): Promise<ExecutionResult> {
  if (mode === "LIVE") return executeLive(opp);
  return executePaper(opp);
}

// ── Close a trade (FIXED: actually calls audit close and square-off) ──
export async function closeTradeExecution(
  tradeId: string,
  exitPrice: number,
  exitReason: string,
): Promise<{ success: boolean; pnl: number; message: string }> {
  const trade = tradeLog.find(t => t.id === tradeId);
  if (!trade) return { success: false, pnl: 0, message: "Trade not found" };

  const isLong = trade.direction === "BUY";
  const pnlPerShare = isLong ? exitPrice - trade.entry : trade.entry - exitPrice;
  const pnl = Math.round(pnlPerShare * trade.quantity);

  trade.exit = exitPrice;
  trade.pnl = pnl;
  trade.status = pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "BREAKEVEN";
  trade.exitReason = exitReason;

  // Close in audit sidecar (FIXED: actually calls closeTrade)
  try {
    await auditClose(tradeId, exitPrice, exitReason, 0);
  } catch {}

  // Close live Breeze position if LIVE mode (FIXED: actually calls squareOff)
  if (trade.mode === "LIVE" && trade.orderId) {
    try {
      const { squareOff } = await import("@/lib/icici-breeze/orders");
      await squareOff(trade.symbol, trade.quantity, "NFO");
    } catch {}
  }

  return { success: true, pnl, message: `Closed ${trade.symbol}: P&L ₹${pnl}` };
}

// ── Get trade log ──
export function getTradeLog(limit = 50): TradeLogEntry[] {
  return tradeLog.slice(0, limit);
}

// ── Get open trades ──
export function getOpenTrades(): TradeLogEntry[] {
  return tradeLog.filter(t => t.status === "OPEN");
}

// ── Get trade stats ──
export function getTradeStats() {
  const closed = tradeLog.filter(t => t.status !== "OPEN");
  const wins = closed.filter(t => t.status === "WIN");
  const losses = closed.filter(t => t.status === "LOSS");
  const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossWins = wins.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0));
  return {
    total: tradeLog.length,
    open: tradeLog.filter(t => t.status === "OPEN").length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : 0,
    totalPnl,
    avgPnl: closed.length > 0 ? Math.round(totalPnl / closed.length) : 0,
    profitFactor: grossLosses > 0 ? Math.round((grossWins / grossLosses) * 100) / 100 : grossWins > 0 ? 99 : 0,
  };
}
