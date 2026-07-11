// lib/sendIntradayAlerts.ts
//
// Runs during market hours on a short interval (e.g. every 15 min).
// Reuses the same scan engine as the daily digest, but:
//   - only fires while the market is actually open
//   - sends each qualifying setup as its own push, immediately
//   - skips anything already alerted today (see intradayState.ts)
//
// This is what catches the 11am breakout the 9:20am digest missed.

import { runDailyScan } from "./dailyScan";
import { formatAlertMessage } from "./tradeAlertEngine";
import { sendTelegramMessage } from "./telegramSend";
import { isMarketOpen } from "./marketHours";
import { alreadySentToday, markSentToday, buildSignature } from "./intradayState";
import { ALL_SYMBOLS } from "./stockUniverse";
import { fetchSnapshot } from "./sendDailyDigest";

const DIGEST_CHAT_IDS = (process.env.TELEGRAM_DIGEST_CHAT_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

export async function sendIntradayAlerts(): Promise<{ ran: boolean; newAlerts: number }> {
  if (!isMarketOpen()) {
    return { ran: false, newAlerts: 0 };
  }
  if (DIGEST_CHAT_IDS.length === 0) {
    console.error("[sendIntradayAlerts] TELEGRAM_DIGEST_CHAT_IDS not set — nowhere to send");
    return { ran: false, newAlerts: 0 };
  }

  // Wider net than the morning digest — intraday catches more names,
  // dedupe + confidence/RR filters (inside runDailyScan) keep quality up.
  const candidates = await runDailyScan(ALL_SYMBOLS, {
    fetchSnapshot,
    topN: 12,
    minConfidence: 0.6, // slightly stricter than the AM digest — fewer, better mid-day pushes
    minRR: 1.5,
  });

  let newAlerts = 0;

  for (const c of candidates) {
    const signature = buildSignature(c.symbol, c.alert);
    if (alreadySentToday(signature)) continue;

    const text = `⚡ Mid-market alert\n\n${formatAlertMessage(c.alert)}\n\nConfidence: ${Math.round(c.confidence * 100)}%  |  R:R 1:${c.rr.toFixed(1)}`;

    const results = await Promise.all(
      DIGEST_CHAT_IDS.map((chatId) => sendTelegramMessage(chatId, text))
    );

    if (results.some(Boolean)) {
      markSentToday(signature);
      newAlerts++;
    }
  }

  return { ran: true, newAlerts };
}
