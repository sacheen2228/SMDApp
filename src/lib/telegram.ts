const TELEGRAM_API = "https://api.telegram.org/bot";

import { isTelegramSendWindow } from "./marketHours";

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
  // Hard gate: no Telegram output outside 09:10-15:20 IST (Mon-Fri).
  // Override for tests with TELEGRAM_ALLOW_OFFHOURS=1.
  if (!isTelegramSendWindow()) {
    console.warn("[Telegram] outside 09:10-15:20 IST window — suppressed send");
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
}): Promise<boolean> {
  const emoji = params.action.includes("BUY") ? "🟢" : "🔴";
  const sourceLabel = params.source || "SDM Engine";
  const msg = `
${emoji} <b>${sourceLabel}</b>

📊 <b>${params.symbol}</b> — ${params.type}
⚡ Action: <b>${params.action}</b>
🎯 Strike: <b>${params.strike.toLocaleString("en-IN")}</b>
💪 Confidence: <b>${params.confidence}%</b>
${params.entry ? `💰 Entry: ₹${params.entry}` : ""}
${params.stopLoss ? `🛑 Stop Loss: ₹${params.stopLoss}` : ""}
${params.target1 ? `🎯 Target 1: ₹${params.target1}` : ""}
${params.target2 ? `🎯 Target 2: ₹${params.target2}` : ""}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
  `.trim();
  return sendTelegramMessage(msg);
}

export async function sendSignalAlert(params: {
  direction: string;
  confidence: number;
  symbol: string;
  reasons: string[];
}): Promise<boolean> {
  const emoji = params.direction === "BULLISH" ? "📈" : params.direction === "BEARISH" ? "📉" : "➡️";
  const msg = `
${emoji} <b>ML Signal — ${params.direction}</b>

📊 Symbol: <b>${params.symbol}</b>
💪 Confidence: <b>${params.confidence}%</b>
📝 Reasons:
${params.reasons.map((r, i) => `  ${i + 1}. ${r}`).join("\n")}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
  `.trim();
  return sendTelegramMessage(msg);
}

export async function sendSystemAlert(message: string): Promise<boolean> {
  const msg = `🤖 <b>System Alert</b>\n\n${message}\n\n⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
  return sendTelegramMessage(msg);
}
