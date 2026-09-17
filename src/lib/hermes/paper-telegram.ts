// Hermes Paper Trading — Telegram notifications
// Routes through telegram-queue for dedup, retry, and restart safety.
// Existing direct sender is preserved as fallback.

import type { PaperTrade, NoTradeObservation } from "./paper-engine";
import { getTelegramQueue } from "./telegram-queue";
import { getEventBus } from "./event-bus";

const TELEGRAM_API = "https://api.telegram.org/bot";

function getBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN || "";
}

function getChatId(): string {
  return process.env.TELEGRAM_CHAT_ID || "7862815314";
}

// Direct sender (kept as fallback, bypasses queue)
async function sendTelegramDirect(text: string): Promise<boolean> {
  const token = getBotToken();
  const chatId = getChatId();
  if (!token || !chatId) return false;

  try {
    const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Queue-aware sender: tries queue first, falls back to direct
async function sendViaQueue(text: string, eventId: string): Promise<boolean> {
  const queue = getTelegramQueue();
  if (queue.isRunning()) {
    return queue.enqueue(eventId, text);
  }
  // Fallback: direct send if queue not running
  return sendTelegramDirect(text);
}

export async function sendPaperTradeSignal(trade: PaperTrade): Promise<boolean> {
  const side = trade.decision === "BUY_CE" ? "BUY CE" : "BUY PE";
  const text = `🔔 <b>HERMES PAPER SIGNAL</b>

<b>${trade.underlying}</b>
<b>${side}</b>

${trade.strike} ${trade.optionType}

Entry: ₹${trade.entryPrice.toFixed(2)}
SL: ₹${trade.stopLoss.toFixed(2)}
TP1: ₹${trade.target1.toFixed(2)}
${trade.target2 ? `TP2: ₹${trade.target2.toFixed(2)}` : ""}
${trade.target3 ? `TP3: ₹${trade.target3.toFixed(2)}` : ""}

Score: ${trade.score}
Regime: ${trade.regime}

Provider: ${trade.provider}
Data: ${trade.freshness}

⚠️ PAPER ONLY — NO REAL ORDER`;

  const eventId = `TRADE_CREATED:${trade.signalId}`;
  return sendViaQueue(text, eventId);
}

export async function sendPaperTradeExit(trade: PaperTrade): Promise<boolean> {
  const pnl = trade.realizedPnL || 0;
  const pnlStr = pnl >= 0 ? `+₹${pnl.toFixed(2)}` : `-₹${Math.abs(pnl).toFixed(2)}`;
  const holding = trade.holdingTimeMs ? `${Math.round(trade.holdingTimeMs / 60000)} min` : "—";

  const exitType = trade.exitSource || trade.status;
  const text = `📊 <b>HERMES PAPER EXIT</b>

<b>${trade.underlying} ${trade.strike} ${trade.optionType}</b>

Entry: ₹${trade.entryPrice.toFixed(2)}
Exit: ₹${(trade.exitPrice || 0).toFixed(2)}

P&L: ${pnlStr}

Result: ${exitType}
Holding: ${holding}

MFE: +₹${(trade.maxFavorableExcursion || 0).toFixed(2)} (${(trade.maxFavorableExcursionPct || 0).toFixed(1)}%)
MAE: -₹${Math.abs(trade.maxAdverseExcursion || 0).toFixed(2)} (${Math.abs(trade.maxAdverseExcursionPct || 0).toFixed(1)}%)

⚠️ PAPER ONLY`;

  const eventId = `TRADE_CLOSED:${trade.signalId}`;
  return sendViaQueue(text, eventId);
}

export async function sendNoTradeObservation(obs: NoTradeObservation): Promise<boolean> {
  const text = `📋 <b>HERMES NO_TRADE</b>

<b>${obs.underlying}</b>
Spot: ₹${obs.spotAtObservation.toLocaleString("en-IN")}

Score: ${obs.score}
Regime: ${obs.regime}

${obs.blockingConditions.slice(0, 3).map(r => `• ${r}`).join("\n")}

Provider: ${obs.provider}
Data: ${obs.freshness}

⚠️ PAPER OBSERVATION`;

  const eventId = `NO_TRADE:${obs.underlying}:${Date.now()}`;
  return sendViaQueue(text, eventId);
}

// Export direct sender for backward compat
export { sendTelegramDirect as sendTelegram };
