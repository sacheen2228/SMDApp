// TIGER Trade Monitor — Background LTP polling + Telegram alerts
// Wraps existing activeTradeTracker SL/TP detection with TIGER-format alerts
// and adds T2→T1 trailing (existing code only does T1→breakeven)

import { getActiveTrades, updateTradeStatus, formatTradeStatus, type ActiveTrade } from "./activeTradeTracker";
import { sendTelegramMessage } from "./telegram";

// ── Config ──
const POLL_INTERVAL_MS = 5_000;      // 5 seconds
const MARKET_START_HOUR = 9;
const MARKET_START_MIN = 15;
const MARKET_END_HOUR = 15;
const MARKET_END_MIN = 30;

let monitorRunning = false;
let monitorTimer: ReturnType<typeof setInterval> | null = null;

// ── LTP fetcher (Breeze → NSE → Yahoo) ──
async function fetchLTP(symbol: string, strike: number, optionType: string): Promise<number> {
  // Try Breeze first
  try {
    const { getOptionChain } = await import("@/lib/icici-breeze/option-chain");
    const chain = await getOptionChain(symbol);
    if (chain?.data) {
      const row = chain.data.find((r: any) => r.strike === strike);
      if (row) {
        const leg = optionType === "CE" ? row.ce : row.pe;
        if (leg?.ltp && leg.ltp > 0) return leg.ltp;
      }
    }
  } catch {}

  // Try NSE API
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

// ── TIGER-format Telegram alerts ──
function pnlStr(entry: number, price: number): string {
  const diff = price - entry;
  const pct = entry > 0 ? (diff / entry) * 100 : 0;
  const sign = diff >= 0 ? "+" : "";
  const icon = diff >= 0 ? "🟢" : "🔴";
  return `${icon} P&L: ${sign}₹${diff.toFixed(2)} (${sign}${pct.toFixed(1)}%)`;
}

function card(t: ActiveTrade): string {
  return [
    `📊 ${t.symbol} — ${t.optionType}`,
    `⚡ Action: BUY ${t.optionType === "CE" ? "CALL" : "PUT"}`,
    `🎯 Strike: ${t.strike}`,
    t.confidence ? `💪 Confidence: ${t.confidence}%` : "",
    `💰 Entry: ₹${t.entry.toFixed(2)}`,
  ].filter(Boolean).join("\n");
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

async function alertSLHit(t: ActiveTrade, exitPrice: number): Promise<void> {
  const label = t.status === "TP1_HIT" ? "TRAILED SL HIT 🔒" : "SL HIT — EXIT TRADE ❌";
  const msg = [
    `🚨 ${label}\n`,
    card(t),
    `🛑 SL: ₹${t.sl.toFixed(2)}`,
    `📉 Exit: ₹${exitPrice.toFixed(2)}`,
    pnlStr(t.entry, exitPrice),
    `\n⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
  ].join("\n");
  await sendTelegramMessage(msg).catch(() => {});
}

async function alertT1Hit(t: ActiveTrade, ltp: number): Promise<void> {
  const msg = [
    "🎯 TARGET 1 HIT — TRAIL SL ⚡\n",
    card(t),
    `📈 LTP: ₹${ltp.toFixed(2)}`,
    `🛑 SL trailed to ₹${t.sl.toFixed(2)} (Breakeven)`,
    `✅ Now ride for T2: ₹${t.tp2.toFixed(2)}`,
    `\n⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
  ].join("\n");
  await sendTelegramMessage(msg).catch(() => {});
}

async function alertT2Hit(t: ActiveTrade, ltp: number): Promise<void> {
  const msg = [
    "🎯 TARGET 2 HIT 🔥\n",
    card(t),
    `📈 LTP: ₹${ltp.toFixed(2)}`,
    `🛑 SL trailed to ₹${t.sl.toFixed(2)} (T1)`,
    `✅ Now ride for T3: ₹${(t.tp3 ?? t.tp2 * 1.5).toFixed(2)}`,
    `\n⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
  ].join("\n");
  await sendTelegramMessage(msg).catch(() => {});
}

async function alertT3Hit(t: ActiveTrade, exitPrice: number): Promise<void> {
  const msg = [
    "🏆 TARGET 3 HIT — FULL EXIT 🎉\n",
    card(t),
    `📈 Exit: ₹${exitPrice.toFixed(2)}`,
    pnlStr(t.entry, exitPrice),
    `\n⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
  ].join("\n");
  await sendTelegramMessage(msg).catch(() => {});
}

// ── Core monitor loop ──
async function monitorTick(): Promise<void> {
  if (!isMarketOpen()) return;

  const trades = getActiveTrades();
  for (const trade of trades) {
    try {
      const ltp = await fetchLTP(trade.symbol, trade.strike, trade.optionType);
      if (ltp <= 0) continue;

      // BUY side logic
      if (trade.side === "BUY") {
        // 1) SL check — always first
        if (ltp <= trade.sl && trade.status !== "SL_HIT") {
          await updateTradeStatus(trade.id, "SL_HIT");
          await alertSLHit(trade, ltp);
          continue;
        }

        // 2) T1 hit → trail SL to breakeven
        if (trade.status === "ACTIVE" && ltp >= trade.tp1) {
          await updateTradeStatus(trade.id, "TP1_HIT");
          // updateTradeStatus already trails SL to breakeven
          await alertT1Hit(trade, ltp);
          continue;
        }

        // 3) T2 hit → trail SL to T1
        if (trade.status === "TP1_HIT" && ltp >= trade.tp2) {
          await updateTradeStatus(trade.id, "TP2_HIT");
          // Override the SL that updateTradeStatus set — trail to T1 instead of breakeven
          trade.sl = trade.tp1;
          await alertT2Hit(trade, ltp);
          continue;
        }

        // 4) T3 hit → full exit
        if (trade.status === "TP2_HIT" && ltp >= (trade.tp3 ?? Infinity)) {
          await updateTradeStatus(trade.id, "TP3_HIT");
          await alertT3Hit(trade, ltp);
          continue;
        }
      }
    } catch (err: any) {
      // silent — price fetch failures are expected
    }
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
