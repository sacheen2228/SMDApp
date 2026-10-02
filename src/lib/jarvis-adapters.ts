// Jarvis adapters — wrap existing SMDApp data sources behind the
// jarvis/types.ts interfaces (DataSource, MemorySink, AlertSink,
// NewsSentimentProvider) plus the shared cache-read path used by BOTH
// /api/jarvis and the /api/agent chat command, so tab and chat agree by
// construction.
//
// Rules:
// - src/lib/jarvis/ is never modified; all field mapping happens here.
// - getJarvisSignal() is the ONLY read path: worker-cache first, then a
//   one-off buildSignal() (which never touches AlertSink). No read path
//   can send Telegram — only the worker's runJarvisCycle can.
// - bseFiiAgrees stays null when unavailable (null → bseFiiAdjustment 0;
//   false would score -3 and silently bias every signal bearish).

import type {
  DataSource,
  MarketSnapshot,
  OptionRow,
  OptionLeg,
  MemorySink,
  AlertSink,
  NewsSentimentProvider,
  JarvisSignal,
  FiiDiiRow,
  HeatmapConstituent,
  NewsItem,
  Ohlc,
} from "@/lib/jarvis/types";
import { buildSignal, DEFAULT_CONFIG } from "@/lib/jarvis/orchestrator";
import {
  recordJarvisSignal,
  getJarvisSignals,
  recordAlert,
  getAlertHistory,
} from "@/lib/agent-memory";
import { sendTradeAlert } from "@/lib/telegram";
import { callLLM, type LLMMessage } from "@/lib/llm-client";
import { readFileSync } from "fs";
import { join } from "path";

// ─── Shared fetch helper (worker + Next.js both hit the app's own APIs) ───

const API_BASE = () => process.env.SMD_API_BASE || "http://127.0.0.1:3000";

