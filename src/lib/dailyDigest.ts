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
import type { TradeRecord } from "./trade-audit-client";

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

export interface McxDigestInfo {
  /** "CRUDEOIL A (82) — LONG entry ₹5000 SL ₹5100 T ₹4800", "NO VALID MCX TRADE" or "DATA_UNAVAILABLE". */
  summary: string;
  source: string;
}

/** MCX commodity section — best scanner trade + data source (never fabricated). */
export async function fetchMCXDigestInfo(): Promise<McxDigestInfo> {
  try {
    const res = await fetchWithTimeout("http://localhost:3000/api/mcx/scanner?mode=best");
    if (!res.ok) return { summary: "DATA_UNAVAILABLE", source: "none" };
    const json = await res.json();
    const best = json?.bestTrade;
    if (!best || best.grade === "NO_TRADE") {
      return { summary: "NO VALID MCX TRADE", source: "mcx-scanner" };
    }
    const summary = `${best.symbol} ${best.grade} (${best.score}) — ${best.direction} entry ₹${best.entry} SL ₹${best.stopLoss} T ₹${best.target}`;
    return { summary, source: best.dataStatus || "mcx-scanner" };
  } catch {
    return { summary: "DATA_UNAVAILABLE", source: "none" };
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
  /** true when the user was actually ALERTED about this trade (the digest
   *  must not present a recorded-but-never-alerted candidate as a position). */
  alerted?: boolean;
}

export interface DigestSections {
  newSignals: string[];
  activeOpen: string[];
  tpHits: string[];
  slHits: string[];
  closed: string[];
  deliveryFailures: string[];
  /** candidates that never became an alert, with the reason (Wave 3) */
  blocked?: string[];
  /** how many candidates were actually sent today */
  sentCount?: number;
}

/** One row of the candidate log (Prisma CandidateLog) — the reason a
 *  candidate did NOT become an alert. */
export interface DigestCandidate {
  source: string;
  symbol: string;
  direction?: string | null;
  strike?: number | null;
  sent: boolean;
  wouldBlock: boolean;
  gateVerdict?: string | null;
  fails?: string[];
  warnings?: string[];
}

/**
 * One row of the TRADE-AUDIT ledger → a digest trade.
 *
 * The sidecar is the REAL ledger (it holds the price ticks, the TP/SL hits
 * and the realised P&L). Its `status` is open/closed, so the outcome has to
 * be read from the hit flags: an SL hit is an SL, a TP hit is a TP, and only
 * a trade that is still open is ACTIVE.
 */
export function mapAuditTrade(t: TradeRecord): DigestTrade {
  const status = t.slHit
    ? "SL_HIT"
    : t.tp3Hit
      ? "TP3_HIT"
      : t.tp2Hit
        ? "TP2_HIT"
        : t.tp1Hit
          ? "TP1_HIT"
          : t.status === "open"
            ? "ACTIVE"
            : "CLOSED";
  return {
    tradeId: t.id,
    symbol: t.symbol,
    strike: t.strikePrice ?? undefined,
    type: t.optionType ?? (t.instrumentType === "EQUITY" ? "EQ" : undefined),
    side: t.trendDirection === "BEARISH" ? "SELL" : "BUY",
    status,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice ?? undefined,
    pnl: t.netPnl ?? undefined,
    tpHitLevel: t.tp3Hit ? "TP3" : t.tp2Hit ? "TP2" : t.tp1Hit ? "TP1" : null,
    strategy: t.strategyId,
  };
}

/** The dedup key of one trade across the stores (the sidecar + the journal). */
function tradeKey(t: DigestTrade): string {
  return [
    String(t.symbol || "").toUpperCase(),
    t.strike ?? "",
    (t.side || "").toUpperCase(),
    t.entryPrice != null ? Number(t.entryPrice).toFixed(2) : "",
  ].join("|");
}

/** The same trade in two stores: the type may be recorded on one side only. */
function sameTrade(a: DigestTrade, b: DigestTrade): boolean {
  if (tradeKey(a) !== tradeKey(b)) return false;
  const ta = (a.type || "").toUpperCase();
  const tb = (b.type || "").toUpperCase();
  return !ta || !tb || ta === tb;
}

/**
 * Merge the two ledgers without double counting: the PRIMARY store wins
 * (the sidecar carries the outcome), the secondary fills the gaps.
 */
export function mergeDigestTrades(primary: DigestTrade[], secondary: DigestTrade[]): DigestTrade[] {
  const out: DigestTrade[] = [...primary];
  for (const t of secondary) {
    const match = out.find((existing) => sameTrade(existing, t));
    if (match) {
      // The journal row means the alert funnel registered the trade → the
      // user WAS alerted about it.
      if (t.alerted) match.alerted = true;
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * The candidate summary: how many candidates were sent and WHY the others
 * never became an alert (the reason is the point of this section).
 */
export function summarizeCandidates(rows: DigestCandidate[]): { sent: number; blocked: string[] } {
  let sent = 0;
  const blocked: string[] = [];
  for (const r of rows) {
    if (r.sent) {
      sent++;
      continue;
    }
    const reason = (r.fails && r.fails.length ? r.fails : r.warnings && r.warnings.length ? r.warnings : [])[0];
    const dir = r.direction ? ` ${r.direction}` : "";
    const strike = r.strike ? ` ${r.strike}` : "";
    blocked.push(`  ${r.source} ${r.symbol}${strike}${dir} — ${reason ?? "blocked (no reason recorded)"}`);
  }
  return { sent, blocked };
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
    const src = t.strategy ? ` · ${t.strategy}` : "";
    const mark = t.alerted === false ? " · not alerted" : "";
    return `  ${t.symbol}${strike} ${t.side || ""} — ₹${t.entryPrice ?? "?"}${pnl}${lvl} [${t.status}]${src}${mark}`;
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
  market: { vix: VixInfo; fii: FiiInfo; mcx?: McxDigestInfo | null },
  now: string
): string {
  const vixLine =
    market.vix.value === "DATA_UNAVAILABLE"
      ? `  VIX: DATA_UNAVAILABLE`
      : `  VIX: ${market.vix.value} (${market.vix.source}, ${market.vix.freshness})`;
  const fiiLine = `  FII: ${market.fii.fii} | DII: ${market.fii.dii}${
    market.fii.date ? ` (${market.fii.date}${market.fii.source ? `, ${market.fii.source}` : ""})` : ""
  }`;
  const mcxLine = market.mcx
    ? `  MCX: ${market.mcx.summary} (${market.mcx.source})`
    : `  MCX: DATA_UNAVAILABLE`;

  const none = "  None";
  const blocked = sections.blocked ?? [];
  return `📊 <b>END OF DAY — ${now}</b>
━━━━━━━━━━━━━━━━━━━━━━━━

📈 <b>Market</b>
${vixLine}
${fiiLine}
${mcxLine}

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

🚫 <b>7. Blocked (no alert sent): ${blocked.length}</b>
${blocked.length > 0 ? groupBlocked(blocked).join("\n") : "  None"}

━━━━━━━━━━━━━━━━━━━━━━━━
💡 <i>Signals reset tomorrow. Fresh setups only.</i>
⏰ ${now}`;
}

/** The blocked lines, grouped by reason — 688 identical rows must not
 *  become a 60k-character Telegram message (the API caps at 4096). */
function groupBlocked(blocked: string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of blocked) {
    const key = line.replace(/^\s+/, "");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const grouped = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([line, n]) => (n > 1 ? `  ${line}  (×${n})` : `  ${line}`));
  return grouped.slice(0, 12);
}

// ─── Load today's trades (IST day boundary) ───────────────────────

/** The IST day window (UTC bounds) + the IST date key of "now". */
export function istDayWindow(now = new Date()): { key: string; start: Date; end: Date } {
  const istNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  istNow.setHours(0, 0, 0, 0);
  const start = new Date(istNow.getTime() - (5.5 * 60 * 60 * 1000));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  const key = new Date(start.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { key, start, end };
}

async function fetchTodayTrades(now: Date = new Date()): Promise<DigestTrade[]> {
  try {
    const { start, end } = istDayWindow(now);

    const trades = await db.trade.findMany({
      where: {
        OR: [
          { tradedAt: { gte: start, lte: end } },
          { entryTime: { gte: start, lte: end } },
          { exitTime: { gte: start, lte: end } },
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
      alerted: true,
    }));
  } catch (err: any) {
    console.warn("[DailyDigest] Failed to load trades:", err.message);
    return [];
  }
}

/**
 * THE REAL LEDGER — the TRADE-AUDIT sidecar (:4001).
 *
 * The 20/11 digest showed 0/0/0/0 because it only read the Prisma journal,
 * while the day's signals lived in the sidecar (22 INTRADAY equity + 9 BTST
 * rows, with the price ticks and the TP/SL hits). The sidecar may be down —
 * that must never break the digest.
 */
async function fetchAuditTrades(now: Date = new Date()): Promise<DigestTrade[]> {
  try {
    const { start, end } = istDayWindow(now);
    const { getTrades } = await import("./trade-audit-client");
    const page = await getTrades({
      dateFrom: start.toISOString(),
      dateTo: end.toISOString(),
      pageSize: 200,
    });
    return (page?.items ?? []).map((t) => mapAuditTrade(t));
  } catch (err: any) {
    console.warn("[DailyDigest] trade-audit ledger unavailable:", err?.message || String(err));
    return [];
  }
}

/** The alerts that were actually SENT — AlertClaim is the atomic decision. */
async function fetchSentClaims(now: Date = new Date()): Promise<string[]> {
  try {
    const { key } = istDayWindow(now);
    const claims = await db.alertClaim.findMany({
      where: { tradeDate: key },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    return claims
      .filter((c) => c.status === "SENT")
      .map((c) => {
        const strike = c.strike > 0 ? ` ${c.strike}` : "";
        const type = c.optionType && c.optionType !== "EQ" ? ` ${c.optionType}` : "";
        return `  ${c.symbol}${strike}${type} — ${c.side} (${c.strategy})`;
      });
  } catch (err: any) {
    console.warn("[DailyDigest] AlertClaim read failed:", err?.message || String(err));
    return [];
  }
}

/** The claim failures (a claim that never reached Telegram). */
async function fetchFailedClaims(now: Date = new Date()): Promise<string[]> {
  try {
    const { key } = istDayWindow(now);
    const claims = await db.alertClaim.findMany({
      where: { tradeDate: key, status: "FAILED" },
      orderBy: { updatedAt: "asc" },
      take: 100,
    });
    return claims.map(
      (c) => `  ${c.symbol} ${c.strike || ""} ${c.optionType} — ${c.lastError || "send failed"} (attempts ${c.attempts}/${c.maxAttempts})`,
    );
  } catch {
    return [];
  }
}

/** Every candidate of today + the reason the non-sent ones never alerted. */
async function fetchCandidates(now: Date = new Date()): Promise<DigestCandidate[]> {
  try {
    const { start, end } = istDayWindow(now);
    const rows = await db.candidateLog.findMany({
      where: { ts: { gte: start, lte: end } },
      orderBy: { ts: "asc" },
      take: 1000,
    });
    const parse = (v: string | null): string[] => {
      if (!v) return [];
      try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    };
    return rows.map((r) => ({
      source: r.source,
      symbol: r.symbol,
      direction: r.direction,
      strike: r.strike,
      sent: !!r.sent,
      wouldBlock: !!r.wouldBlock,
      gateVerdict: r.gateVerdict,
      fails: parse(r.fails),
      warnings: parse(r.warnings),
    }));
  } catch (err: any) {
    console.warn("[DailyDigest] CandidateLog read failed:", err?.message || String(err));
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

export async function buildDigestData(asOf: Date = new Date()): Promise<{
  sections: DigestSections;
  market: { vix: VixInfo; fii: FiiInfo; mcx: McxDigestInfo };
  now: string;
}> {
  const now = asOf.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const todaySignals = getTodaySignals();
  const [journalTrades, auditTrades, sentClaims, failedClaims, candidates, vix, fii, mcx, deliveryFailures] =
    await Promise.all([
      fetchTodayTrades(asOf),
      fetchAuditTrades(asOf),
      fetchSentClaims(asOf),
      fetchFailedClaims(asOf),
      fetchCandidates(asOf),
      fetchVIXInfo(),
      fetchFII(),
      fetchMCXDigestInfo(),
      fetchDeliveryFailures(),
    ]);

  // THE REAL LEDGER: the sidecar wins (it carries the outcome), the Prisma
  // journal fills the gaps. The same trade in both stores is counted ONCE.
  const trackerTrades: DigestTrade[] = getMonitoredTrades().map((t: any) => ({
    tradeId: t.id,
    symbol: t.symbol,
    strike: t.strike || undefined,
    type: t.optionType || undefined,
    side: t.side || undefined,
    status: "ACTIVE",
    entryPrice: t.entry,
    strategy: t.source || "tracker",
    alerted: true,
  }));
  const trades = mergeDigestTrades(auditTrades, [...journalTrades, ...trackerTrades]);

  const sections = categorizeTrades(trades, todaySignals, [
    ...failedClaims,
    ...deliveryFailures,
  ]);

  // The sent signals: the atomic claims (authoritative) + the sent-only
  // dedup map, deduped by symbol/strike/type.
  const seenSig = new Set<string>();
  const newSignals: string[] = [];
  for (const line of sentClaims) {
    const key = line.replace(/\s*\(.*\)$/, "").trim().toUpperCase();
    if (seenSig.has(key)) continue;
    seenSig.add(key);
    newSignals.push(line);
  }
  for (const [sig, info] of todaySignals) {
    const parts = sig.split("|");
    const key = `${parts[0]}|${parts[1]}|${parts[2]}`.toUpperCase();
    if (seenSig.has(key)) continue;
    seenSig.add(key);
    const emoji = parts[3]?.includes("BUY") || parts[3]?.includes("LONG") ? "🟢" : "🔴";
    newSignals.push(`${emoji} ${parts[0]} ${parts[1]} ${parts[2]} — ${info.confidence}% (${info.source})`);
  }
  sections.newSignals = newSignals;

  // A sidecar row that matches a SENT claim was alerted; the rest were only
  // RECORDED (the candidate never reached Telegram).
  const sentKeys = new Set<string>();
  for (const c of await db.alertClaim.findMany({ where: { tradeDate: istDayWindow(asOf).key, status: "SENT" } }).catch(() => [] as any[])) {
    sentKeys.add(`${String(c.symbol || "").toUpperCase()}|${c.strike ?? ""}|${String(c.side || "").toUpperCase()}`);
  }
  for (const t of trades) {
    if (t.alerted) continue;
    const key = `${String(t.symbol || "").toUpperCase()}|${t.strike ?? ""}|${String(t.side || "").toUpperCase()}`;
    if (sentKeys.has(key)) t.alerted = true;
  }

  // The blocked candidates — the reason nothing was sent is now visible.
  const cand = summarizeCandidates(candidates);
  sections.blocked = cand.blocked;
  sections.sentCount = cand.sent;

  return { sections, market: { vix, fii, mcx }, now };
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
