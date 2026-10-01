// TIGER Trade Monitor — Background LTP polling + Telegram alerts
// THE production TP/SL event loop (auto-started by instrumentation.ts).
//
// Event flow:
//   fetchLTP → detect (BUY + SELL) → activeTradeTracker.updateTradeStatus
//   → DB status + active-trade-lock update/release
//   → telegram-alerts.sendTPSLAlert (delivery flags + retry) → telegram.ts
//
// Detection iterates getMonitoredTrades() (non-terminal: ACTIVE/TP1/TP2)
// so trailing trades keep being watched. Terminal hits stop monitoring and
// release the one-trade-per-underlying lock.

import {
  getMonitoredTrades, updateTradeStatus, getTrade,
  isTerminalTradeStatus, type ActiveTrade,
} from "./activeTradeTracker";
import { sendTelegramMessage } from "./telegram";
import { sendTPSLAlert, retryFailedAlerts } from "./agents/telegram-alerts";
import type { TPSLAlert, TPSLAlertType } from "./agents/agent-contract";

// ── Config ──
const POLL_INTERVAL_MS = 5_000;      // 5 seconds
const MARKET_START_HOUR = 9;
const MARKET_START_MIN = 15;
const MARKET_END_HOUR = 15;
const MARKET_END_MIN = 30;
const LTP_FAIL_THRESHOLD = 10;       // consecutive failures → monitoring error alert

let monitorRunning = false;
let monitorTimer: ReturnType<typeof setInterval> | null = null;
const ltpFailCounts = new Map<string, number>();

