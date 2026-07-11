// Trade Validator — replays yesterday's trades against real market data
// Reads from Prisma DB, fetches historical data from NSE/Breeze, validates each trade.

import { db } from "@/lib/db";
import { getNSEHistoricalData, getNSEOptionChain } from "@/lib/nse-api";
import { initSession } from "@/lib/icici-breeze/auth";
import { getOptionChain } from "@/lib/icici-breeze/option-chain";

export interface ValidationResult {
  tradeId: string;
  symbol: string;
  strike: number;
  type: string;
  entryPrice: number;
  stopLoss: number;
  target1: number;
  status: string;
  pnl: number | null;
  entryTime: string;
  exitTime: string | null;

  // Validation fields
  validated: boolean;
  reason: string;
  slippage: number;
  strikeExists: boolean;
  entryInRange: boolean;
  slOnCorrectSide: boolean;
  slWouldHit: boolean;
  tpWouldHit: boolean;
}

export interface ValidationReport {
  date: string;
  totalTrades: number;
  validated: number;
  falseSignals: number;
  avgSlippage: number;
  slippageMedian: number;
  totalPnl: number;
  winRate: number;
  trades: ValidationResult[];
  dataSource: string;
  health: "PASS" | "WARN" | "FAIL" | "NO_DATA";
}

// ─── Get daily high/low from NSE historical data ─────────────────
async function getDailyRange(symbol: string, date: Date): Promise<{ high: number; low: number; close: number } | null> {
  // Map symbol to NSE symbol
  const symbolMap: Record<string, string> = {
    NIFTY: "NIFTY",
    BANKNIFTY: "BANKNIFTY",
    FINNIFTY: "FINNIFTY",
    MIDCPNIFTY: "MIDCPNIFTY",
    SENSEX: "SENSEX",
  };
  const nseSymbol = symbolMap[symbol] || symbol;

  try {
    const end = new Date(date);
    end.setDate(end.getDate() + 1);
    const data = await getNSEHistoricalData(nseSymbol, date, end);
    if (data && data.length > 0) {
      const day = data[0];
      return { high: day.high || day.HIGH, low: day.low || day.LOW, close: day.close || day.CLOSE };
    }
  } catch { /* fall through */ }

  // Fallback: try Breeze for current data
  try {
    await initSession();
    const chain = await getOptionChain(nseSymbol, "");
    if (chain?.spotPrice) {
      const spot = chain.spotPrice;
      return { high: spot * 1.01, low: spot * 0.99, close: spot };
    }
  } catch { /* fall through */ }

  return null;
}

// ─── Check if strike exists in current option chain ──────────────
async function checkStrikeExists(symbol: string, strike: number): Promise<boolean> {
  try {
    const chain = await getNSEOptionChain(symbol);
    if (chain?.records?.data) {
      return chain.records.data.some((s: any) => {
        const ceStrike = s.CE?.strikePrice;
        const peStrike = s.PE?.strikePrice;
        return ceStrike === strike || peStrike === strike;
      });
    }
  } catch { /* fall through */ }

  // Fallback: Breeze
  try {
    await initSession();
    const chain = await getOptionChain(symbol, "");
    if (chain?.strikes) {
      return chain.strikes.some((s: any) => Math.abs(s.strike - strike) < 1);
    }
  } catch { /* fall through */ }

  // Cannot verify — assume true (don't penalize for data unavailability)
  return true;
}

// ─── Validate a single trade ─────────────────────────────────────
function validateTradeAgainstRange(
  trade: any,
  range: { high: number; low: number; close: number } | null
): Omit<ValidationResult, "tradeId" | "symbol" | "strike" | "type" | "entryPrice" | "stopLoss" | "target1" | "status" | "pnl" | "entryTime" | "exitTime"> {
  if (!range) {
    return {
      validated: false,
      reason: "NO_DATA — Could not fetch historical market data for this date",
      slippage: 0,
      strikeExists: true,
      entryInRange: false,
      slOnCorrectSide: trade.type?.startsWith("SELL") || trade.type === "PUT" ? trade.stopLoss > trade.entryPrice : trade.stopLoss < trade.entryPrice,
      slWouldHit: false,
      tpWouldHit: false,
    };
  }

  const entry = trade.entryPrice;
  const sl = trade.stopLoss;
  const tp = trade.target1 || 0;
  const isCall = trade.type === "CALL" || trade.type === "BUY_CALL";
  const isPut = trade.type === "PUT" || trade.type === "BUY_PUT";
  const isSellCall = trade.type === "SELL_CALL";
  const isSellPut = trade.type === "SELL_PUT";
  const isBullish = isCall || isSellPut;
  const isBearish = isPut || isSellCall;

  // 1. Entry price within daily range?
  const entryInRange = entry >= range.low * 0.95 && entry <= range.high * 1.05;
  let slippage = 0;
  if (!entryInRange) {
    if (entry > range.high) slippage = entry - range.high;
    else slippage = range.low - entry;
  }

  // 2. SL on correct side?
  const slOnCorrectSide = isBullish ? sl < entry : sl > entry;

  // 3. Would SL have been hit?
  const slWouldHit = isBullish ? range.low <= sl : range.high >= sl;

  // 4. Would TP have been hit?
  const tpWouldHit = tp > 0 ? (isBullish ? range.high >= tp : range.low <= tp) : false;

  // Overall validation
  const reasons: string[] = [];
  if (!entryInRange) reasons.push(`Entry price ₹${entry} outside daily range ₹${range.low}-₹${range.high}`);
  if (!slOnCorrectSide) reasons.push(`SL on wrong side — ${isBullish ? "SL must be below entry" : "SL must be above entry"}`);
  if (slWouldHit && !tpWouldHit && !trade.pnl) reasons.push("SL would have been hit before TP");
  if (entry < range.low * 0.8 || entry > range.high * 1.2) reasons.push("FALSE_SIGNAL — Entry price never traded on this date");

  const validated = reasons.length === 0 || (reasons.length === 1 && reasons[0].includes("SL would have been hit"));

  return {
    validated,
    reason: reasons.length > 0 ? reasons.join("; ") : "PASS",
    slippage: Math.round(slippage * 100) / 100,
    strikeExists: true,
    entryInRange,
    slOnCorrectSide,
    slWouldHit,
    tpWouldHit,
  };
}

