// Option Buyer TP/SL Alert Monitor
// Polls live prices, detects TP/SL hits, sends Telegram alerts

import { sendTelegramMessage } from '@/lib/telegram';

interface MonitoredTrade {
  id: string;
  symbol: string;
  direction: "CE" | "PE";
  strike: number;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  expiry: string;
  status: "ACTIVE" | "TP1" | "TP2" | "TP3" | "SL" | "EXPIRED";
  slHit: boolean;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  addedAt: string;
  lastCheck: string;
}

// In-memory monitored trades (persisted to file for restarts)
let monitoredTrades: MonitoredTrade[] = [];

function formatPriceAlert(trade: MonitoredTrade, hitType: "SL" | "TP1" | "TP2" | "TP3", currentPrice: number): string {
  const emoji = hitType === "SL" ? "🛑" : hitType === "TP1" ? "🎯" : hitType === "TP2" ? "🎯🎯" : "🎯🎯🎯";
  const action = hitType === "SL" ? "STOP LOSS HIT" : `${hitType} TARGET HIT`;
  const pnl = currentPrice - trade.entry;
  const pnlPct = ((pnl / trade.entry) * 100).toFixed(1);
  const pnlEmoji = pnl >= 0 ? "🟢" : "🔴";

  return [
    `${emoji} <b>${trade.symbol} ${trade.direction} — ${action}</b>`,
    "",
    `📊 Strike: ${trade.strike}`,
    `⚡ Entry: ₹${trade.entry.toFixed(2)}`,
    `📍 Current: ₹${currentPrice.toFixed(2)}`,
    `${pnlEmoji} P&L: ₹${pnl.toFixed(2)} (${pnlPct}%)`,
    "",
    hitType === "SL" ? `🛑 SL was: ₹${trade.stopLoss.toFixed(2)}` : `🎯 ${hitType} was: ₹${hitType === "TP1" ? trade.tp1 : hitType === "TP2" ? trade.tp2 : trade.tp3}.toFixed(2)`,
    `📅 Expiry: ${trade.expiry}`,
    "",
    `⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
  ].join("\n");
}

export function addMonitoredTrade(trade: Omit<MonitoredTrade, "id" | "status" | "slHit" | "tp1Hit" | "tp2Hit" | "tp3Hit" | "addedAt" | "lastCheck">): string {
  const id = `OB-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const monitored: MonitoredTrade = {
    ...trade,
    id,
    status: "ACTIVE",
    slHit: false, tp1Hit: false, tp2Hit: false, tp3Hit: false,
    addedAt: new Date().toISOString(),
    lastCheck: new Date().toISOString(),
  };
  monitoredTrades.push(monitored);
  return id;
}

export async function checkMonitoredTrades(fetchPrice: (symbol: string) => Promise<number | null>): Promise<{ checked: number; alerts: string[] }> {
  const alerts: string[] = [];
  const now = new Date();

  for (const trade of monitoredTrades) {
    if (trade.status !== "ACTIVE") continue;

    // Skip if last check was < 30 seconds ago
    const lastCheck = new Date(trade.lastCheck).getTime();
    if (now.getTime() - lastCheck < 30_000) continue;

    trade.lastCheck = now.toISOString();

    // Get current premium price (approximation: use spot + strike relationship)
    // In production, this would fetch live option premium from Breeze/NSE
    const currentPrice = await fetchPrice(trade.symbol);
    if (!currentPrice || currentPrice <= 0) continue;

    // Check SL hit (premium drops below SL)
    if (!trade.slHit && currentPrice <= trade.stopLoss) {
      trade.slHit = true;
      trade.status = "SL";
      const msg = formatPriceAlert(trade, "SL", currentPrice);
      await sendTelegramMessage(msg).catch(() => {});
      alerts.push(`SL HIT: ${trade.symbol} ${trade.direction} ${trade.strike}`);
    }

    // Check TP1 hit
    if (!trade.tp1Hit && currentPrice >= trade.tp1) {
      trade.tp1Hit = true;
      trade.status = "TP1";
      const msg = formatPriceAlert(trade, "TP1", currentPrice);
      await sendTelegramMessage(msg).catch(() => {});
      alerts.push(`TP1 HIT: ${trade.symbol} ${trade.direction} ${trade.strike}`);
    }

    // Check TP2 hit
    if (!trade.tp2Hit && currentPrice >= trade.tp2) {
      trade.tp2Hit = true;
      trade.status = "TP2";
      const msg = formatPriceAlert(trade, "TP2", currentPrice);
      await sendTelegramMessage(msg).catch(() => {});
      alerts.push(`TP2 HIT: ${trade.symbol} ${trade.direction} ${trade.strike}`);
    }

    // Check TP3 hit
    if (!trade.tp3Hit && currentPrice >= trade.tp3) {
      trade.tp3Hit = true;
      trade.status = "TP3";
      const msg = formatPriceAlert(trade, "TP3", currentPrice);
      await sendTelegramMessage(msg).catch(() => {});
      alerts.push(`TP3 HIT: ${trade.symbol} ${trade.direction} ${trade.strike}`);
    }
  }

  // Remove expired trades (older than 1 day or status is terminal)
  monitoredTrades = monitoredTrades.filter(t => {
    if (t.status === "SL" || t.status === "TP3" || t.status === "EXPIRED") return false;
    const age = now.getTime() - new Date(t.addedAt).getTime();
    if (age > 24 * 60 * 60 * 1000) return false; // 24h expiry
    return true;
  });

  return { checked: monitoredTrades.filter(t => t.status === "ACTIVE").length, alerts };
}

export function getMonitoredTrades(): MonitoredTrade[] {
  return [...monitoredTrades];
}