// ── LTP fetcher (Breeze → NSE → Yahoo) ──
// Exported for the EOD square-off route — same honest price source for the
// 15:31 close as the live SL/TP monitor uses.
export async function fetchLTP(symbol: string, strike: number, optionType: string): Promise<number> {
  const isOption = optionType === "CE" || optionType === "PE";

  if (isOption && strike > 0) {
    // Option premium from Breeze (getOptionChain needs an expiry — "" = nearest)
    try {
      const { getOptionChain } = await import("@/lib/icici-breeze/option-chain");
      const chain = await getOptionChain(symbol, "");
      if (chain) {
        const idx = chain.strikes.indexOf(strike);
        if (idx >= 0) {
          const call = chain.calls[idx];
          const put = chain.puts[idx];
          const leg = optionType === "CE" ? call : put;
          if (leg?.ltp && leg.ltp > 0) return leg.ltp;
        }
      }
    } catch {}

    // Option premium from NSE API
    try {
      const { getNSEOptionChain } = await import("@/lib/nse-api");
      const data = await getNSEOptionChain(symbol);
      if (data?.records?.data) {
        const row = data.records.data.find((r: any) => r.strikePrice === strike);
        if (row) {
          const leg = optionType === "CE" ? row.CE : row.PE;
          if (leg?.lastPrice && leg.lastPrice > 0) return leg.lastPrice;
        }
      }
    } catch {}

    return 0;
  }

  // Equity / futures LTP — Breeze quotes
  try {
    const { getQuotes } = await import("@/lib/icici-breeze/option-chain");
    const q = await getQuotes(symbol, "NSE");
    const ltp = Number(q?.[0]?.ltp ?? q?.ltp ?? 0);
    if (ltp > 0) return ltp;
  } catch {}

  // Equity fallback — Yahoo Finance
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}.NS?interval=1m&range=1d`,
      { signal: AbortSignal.timeout(5000) }
    );
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    const ltp = Number(meta?.regularMarketPrice ?? 0);
    if (ltp > 0) return ltp;
  } catch {}

  return 0;
}

// ── Market hours check ──
function isMarketOpen(): boolean {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours();
  const m = ist.getMinutes();
  const dow = ist.getDay();
  if (dow === 0 || dow === 6) return false;
  const mins = h * 60 + m;
  return mins >= MARKET_START_HOUR * 60 + MARKET_START_MIN && mins <= MARKET_END_HOUR * 60 + MARKET_END_MIN;
}

// ── Alert builders (full TASK-3 field set) ──
function pnlStr(entry: number, price: number, side: "BUY" | "SELL"): string {
  const diff = side === "BUY" ? price - entry : entry - price;
  const pct = entry > 0 ? (diff / entry) * 100 : 0;
  const sign = diff >= 0 ? "+" : "";
  const icon = diff >= 0 ? "🟢" : "🔴";
  return `${icon} P&L: ${sign}₹${diff.toFixed(2)} (${sign}${pct.toFixed(1)}%)`;
}

function card(t: ActiveTrade): string {
  return [
    `📊 ${t.symbol} — ${t.optionType || t.instrument}`,
    `⚡ Direction: ${t.side} ${t.optionType === "CE" ? "CALL" : t.optionType === "PE" ? "PUT" : t.instrument || ""}`.trim(),
    t.strike ? `🎯 Strike: ${t.strike}` : "",
    `🧾 Trade ID: ${t.id}`,
    t.confidence ? `💪 Confidence: ${t.confidence}%` : "",
    `💰 Entry: ₹${t.entry.toFixed(2)}`,
  ].filter(Boolean).join("\n");
}

function buildAlert(t: ActiveTrade, alertType: TPSLAlertType, ltp: number): TPSLAlert {
  const isTP = alertType.startsWith("TP");
  const instr = (["CALL", "PUT", "FUTURES", "EQUITY"].includes(t.instrument)
    ? t.instrument
    : t.optionType === "CE" ? "CALL"
    : t.optionType === "PE" ? "PUT"
    : "EQUITY") as "CALL" | "PUT" | "FUTURES" | "EQUITY";
  const hitPrice =
    alertType === "SL_HIT" ? t.sl :
    alertType === "TP1_HIT" ? t.tp1 :
    alertType === "TP2_HIT" ? t.tp2 :
    (t.tp3 ?? t.tp2);
  const labels: Record<string, string> = {
    SL_HIT: t.status === "TP1_HIT" ? "TRAILED SL HIT" : "SL HIT — TRADE CLOSED",
    TP1_HIT: "TARGET 1 HIT",
    TP2_HIT: "TARGET 2 HIT",
    TP3_HIT: "TARGET 3 HIT — FULL EXIT",
  };
  const hitTime = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const finalStatus = alertType === "SL_HIT" ? "SL_HIT" : alertType;

  const message = [
    `${"━".repeat(20)}`,
    `${isTP ? "🎯" : "🚨"} ${labels[alertType] || alertType}`,
    `${"━".repeat(20)}`,
    card(t),
    `💲 Current LTP: ₹${ltp.toFixed(2)}`,
    `🛑 SL: ₹${t.sl.toFixed(2)}`,
    `🎯 TP Level: ₹${hitPrice.toFixed(2)} (${alertType.replace("_HIT", "")})`,
    t.tp1 ? `TP1: ₹${t.tp1.toFixed(2)} | TP2: ₹${t.tp2.toFixed(2)}${t.tp3 ? ` | TP3: ₹${t.tp3.toFixed(2)}` : ""}` : "",
    pnlStr(t.entry, hitPrice, t.side),
    `🕐 Hit time: ${hitTime}`,
    `📌 Final status: ${finalStatus}`,
    `${"━".repeat(20)}`,
  ].filter(Boolean).join("\n");

  return {
    alertId: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tradeId: t.id,
    alertType,
    symbol: t.symbol,
    side: t.side,
    instrument: instr,
    strike: t.strike,
    entry: t.entry,
    currentLTP: ltp,
    triggerPrice: hitPrice,
    sl: t.sl,
    tp1: t.tp1,
    tp2: t.tp2,
    tp3: t.tp3,
    pnl: t.side === "BUY" ? hitPrice - t.entry : t.entry - hitPrice,
    pnlPct: t.entry > 0
      ? ((t.side === "BUY" ? hitPrice - t.entry : t.entry - hitPrice) / t.entry) * 100
      : 0,
    timestamp: new Date().toISOString(),
    message,
    sent: false,
    retryCount: 0,
  };
}

async function alertNewTrade(t: ActiveTrade): Promise<void> {
  // Don't send trade alerts outside market hours
  if (!isMarketOpen()) return;

  const msg = [
    "TIGER Analysis (live)\n",
    card(t),
    `🛑 Stop Loss: ₹${t.sl.toFixed(2)}`,
    `🎯 Target 1: ₹${t.tp1.toFixed(2)}`,
    `🎯 Target 2: ₹${t.tp2.toFixed(2)}`,
    t.tp3 ? `🎯 Target 3: ₹${t.tp3.toFixed(2)}` : "",
    `\n⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
  ].filter(Boolean).join("\n");
  await sendTelegramMessage(msg).catch(() => {});
}

// ── Detection helpers ──
function detectHit(t: ActiveTrade, ltp: number): TPSLAlertType | null {
  if (isTerminalTradeStatus(t, t.status)) return null;

  if (t.side === "BUY") {
    // 1) SL check — always first (covers trailed SL after TP1)
    if (ltp <= t.sl) return "SL_HIT";
    // 2) TP ladder by status
    if (t.status === "ACTIVE" && ltp >= t.tp1) return "TP1_HIT";
    if (t.status === "TP1_HIT" && t.tp2 > 0 && ltp >= t.tp2) return "TP2_HIT";
    if (t.status === "TP2_HIT" && t.tp3 && t.tp3 > 0 && ltp >= t.tp3) return "TP3_HIT";
  } else {
    // SELL (equity/futures/commodities): SL above entry, TP below
    if (ltp >= t.sl) return "SL_HIT";
    if (t.status === "ACTIVE" && ltp <= t.tp1) return "TP1_HIT";
    if (t.status === "TP1_HIT" && t.tp2 > 0 && ltp <= t.tp2) return "TP2_HIT";
    if (t.status === "TP2_HIT" && t.tp3 && t.tp3 > 0 && ltp <= t.tp3) return "TP3_HIT";
  }
  return null;
}

