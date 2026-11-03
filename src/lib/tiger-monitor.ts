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
  detectPlanHit, stopFillPrice, targetLevel,
  planPnlRupees, planPnlPct, tickPx, fmtStrike,
} from "./activeTradeTracker";
import { sendTelegramMessage } from "./telegram";
import { sendAlertText } from "./agents/telegram-alerts";
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

// ── LTP fetcher (MO path → Breeze → NSE) ──
// Exported for the EOD square-off route — same honest price source for the
// 15:31 close as the live SL/TP monitor uses.
//
// THE ORDER (explicit):
//   1. THE MO PATH — the MOAPI service (src/lib/motilal/service.ts) and then
//      the direct Motilal REST client (src/lib/motilal/market.ts). A Motilal
//      premium is only used when it PASSES THE PLAUSIBILITY GUARD
//      (src/lib/motilal/quote.ts): it must be a positive price, it must be
//      the trade's contract (strike + option type + expiry), and it must be
//      strictly below the underlying price. A price that fails the guard is
//      REJECTED — never used, never displayed.
//   2. BREEZE — the authorised ICICI feed (the option chain).
//   3. NSE — the exchange's own chain (free, no token).
//   4. 0 — "LTP feed unavailable" (the monitor reports it; it never invents
//      a price).
//
// When the MOAPI service is not configured (MOAPI_SERVICE_URL unset) or is
// down, rung 1 produces nothing and the behaviour is EXACTLY what it was
// before the service existed.
export interface LTPFetchDeps {
  /** The MO path (service → direct Motilal REST), guarded. */
  moPath?: (ref: {
    symbol: string;
    strike: number;
    optionType: string;
    expiry?: string;
  }) => Promise<number>;
  /** The Breeze option chain. */
  breezeChain?: (symbol: string, strike: number, optionType: string) => Promise<number>;
  /** The NSE option chain. */
  nseChain?: (symbol: string, strike: number, optionType: string) => Promise<number>;
}

/** The default MO path — the service, then the direct Motilal REST client. */
async function defaultMOPath(ref: {
  symbol: string;
  strike: number;
  optionType: string;
  expiry?: string;
}): Promise<number> {
  const { resolveMOOptionLTP } = await import("@/lib/motilal/quote");
  const result = await resolveMOOptionLTP({
    symbol: ref.symbol,
    strike: ref.strike,
    optionType: ref.optionType,
    expiry: ref.expiry,
  });
  return result.ltp > 0 ? result.ltp : 0;
}

/** The default Breeze rung (unchanged behaviour). */
async function defaultBreezeChain(
  symbol: string,
  strike: number,
  optionType: string
): Promise<number> {
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
  return 0;
}

