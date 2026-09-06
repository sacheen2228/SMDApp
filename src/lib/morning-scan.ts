// Morning Scan — High-accuracy trades at 9 AM
// Dedup: same symbol+direction+strike skipped unless price or accuracy changed

import { readFileSync, writeFileSync, existsSync } from "fs";
import { sendTelegramMessage } from "./telegram";

const SCAN_FILE = "/tmp/morning-scan-history.json";

interface SentTrade {
  symbol: string;
  direction: string;
  strike: number;
  entry: number;
  score: number;
  sentAt: string;
}

interface ScanOpportunity {
  symbol: string;
  name: string;
  instrument: string;
  strategy: string;
  score: number;
  confidence: number;
  direction: string;
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  reasoning: string[];
  position: {
    quantity: number;
    totalCost: number;
    maxLoss: number;
    maxLossPct: number;
  };
  data: {
    ltp: number;
    changePct: number;
  };
}

// ── Load sent trades history ──
function loadHistory(): SentTrade[] {
  try {
    if (existsSync(SCAN_FILE)) {
      return JSON.parse(readFileSync(SCAN_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

// ── Save sent trades history ──
function saveHistory(trades: SentTrade[]): void {
  writeFileSync(SCAN_FILE, JSON.stringify(trades, null, 2));
}

// ── Check if trade is duplicate ──
function isDuplicate(
  opp: ScanOpportunity,
  history: SentTrade[]
): boolean {
  const match = history.find(
    (h) =>
      h.symbol === opp.symbol &&
      h.direction === opp.direction &&
      h.strike === (opp as any).strike
  );

  if (!match) return false;

  // Allow re-send if price changed > 1% or accuracy changed > 5 points
  const priceChanged =
    Math.abs(match.entry - opp.entry) / match.entry > 0.01;
  const scoreChanged = Math.abs(match.score - opp.score) > 5;

  return !priceChanged && !scoreChanged;
}

// ── Format trade message ──
function formatTradeMessage(
  opp: ScanOpportunity,
  rank: number,
  totalScanned: number
): string {
  const emoji = opp.direction === "BUY" ? "🟢" : "🔴";
  const dir = opp.direction === "BUY" ? "BUY" : "SELL";

  let msg = `${emoji} <b>#${rank} ${opp.symbol}</b> — ${dir}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📊 Score: <b>${opp.score}/100</b> | Conf: ${opp.confidence}%\n`;
  msg += `📈 Strategy: ${opp.strategy}\n`;
  msg += `💰 Entry: ₹${opp.entry.toFixed(2)}\n`;
  msg += `🛑 Stop Loss: ₹${opp.stopLoss.toFixed(2)}\n`;
  msg += `🎯 Target 1: ₹${opp.target1.toFixed(2)}\n`;
  msg += `🎯 Target 2: ₹${opp.target2.toFixed(2)}\n`;
  msg += `📐 R:R: 1:${opp.riskReward.toFixed(1)}\n`;

  if (opp.position.quantity > 0) {
    msg += `📦 Qty: ${opp.position.quantity} | Cost: ₹${opp.position.totalCost.toLocaleString()}\n`;
    msg += `⚠️ Max Loss: ₹${opp.position.maxLoss} (${opp.position.maxLossPct.toFixed(1)}%)\n`;
  }

  if (opp.reasoning.length > 0) {
    msg += `\n📝 ${opp.reasoning.join(" • ")}\n`;
  }

  msg += `🔄 LTP: ₹${opp.data.ltp} (${opp.data.changePct > 0 ? "+" : ""}${opp.data.changePct.toFixed(1)}%)`;

  return msg;
}

// ── Main morning scan ──
export async function runMorningScan(): Promise<{
  sent: number;
  skipped: number;
  totalScanned: number;
  message: string;
}> {
  const results = { sent: 0, skipped: 0, totalScanned: 0, message: "" };

  try {
    // Fetch challenge scan (has all opportunities with scoring)
    const scanRes = await fetch("http://localhost:3000/api/challenge");
    const scanData = await scanRes.json();

    const opportunities: ScanOpportunity[] =
      scanData.scan?.topOpportunities || [];

    if (opportunities.length === 0) {
      results.message = "No opportunities found";
      return results;
    }

    results.totalScanned = opportunities.length;

    // Filter high-accuracy only (score >= 70)
    const highAccuracy = opportunities.filter((o) => o.score >= 70);

    if (highAccuracy.length === 0) {
      results.message = `Scanned ${opportunities.length} — none with score ≥ 70`;
      return results;
    }

    // Load dedup history
    const history = loadHistory();

    // Build message
    let header = `☀️ <b>MORNING SCAN — ${new Date().toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</b>\n`;
    header += `━━━━━━━━━━━━━━━━━━━\n`;
    header += `📊 Scanned: ${results.totalScanned} | High-Accuracy: ${highAccuracy.length}\n\n`;

    let body = "";
    let rank = 0;

    for (const opp of highAccuracy) {
      if (isDuplicate(opp, history)) {
        results.skipped++;
        continue;
      }

      rank++;
      if (rank <= 5) {
        // Max 5 trades per morning
        body += formatTradeMessage(opp, rank, results.totalScanned) + "\n\n";

        // Record as sent
        history.push({
          symbol: opp.symbol,
          direction: opp.direction,
          strike: (opp as any).strike || opp.entry,
          entry: opp.entry,
          score: opp.score,
          sentAt: new Date().toISOString(),
        });

        results.sent++;
      }
    }

    if (results.sent === 0) {
      results.message = `Scanned ${results.totalScanned} | ${results.skipped} duplicates skipped | No new high-accuracy trades`;
      return results;
    }

    const footer = `\n━━━━━━━━━━━━━━━━━━━\n⏰ ${new Date().toLocaleTimeString("en-IN")} | ⚠️ Not financial advice`;

    const fullMessage = header + body + footer;

    // Send via Telegram
    await sendTelegramMessage(fullMessage);

    // Save history (keep last 7 days)
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentHistory = history.filter(
      (h) => new Date(h.sentAt).getTime() > sevenDaysAgo
    );
    saveHistory(recentHistory);

    results.message = `Sent ${results.sent} trades | ${results.skipped} skipped (duplicate)`;
  } catch (error: any) {
    results.message = `Scan failed: ${error.message}`;
  }

  return results;
}
