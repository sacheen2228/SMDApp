const TELEGRAM_API = "https://api.telegram.org/bot";

import { isTelegramSendWindow } from "./marketHours";
import {
  buildSignalSignature,
  isSignalAlreadySent,
  markSignalSent,
  isSignalDuplicateOrLowerQuality,
} from "./signalTracker";

// Short-term throttle: prevent sending same signal within 5 minutes
const recentAlerts = new Map<string, number>();
const SHORT_COOLDOWN_MS = 5 * 60 * 1000;

function shortTermThrottle(key: string): boolean {
  const last = recentAlerts.get(key);
  if (last && Date.now() - last < SHORT_COOLDOWN_MS) return true;
  recentAlerts.set(key, Date.now());
  if (recentAlerts.size > 200) {
    const cutoff = Date.now() - 3600000;
    for (const [k, v] of recentAlerts) { if (v < cutoff) recentAlerts.delete(k); }
  }
  return false;
}

function getBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN || "";
}

function getChatId(): string {
  return process.env.TELEGRAM_CHAT_ID || "";
}

export async function verifyTelegramBot(): Promise<{ ok: boolean; username?: string; description?: string }> {
  const token = getBotToken();
  if (!token) {
    return { ok: false, description: "TELEGRAM_BOT_TOKEN not configured" };
  }
  try {
    const res = await fetch(`${TELEGRAM_API}${token}/getMe`);
    const data = await res.json();
    if (!data.ok) {
      return { ok: false, description: data.description || "getMe failed" };
    }
    return { ok: true, username: data.result?.username };
  } catch (err: any) {
    return { ok: false, description: err?.message || "network error" };
  }
}

export async function sendTelegramMessage(text: string, chatId?: string): Promise<boolean> {
  // Hard gate: no Telegram output outside 09:10-15:30 IST (Mon-Fri).
  // Override for tests with TELEGRAM_ALLOW_OFFHOURS=1.
  if (!isTelegramSendWindow()) {
    console.warn("[Telegram] outside 09:10-15:30 IST window — suppressed send");
    return false;
  }
  const token = getBotToken();
  const cid = chatId || getChatId();
  if (!token || !cid) {
    console.warn("[Telegram] Bot token or chat ID not configured");
    return false;
  }
  try {
    const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cid,
        text,
        parse_mode: "HTML",
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("[Telegram] Send failed:", data.description);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error("[Telegram] Error:", err.message);
    return false;
  }
}

// Full-day dedup: check if same signal was sent today
export function checkTradeDedup(symbol: string, action: string, strike: number, type: string): boolean {
  const sig = buildSignalSignature({ symbol, strike, optionType: type, direction: action });
  if (isSignalAlreadySent(sig)) return true;
  // Also check short-term throttle
  return shortTermThrottle(sig);
}

export async function sendTradeAlert(params: {
  symbol: string;
  action: string;
  strike: number;
  type: string;
  confidence: number;
  entry?: number;
  stopLoss?: number;
  target1?: number;
  target2?: number;
  source?: string;
  instrument?: string;  // 'CALL' | 'PUT' | 'FUTURES' | 'EQUITY' — for SELL safety
  mtf?: {
    direction: string;
    compositeScore: number;
    confidence: number;
    trendDirection: string;
    reasons: string[];
  } | null;
}): Promise<boolean> {
  // SAFETY: Option selling blocked — instrument-aware (options only)
  // SELL is valid for EQUITY and FUTURES
  const isOption = params.instrument === 'CALL' || params.instrument === 'PUT';
  if (isOption && params.action && (params.action.includes('SELL') || params.action.includes('SHORT'))) {
    console.log(`[Telegram] BLOCKED: ${params.symbol} — option selling not allowed (${params.action} on ${params.instrument})`);
    return false;
  }

  const sig = buildSignalSignature({
    symbol: params.symbol,
    strike: params.strike,
    optionType: params.type,
    direction: params.action,
  });

  // FULL-DAY dedup: skip if same signal sent today with >= confidence
  if (isSignalDuplicateOrLowerQuality(sig, params.confidence)) {
    console.log(`[Telegram] Dedup (full-day): skipped ${sig} — already sent with equal/higher confidence`);
    return false;
  }

  // Short-term throttle: also skip if sent within 5 minutes
  if (shortTermThrottle(sig)) {
    console.log(`[Telegram] Dedup (short-term): skipped ${sig} (sent <5min ago)`);
    return false;
  }

  const emoji = params.action.includes("BUY") ? "🟢" : "🔴";
  const sourceLabel = params.source || "SDM Engine";
  const mtfLine = params.mtf
    ? `\n📐 MTF: ${params.mtf.direction} (${params.mtf.trendDirection} trend, score ${params.mtf.compositeScore})`
    : '';
  const msg = `
${emoji} <b>${sourceLabel}</b>

📊 <b>${params.symbol}</b> — ${params.type}
⚡ Action: <b>${params.action}</b>
🎯 Strike: <b>${params.strike.toLocaleString("en-IN")}</b>
💪 Confidence: <b>${params.confidence}%</b>${mtfLine}
${params.entry ? `💰 Entry: ₹${params.entry}` : ""}
${params.stopLoss ? `🛑 Stop Loss: ₹${params.stopLoss}` : ""}
${params.target1 ? `🎯 Target 1: ₹${params.target1}` : ""}
${params.target2 ? `🎯 Target 2: ₹${params.target2}` : ""}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
  `.trim();

  const sent = await sendTelegramMessage(msg);
  if (sent) {
    markSignalSent(sig, params.confidence, params.source || "sdm-engine");
  }
  return sent;
}

export async function sendSignalAlert(params: {
  direction: string;
  confidence: number;
  symbol: string;
  reasons: string[];
}): Promise<boolean> {
  const sig = buildSignalSignature({
    symbol: params.symbol,
    direction: params.direction,
  });

  // Full-day dedup for signals too
  if (isSignalDuplicateOrLowerQuality(sig, params.confidence)) {
    console.log(`[Telegram] Dedup: skipped signal ${sig}`);
    return false;
  }

  const emoji = params.direction === "BULLISH" ? "📈" : params.direction === "BEARISH" ? "📉" : "➡️";
  const msg = `
${emoji} <b>ML Signal — ${params.direction}</b>

📊 Symbol: <b>${params.symbol}</b>
💪 Confidence: <b>${params.confidence}%</b>
📝 Reasons:
${params.reasons.map((r, i) => `  ${i + 1}. ${r}`).join("\n")}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
  `.trim();
  const sent = await sendTelegramMessage(msg);
  if (sent) {
    markSignalSent(sig, params.confidence, "ml-signal");
  }
  return sent;
}

export async function sendSystemAlert(message: string): Promise<boolean> {
  const msg = `🤖 <b>System Alert</b>\n\n${message}\n\n⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
  return sendTelegramMessage(msg);
}
