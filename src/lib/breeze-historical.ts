// ═══════════════════════════════════════════════════════════════════
// Breeze Historical Intraday Candles
// Fetches REAL intraday OHLCV data from ICICI Breeze for indices (NIFTY, SENSEX, etc.)
// Used by backtest-audit.ts to verify every trade against actual market candles.
// ═══════════════════════════════════════════════════════════════════

import { initSession, getBreezeClient } from "@/lib/icici-breeze/auth";

// ─── Symbol mapping to Breeze stock codes ─────────────────────────
const BREEZE_STOCK_CODE: Record<string, string> = {
  NIFTY: "NIFTY",
  BANKNIFTY: "BANKNIFTY",
  FINNIFTY: "FINNIFTY",
  MIDCPNIFTY: "MIDCPNIFTY",
  SENSEX: "SENSEX",
  BANKEX: "BANKEX",
};

const EXCHANGE_CODE: Record<string, string> = {
  NIFTY: "NFO",
  BANKNIFTY: "NFO",
  FINNIFTY: "NFO",
  MIDCPNIFTY: "NFO",
  SENSEX: "BFO",
  BANKEX: "BFO",
};

// ─── Types ───────────────────────────────────────────────────────
export interface HistoricalCandle {
  time: string;        // ISO string "YYYY-MM-DD HH:MM:SS"
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IntradayCandleResult {
  candles: HistoricalCandle[];
  source: "breeze" | "fallback";
  warning?: string;
}

// ─── Get intraday candles for a specific date ────────────────────
export async function getIntradayCandles(
  symbol: string,
  dateStr: string,
  interval: "1minute" | "5minute" | "15minute" = "5minute"
): Promise<IntradayCandleResult> {
  const upperSym = symbol.toUpperCase();
  const stockCode = BREEZE_STOCK_CODE[upperSym];
  const exchangeCode = EXCHANGE_CODE[upperSym];

  if (!stockCode || !exchangeCode) {
    return {
      candles: [],
      source: "fallback",
      warning: `Unknown symbol ${symbol} for Breeze historical`,
    };
  }

  // Market hours: 09:15 to 15:30 IST
  const date = new Date(dateStr + "T00:00:00.000Z");
  const fromDate = new Date(date);
  fromDate.setHours(9, 15, 0, 0); // 09:15 IST
  const toDate = new Date(date);
  toDate.setHours(15, 30, 0, 0); // 15:30 IST

  // Format for Breeze: "YYYY-MM-DD HH:MM:SS"
  const formatBreezeDate = (d: Date): string => {
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const fromDateStr = formatBreezeDate(fromDate);
  const toDateStr = formatBreezeDate(toDate);

  // For indices (NIFTY, SENSEX, etc.), use productType "cash" without strike/right/expiry
  const isIndex = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"].includes(stockCode.toUpperCase());
  const productType = isIndex ? "cash" : "options";
  // Index spot candles need NSE/BSE exchange, not NFO/BFO
  const cashExchange = isIndex ? (["SENSEX", "BANKEX"].includes(stockCode.toUpperCase()) ? "BSE" : "NSE") : exchangeCode;

  try {
    // Ensure Breeze session is valid
    await initSession();
    const breeze = getBreezeClient();

    // Call Breeze getHistoricalDatav2 (intraday)
    const request: any = {
      interval: interval,
      fromDate: fromDateStr,
      toDate: toDateStr,
      stockCode: stockCode,
      exchangeCode: cashExchange,
      productType: productType,
    };

    // For options, add required fields
    if (!isIndex) {
      request.expiryDate = "";
      request.right = "";
      request.strikePrice = "";
    }

    const result = await breeze.getHistoricalDatav2(request);

    if (!result || result.Error || result.Status === 401) {
      const errMsg = result?.Error || result?.Message || "Breeze historical call failed";
      console.warn(`[Breeze Historical] ${errMsg} for ${symbol} on ${dateStr}`);
      return {
        candles: [],
        source: "fallback",
        warning: `Breeze error: ${errMsg}`,
      };
    }

    // Response structure: { Success: [{ time, open, high, low, close, volume }, ...] }
    const rawCandles = result.Success || result.data || result || [];
    const candles: HistoricalCandle[] = [];

    for (const c of rawCandles) {
      const timeStr = c.time || c.datetime || c.timestamp;
      if (!timeStr) continue;

      const open = Number(c.open ?? c.o ?? 0);
      const high = Number(c.high ?? c.h ?? 0);
      const low = Number(c.low ?? c.l ?? 0);
      const close = Number(c.close ?? c.c ?? 0);
      const volume = Number(c.volume ?? c.v ?? 0);

      if (!open && !high && !low && !close) continue;

      candles.push({
        time: timeStr,
        open,
        high,
        low,
        close,
        volume,
      });
    }

    // Sort by time ascending
    candles.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    return {
      candles,
      source: "breeze",
    };
  } catch (err: any) {
    console.error(`[Breeze Historical] Exception for ${symbol} on ${dateStr}:`, err.message);
    return {
      candles: [],
      source: "fallback",
      warning: `Exception: ${err.message}`,
    };
  }
}

// ─── Get daily candles (used for real per-instrument ATR) ──────────
export async function getDailyCandles(
  symbol: string,
  days: number = 100
): Promise<IntradayCandleResult> {
  const upperSym = symbol.toUpperCase();
  const stockCode = BREEZE_STOCK_CODE[upperSym];
  const isIndex = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"].includes(stockCode?.toUpperCase());
  if (!stockCode || !isIndex) {
    return { candles: [], source: "fallback", warning: `Unknown index ${symbol}` };
  }
  // Index spot candles live on NSE/BSE cash, not NFO/BFO
  const cashExchange = ["SENSEX", "BANKEX"].includes(stockCode.toUpperCase()) ? "BSE" : "NSE";

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
  const fmt = (d: Date): string => {
    const p = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 00:00:00`;
  };

  try {
    await initSession();
    const breeze = getBreezeClient();
    const result = await breeze.getHistoricalDatav2({
      interval: "1day",
      fromDate: fmt(from),
      toDate: fmt(to),
      stockCode,
      exchangeCode: cashExchange,
      productType: "cash",
    });

    if (!result || result.Error || result.Status === 401) {
      const msg = result?.Error || result?.Message || "Breeze daily historical failed";
      console.warn(`[Breeze Daily] ${msg} for ${symbol}`);
      return { candles: [], source: "fallback", warning: msg };
    }

    const raw = result.Success || result.data || result || [];
    const candles: HistoricalCandle[] = [];
    for (const c of raw) {
      const t = c.time || c.datetime || c.date || c.timestamp;
      if (!t) continue;
      const o = Number(c.open ?? c.o ?? 0);
      const h = Number(c.high ?? c.h ?? 0);
      const l = Number(c.low ?? c.l ?? 0);
      const cl = Number(c.close ?? c.c ?? 0);
      const v = Number(c.volume ?? c.v ?? 0);
      if (!o && !h && !l && !cl) continue;
      candles.push({ time: t, open: o, high: h, low: l, close: cl, volume: v });
    }
    candles.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    return { candles, source: "breeze" };
  } catch (err: any) {
    console.warn(`[Breeze Daily] Exception for ${symbol}:`, err.message);
    return { candles: [], source: "fallback", warning: err.message };
  }
}

// ─── Get the exact candle at a specific timestamp (or nearest before) ──
export function findCandleAtOrBefore(
  candles: HistoricalCandle[],
  targetTime: string | Date
): HistoricalCandle | null {
  const target = new Date(targetTime).getTime();
  let best: HistoricalCandle | null = null;
  let bestDiff = Infinity;

  for (const c of candles) {
    const candleTime = new Date(c.time).getTime();
    if (candleTime <= target) {
      const diff = target - candleTime;
      if (diff < bestDiff) {
        bestDiff = diff;
        best = c;
      }
    }
  }
  return best;
}

// ─── Verify a trade's entry/exit/SL/TP against real intraday candles ────
export interface TradeVerificationResult {
  entryVerified: boolean;
  entryReason: string;
  exitVerified: boolean;
  exitReason: string;
  slHitTime: string | null;
  tpHitTime: string | null;
  slHitPrice: number | null;
  tpHitPrice: number | null;
  actualExitPrice: number | null;
  actualExitTime: string | null;
  mismatchDetails: string[];
  computedPnl: number; // The P&L computed from the actual exit price
  lotSize: number;     // The lot size used for P&L calculation
  direction: "long" | "short"; // Trade direction
}

export function verifyTradeAgainstCandles(
  trade: {
    direction: "long" | "short";
    entryTime: string;
    entryPrice: number;
    exitTime: string | null;
    exitPrice: number | null;
    stopLoss: number;
    target1: number;
    target2: number;
    target3: number;
    tpHitLevel: string | null;
    status: string;
    lotSize: number;
  },
  candles: HistoricalCandle[]
): TradeVerificationResult {
  // Baseline P&L from the stored exit price — the correct value when no
  // candle replay occurs (handled by the early-return below). The replay path
  // recomputes it from the actual candle exit price before returning. Scoped
  // in an IIFE so its locals don't collide with the replay-path declarations.
  const baselinePnl = (() => {
    const exitForPnl = trade.exitPrice ?? trade.entryPrice;
    const perLot = trade.direction === "long"
      ? exitForPnl - trade.entryPrice
      : trade.entryPrice - exitForPnl;
    const v = perLot * trade.lotSize;
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
  })();

  const result: TradeVerificationResult = {
    entryVerified: false,
    entryReason: "",
    exitVerified: false,
    exitReason: "",
    slHitTime: null,
    tpHitTime: null,
    slHitPrice: null,
    tpHitPrice: null,
    actualExitPrice: null,
    actualExitTime: null,
    mismatchDetails: [],
    // Static fields known upfront
    direction: trade.direction,
    lotSize: trade.lotSize,
    computedPnl: baselinePnl,
  };

  if (!candles || !Array.isArray(candles) || candles.length === 0) {
    result.entryReason = "No candle data available for verification";
    result.exitReason = "No candle data available for verification";
    return result;
  }

  const isLong = trade.direction === "long";
  const entryTime = new Date(trade.entryTime);
  const exitTime = trade.exitTime ? new Date(trade.exitTime) : null;

  // ─── 1. ENTRY VERIFICATION ───
  // Find the candle at or just after entry time
  const entryCandle = candles.find(
    (c) => new Date(c.time) >= entryTime
  ) || candles[candles.length - 1];

  if (entryCandle) {
    const entryInRange =
      trade.entryPrice >= entryCandle.low * 0.995 &&
      trade.entryPrice <= entryCandle.high * 1.005;

    if (entryInRange) {
      result.entryVerified = true;
      result.entryReason = `Entry ${trade.entryPrice} within candle range [${entryCandle.low}, ${entryCandle.high}] at ${entryCandle.time}`;
    } else {
      result.entryVerified = false;
      result.entryReason = `Entry ${trade.entryPrice} OUTSIDE candle range [${entryCandle.low}, ${entryCandle.high}] at ${entryCandle.time}`;
      result.mismatchDetails.push(`Entry price mismatch: ${trade.entryPrice} vs candle [${entryCandle.low}-${entryCandle.high}]`);
    }
  } else {
    result.entryReason = "No candle found at entry time";
  }

  // ─── 2. SL/TP REPLAY ───
  // Replay candles from entry onward to find first SL/TP hit
  let entryIndex = candles.findIndex((c) => new Date(c.time) >= entryTime);
  if (entryIndex === -1) entryIndex = candles.length - 1;

  let slHit = false;
  let tpHit = false;
  let actualExitPrice: number | null = null;
  let actualExitTime: string | null = null;

  for (let i = entryIndex + 1; i < candles.length; i++) {
    const candle = candles[i];

    if (isLong) {
      // Check SL first (adverse move)
      if (!slHit && candle.low <= trade.stopLoss) {
        slHit = true;
        result.slHitTime = candle.time;
        result.slHitPrice = trade.stopLoss;
      }
      // Check TP levels (favorable move)
      if (!tpHit) {
        if (trade.target3 > 0 && candle.high >= trade.target3) {
          tpHit = true;
          result.tpHitTime = candle.time;
          result.tpHitPrice = trade.target3;
        } else if (trade.target2 > 0 && candle.high >= trade.target2) {
          tpHit = true;
          result.tpHitTime = candle.time;
          result.tpHitPrice = trade.target2;
        } else if (candle.high >= trade.target1) {
          tpHit = true;
          result.tpHitTime = candle.time;
          result.tpHitPrice = trade.target1;
        }
      }
    } else {
      // Short: SL is UP, TP is DOWN
      if (!slHit && candle.high >= trade.stopLoss) {
        slHit = true;
        result.slHitTime = candle.time;
        result.slHitPrice = trade.stopLoss;
      }
      if (!tpHit) {
        if (trade.target3 > 0 && candle.low <= trade.target3) {
          tpHit = true;
          result.tpHitTime = candle.time;
          result.tpHitPrice = trade.target3;
        } else if (trade.target2 > 0 && candle.low <= trade.target2) {
          tpHit = true;
          result.tpHitTime = candle.time;
          result.tpHitPrice = trade.target2;
        } else if (candle.low <= trade.target1) {
          tpHit = true;
          result.tpHitTime = candle.time;
          result.tpHitPrice = trade.target1;
        }
      }
    }

    // Stop if both hit or we passed exit time
    if (slHit && tpHit) break;
    if (exitTime && new Date(candle.time) >= exitTime) break;
  }

  // ─── 3. EXIT VERIFICATION ───
  // Determine what actually happened per candles
  const candleOutcome = slHit ? "SL" : tpHit ? "TP" : "NO_HIT";

  // Compare with stored status
  const statusUpper = trade.status.toUpperCase();
  const isStoredTp = statusUpper === "TP_HIT";
  const isStoredSl = statusUpper === "SL_HIT";

  if (isStoredTp && candleOutcome === "TP") {
    result.exitVerified = true;
    result.exitReason = `TP hit at ${result.tpHitPrice} (${result.tpHitTime}) matches stored TP`;
  } else if (isStoredSl && candleOutcome === "SL") {
    result.exitVerified = true;
    result.exitReason = `SL hit at ${result.slHitPrice} (${result.slHitTime}) matches stored SL`;
  } else if (isStoredTp && candleOutcome === "SL") {
    result.exitVerified = false;
    result.exitReason = `STORED TP but candles show SL hit first at ${result.slHitPrice} (${result.slHitTime})`;
    result.mismatchDetails.push(`Stored TP but SL hit first at ${result.slHitPrice}`);
  } else if (isStoredSl && candleOutcome === "TP") {
    result.exitVerified = false;
    result.exitReason = `STORED SL but candles show TP hit first at ${result.tpHitPrice} (${result.tpHitTime})`;
    result.mismatchDetails.push(`Stored SL but TP hit first at ${result.tpHitPrice}`);
  } else if (isStoredTp && candleOutcome === "NO_HIT") {
    // Trade marked TP but candles show neither hit — check if stored exit price is reachable
    if (trade.exitPrice !== null) {
      const exitCandle = candles.find((c) => new Date(c.time) >= (trade.exitTime ? new Date(trade.exitTime) : entryTime));
      if (exitCandle) {
        const exitInRange = isLong
          ? trade.exitPrice >= exitCandle.low && trade.exitPrice <= exitCandle.high
          : trade.exitPrice >= exitCandle.low && trade.exitPrice <= exitCandle.high;
        if (exitInRange) {
          result.exitVerified = true;
          result.exitReason = `Exit ${trade.exitPrice} reachable at ${exitCandle.time} (no SL/TP hit in candles)`;
          result.actualExitPrice = trade.exitPrice;
          result.actualExitTime = trade.exitTime;
        } else {
          result.exitVerified = false;
          result.exitReason = `Stored exit ${trade.exitPrice} NOT reachable in candle [${exitCandle.low}, ${exitCandle.high}] at ${exitCandle.time}`;
          result.mismatchDetails.push(`Exit price unreachable in market`);
        }
      }
    }
  } else if (isStoredSl && candleOutcome === "NO_HIT") {
    if (trade.exitPrice !== null) {
      const exitCandle = candles.find((c) => new Date(c.time) >= (trade.exitTime ? new Date(trade.exitTime) : entryTime));
      if (exitCandle) {
        const exitInRange = trade.exitPrice >= exitCandle.low && trade.exitPrice <= exitCandle.high;
        if (exitInRange) {
          result.exitVerified = true;
          result.exitReason = `Exit ${trade.exitPrice} reachable at ${exitCandle.time} (no SL/TP hit in candles)`;
          result.actualExitPrice = trade.exitPrice;
          result.actualExitTime = trade.exitTime;
        } else {
          result.exitVerified = false;
          result.exitReason = `Stored exit ${trade.exitPrice} NOT reachable in candle [${exitCandle.low}, ${exitCandle.high}] at ${exitCandle.time}`;
          result.mismatchDetails.push(`Exit price unreachable in market`);
        }
      }
    }
  }

  // Record actual exit from candles if different
  if (result.actualExitPrice === null && trade.exitPrice !== null) {
    result.actualExitPrice = trade.exitPrice;
    result.actualExitTime = trade.exitTime;
  }

  // Compute P&L from actual exit (or stored exit if no candle exit)
  const exitForPnl = result.actualExitPrice ?? trade.exitPrice ?? trade.entryPrice;
  const perLot = trade.direction === "long"
    ? exitForPnl - trade.entryPrice
    : trade.entryPrice - exitForPnl;
  const lotSize = trade.lotSize ?? 0;
  const computed = perLot * lotSize;
  result.computedPnl = Number.isFinite(computed) ? Math.round(computed * 100) / 100 : 0;
  result.lotSize = trade.lotSize;
  result.direction = trade.direction;

  return result;
}

// ─── Compute AI prediction accuracy ───────────────────────────────
export interface AIPredictionAccuracy {
  total: number;
  correct: number;
  accuracy: number;
  bySignal: Record<string, { total: number; correct: number; accuracy: number }>;
}

export function computeAIPredictionAccuracy(
  trades: Array<{
    aiReasonSnapshot?: string;
    status: string;
    type: string;
  }>
): AIPredictionAccuracy {
  let total = 0;
  let correct = 0;
  const bySignal: Record<string, { total: number; correct: number }> = {};

  for (const t of trades) {
    if (!t.aiReasonSnapshot) continue;
    total++;
    const isWin = t.status.toUpperCase() === "TP_HIT";
    if (isWin) correct++;

    // Extract signal type from AI reason
    let signal = "UNKNOWN";
    const reason = t.aiReasonSnapshot.toUpperCase();
    if (reason.includes("BUY CALL") || reason.includes("LONG CALL")) signal = "BUY_CALL";
    else if (reason.includes("BUY PUT") || reason.includes("LONG PUT")) signal = "BUY_PUT";
    else if (reason.includes("SELL CALL")) signal = "SELL_CALL";
    else if (reason.includes("SELL PUT")) signal = "SELL_PUT";

    if (!bySignal[signal]) bySignal[signal] = { total: 0, correct: 0 };
    bySignal[signal].total++;
    if (isWin) bySignal[signal].correct++;
  }

  const bySignalAcc: AIPredictionAccuracy["bySignal"] = {};
  for (const [sig, data] of Object.entries(bySignal)) {
    bySignalAcc[sig] = {
      total: data.total,
      correct: data.correct,
      accuracy: data.total > 0 ? Math.round((data.correct / data.total) * 1000) / 10 : 0,
    };
  }

  return {
    total,
    correct,
    accuracy: total > 0 ? Math.round((correct / total) * 1000) / 10 : 0,
    bySignal: bySignalAcc,
  };
}