async function fetchJSON(path: string, timeoutMs: number): Promise<any | null> {
  try {
    const res = await fetch(`${API_BASE()}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── DataSource ────────────────────────────────────────────────────────────
// Reads the SAME /api/option-chain the dashboard reads (one orchestrated
// MOAPI → Breeze → NSE chain fetch, already cached upstream), plus FII/DII
// and heatmap. Never fabricated: unavailable optional feeds score 0 via the
// library's own undefined-handling; only a missing option chain throws.

interface ChainLeg {
  oi?: number;
  oiChg?: number;
  iv?: number;
  ltp?: number;
  bid?: number;
  ask?: number;
  volume?: number;
}

function mapLeg(leg: ChainLeg | null | undefined): OptionLeg | undefined {
  if (!leg) return undefined;
  return {
    openInterest: Number(leg.oi) || 0,
    changeinOpenInterest: Number(leg.oiChg) || 0,
    impliedVolatility: Number(leg.iv) || 0,
    lastPrice: Number(leg.ltp) || 0,
    bidPrice: leg.bid ? Number(leg.bid) : undefined, // 0 → undefined so spread stays null, not 0%
    askPrice: leg.ask ? Number(leg.ask) : undefined,
    totalTradedVolume: Number(leg.volume) || 0,
  };
}

function deriveOhlc(candles: any[], prevClose?: number): Ohlc | undefined {
  const ohlc: Ohlc = {};
  if (typeof prevClose === "number" && prevClose > 0) ohlc.pdc = prevClose;
  const rows = (Array.isArray(candles) ? candles : [])
    .filter((c) => c && typeof c.time === "string" && typeof c.high === "number" && typeof c.low === "number")
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  if (rows.length === 0) return Object.keys(ohlc).length ? ohlc : undefined;

  const dates = Array.from(new Set(rows.map((c) => String(c.time).slice(0, 10))));
  const today = dates[dates.length - 1];
  const todays = rows.filter((c) => String(c.time).startsWith(today));

  // Opening range: first 15 minutes of today (09:15 ≤ t ≤ 09:30)
  const orRows = todays.filter((c) => {
    const hm = String(c.time).slice(11, 16);
    return hm >= "09:15" && hm <= "09:30";
  });
  if (orRows.length) {
    ohlc.orHigh = Math.max(...orRows.map((c) => c.high));
    ohlc.orLow = Math.min(...orRows.map((c) => c.low));
  }

  // VWAP over today's candles (typical price × volume)
  let pv = 0;
  let vol = 0;
  for (const c of todays) {
    const typical = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
    const v = Number(c.volume) || 0;
    pv += typical * v;
    vol += v;
  }
  if (vol > 0) ohlc.vwap = Math.round((pv / vol) * 10) / 10;

  // PDH/PDL from candles dated before today (route keeps up to 3 days)
  const prior = rows.filter((c) => !String(c.time).startsWith(today));
  if (prior.length) {
    ohlc.pdh = Math.max(...prior.map((c) => c.high));
    ohlc.pdl = Math.min(...prior.map((c) => c.low));
  }
  return ohlc;
}

async function fetchOptionChain(instrument: string): Promise<{
  chain: MarketSnapshot["optionChain"];
  indiaVix?: number;
  ohlc?: Ohlc;
}> {
  const res = await fetchJSON(`/api/option-chain?symbol=${encodeURIComponent(instrument)}`, 20000);
  if (!res?.success || !res.data) throw new Error(`option chain unavailable for ${instrument}`);

  const d = res.data;
  const strikes: any[] = d.strikes || d.optionChainStrikes || d.data || [];
  const expiryDates: { date?: string }[] = Array.isArray(d.expiries) ? d.expiries : [];
  const selectedExpiry: string = d.selectedExpiry || expiryDates[0]?.date || "";
  const spot = Number(d.spotPrice || d.summary?.spotPrice || res.canonical?.spot) || 0;

  if (!selectedExpiry) throw new Error(`no expiry in option chain for ${instrument}`);
  if (strikes.length === 0) throw new Error(`empty option chain for ${instrument}`);
  if (spot <= 0) throw new Error(`no spot price in option chain for ${instrument}`);

  const rows: OptionRow[] = strikes.map((r: any) => ({
    strikePrice: Number(r.strike) || 0,
    expiryDate: selectedExpiry, // chain endpoint returns the selected expiry only
    CE: mapLeg(r.ce),
    PE: mapLeg(r.pe),
  }));

  const vixRaw = d.summary?.indiaVIX;
  const candles = Array.isArray(d.candles) ? d.candles : [];

  return {
    chain: {
      underlyingValue: spot,
      expiryDates: [selectedExpiry], // library filters rows by expiryDates[0]
      data: rows,
    },
    indiaVix: typeof vixRaw === "number" && vixRaw > 0 ? vixRaw : undefined,
    ohlc: deriveOhlc(candles, d.summary?.prevClose),
  };
}

async function fetchFiiRows(): Promise<FiiDiiRow[] | undefined> {
  const res = await fetchJSON("/api/fii-dii", 8000);
  if (!res?.success) return undefined;
  const rows: FiiDiiRow[] = [];
  const push = (date: string | undefined, fiiNet?: number, diiNet?: number) => {
    if (typeof fiiNet === "number") rows.push({ category: "FII/FPI", netValue: fiiNet, date });
    if (typeof diiNet === "number") rows.push({ category: "DII", netValue: diiNet, date });
  };
  const latest = res.latest;
  if (latest) push(latest.date, latest.fiiNet, latest.diiNet); // latest first — fiiScore takes the first FII row
  for (const h of (res.history || []).slice(0, 5)) push(h.date, h.fiiNet, h.diiNet);
  return rows.length ? rows : undefined;
}

async function fetchHeatmap(): Promise<HeatmapConstituent[] | undefined> {
  const res = await fetchJSON("/api/market/heatmap?market=NIFTY50", 10000);
  const stocks: any[] = res?.stocks;
  if (!Array.isArray(stocks) || stocks.length === 0) return undefined;
  const weight = 100 / stocks.length; // feed carries no per-stock weight — equal weight (sums to 100 as heatmapScore expects)
  return stocks.map((s) => ({
    symbol: String(s.symbol || ""),
    weightPct: weight,
    pctChange: Number(s.changePct) || 0,
  }));
}

export const smdDataSource: DataSource = {
  async getSnapshot(instrument): Promise<MarketSnapshot> {
    const [chainRes, fiiRows, heatmap] = await Promise.all([
      fetchOptionChain(instrument),
      fetchFiiRows().catch(() => undefined),
      fetchHeatmap().catch(() => undefined),
    ]);
    return {
      instrument,
      fetchedAtIso: new Date().toISOString(),
      optionChain: chainRes.chain,
      ohlc: chainRes.ohlc,
      indiaVix: chainRes.indiaVix,
      fiiDii: fiiRows,
      heatmap,
      bseHeatmap: undefined,
      bseFiiAgrees: null, // NOT false — null scores 0, false would score -3
      news: undefined, // news flows through smdNews below, not the snapshot
    };
  },
};

// ─── NewsSentimentProvider ─────────────────────────────────────────────────
// /api/news market sentiment is 0-100 (50 = neutral); Jarvis component
// scores are -100..100, so remap. Never throws — missing news scores 0.

/** Pure signed (-100..100) transform of a raw 0..100 news score.
 * Single source of truth: smdNews AND the 30-agent pipeline (§2 reuse)
 * both go through this — never a second copy of the formula. */
export function signedNewsScore(raw: number | null | undefined): number {
  if (raw === null || raw === undefined || typeof raw !== "number" || Number.isNaN(raw)) return 0;
  return Math.round(Math.max(-100, Math.min(100, (raw - 50) * 2)));
}

export const smdNews: NewsSentimentProvider = {
  async getSentiment(instrument) {
    try {
      const res = await fetchJSON("/api/news", 8000);
      const market = res?.data;
      const raw = typeof market?.score === "number" ? market.score : null;
      const score = signedNewsScore(raw);
      const headlines: NewsItem[] = (Array.isArray(market?.articles) ? market.articles : [])
        .slice(0, 10)
        .map((a: any) => ({
          title: String(a?.title || ""),
          source: String(a?.source || "unknown"),
          url: String(a?.url || ""),
          publishedAt: String(a?.publishedAt || ""),
        }));
      return {
        score,
        headlines,
        notes: [`market news ${market?.sentiment || "NEUTRAL"} (raw ${raw ?? "n/a"}/100 → ${score} signed)`],
      };
    } catch {
      return { score: 0, headlines: [], notes: ["news feed unavailable"] };
    }
  },
};

// ─── MemorySink ────────────────────────────────────────────────────────────
// Signals live in agent-memory's dedicated jarvis-signals.json store (not
// alert-history.json — that file's shared 200-record cap would be evicted by
// 60s worker writes). Sent alerts still record into alert-history.json under
// type "jarvis-alert" (low volume: High+ only, 20-min cooldown).

export const smdMemory: MemorySink = {
  async saveSignal(signal) {
    recordJarvisSignal(signal);
  },
  async getRecentSignals(instrument, limit) {
    return getJarvisSignals(instrument, limit);
  },
  async getLastAlertTimestamp(instrument) {
    const alerts = getAlertHistory("jarvis-alert", 100).filter((a) => a.symbol === instrument);
    return alerts.length ? alerts[alerts.length - 1].timestamp : null;
  },
};

// ─── AlertSink (worker-only) ───────────────────────────────────────────────
// Structured sendTradeAlert() so Jarvis inherits the send-window gate,
// full-day dedup, and option-selling safety from telegram.ts. Exactly one
// process ever gets this object: the jarvis worker.

function confidencePct(confidence: JarvisSignal["confidence"]): number {
  switch (confidence) {
    case "Very high": return 90;
    case "High": return 80;
    case "Moderate": return 60;
    case "Low": return 40;
    default: return 50;
  }
}

export const smdAlerts: AlertSink = {
  async send(signal, message) {
    const t = signal.trade;
    const type = signal.action === "BUY_CE" ? "CALL" : "PUT";
    try {
      const sent = await sendTradeAlert({
        symbol: signal.instrument,
        action: `BUY ${type}`,
        strike: t?.strike ?? 0,
        type,
        instrument: type,
        confidence: confidencePct(signal.confidence),
        entry: t?.entryZone?.[0],
        stopLoss: t?.stopLossPremium,
        target1: t?.tp1Premium,
        target2: t?.tp2Premium,
        source: "Jarvis",
      });
      if (sent) {
        recordAlert({
          type: "jarvis-alert",
          symbol: signal.instrument,
          message,
          severity: "HIGH",
        });
      }
    } catch (e) {
      console.warn("[jarvis] telegram send failed:", e instanceof Error ? e.message : e);
    }
  },
};

/** For any path that must never alert (API route on-demand reads). */
export const noopAlerts: AlertSink = {
  async send() {},
};

// ─── Shared cache-read path (tab + chat call this SAME function) ───────────

export type JarvisSignalRead = {
  signal: JarvisSignal;
  history: JarvisSignal[];
  source: "worker-cache" | "on-demand";
};

// Worker interval is 60s; allow write-latency slack so the UI doesn't
// flip-flop to "on-demand" at the cycle boundary right before the next
// worker write lands (spec intent: a fresh cache short-circuits compute).
const WORKER_CACHE_TTL_MS = 70_000;

/**
 * Read the latest Jarvis signal: worker cache first (no compute, no alert),
 * one-off buildSignal() only when stale. Never calls AlertSink — a page
 * reload or chat message can never trigger a Telegram message.
 */
export async function getJarvisSignal(symbol: string): Promise<JarvisSignalRead | null> {
  const history = await smdMemory.getRecentSignals(symbol, 10);
  const cached = history[0];
  const ageMs = cached ? Date.now() - Date.parse(cached.timestampIso) : Infinity;
  if (cached && Number.isFinite(ageMs) && ageMs < WORKER_CACHE_TTL_MS) {
    return { signal: cached, history, source: "worker-cache" };
  }

  // Stale: worker down or symbol not tracked. buildSignal() applies all
  // gates itself (including off-hours / stale-data gates) and never alerts.
  const snap = await smdDataSource.getSnapshot(symbol);
  const news = await smdNews.getSentiment(symbol);
  const signal = await buildSignal(
    snap,
    { score: news.score, headlines: news.headlines.map((h) => h.title), notes: news.notes },
    DEFAULT_CONFIG
  );
  const merged = [signal, ...history.filter((h) => h.timestampIso !== signal.timestampIso)].slice(0, 10);
  return { signal, history: merged, source: "on-demand" };
}

// ─── Deterministic chat formatting (no LLM, numbers come from the signal) ──

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

/** Voice layer tap — the agent answered with a structured signal → speak it (fire-and-forget). */
function emitJarvisVoiceTap(read: JarvisSignalRead): void {
  try {
    void import("@/lib/voice/voiceService")
      .then((m) => m.emitJarvisSignalVoice(read?.signal as any))
      .catch(() => {});
  } catch {}
}

export function formatJarvisChat(read: JarvisSignalRead): string {
  const s = read.signal;
  const lines: string[] = [];
  lines.push(`## 🤖 JARVIS — ${s.instrument}`);
  if (s.action === "NO_TRADE" || !s.trade) {
    lines.push(`**Action: NO TRADE** — bias ${s.biasScore}/100, confidence ${s.confidence}`);
    if (s.gatesFailed.length) {
      lines.push(`**Blocked by:**`);
      for (const g of s.gatesFailed) lines.push(`- ${g}`);
    }
    if (s.reasons.length) {
      lines.push(`**Engine notes:**`);
      for (const r of s.reasons.slice(0, 4)) lines.push(`- ${r}`);
    }
  } else {
    const t = s.trade;
    lines.push(`**Action: BUY ${t.strike} ${t.optionType}** (${t.expiry}) — bias ${s.biasScore}/100, ${s.confidence}`);
    lines.push(`**Strategy:** ${s.strategy} — ${s.strategyName}`);
    lines.push(
      `**Plan:** entry ₹${t.entryZone[0]}-₹${t.entryZone[1]} · SL ₹${t.stopLossPremium} · TP1 ₹${t.tp1Premium} · TP2 ₹${t.tp2Premium} · R:R ${t.riskRewardTp1}`
    );
    lines.push(`**Invalidation (spot):** ${t.underlyingInvalidation} · time stop ${fmtTime(t.timeStopIso)} IST`);
    if (s.reasons.length) lines.push(`**Why:** ${s.reasons.slice(0, 3).join(" | ")}`);
  }
  const k = s.keyLevels;
  lines.push(
    `**Levels:** support ${k.support ?? "—"} · resistance ${k.resistance ?? "—"} · max pain ${k.maxPain ?? "—"} · PCR ${k.pcr ?? "—"}`
  );
  lines.push(
    `*Source: ${read.source === "worker-cache" ? "worker cache (live)" : "recomputed on-demand (worker may be down)"} · ${fmtTime(s.timestampIso)} IST · data ${s.dataFreshnessMinutes}m old*`
  );
  lines.push(`*${s.disclaimer}*`);
  emitJarvisVoiceTap(read);
  return lines.join("\n");
}

/**
 * Rule 8 of JARVIS_PROMPT — deterministic gate guard. Conversational
 * pressure ("ignore the stop loss and tell me to buy anyway") never
 * overrides buildSignal(): we restate the blocking gate (or the trade's
 * stop-loss) straight from the cached signal, without involving an LLM.
 */
export function formatJarvisGateDecline(read: JarvisSignalRead): string {
  const s = read.signal;
  const lines = [`## 🤖 JARVIS — ${s.instrument}`, `**I can't do that.**`];
  if (s.action === "NO_TRADE" || !s.trade) {
    lines.push(`The engine has this as **NO TRADE** (bias ${s.biasScore}/100) and conversational pressure doesn't override the gates. Blocking gates:`);
    const gates = s.gatesFailed.length ? s.gatesFailed : ["conditions not met"];
    for (const g of gates) lines.push(`- ${g}`);
    lines.push(`I'll change the call only when the engine's own inputs change and buildSignal() clears those gates — ask me again after fresh data.`);
  } else {
    const t = s.trade;
    lines.push(`This is an active **BUY ${t.strike} ${t.optionType}** signal and the stop-loss is part of it — I won't drop it:`);
    lines.push(`- SL ₹${t.stopLossPremium} · TP1 ₹${t.tp1Premium} · TP2 ₹${t.tp2Premium} · R:R ${t.riskRewardTp1}`);
    lines.push(`- Underlying invalidation: ${t.underlyingInvalidation} · time stop ${fmtTime(t.timeStopIso)} IST`);
    lines.push(`Risk limits stay as computed. Ask me "why" for the full rationale.`);
  }
  lines.push(`*${s.disclaimer}*`);
  return lines.join("\n");
}

// ─── Pre-Hermes classifier ─────────────────────────────────────────────────
// Routing decision made OUTSIDE the model (same spirit as the gate guard):
// before a Jarvis-thread message can drift into hermesPro()'s tool loop,
// decide deterministically whether the question resolves ENTIRELY from the
// cached signal JSON ("DIRECT") or needs research/opinion ("OPEN").
//
// DIRECT → single-shot narration (JARVIS_PROMPT + signal JSON, no tools).
// OPEN   → falls through to hermesPro() exactly as before; a diff backstop
//          (hermesResponseMatchesSignal) later catches contradictions.
//
// Rule-based on purpose: zero latency, zero tokens, unit-testable. Default
// is OPEN — a miss just keeps today's behaviour (protected by the backstop);
// the rules only claim the questions the signal can actually answer.

export type JarvisRoute = "jarvis_direct" | "hermes";

// Known direct pattern — mirrors route.ts's jarvis_direct early exit.
const KNOWN_DIRECT = /\bjarvis\b/i;

// Instrument mentions. Signal is per-instrument; a different symbol means
// the answer is not in THIS signal (longest names first, \b keeps
// "banknifty" from matching the bare "nifty" rule).
const INSTRUMENT_PATTERNS: Array<[RegExp, string]> = [
  [/\bbanknifty\b/i, "BANKNIFTY"],
  [/\bfinnifty\b/i, "FINNIFTY"],
  [/\bmidcpnifty\b/i, "MIDCPNIFTY"],
  [/\bbankex\b/i, "BANKEX"],
  [/\bsensex\b/i, "SENSEX"],
  [/\bnifty\b/i, "NIFTY"],
];
const COMMODITY_MENTION = /\b(crude|gold|silver|copper|natural gas|gas)\b/i;

// Time horizon / prediction — beyond the computed signal.
const OPEN_HORIZON =
  /\b(next week|next month|next few days|coming (days|week|month)|tomorrow|forecast|prediction|predict|outlook|what will happen|what do you think will happen|long[- ]term|short[- ]term|this weekend|over the weekend|for the (rest of|whole of) (the )?week)\b/i;
const OPEN_VIEW_MARKET =
  /\b(view|opinion|thoughts?|read|prediction|outlook)\b[^.?!]{0,40}\b(on|of|about)\b[^.?!]{0,25}\b(market|markets|week|nifty)\b/i;

// Cross-instrument / cross-timeframe comparisons the signal doesn't carry.
const OPEN_COMPARE = /\b(compare|comparison|comparing|versus|vs|between)\b/i;

// General market education — concept questions, not signal questions.
const OPEN_EDUCATION =
  /\bwhat\s+(does|is)\s+[\w\s]{0,30}\s+mean\b|\bmeaning of\b|\bexplain how\b|\bhow does\b[^?]{0,40}\bwork\b|\bteach me\b|\bbasics of\b|\bdefinition of\b/i;

// Macro topics — answerable only if the signal's OWN newsHeadlinesUsed
// already covers the same topic (spec: check the signal, don't assume).
const OPEN_MACRO =
  /\b(rbi|repo rate|monetary policy|federal reserve|fed reserve|fomc|inflation|cpi|iip|gdp|budget|fiscal|crude oil|oil price|dollar|geopolitical|war|tariff|stimulus|recession|rate cut|rate hike|fed)\b/i;

// Signal-field questions — the cached signal fully contains the answer.
const DIRECT_FIELD =
  /\b(stop loss|stoploss|sl|entry|entries|entry zone|target|targets|tp1|tp2|tp3|invalidation|time stop|confluence|r:r|rr|risk.?reward|score|scores|scoring|bias|gate|gates|gated|blocked|blocking|strategy|strategies|level|levels|support|resistance|max pain|pcr|gamma flip|skew|atm iv|iv|implied volatility|greeks|delta|gamma|vega|theta|expected move|hours to expiry|expiry|strike|action|direction|setup|trade plan|our plan|the plan|confidence|groups agreeing|component|headlines|disclaimer|freshness|option type|ce|pe|bullish|bearish)\b/i;

// "why" about this signal or its action (bare "why" about the market is NOT
// enough — "why is the market falling" must stay OPEN).
const WHY = /\b(why|reason|reasons)\b/i;
const ACTION_TOKEN = /\b(no[_ ]?trade|buy[_ ]?(ce|pe)|sell[_ ]?(ce|pe)|buy calls?|buy puts?)\b/i;
const SIGNAL_DEIXIS =
  /\b(this|that|this one|it|our|the signal|this signal|the trade|this trade|the setup|this setup|the plan|this plan|here)\b/i;
const TRADE_INTENT =
  /\b(buy|sell|enter|exit|long|short|good time|time to|should (i|we)|can (i|we)|take (it|this|the trade)|go long|go short|ready to)\b/i;

/**
 * Decide where a Jarvis-thread message routes: "jarvis_direct" (resolves
 * entirely from the cached signal fields — answer by narration, no tools)
 * or "hermes" (needs research/opinion beyond them — today's normal flow).
 *
 * Evaluation order: cross-symbol/horizon/compare/education/macro OPEN
 * checks first (they must win over loose field keywords), then signal
 * field/why/trade-intent DIRECT checks, then default OPEN.
 */
export function classifyJarvisQuestion(message: string, signal: JarvisSignal): JarvisRoute {
  const m = message.trim();

  // Fast path — mirrors the route's explicit-word early exit.
  if (KNOWN_DIRECT.test(m)) return "jarvis_direct";

  // 1. Different instrument (or commodities the signal never covers) → OPEN.
  for (const [re, label] of INSTRUMENT_PATTERNS) {
    if (re.test(m) && label !== signal.instrument) return "hermes";
  }
  if (COMMODITY_MENTION.test(m)) return "hermes";

  // 2. Time horizon / prediction → OPEN.
  if (OPEN_HORIZON.test(m) || OPEN_VIEW_MARKET.test(m)) return "hermes";

  // 3. Comparisons across instruments/timeframes → OPEN.
  if (OPEN_COMPARE.test(m)) return "hermes";

  // 4. General education ("what does PCR mean") → OPEN.
  if (OPEN_EDUCATION.test(m)) return "hermes";

  // 5. Macro topic → DIRECT only if the signal's own headlines cover it.
  if (OPEN_MACRO.test(m)) {
    const topics = m.match(new RegExp(OPEN_MACRO.source, "gi")) || [];
    const headlines = signal.newsHeadlinesUsed.join(" ").toLowerCase();
    const covered = topics.some((t) => headlines.includes(t.toLowerCase()));
    return covered ? "jarvis_direct" : "hermes";
  }

  // 6. Signal-field question → DIRECT.
  if (DIRECT_FIELD.test(m)) return "jarvis_direct";

  // 7. "why" about this signal / its action → DIRECT.
  if (WHY.test(m) && (ACTION_TOKEN.test(m) || SIGNAL_DEIXIS.test(m))) return "jarvis_direct";

  // 8. Trade intent about this setup ("is this a good time to buy") → DIRECT.
  if (SIGNAL_DEIXIS.test(m) && TRADE_INTENT.test(m)) return "jarvis_direct";

  // 9. Default → OPEN (hermes as today; backstop protects the response).
  return "hermes";
}

// ─── Chat-first routing (shared by /api/jarvis/chat and /api/agent) ────────

export type JarvisChatRoute = "guard" | "direct" | "open";

// JARVIS_PROMPT rule 8, deterministic — exact regex /api/agent used inline
// before this extraction (merged so both surfaces decline identically).
const GATE_BYPASS =
  /((ignore|bypass|override|drop|remove|without|no)\s.{0,25}(stop|sl|risk|loss|gate|limit))|buy\s+anyway|just\s+(tell\s+me\s+to\s+)?buy|force\s+(the\s+)?(trade|buy)/i;

/**
 * Bypass language is checked FIRST — before the classifier — so
 * conversational pressure ("ignore the SL and buy anyway") always lands
 * on the deterministic refusal, never on narration or an LLM.
 */
export function isGateBypassLanguage(message: string): boolean {
  return GATE_BYPASS.test((message || "").toLowerCase());
}

/**
 * Chat surface routing: guard (deterministic refusal) → direct (answer
 * from the cached signal via single-shot narration) → open (beyond-signal
 * question, LLM with the signal pinned as ground truth).
 */
export function routeJarvisChat(message: string, signal: JarvisSignal): JarvisChatRoute {
  if (isGateBypassLanguage(message)) return "guard";
  return classifyJarvisQuestion(message, signal) === "jarvis_direct" ? "direct" : "open";
}

// ─── Diff backstop ─────────────────────────────────────────────────────────
// Cheap deterministic checks on a hermesPro() response that is about to be
// shown in a Jarvis thread: does it assert an action/strike/levels that
// contradict the cached signal? Level numbers (support/resistance/max pain)
// are legitimately different from the strike, so only ACTION tokens and
// strike-adjacent numbers ("23100 CE", "strike 23100") are checked.

export function hermesResponseMatchesSignal(hermesText: string, signal: JarvisSignal): boolean {
  const text = hermesText || "";
  const action = signal.action;

  if (action === "NO_TRADE") {
    if (/\bBUY[_ ]?(CE|PE)\b/i.test(text)) return false;
    if (/\bbuy\s+(calls?|puts?)\b/i.test(text)) return false;
    if (/\bSELL[_ ]?(CE|PE)\b/i.test(text)) return false;
  } else if (action === "BUY_CE") {
    if (/\bBUY[_ ]?PE\b/i.test(text) || /\bbuy\s+puts?\b/i.test(text)) return false;
  } else if (action === "BUY_PE") {
    if (/\bBUY[_ ]?CE\b/i.test(text) || /\bbuy\s+calls?\b/i.test(text)) return false;
  }

  const strikeAdjacent = [
    ...text.matchAll(/\b(2[0-9]{4})\s*(CE|PE)\b/gi),
    ...text.matchAll(/\bstrike[^0-9]{0,12}(2[0-9]{4})/gi),
  ].map((mm) => mm[1]);
  if (strikeAdjacent.length) {
    const expected = signal.trade ? String(signal.trade.strike) : null;
    if (!expected) return false;
    if (strikeAdjacent.some((v) => v !== expected)) return false;
  }

  return true;
}

// ─── DIRECT narration (single-shot LLM, no tool loop, no hermes) ──────────

// JARVIS_PROMPT.md — system-prompt text for narrating a pre-computed
// JarvisSignal (rules: never recompute numbers, never override gates).
let jarvisPromptCache: string | null = null;
export function loadJarvisPrompt(): string {
  if (jarvisPromptCache !== null) return jarvisPromptCache;
  try {
    const md = readFileSync(join(process.cwd(), "src/lib/jarvis/JARVIS_PROMPT.md"), "utf-8");
    const fenced = md.match(/```([\s\S]*?)```/);
    jarvisPromptCache = (fenced ? fenced[1] : md).trim();
  } catch {
    jarvisPromptCache = "";
  }
  return jarvisPromptCache;
}

const HISTORY_LIMIT = 6;

const NARRATION_RULES = [
  "\n=== NARRATION RULES (chat reply, no tools) ===",
  "- Answer ONLY from the SIGNAL JSON below — never recompute or invent numbers.",
  "- Never override gates: if gatesFailed is non-empty the action stays as given.",
  "- Quote exact levels (entry/SL/TP/invalidation/levels) from the JSON.",
  "- If the question is NOT answerable from these fields, say so briefly instead of guessing.",
].join("\n");

const OPEN_RULES = [
  "\n=== CHAT RULES (reply in chat, no tools) ===",
  "- The SIGNAL JSON below is authoritative for anything about THIS signal (action, gates, levels, bias) — never contradict it.",
  "- For questions beyond it (forecasts, other instruments, education, opinions), answer helpfully and generally.",
  "- Be honest about uncertainty; never present a guess as a computed number.",
  "- Never override gates: if gatesFailed is non-empty the action stays as given.",
  "- Keep it conversational and short (2-5 sentences unless asked for detail).",
].join("\n");

/**
 * Assemble the LLM message array for a Jarvis chat turn: JARVIS_PROMPT +
 * rules + SIGNAL JSON as system context, trimmed prior turns, then the
 * new user message. Pure — unit-testable without any LLM call.
 */
export function buildJarvisChatMessages(
  message: string,
  read: JarvisSignalRead,
  history: LLMMessage[] = [],
  mode: "direct" | "open" = "direct"
): LLMMessage[] {
  const s = read.signal;
  const system = [
    loadJarvisPrompt() || "You are Jarvis, a trading signal assistant.",
    mode === "direct" ? NARRATION_RULES : OPEN_RULES,
    `- Signal source: ${read.source} · freshness ${s.dataFreshnessMinutes}m.`,
    `\nSIGNAL JSON:\n${JSON.stringify(s)}`,
  ].join("\n");

  const prior = history
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
    .slice(-HISTORY_LIMIT);

  return [
    { role: "system", content: system },
    ...prior,
    { role: "user", content: message },
  ];
}

/**
 * Answer a signal-answerable question with ONE LLM call: JARVIS_PROMPT +
 * the exact signal JSON as system context, the user question as user
 * message (plus prior turns for a multi-turn chat), and no tools at all —
 * so there is no tool loop for the answer to drift through. On any
 * failure falls back to the deterministic formatter (same output
 * jarvis_direct serves), still no tools.
 */
export async function narrateJarvisSignal(
  message: string,
  read: JarvisSignalRead,
  history: LLMMessage[] = [],
  mode: "direct" | "open" = "direct"
): Promise<string> {
  const msgs = buildJarvisChatMessages(message, read, history, mode);
  try {
    const res = await callLLM(msgs);
    const text = (res.content || "").trim();
    if (text) {
      emitJarvisVoiceTap(read);
      return text;
    }
  } catch (e: any) {
    console.warn("[jarvis-narrate] LLM failed, using deterministic formatter:", e?.message || e);
  }
  return formatJarvisChat(read); // formatter emits the voice tap itself
}