/** The default NSE rung (unchanged behaviour). */
async function defaultNSEChain(
  symbol: string,
  strike: number,
  optionType: string
): Promise<number> {
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

export async function fetchLTP(
  symbol: string,
  strike: number,
  optionType: string,
  expiry?: string,
  deps?: LTPFetchDeps
): Promise<number> {
  const isOption = optionType === "CE" || optionType === "PE";

  if (isOption && strike > 0) {
    // 1. The MO path (service → direct REST) — guarded.
    const moPath = deps?.moPath ?? defaultMOPath;
    const mo = await moPath({ symbol, strike, optionType, expiry });
    if (mo > 0) return mo;

    // 2. Breeze (existing).
    const breezeChain = deps?.breezeChain ?? defaultBreezeChain;
    const breeze = await breezeChain(symbol, strike, optionType);
    if (breeze > 0) return breeze;

    // 3. NSE (existing).
    const nseChain = deps?.nseChain ?? defaultNSEChain;
    const nse = await nseChain(symbol, strike, optionType);
    if (nse > 0) return nse;

    return 0;
  }

  // Equity / futures LTP — Breeze quotes first
  try {
    const { getQuotes } = await import("@/lib/icici-breeze/option-chain");
    const q = await getQuotes(symbol, "NSE");
    const ltp = Number(q?.[0]?.ltp ?? q?.ltp ?? 0);
    if (ltp > 0) return ltp;
  } catch {}

  // Equity fallback — the FREE NSE/Moneycontrol quotes (never Yahoo: the SOP
  // says a price that is not from the exchange is not a price we may act on).
  try {
    const { fetchStockQuotes } = await import("@/lib/nse-stock-data");
    const quotes = await fetchStockQuotes([symbol]);
    const ltp = Number(quotes?.[symbol]?.ltp ?? quotes?.[symbol.toUpperCase()]?.ltp ?? 0);
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
/** Signed P&L for the POSITION (lot-multiplied) + the % of the premium.
 *  The sign follows the plan geometry — a mirrored (bearish) plan pays out the
 *  other way, so its stop-out is a LOSS and its target is a GAIN. */
function pnlStr(t: ActiveTrade, price: number): string {
  const pnl = planPnlRupees(t, price);
  const pct = planPnlPct(t, price);
  const icon = pnl >= 0 ? "🟢" : "🔴";
  const r = Math.round(pnl * 100) / 100;
  return `${icon} P&L: ₹${r < 0 ? "-" : "+"}${Math.abs(r).toFixed(2)} (${Math.abs(pct).toFixed(1)}%)`;
}

function card(t: ActiveTrade): string {
  return [
    `📊 ${t.symbol} — ${t.optionType || t.instrument}`,
    `⚡ Direction: ${t.side} ${t.optionType === "CE" ? "CALL" : t.optionType === "PE" ? "PUT" : t.instrument || ""}`.trim(),
    t.strike ? `🎯 Strike: ${fmtStrike(t.strike)}` : "",
    `🧾 Trade ID: ${t.id}`,
    t.confidence ? `💪 Confidence: ${t.confidence}%` : "",
    `💰 Entry: ₹${tickPx(t.entry)}`,
  ].filter(Boolean).join("\n");
}

function buildAlert(t: ActiveTrade, alertType: TPSLAlertType, ltp: number): TPSLAlert {
  const isTP = alertType.startsWith("TP");
  const instr = (["CALL", "PUT", "FUTURES", "EQUITY"].includes(t.instrument)
    ? t.instrument
    : t.optionType === "CE" ? "CALL"
    : t.optionType === "PE" ? "PUT"
    : "EQUITY") as "CALL" | "PUT" | "FUTURES" | "EQUITY";
  // The FILL: the stop level (or worse on a gap) for an SL, the target level
  // for a TP. Never the entry — a stop-out is not a fill at the entry.
  const hitPrice = alertType === "SL_HIT"
    ? stopFillPrice(t, ltp)
    : targetLevel(t, alertType as "TP1_HIT" | "TP2_HIT" | "TP3_HIT");
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
    `💲 Current LTP: ₹${tickPx(ltp)}`,
    `🛑 SL: ₹${tickPx(t.sl)}`,
    alertType === "SL_HIT"
      ? `📉 Exit: ₹${tickPx(hitPrice)} (stop${hitPrice > t.sl ? " — gapped" : ""})`
      : `🎯 TP Level: ₹${tickPx(hitPrice)} (${alertType.replace("_HIT", "")})`,
    t.tp1 ? `TP1: ₹${tickPx(t.tp1)}${t.tp2 && t.tp2 !== t.tp1 ? ` | TP2: ₹${tickPx(t.tp2)}` : ""}${t.tp3 ? ` | TP3: ₹${tickPx(t.tp3)}` : ""}` : "",
    pnlStr(t, hitPrice),
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
    pnl: planPnlRupees(t, hitPrice),
    pnlPct: planPnlPct(t, hitPrice),
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
    ...(t.tp2 && t.tp2 !== t.tp1 ? [`🎯 Target 2: ₹${t.tp2.toFixed(2)}`] : []),
    t.tp3 ? `🎯 Target 3: ₹${t.tp3.toFixed(2)}` : "",
    `\n⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
  ].filter(Boolean).join("\n");
  await sendTelegramMessage(msg).catch(() => {});
}

// ── Detection helpers ──
/**
 * THE hit ladder — shared with the 15-minute monitor (activeTradeTracker).
 * Side-aware: a MIRRORED (bearish) plan has its stop ABOVE the entry and its
 * targets BELOW it, so it stops when the price RISES to the stop and targets
 * when it FALLS to them. Testing it like a long fired a false SL the moment
 * the trade opened (price 41.05 <= stop 49.25).
 */
function detectHit(t: ActiveTrade, ltp: number): TPSLAlertType | null {
  if (isTerminalTradeStatus(t, t.status)) return null;
  return detectPlanHit(t, ltp) as TPSLAlertType | null;
}

/** Test seam: the pure hit detector. */
export function detectHitForTest(t: any, ltp: number): TPSLAlertType | null {
  return detectHit(t, ltp);
}

// ── Core monitor loop (exported for e2e tests) ──
export async function pollTradesOnce(
  resolveLTP?: (t: ActiveTrade) => Promise<number>
): Promise<{ detected: number; sent: number; errors: string[] }> {
  const errors: string[] = [];
  let detected = 0;
  let sent = 0;
  const resolver =
    resolveLTP ??
    ((t: ActiveTrade) => fetchLTP(t.symbol, t.strike, t.optionType, t.expiry));

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
          // through the injectable sender: a test run must never push a fixture
          // (e.g. symbol "TP1E…") to the real Telegram bot
          await sendAlertText(msg).catch(() => {});
          errors.push(`LTP unavailable for ${trade.symbol} (${trade.id}) after ${fails} attempts`);
        }
        continue;
      }
      ltpFailCounts.delete(trade.id);

      const hit = detectHit(trade, ltp);
      if (!hit) continue;

      detected++;

      // 1) Tracker: status update + DB persist + lock update/release
      //    The exit price is the FILL (the stop level, or worse on a gap) — the
      //    journal must never record the entry price as the exit.
      const fill = hit === "SL_HIT" ? stopFillPrice(trade, ltp) : undefined;
      await updateTradeStatus(trade.id, hit, fill);
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