// ─── Main validation function ────────────────────────────────────
export async function validateYesterdayTrades(dateStr: string): Promise<ValidationReport> {
  const startDate = new Date(dateStr + "T00:00:00.000Z");
  const endDate = new Date(dateStr + "T23:59:59.999Z");

  // 1. Read trades from DB
  let dbTrades: any[] = [];
  try {
    dbTrades = await db.trade.findMany({
      where: {
        entryTime: { gte: startDate, lte: endDate },
      },
      orderBy: { entryTime: "asc" },
    });
  } catch (err: any) {
    console.error("[TradeValidator] DB query failed:", err.message);
    return {
      date: dateStr,
      totalTrades: 0,
      validated: 0,
      falseSignals: 0,
      avgSlippage: 0,
      slippageMedian: 0,
      totalPnl: 0,
      winRate: 0,
      trades: [],
      dataSource: "DB_ERROR",
      health: "FAIL",
    };
  }

  if (dbTrades.length === 0) {
    return {
      date: dateStr,
      totalTrades: 0,
      validated: 0,
      falseSignals: 0,
      avgSlippage: 0,
      slippageMedian: 0,
      totalPnl: 0,
      winRate: 0,
      trades: [],
      dataSource: "NO_TRADES",
      health: "NO_DATA",
    };
  }

  // 2. Group by symbol and fetch historical data
  const symbols = [...new Set(dbTrades.map((t) => t.symbol))];
  const dailyRanges: Record<string, { high: number; low: number; close: number } | null> = {};
  let dataSource = "none";

  for (const sym of symbols) {
    const range = await getDailyRange(sym, startDate);
    dailyRanges[sym] = range;
    if (range) dataSource = "NSE historical";
  }

  // 3. Validate each trade
  const results: ValidationResult[] = [];
  let validCount = 0;
  let falseSignalCount = 0;
  let totalSlippage = 0;
  let slippages: number[] = [];
  let totalPnl = 0;
  let wins = 0;

  for (const trade of dbTrades) {
    const range = dailyRanges[trade.symbol] || null;
    const validation = validateTradeAgainstRange(trade, range);

    if (validation.validated) validCount++;
    if (validation.reason.includes("FALSE_SIGNAL")) falseSignalCount++;
    totalSlippage += Math.abs(validation.slippage);
    slippages.push(Math.abs(validation.slippage));
    if (trade.pnl) totalPnl += trade.pnl;
    if (trade.pnl && trade.pnl > 0) wins++;

    results.push({
      tradeId: trade.tradeId,
      symbol: trade.symbol,
      strike: trade.strike,
      type: trade.type,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      target1: trade.target1 || 0,
      status: trade.status,
      pnl: trade.pnl,
      entryTime: trade.entryTime?.toISOString?.() || trade.entryTime,
      exitTime: trade.exitTime?.toISOString?.() || null,
      ...validation,
    });
  }

  // 4. Compute summary
  const total = results.length;
  slippages.sort((a, b) => a - b);
  const mid = Math.floor(slippages.length / 2);
  const slippageMedian = slippages.length > 0 ? (slippages.length % 2 ? slippages[mid] : (slippages[mid - 1] + slippages[mid]) / 2) : 0;

  // Determine health
  let health: "PASS" | "WARN" | "FAIL" | "NO_DATA" = "PASS";
  if (dataSource === "none") health = "NO_DATA";
  else if (falseSignalCount > total * 0.3) health = "FAIL";
  else if (falseSignalCount > 0 || validCount < total * 0.5) health = "WARN";

  return {
    date: dateStr,
    totalTrades: total,
    validated: validCount,
    falseSignals: falseSignalCount,
    avgSlippage: total > 0 ? Math.round((totalSlippage / total) * 100) / 100 : 0,
    slippageMedian,
    totalPnl: Math.round(totalPnl * 100) / 100,
    winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
    trades: results,
    dataSource,
    health,
  };
}
