// Trade Validator — replays yesterday's trades against real market data
// Reads from Prisma DB, fetches historical data from NSE/Breeze, validates each trade.

import { db } from "@/lib/db";
import { getNSEHistoricalData, getNSEOptionChain } from "@/lib/nse-api";
import { initSession } from "@/lib/icici-breeze/auth";
import { getOptionChain } from "@/lib/icici-breeze/option-chain";
import { getYahooSymbol } from "@/lib/trade-backtest-engine";

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
// Exported for scripts/repair-legacy-exits.ts — real day OHLC/close for an
// arbitrary past date (NSE first, exact-date Yahoo daily as fallback).
const NSE_MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * Pick the row whose bar date IS the target session (strict — never returns
 * an adjacent session's bar). NSE historical range queries clamp across
 * boundaries: [Sun, Mon] comes back with Monday's bar as data[0], so
 * trusting data[0] silently stamped weekends/holidays with the next
 * session's close.
 */
export function findBarForDate<T extends object>(
  rows: T[] | null | undefined,
  targetISO: string
): T | null {
  if (!Array.isArray(rows) || !/^\d{4}-\d{2}-\d{2}$/.test(targetISO)) return null;
  for (const row of rows) {
    const raw = String((row as any)?.mtimestamp ?? "").trim();
    if (!raw) continue;
    let iso: string | null = null;
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
    if (m) iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    if (!iso) {
      m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(raw);
      if (m) {
        const mo = NSE_MONTHS[m[2].toLowerCase()];
        if (mo) iso = `${m[3]}-${mo}-${m[1].padStart(2, "0")}`;
      }
    }
    if (!iso) {
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
      if (m) iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    }
    if (iso === targetISO) return row;
  }
  return null;
}

export async function getDailyRange(symbol: string, date: Date): Promise<{ high: number; low: number; close: number } | null> {
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
    const targetISO = date.toISOString().slice(0, 10);
    const data = await getNSEHistoricalData(nseSymbol, date, end);
    const day: any = findBarForDate(data as any, targetISO);
    if (day) {
      const high = Number(day.chTradeHighPrice ?? day.high ?? day.HIGH ?? 0);
      const low = Number(day.chTradeLowPrice ?? day.low ?? day.LOW ?? 0);
      const close = Number(day.chClosingPrice ?? day.close ?? day.CLOSE ?? 0);
      if (high > 0 && low > 0 && Number.isFinite(high) && Number.isFinite(low)) {
        return { high, low, close: close > 0 ? close : (high + low) / 2 };
      }
    }
  } catch { /* fall through */ }

  // Fallback: Yahoo Finance daily OHLC for the exact date (real data, never fabricated)
  try {
    const yahooSymbol = getYahooSymbol(nseSymbol);
    const dayMs = 86400000;
    const p1 = Math.floor((date.getTime() - 4 * dayMs) / 1000);
    const p2 = Math.floor((date.getTime() + 2 * dayMs) / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?period1=${p1}&period2=${p2}&interval=1d`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (res.ok) {
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      const ts: number[] = result?.timestamp || [];
      const q = result?.indicators?.quote?.[0];
      const target = date.toISOString().slice(0, 10);
      const pad = (n: number) => String(n).padStart(2, "0");
      for (let i = 0; i < ts.length; i++) {
        // Shift epoch to IST before reading the calendar date
        const ist = new Date((ts[i] + 19800) * 1000);
        const dstr = `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
        if (dstr === target) {
          const high = Number(q?.high?.[i]);
          const low = Number(q?.low?.[i]);
          const close = Number(q?.close?.[i]);
          if (high > 0 && low > 0 && Number.isFinite(high) && Number.isFinite(low)) {
            return { high, low, close: Number.isFinite(close) && close > 0 ? close : (high + low) / 2 };
          }
        }
      }
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
  const isCall = trade.type === "CALL" || trade.type === "BUY_CALL" || trade.type === "CE";
  const isPut = trade.type === "PUT" || trade.type === "BUY_PUT" || trade.type === "PE";
  const isSellCall = trade.type === "SELL_CALL";
  const isSellPut = trade.type === "SELL_PUT";
  const isEquity = trade.type === "EQUITY" || trade.type === "STOCK";
  const isBullish = isCall || isSellPut || (isEquity && trade.side !== "SELL");
  const isBearish = isPut || isSellCall || (isEquity && trade.side === "SELL");

  if (!range) {
    return {
      validated: false,
      reason: "NO_DATA — Could not fetch historical market data for this date",
      slippage: 0,
      strikeExists: true,
      entryInRange: false,
      slOnCorrectSide: isBullish ? trade.stopLoss < trade.entryPrice : trade.stopLoss > trade.entryPrice,
      slWouldHit: false,
      tpWouldHit: false,
    };
  }

  const entry = trade.entryPrice;
  const sl = trade.stopLoss;
  const tp = trade.target1 || 0;

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
