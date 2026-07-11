// lib/dailyDigest.ts
//
// Turns the ranked scan picks into a single Telegram-ready digest
// message (Markdown). Used by sendDailyDigest.ts.

import { formatAlertMessage } from "./tradeAlertEngine";
import type { ScanPick } from "./dailyScan";

export function formatDailyDigest(picks: ScanPick[]): string {
  if (!picks.length) {
    return "📊 SDM Daily Digest\n\nNo high-confidence setups detected right now. Markets may be quiet or live data is temporarily unavailable.";
  }

  const when = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  const header = `📊 *SDM Daily Digest* — ${when}\n\nTop setups across the universe:`;

  const body = picks
    .map((p, i) => {
      const tag = p.alert.side === "BUY" ? "🟢" : "🔴";
      const lines = [
        `${i + 1}. ${tag} *${p.alert.instrument}*`,
        formatAlertMessage(p.alert, { markdown: true }),
        `Confidence: ${Math.round(p.confidence * 100)}%  |  R:R 1:${p.rr.toFixed(1)}`,
      ];
      return lines.join("\n");
    })
    .join("\n\n");

  return `${header}\n\n${body}`;
}
