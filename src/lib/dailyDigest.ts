// lib/dailyDigest.ts
//
// End-of-day digest — sends summary of all signals sent today,
// what worked, what didn't, and tomorrow's outlook.
//
// SECTIONS (required):
//   1. New signals today
//   2. Active OPEN trades only
//   3. TP1/TP2/TP3 hit trades today
//   4. SL hit trades today
//   5. Closed/cancelled/error trades
//   6. Telegram delivery failures
//
// TP/SL-hit or closed trades are NEVER counted as Active Trades.
// VIX shows value+source+freshness, or DATA_UNAVAILABLE — never silent N/A.

import { getTodaySignals } from "./signalTracker";
import { getMonitoredTrades } from "./activeTradeTracker";
import { sendTelegramMessage } from "./telegram";
import { db } from "./db";

const DIGEST_CHAT_IDS = (process.env.TELEGRAM_DIGEST_CHAT_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

/** Chat IDs with fallback to the main bot chat so the digest always has a target. */
export function getDigestChatIds(): string[] {
  if (DIGEST_CHAT_IDS.length > 0) return DIGEST_CHAT_IDS;
  const main = process.env.TELEGRAM_CHAT_ID || "";
  return main ? [main] : [];
}

async function fetchWithTimeout(url: string, ms = 10000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { cache: "no-store", signal: ctrl.signal }).finally(() =>
    clearTimeout(timer)
  );
}

export interface VixInfo {
  value: string;
  source: string;
  freshness: string;
}

export async function fetchVIXInfo(): Promise<VixInfo> {
  const unavailable: VixInfo = {
    value: "DATA_UNAVAILABLE",
    source: "none",
    freshness: "UNAVAILABLE",
  };
  try {
    // Primary: option-chain summary (NSE/Breeze live VIX)
    const res = await fetchWithTimeout("http://localhost:3000/api/option-chain?symbol=NIFTY");
    if (!res.ok) return unavailable;
    const json = await res.json();
    const summary = json?.data?.summary ?? json?.summary;
    const vix = summary?.indiaVIX ?? json?.data?.indiaVIX;
    if (vix == null || Number(vix) <= 0) return unavailable;
    const live = summary?.vixLive !== false;
    return {
      value: Number(vix).toFixed(2),
      source: json?.data?.dataSource || "nse-api",
      freshness: live ? "LIVE" : "DELAYED",
    };
  } catch {
    return unavailable;
  }
}

export interface FiiInfo {
  fii: string;
  dii: string;
  date?: string;
  source?: string;
  freshness?: string;
}

export async function fetchFII(): Promise<FiiInfo> {
  try {
    const res = await fetchWithTimeout("http://localhost:3000/api/fii-dii");
    if (!res.ok) return { fii: "DATA_UNAVAILABLE", dii: "DATA_UNAVAILABLE" };
    const json = await res.json();
    if (json?.success === false || json?.fiiNet == null) {
      return { fii: "DATA_UNAVAILABLE", dii: "DATA_UNAVAILABLE" };
    }
    const fmt = (n: any) =>
      n == null ? "DATA_UNAVAILABLE" : `${Number(n) >= 0 ? "+" : ""}${Number(n).toFixed(1)} Cr`;
    return {
      fii: fmt(json.fiiNet),
      dii: fmt(json.diiNet),
      date: json.date || undefined,
      source: json.source || "NSE",
      freshness: json.freshness?.freshness || json.provenance?.freshness,
    };
  } catch {
    return { fii: "DATA_UNAVAILABLE", dii: "DATA_UNAVAILABLE" };
  }
}

// ─── Categorize trades (pure — unit-tested) ───────────────────────

export interface DigestTrade {
  tradeId: string;
  symbol: string;
  strike?: number;
  type?: string;
  side?: string;
  status: string;
  entryPrice?: number;
  exitPrice?: number;
  pnl?: number;
  tpHitLevel?: string | null;
  strategy?: string;
}

export interface DigestSections {
  newSignals: string[];
  activeOpen: string[];
  tpHits: string[];
  slHits: string[];
  closed: string[];
  deliveryFailures: string[];
}

const OPEN_STATUSES = new Set(["ACTIVE", "OPEN", "PENDING"]);
const TP_STATUSES = new Set(["TP1_HIT", "TP2_HIT", "TP3_HIT", "TP_HIT"]);
const SL_STATUSES = new Set(["SL_HIT"]);
const CLOSED_STATUSES = new Set([
  "CLOSED", "CANCELLED", "EXPIRED", "ERROR", "EXIT", "WIN", "LOSS", "BREAKEVEN", "TIME_EXIT", "EXPIRY_EXIT",
]);

export function categorizeTrades(
  trades: DigestTrade[],
  signals: Map<string, { sentAt: string; confidence: number; source: string }>,
  deliveryFailures: string[] = []
): DigestSections {
  // 1. New signals today
  const newSignals: string[] = [];
  for (const [sig, info] of signals) {
    const parts = sig.split("|");
    const emoji =
      parts[3]?.includes("BUY") || parts[3]?.includes("LONG") ? "🟢" : "🔴";
    newSignals.push(
      `${emoji} ${parts[0]} ${parts[1]} ${parts[2]} — ${info.confidence}% (${info.source})`
    );
  }

  const activeOpen: string[] = [];
  const tpHits: string[] = [];
  const slHits: string[] = [];
  const closed: string[] = [];

  const line = (t: DigestTrade): string => {
    const strike = t.strike ? ` ${t.strike}${t.type || ""}` : "";
    const pnl = t.pnl != null ? ` | P&L ₹${t.pnl}` : "";
    const lvl = t.tpHitLevel && TP_STATUSES.has(t.status) ? ` (${t.tpHitLevel})` : "";
    return `  ${t.symbol}${strike} ${t.side || ""} — ₹${t.entryPrice ?? "?"}${pnl}${lvl} [${t.status}]`;
  };

  for (const t of trades) {
    if (OPEN_STATUSES.has(t.status)) {
      activeOpen.push(line(t));
    } else if (TP_STATUSES.has(t.status)) {
      tpHits.push(line(t));
    } else if (SL_STATUSES.has(t.status)) {
      slHits.push(line(t));
    } else if (CLOSED_STATUSES.has(t.status)) {
      closed.push(line(t));
    } else {
      // Unknown status — treat as closed bucket, never as Active
      closed.push(line(t));
    }
  }

  return {
    newSignals,
    activeOpen,
    tpHits,
    slHits,
    closed,
    deliveryFailures,
  };
}