// ── Core monitor loop (exported for e2e tests) ──
export async function pollTradesOnce(
  resolveLTP?: (t: ActiveTrade) => Promise<number>
): Promise<{ detected: number; sent: number; errors: string[] }> {
  const errors: string[] = [];
  let detected = 0;
  let sent = 0;
  const resolver = resolveLTP ?? ((t: ActiveTrade) => fetchLTP(t.symbol, t.strike, t.optionType));

  const trades = getMonitoredTrades(); // non-terminal only
  for (const trade of trades) {
    try {
      const ltp = await resolver(trade);
      if (ltp <= 0) {
        const fails = (ltpFailCounts.get(trade.id) || 0) + 1;
        ltpFailCounts.set(trade.id, fails);
        // Monitoring error alert — fires ONCE at threshold (not an SL flag,
        // so it can never block a real SL_HIT delivery later)
        if (fails === LTP_FAIL_THRESHOLD) {
          const msg = [
            "⚠️ MONITORING ERROR",
            card(trade),
            `LTP feed unavailable after ${fails} consecutive attempts`,
            `Trade remains OPEN — no TP/SL detection until feed recovers`,
            `Time: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
          ].join("\n");
          await sendTelegramMessage(msg).catch(() => {});
          errors.push(`LTP unavailable for ${trade.symbol} (${trade.id}) after ${fails} attempts`);
        }
        continue;
      }
      ltpFailCounts.delete(trade.id);

      const hit = detectHit(trade, ltp);
      if (!hit) continue;

      detected++;

      // 1) Tracker: status update + DB persist + lock update/release
      await updateTradeStatus(trade.id, hit);
      const fresh = getTrade(trade.id) ?? trade; // may be deleted if terminal

      // 2) Telegram: delivery-flagged alert (dedup + retry)
      const alert = buildAlert({ ...fresh, status: hit }, hit, ltp);
      const ok = await sendTPSLAlert(alert);
      if (ok) sent++;

      // 3) Retry any previously failed alerts alongside
      await retryFailedAlerts().catch(() => {});

      if (isTerminalTradeStatus(trade, hit)) {
        ltpFailCounts.delete(trade.id);
        console.log(`[TIGER] ${trade.symbol} ${hit} — monitoring stopped, lock released`);
      }
    } catch (err: any) {
      errors.push(`${trade.id}: ${err.message}`);
    }
  }

  return { detected, sent, errors };
}

/** Back-compat tick used by setInterval — market-hours gated. */
async function monitorTick(): Promise<void> {
  if (!isMarketOpen()) return;
  try {
    const result = await pollTradesOnce();
    if (result.detected > 0 || result.errors.length > 0) {
      console.log(
        `[TIGER] tick detected=${result.detected} sent=${result.sent} errors=${result.errors.length}`,
        result.errors.slice(0, 3)
      );
    }
  } catch (err: any) {
    console.warn(`[TIGER] tick error: ${err.message}`);
  }
}

// ── Public API ──
export async function startTigerMonitor(): Promise<void> {
  const g = globalThis as any;
  if (!g.__tigerMonitor) g.__tigerMonitor = { running: false, timer: null };
  const state = g.__tigerMonitor;
  if (state.running) return;

  // Reload active trades from database before starting monitor
  try {
    const { reloadActiveTrades } = await import("./activeTradeTracker");
    const loaded = await reloadActiveTrades();
    console.log(`[TIGER] Reloaded ${loaded} active trades from database`);
  } catch (err: any) {
    console.warn(`[TIGER] Failed to reload trades: ${err.message}`);
  }

  state.running = true;
  state.timer = setInterval(monitorTick, POLL_INTERVAL_MS);
  monitorRunning = true;
  monitorTimer = state.timer;
  console.log("[TIGER] Trade monitor started — polling every 5s");
}

export function stopTigerMonitor(): void {
  const g = globalThis as any;
  const state = g.__tigerMonitor;
  if (state?.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  if (state) state.running = false;
  monitorRunning = false;
  console.log("[TIGER] Trade monitor stopped");
}

export function isTigerMonitorRunning(): boolean {
  const g = globalThis as any;
  return g.__tigerMonitor?.running || monitorRunning;
}

// Re-export for convenience
export { alertNewTrade };
export type { ActiveTrade };
