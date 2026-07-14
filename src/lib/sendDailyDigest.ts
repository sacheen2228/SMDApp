// lib/sendDailyDigest.ts
//
// Orchestrates one full daily-digest run: scan universe -> pick top N ->
// format -> send to Telegram. Called by both the HTTP cron route and the
// self-hosted scheduler, so the logic lives in one place.

import { runDailyScan, type SymbolSnapshot } from "./dailyScan";
import { formatDailyDigest } from "./dailyDigest";
import { sendTelegramMessage } from "./telegramSend";
import { ALL_SYMBOLS } from "./stockUniverse";
import { fetchNewsSentiment } from "./newsSentimentAdapter";
import { isTelegramSendWindow } from "./marketHours";
import type { OptionChainRow } from "./tradeAlertEngine";

const BASE = process.env.INTERNAL_API_BASE || "http://localhost:3000";

// ─── Live data wiring ───────────────────────────────────────────
// Reuses the SAME internal option-chain + news endpoints the chat UI
// and SDM bot already use, so the digest sees identical live data.
export async function fetchSnapshot(symbol: string, base = BASE): Promise<SymbolSnapshot | null> {
  try {
    const res = await fetch(`${base}/api/option-chain?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    if (!res.ok) return null;
    const json = await res.json();
    const d = json?.data;
    if (!d) return null;

    const spot = d.spotPrice || d.summary?.spotPrice || 0;
    const pcr = d.pcr ?? 1;
    const vix = d.greeks?.vix ?? d.vix ?? 15;
    const expiryLabel = d.expiries?.[0]?.label || d.selectedExpiry;

    const chain: OptionChainRow[] = (d.data || []).map((row: any) => ({
      strike: row.strike,
      ce: row.ce
        ? { ltp: row.ce.ltp || 0, oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0, iv: row.ce.iv || 0, delta: row.ce.delta || 0, vol: row.ce.volume || row.ce.vol || 0 }
        : { ltp: 0, oi: 0, oiChg: 0, iv: 0, delta: 0, vol: 0 },
      pe: row.pe
        ? { ltp: row.pe.ltp || 0, oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0, iv: row.pe.iv || 0, delta: row.pe.delta || 0, vol: row.pe.volume || row.pe.vol || 0 }
        : { ltp: 0, oi: 0, oiChg: 0, iv: 0, delta: 0, vol: 0 },
    }));

    const newsSentiment = await fetchNewsSentiment(symbol, base).catch(() => ({ score: 0 }));

    return { symbol, spot, pcr, vix, chain, newsSentiment, expiryLabel };
  } catch (err) {
    console.error(`[fetchSnapshot] ${symbol} failed:`, err);
    return null;
  }
}

const DIGEST_CHAT_IDS = (process.env.TELEGRAM_DIGEST_CHAT_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

export async function sendDailyDigest(): Promise<{ sent: boolean; pickCount: number }> {
  if (!isTelegramSendWindow()) {
    console.error(
      "[sendDailyDigest] outside 09:10-15:20 IST (Mon-Fri) — skipping send"
    );
    return { sent: false, pickCount: 0 };
  }
  if (DIGEST_CHAT_IDS.length === 0) {
    console.error("[sendDailyDigest] TELEGRAM_DIGEST_CHAT_IDS not set — nowhere to send");
    return { sent: false, pickCount: 0 };
  }

  const picks = await runDailyScan(ALL_SYMBOLS, { fetchSnapshot });
  const message = formatDailyDigest(picks);

  const results = await Promise.all(
    DIGEST_CHAT_IDS.map((chatId) => sendTelegramMessage(chatId, message))
  );

  return { sent: results.every(Boolean), pickCount: picks.length };
}