// ─── Format digest message (pure — unit-tested) ───────────────────

export function formatDigestMessage(
  sections: DigestSections,
  market: { vix: VixInfo; fii: FiiInfo },
  now: string
): string {
  const vixLine =
    market.vix.value === "DATA_UNAVAILABLE"
      ? `  VIX: DATA_UNAVAILABLE`
      : `  VIX: ${market.vix.value} (${market.vix.source}, ${market.vix.freshness})`;
  const fiiLine = `  FII: ${market.fii.fii} | DII: ${market.fii.dii}${
    market.fii.date ? ` (${market.fii.date}${market.fii.source ? `, ${market.fii.source}` : ""})` : ""
  }`;

  const none = "  None";
  return `📊 <b>END OF DAY — ${now}</b>
━━━━━━━━━━━━━━━━━━━━━━━━

📈 <b>Market</b>
${vixLine}
${fiiLine}

🎯 <b>1. New Signals Today: ${sections.newSignals.length}</b>
${sections.newSignals.length > 0 ? sections.newSignals.join("\n") : none}

💼 <b>2. Active OPEN Trades: ${sections.activeOpen.length}</b>
${sections.activeOpen.length > 0 ? sections.activeOpen.join("\n") : "  Active Trades: 0"}

✅ <b>3. TP1/TP2/TP3 Hit Today: ${sections.tpHits.length}</b>
${sections.tpHits.length > 0 ? sections.tpHits.join("\n") : none}

🛑 <b>4. SL Hit Today: ${sections.slHits.length}</b>
${sections.slHits.length > 0 ? sections.slHits.join("\n") : none}

📦 <b>5. Closed/Cancelled/Error: ${sections.closed.length}</b>
${sections.closed.length > 0 ? sections.closed.join("\n") : none}

📨 <b>6. Telegram Delivery Failures: ${sections.deliveryFailures.length}</b>
${sections.deliveryFailures.length > 0 ? sections.deliveryFailures.join("\n") : "  None"}

━━━━━━━━━━━━━━━━━━━━━━━━
💡 <i>Signals reset tomorrow. Fresh setups only.</i>
⏰ ${now}`;
}

// ─── Load today's trades from DB (IST day boundary) ───────────────

async function fetchTodayTrades(): Promise<DigestTrade[]> {
  try {
    // IST day window in UTC: IST = UTC+5:30
    const now = new Date();
    const istNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    istNow.setHours(0, 0, 0, 0);
    const dayStart = new Date(istNow.getTime() - (5.5 * 60 * 60 * 1000));
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

    const trades = await db.trade.findMany({
      where: {
        OR: [
          { tradedAt: { gte: dayStart, lte: dayEnd } },
          { entryTime: { gte: dayStart, lte: dayEnd } },
          { exitTime: { gte: dayStart, lte: dayEnd } },
        ],
      },
      orderBy: { entryTime: "desc" },
      take: 200,
    });

    return trades.map((t) => ({
      tradeId: t.tradeId,
      symbol: t.symbol,
      strike: t.strike || undefined,
      type: t.type,
      side: t.side,
      status: t.status,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice ?? undefined,
      pnl: t.pnl ?? undefined,
      tpHitLevel: t.tpHitLevel,
      strategy: t.strategy,
    }));
  } catch (err: any) {
    console.warn("[DailyDigest] Failed to load trades:", err.message);
    return [];
  }
}

async function fetchDeliveryFailures(): Promise<string[]> {
  try {
    const { getGlobalDeliveryStats } = await import("./agents/telegram-alerts");
    const stats = getGlobalDeliveryStats();
    return stats.failures.map(
      (f) => `  ${f.tradeId} ${f.alertType} — ${f.error || "send failed"} (retry ${f.retryCount}/3)`
    );
  } catch {
    return [];
  }
}

// ─── Build full digest data ───────────────────────────────────────

export async function buildDigestData(): Promise<{
  sections: DigestSections;
  market: { vix: VixInfo; fii: FiiInfo };
  now: string;
}> {
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const todaySignals = getTodaySignals();
  const [trades, vix, fii, deliveryFailures] = await Promise.all([
    fetchTodayTrades(),
    fetchVIXInfo(),
    fetchFII(),
    fetchDeliveryFailures(),
  ]);
  const sections = categorizeTrades(trades, todaySignals, deliveryFailures);
  return { sections, market: { vix, fii }, now };
}

export async function sendDailyDigest(): Promise<boolean> {
  const chatIds = getDigestChatIds();
  if (chatIds.length === 0) {
    console.warn("[DailyDigest] No TELEGRAM_DIGEST_CHAT_IDS or TELEGRAM_CHAT_ID configured");
    return false;
  }

  const { sections, market, now } = await buildDigestData();
  const msg = formatDigestMessage(sections, market, now);

  const results = await Promise.all(
    chatIds.map((chatId) => sendTelegramMessage(msg, chatId))
  );

  return results.some(Boolean);
}
