// lib/dailyDigest.ts
//
// End-of-day digest — sends summary of all signals sent today,
// what worked, what didn't, and tomorrow's outlook.

import { getTodaySignals } from "./signalTracker";
import { getActiveTrades } from "./activeTradeTracker";
import { sendTelegramMessage } from "./telegram";

const DIGEST_CHAT_IDS = (process.env.TELEGRAM_DIGEST_CHAT_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

async function fetchWithTimeout(url: string, ms = 10000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { cache: "no-store", signal: ctrl.signal }).finally(() =>
    clearTimeout(timer)
  );
}

async function fetchVIX(): Promise<string> {
  try {
    const res = await fetchWithTimeout("http://localhost:3000/api/vix");
    if (!res.ok) return "N/A";
    const json = await res.json();
    return json?.vix ?? json?.data?.vix ?? "N/A";
  } catch {
    return "N/A";
  }
}

async function fetchFII(): Promise<{ fii: string; dii: string }> {
  try {
    const res = await fetchWithTimeout("http://localhost:3000/api/fii-dii");
    if (!res.ok) return { fii: "N/A", dii: "N/A" };
    const json = await res.json();
    return { fii: json?.fiiNet ?? "N/A", dii: json?.diiNet ?? "N/A" };
  } catch {
    return { fii: "N/A", dii: "N/A" };
  }
}

export async function sendDailyDigest(): Promise<boolean> {
  if (DIGEST_CHAT_IDS.length === 0) {
    console.warn("[DailyDigest] No TELEGRAM_DIGEST_CHAT_IDS configured");
    return false;
  }

  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const todaySignals = getTodaySignals();
  const activeTrades = getActiveTrades();

  // Fetch market data
  const [vix, fii] = await Promise.all([fetchVIX(), fetchFII()]);

  // Build signal list
  const signalLines: string[] = [];
  for (const [sig, info] of todaySignals) {
    const parts = sig.split("|");
    const emoji = parts[3]?.includes("BUY") || parts[3]?.includes("LONG") ? "🟢" : "🔴";
    signalLines.push(
      `${emoji} ${parts[0]} ${parts[1]} ${parts[2]} — ${info.confidence}% (${info.source})`
    );
  }

  // Active trades summary
  const activeLines = activeTrades.map((t) => {
    const pnl = t.entry > 0 ? ((0 - t.entry) / t.entry * 100).toFixed(1) : "—";
    return `  ${t.symbol} ${t.strike} ${t.optionType} — Entry ₹${t.entry} | SL ₹${t.sl}`;
  });

  const msg = `📊 <b>END OF DAY — ${now}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━

📈 <b>Market</b>
  VIX: ${vix}
  FII: ${fii.fii} | DII: ${fii.dii}

🎯 <b>Signals Sent Today: ${todaySignals.size}</b>
${signalLines.length > 0 ? signalLines.join("\n") : "  No signals sent"}

💼 <b>Active Trades: ${activeTrades.length}</b>
${activeLines.length > 0 ? activeLines.join("\n") : "  No active trades"}

━━━━━━━━━━━━━━━━━━━━━━━━━
💡 <i>Signals reset tomorrow. Fresh setups only.</i>
⏰ ${now}`;

  const results = await Promise.all(
    DIGEST_CHAT_IDS.map((chatId) => sendTelegramMessage(msg, chatId))
  );

  return results.some(Boolean);
}
