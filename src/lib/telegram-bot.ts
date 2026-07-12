import { sendTelegramMessage } from "./telegram";

const TELEGRAM_API = "https://api.telegram.org/bot";

function getBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN || "";
}

async function callTelegram(method: string, body: any): Promise<any> {
  const token = getBotToken();
  if (!token) return null;
  try {
    const res = await fetch(`${TELEGRAM_API}${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch {
    return null;
  }
}

export async function getUpdates(offset?: number): Promise<any[]> {
  const result = await callTelegram("getUpdates", {
    offset,
    timeout: 10,
    allowed_updates: ["message"],
  });
  return result?.ok ? (result.result || []) : [];
}

export async function setWebhook(url: string): Promise<boolean> {
  const result = await callTelegram("setWebhook", { url });
  return result?.ok === true;
}

export async function getWebhookInfo(): Promise<any> {
  const result = await callTelegram("getWebhookInfo", {});
  return result?.ok ? result.result : null;
}

export async function deleteWebhook(): Promise<boolean> {
  const result = await callTelegram("deleteWebhook", {});
  return result?.ok === true;
}

// ─── Auto-bot API helpers ──────────────────────────────────────────

const BOT_API = "http://localhost:8000";

async function fetchBotApi(path: string): Promise<any> {
  try {
    const res = await fetch(`${BOT_API}${path}`, { signal: AbortSignal.timeout(5000) });
    return await res.json();
  } catch {
    return null;
  }
}

async function handleBotStats(): Promise<string> {
  const stats = await fetchBotApi("/api/stats");
  if (!stats) return "⚠️ Auto-bot not reachable (is it running on port 8000?)";
  return [
    "🤖 <b>Breakout/Desk Bot</b>",
    "",
    `Today P&L: <b>${stats.today_pnl >= 0 ? "+" : ""}${stats.today_pnl?.toFixed(0) || 0}</b>`,
    `Win Rate: <b>${stats.win_rate?.toFixed(0) || 0}%</b>`,
    `Trades Today: <b>${stats.today_trades || 0}</b>`,
    `Open Positions: <b>${stats.open_positions || 0}</b>`,
    `All-time P&L: <b>${stats.alltime_pnl >= 0 ? "+" : ""}${stats.alltime_pnl?.toFixed(0) || 0}</b>`,
    `Wins: ${stats.wins || 0} | Losses: ${stats.losses || 0}`,
    `🕐 ${formatDateTime(new Date().toISOString())}`,
  ].filter(Boolean).join("\n");
}

async function handleAlerts(): Promise<string> {
  const alerts = await fetchBotApi("/api/alerts");
  if (!alerts) return "⚠️ Auto-bot not reachable.";
  if (!Array.isArray(alerts) || alerts.length === 0) return "✅ No pending breakout alerts.";
  return [
    "🚨 <b>Pending Breakout Alerts</b>",
    "",
    ...alerts.slice(0, 10).map((a: any, i: number) =>
      `${i + 1}. <b>${a.ticker}</b> (${a.market})\n   Level: ${a.broke} | SL: ${a.stop} | TP: ${a.target}\n   Vol: ${a.volume} | Touches: ${a.touches} | Qty: ${a.qty}`
    ),
  ].filter(Boolean).join("\n");
}

async function handlePositions(): Promise<string> {
  const positions = await fetchBotApi("/api/positions");
  if (!positions) return "⚠️ Auto-bot not reachable.";
  if (!Array.isArray(positions) || positions.length === 0) return "📭 No open positions.";
  return [
    "📊 <b>Open Positions</b>",
    "",
    ...positions.slice(0, 10).map((p: any) =>
      `<b>${p.ticker}</b> (${p.market})\n   Qty: ${p.qty} @ ${p.entry} | Last: ${p.last}\n   SL: ${p.stop} | TP: ${p.target}\n   P&L: <b>${p.live_pnl >= 0 ? "+" : ""}${p.live_pnl?.toFixed(0) || 0}</b>`
    ),
  ].filter(Boolean).join("\n");
}

async function handleBotTrades(): Promise<string> {
  const closed = await fetchBotApi("/api/closed");
  if (!closed) return "⚠️ Auto-bot not reachable.";
  if (!Array.isArray(closed) || closed.length === 0) return "📭 No closed trades yet.";
  return [
    "📋 <b>Recent Closed Trades</b>",
    "",
    ...closed.slice(0, 10).map((t: any) => {
      const emoji = t.live_pnl >= 0 ? "✅" : "❌";
      return `${emoji} <b>${t.ticker}</b> | ${t.qty} @ ${t.entry} → ${t.last} | P&L: ${t.live_pnl >= 0 ? "+" : ""}${t.live_pnl?.toFixed(0) || 0}`;
    }),
  ].filter(Boolean).join("\n");
}

async function fetchApi(path: string): Promise<any> {
  try {
    const base = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10000) });
    return await res.json();
  } catch {
    return null;
  }
}

function formatPrice(n: number): string {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function formatDateTime(d: string): string {
  return new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

async function handleSignal(symbol: string): Promise<string> {
  // Try the Python Zero-to-Hero screener first
  const screener = await fetchApi(`/api/screener?action=signal&symbol=${symbol}&direction=`);
  if (screener?.success) {
    // If screener has a structured trade, build clean output
    if (screener.trade) {
      const t = screener.trade;
      const reasons = (screener.reasons as string[] || []).map((r: string) => r).join("\n");
      const sourceLabel = screener.data_source === "simulation" ? " ⚠️ SIMULATION" : "";
      return [
        `<b>${screener.symbol} — Trade Score: ${screener.score}/100 (${screener.grade})${sourceLabel}</b>`,
        "",
        `Direction: ${t.action}`,
        `Strike: ${t.strike_label} (${formatPrice(t.strike)})`,
        `Entry: ${formatPrice(t.entry)}`,
        `<b>SL:</b> ${formatPrice(t.sl)}`,
        `<b>TP1:</b> ${formatPrice(t.tp1)}`,
        `<b>TP2:</b> ${formatPrice(t.tp2)}`,
        `Runner: ${t.runner}`,
        "",
        `Confidence: ${screener.confidence}%`,
        "",
        "Reason:",
        reasons,
        "",
        `Spot: ${formatPrice(screener.spot_price)}  |  Data: ${screener.data_source || "?"}  |  🐍 Zero-to-Hero`,
      ].filter(Boolean).join("\n");
    }
    // Fallback: use lines field (older format)
    const lines = screener.lines || [];
    if (lines.length > 0) {
      return lines.join("\n");
    }
  }

  // Fallback: SDM Analysis engine
  const data = await fetchApi(`/api/option-chain?symbol=${symbol}`);
  if (!data?.success) return `⚠️ No signal available for ${symbol}.`;
  const rec = data.analysis?.recommendation;
  if (!rec?.action) return `⚠️ No trade signal for ${symbol} right now.`;
  const action = rec.action;
  const conf = rec.confidence || rec.sdmScore || 0;
  const strike = rec.strike || data.data?.atmStrike || data.data?.spotPrice || 0;
  const optionType = rec.optionType || rec.direction || "";
  const entry = rec.entryPrice;
  const sl = rec.stopLoss;
  const t1 = rec.tp1;
  const t2 = rec.tp2;
  const risk = rec.riskLevel || "";
  const source = data.source || "unknown";
  return [
    `<b>${symbol}</b>  |  ${source === "simulation" ? "🔄 Simulation" : "📡 Live"}`,
    `Action: <b>${action}</b>  |  Confidence: <b>${conf.toFixed(0)}%</b>${risk ? `  |  Risk: ${risk}` : ""}`,
    strike ? `Strike: ${formatPrice(strike)} ${optionType}` : "",
    entry ? `Entry: ₹${entry.toFixed(2)}` : "",
    sl ? `SL: ₹${sl.toFixed(2)}` : "",
    t1 ? `TP1: ₹${t1.toFixed(2)}` : "",
    t2 ? `TP2: ₹${t2.toFixed(2)}` : "",
    "",
    `🕐 ${formatDateTime(data.lastUpdate || new Date().toISOString())}`,
  ].filter(Boolean).join("\n");
}

async function handlePrice(symbol: string): Promise<string> {
  const data = await fetchApi(`/api/option-chain?symbol=${symbol}`);
  if (!data?.success) return `⚠️ Could not fetch price for ${symbol}.`;
  const root = data.data || {};
  const spot = root.spotPrice || root.summary?.spotPrice || 0;
  const source = data.source || "unknown";
  const apiSymbol = root.symbol || symbol;
  const change = root.spotChange ?? root.summary?.spotChange ?? root.summary?.change ?? 0;
  const changePct = root.spotChangePct ?? root.summary?.spotChangePct ?? root.summary?.changePct ?? 0;
  const chgSign = change >= 0 ? "📈" : "📉";
  const symbolLabel = apiSymbol !== symbol ? `${symbol} (via ${apiSymbol})` : symbol;
  return [
    `💰 <b>${symbolLabel}</b>`,
    `Spot: <b>${formatPrice(spot)}</b>`,
    source !== "simulation" ? `${chgSign} ${change >= 0 ? "+" : ""}${change.toFixed(2)} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)` : "📡 Simulation mode",
    `Source: ${source}`,
    `🕐 ${formatDateTime(data.lastUpdate || new Date().toISOString())}`,
  ].filter(Boolean).join("\n");
}

async function handleStatus(): Promise<string> {
  const [health, trades] = await Promise.all([
    fetchApi("/api/admin/system"),
    fetchApi("/api/trade-journal"),
  ]);
  const hData = health?.data;
  const tStats = trades?.stats;
  const breezeStatus = hData?.breeze?.connected ? "✅ Connected" : "❌ Disconnected";
  const dataSrc = hData?.breeze?.connected ? "📡 Real API" : "🔄 Simulation";
  const tradeLine = tStats ? `Trades: ${tStats.total} (${tStats.open} open, ${tStats.winRate}% win rate, P&L: ${tStats.totalPnL >= 0 ? "+" : ""}${tStats.totalPnL})` : "";
  return [
    "🤖 <b>SMDApp Status</b>",
    "",
    `Breeze API: ${breezeStatus}`,
    `Data Source: ${dataSrc}`,
    tradeLine,
    `🕐 ${formatDateTime(new Date().toISOString())}`,
  ].filter(Boolean).join("\n");
}

export async function processMessage(chatId: number, text: string): Promise<void> {
  const msg = text.trim();
  const lower = msg.toLowerCase();

  // Handle commands
  if (lower === "/start") {
    await sendTelegramMessage(
      `🤖 <b>SD Trading Bot</b>\n\nWelcome! I'll send you trade alerts from SDM engine and the Breakout/Desk automated bot.\n\n<b>Commands:</b>\n/signal NIFTY — Latest trade signal\n/price NIFTY — Current spot price\n/status — System status\n/alerts — Pending breakout alerts\n/positions — Open positions\n/botstats — Auto-bot stats\n/bottrades — Recent closed trades\n/help — Full help`,
      String(chatId)
    );
    return;
  }

  if (lower === "/help") {
    await sendTelegramMessage(
      `<b>Available Commands:</b>\n\n` +
      `<b>📈 SDM Trading</b>\n` +
      `/signal [SYMBOL] — Get latest SDM trade signal\n` +
      `/price [SYMBOL] — Get current spot price\n` +
      `/status — System health & trade stats\n\n` +
      `<b>🤖 Auto-Bot (Breakout/Desk)</b>\n` +
      `/alerts — Pending breakout alerts\n` +
      `/positions — Open positions\n` +
      `/botstats — Auto-bot performance stats\n` +
      `/bottrades — Recent closed trades\n\n` +
      `<b>Supported symbols:</b>\n` +
      `NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX\n\n` +
      `You'll also receive automatic alerts when trades trigger.`,
      String(chatId)
    );
    return;
  }

  if (lower === "/status") {
    const response = await handleStatus();
    await sendTelegramMessage(response, String(chatId));
    return;
  }

  // Auto-bot commands
  if (lower === "/alerts") {
    const response = await handleAlerts();
    await sendTelegramMessage(response, String(chatId));
    return;
  }

  if (lower === "/positions") {
    const response = await handlePositions();
    await sendTelegramMessage(response, String(chatId));
    return;
  }

  if (lower === "/botstats") {
    const response = await handleBotStats();
    await sendTelegramMessage(response, String(chatId));
    return;
  }

  if (lower === "/bottrades") {
    const response = await handleBotTrades();
    await sendTelegramMessage(response, String(chatId));
    return;
  }

  // /signal or /price with symbol
  if (lower.startsWith("/signal")) {
    const parts = msg.split(/\s+/);
    const symbol = parts[1]?.toUpperCase();
    if (!symbol || !["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"].includes(symbol)) {
      await sendTelegramMessage("Usage: /signal NIFTY\n\nSupported: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX", String(chatId));
      return;
    }
    const response = await handleSignal(symbol);
    await sendTelegramMessage(response, String(chatId));
    return;
  }

  if (lower.startsWith("/price")) {
    const parts = msg.split(/\s+/);
    const symbol = parts[1]?.toUpperCase();
    if (!symbol || !["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"].includes(symbol)) {
      await sendTelegramMessage("Usage: /price NIFTY\n\nSupported: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX", String(chatId));
      return;
    }
    const response = await handlePrice(symbol);
    await sendTelegramMessage(response, String(chatId));
    return;
  }

  // Unknown command — suggest /help
  await sendTelegramMessage(
    `Unknown command. Try /help to see available commands.`,
    String(chatId)
  );
}

let lastUpdateId = 0;

export async function pollUpdates(): Promise<number> {
  const updates = await getUpdates(lastUpdateId + 1);
  let processed = 0;
  for (const update of updates) {
    if (update.update_id) {
      lastUpdateId = update.update_id;
    }
    const msg = update.message;
    if (msg?.text && msg.chat?.id) {
      await processMessage(msg.chat.id, msg.text);
      processed++;
    }
  }
  return processed;
}
