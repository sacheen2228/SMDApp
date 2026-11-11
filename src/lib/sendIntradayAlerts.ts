// lib/sendIntradayAlerts.ts
//
// Runs during market hours every 15 min. Before scanning for new trades,
// checks active trades for SL/TP hits. Sends a Telegram push for each.
// Uses the SDM V2 engine (via /api/sdm-signal) for trade generation so
// Telegram alerts match the SMD bot's recommendations exactly.

import { recordIntradayTrade } from "./intraday-scanner";
import { isTelegramSendWindow, isTradingDay } from "./marketHours";
import { alreadySentToday, markSentToday, buildSignature } from "./intradayState";
import { ALL_SYMBOLS } from "./stockUniverse";
import { getNextMonthlyExpiry, NSE_HOLIDAYS } from "./expiry-calculator";
import {
  checkSLTP, addTrade,
  hasActiveTrade, tickPx, fmtStrike
} from "./activeTradeTracker";
import { registerAgent, getAgentByName, createSignal } from "@/lib/agents/registry";
import { transitionSignal } from "@/lib/agents/signal-lifecycle";
import { evaluateTradeGate, sendTradeAlert } from "@/lib/telegram";
import { sendTradeEvent } from "@/lib/trade-event-coordinator";
import { isAlertsOwner } from "@/lib/alerts-owner";
import { CONF_FLOOR_CALL, CONF_FLOOR_PUT } from "@/lib/signal-persistence";
import { providerHealth } from "@/lib/provider-health";
import { getIntradayGateMode, recordGateDecision } from "@/lib/intraday-gates";
import { toIsoExpiry } from "@/lib/expiry-date";

const BASE = process.env.INTERNAL_API_BASE || "http://localhost:3000";

const DIGEST_CHAT_IDS = (process.env.TELEGRAM_DIGEST_CHAT_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

function fetchWithTimeout(url: string, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { cache: "no-store", signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// Fetch SDM signal for a symbol+direction+expiry and push to candidates array
async function fetchAndPushSignal(
  sym: string,
  direction: string,
  candidates: { symbol: string; alert: any }[],
  expiry?: string
): Promise<void> {
  const startMs = Date.now();
  
  // Breeze fast-fail: if Breeze circuit is open, log and fall back to MOAPI/NSE via the API
  if (providerHealth.shouldSkip("breeze")) {
    console.log("[sendIntradayAlerts] " + sym + " " + direction + " Breeze circuit open, falling back to MOAPI/NSE");
  }
  
  try {
    let url = `${BASE}/api/sdm-signal?symbol=${encodeURIComponent(sym)}&dir=${direction}`;
    if (expiry) url += `&expiry=${encodeURIComponent(expiry)}`;

    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      console.error("[sdm-signal] " + sym + " " + direction + " HTTP " + res.status);
      return;
    }
    const json = await res.json();
    if (!json.success || !json.signal) {
      console.error("[sdm-signal] " + sym + " " + direction + " no signal: " + JSON.stringify(json.error || json));
      return;
    }

    const alert = sdmSignalToAlert(sym, json.signal);
    if (!alert) {
      console.error("[sdm-signal] " + sym + " " + direction + " null alert from sdmSignalToAlert");
      return;
    }

    const conf = (alert.confidence || 0) / 100;
    const rr = alert.rrGate || 1;
    const floor = (alert.optionType === "CE") ? CONF_FLOOR_CALL : CONF_FLOOR_PUT;
    if (conf < floor / 100 || rr < 1.5) {
      console.log("[sdm-signal] " + sym + " " + direction + " floor gate: conf=" + conf + " rr=" + rr + " floor=" + floor / 100);
      return;
    }

    // Gate check: veto + risk limits (same logic as /api/telegram)
    try {
      const gate = await evaluateTradeGate({
        symbol: alert.symbol,
        action: alert.side,
        optionType: alert.optionType,
        strike: alert.strike,
        entry: alert.entry,
        stopLoss: alert.sl,
        tp1: alert.tp1,
        confidence: alert.confidence,
        spot: alert.spot,
        expiry: alert.expiryDate,
      });
      const mode = getIntradayGateMode();
      recordGateDecision(gate.blocked, mode);
      if (gate.blocked) {
        const reasonStr = gate.reasons.join(", ");
        if (mode === "enforce") {
          console.log("[Intraday] GATE BLOCK " + alert.symbol + " " + alert.strike + " " + alert.optionType + " " + reasonStr);
          return;
        }
        // log mode: log but still send; the counter is the would-have-blocked tally
        console.log("[Intraday] WOULD BLOCK " + alert.symbol + " " + alert.strike + " " + alert.optionType + " " + reasonStr);
      }
    } catch (err: any) {
      const mode = getIntradayGateMode();
      recordGateDecision(true, mode);
      const msg = err?.message || String(err);
      if (mode === "enforce") {
        console.log("[Intraday] GATE ERROR " + alert.symbol + " " + alert.strike + " " + alert.optionType + ": " + msg);
        return;
      }
      console.log("[Intraday] GATE ERROR " + alert.symbol + " " + alert.strike + " " + alert.optionType + ": " + msg);
    }

    candidates.push({ symbol: sym, alert });
  } catch (err: any) {
    console.error("[sdm-signal] " + sym + " " + direction + " unexpected error: " + (err?.message || String(err)));
  }
}

// Price fetcher for SL/TP checking — fetches live option price
/**
 * The LIVE premium of the exact contract that was opened.
 *
 * Fail closed on anything that is not that contract's premium:
 *   • a chain for a DIFFERENT expiry is a different contract (its premium would
 *     silently move the stop/TP of this trade),
 *   • a premium worth more than its underlying is not a premium (that is the
 *     underlying itself leaking into the option price).
 */
export async function getCurrentOptionPrice(
  symbol: string,
  strike: number,
  optionType: string,
  expiry?: string
): Promise<number> {
  try {
    const expiryParam = expiry ? `&expiry=${encodeURIComponent(expiry)}` : "";
    const res = await fetchWithTimeout(
      `${BASE}/api/option-chain?symbol=${encodeURIComponent(symbol)}${expiryParam}&readonly=1`
    );
    if (!res.ok) return 0;
    const json = await res.json();
    const data = json?.data?.data || [];

    // Fail closed on a stale chain: a 15-minute monitor cannot price a stop off
    // a chain that was collected more than 10 minutes ago.
    const asOfRaw = json?.data?.asOf || json?.data?.timestamp || json?.data?.fetchedAt || json?.data?.chainAsOf;
    if (asOfRaw) {
      const asOfMs = Date.parse(asOfRaw);
      if (Number.isFinite(asOfMs) && Date.now() - asOfMs > 10 * 60 * 1000) {
        console.warn(`[sendIntradayAlerts] ${symbol} chain is ${Math.round((Date.now() - asOfMs) / 60000)}m old — no LTP`);
        return 0;
      }
    }

    // The chain must be the expiry we opened (when both are known).
    const chainExpiry = json?.data?.expiry || json?.data?.selectedExpiry || "";
    const wantExpiry = expiryKey(expiry);
    const haveExpiry = expiryKey(chainExpiry);
    if (wantExpiry && haveExpiry && wantExpiry !== haveExpiry) {
      console.warn(`[sendIntradayAlerts] ${symbol} chain expiry ${chainExpiry} ≠ trade expiry ${expiry} — no LTP`);
      return 0;
    }

    const row = data.find((r: any) => Number(r.strike) === Number(strike));
    if (!row) return 0;
    const side = optionType === "CE" ? row.ce : row.pe;
    const ltp = Number(side?.ltp || 0);
    if (!(ltp > 0)) return 0;

    // An option can never be worth more than its underlying. If the feed hands
    // back the spot, it is not a premium → fail closed.
    const spot = Number(json?.data?.spotPrice || 0);
    if (spot > 0 && ltp >= spot) {
      console.warn(`[sendIntradayAlerts] ${symbol} ${strike} ${optionType} ltp ${ltp} ≥ spot ${spot} — not a premium, ignoring`);
      return 0;
    }
    return ltp;
  } catch {
    return 0;
  }
}

/** Normalise an expiry label to YYYY-MM-DD ("27-Oct-2026" → "2026-10-27"). */
export function expiryKey(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const months: Record<string, string> = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    const mm = months[m[2].toLowerCase()];
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

function sdmSignalToAlert(symbol: string, signal: any): any {
  const isCall = signal.direction === "CALL";
  if (signal.direction !== "CALL" && signal.direction !== "PUT") return null;
  if (!signal.entry || signal.entry <= 0) return null;
  if (!signal.strike || signal.strike <= 0) return null;
  // FAIL CLOSED on a plan that cannot be monitored: no stop / no target means
  // the trade would sit open forever (and the alert would print "₹undefined").
  if (!signal.sl || signal.sl <= 0) return null;
  if (!signal.tp1 || signal.tp1 <= 0) return null;
  // The stop must be on the correct side of the entry for a BUY.
  if (signal.sl >= signal.entry) return null;
  // An option premium can never be worth more than its underlying — that is
  // the underlying leaking into the option price.
  const spot = Number(signal?.marketContext?.spot || 0);
  if (spot > 0 && signal.entry >= spot) return null;

  const optionType = isCall ? "CE" : "PE";
  // The gate keeps the engine's own R:R bucket (unchanged behaviour); the
  // DISPLAYED R:R is computed from the entry/stop/TP1 the alert actually shows,
  // so the number and the levels can never disagree.
  const rrGate = signal.riskReward > 3 ? 4 : signal.riskReward > 2 ? 3 : signal.riskReward > 1 ? 2 : 1;
  const long = signal.tp1 > signal.entry;
  const risk = long ? signal.entry - signal.sl : signal.sl - signal.entry;
  const reward = long ? signal.tp1 - signal.entry : signal.entry - signal.tp1;
  const rr = risk > 0 ? Math.round((reward / risk) * 10) / 10 : 0;

  const reasons = (signal.whyThisTrade || [])
    .map((w: any) => `${w.label}: ${w.value}`)
    .join(" · ");
  const extra = signal.reason ? ` · ${signal.reason}` : "";

  const expiryLabel = signal.daysToExpiry
    ? signal.isExpiryDay ? "Expiry Today" : `${signal.daysToExpiry}d to expiry`
    : undefined;

  return {
    id: `opt-${symbol}-${Date.now()}`,
    kind: "option" as const,
    symbol,
    side: "BUY" as const,
    instrument: `${symbol} ${signal.strike} ${optionType}`,
    strike: signal.strike,
    optionType,
    entry: signal.entry,
    sl: signal.sl,
    tp1: signal.tp1,
    tp2: signal.tp2 || 0,
    tp3: signal.tp3,
    rr,
    rrGate,
    confidence: Math.round(signal.confidence || 50),
    rationale: reasons + extra || "SDM V2 engine recommendation",
    expiry: expiryLabel,
    // Real calendar expiry for the journal/gate (label is display-only above)
    expiryDate: toIsoExpiry(signal.expiryDate || signal.selectedExpiry) || undefined,
    spot: spot || undefined,
    generatedAt: new Date().toISOString(),
    greeks: signal.greeks || null,
    dataSource: signal?.dataHealth?.source || signal?.source || "unknown",
  };
}

function formatSDMMessage(alert: any): string {
  const isCall = alert.optionType === "CE";
  const emoji = isCall ? "🟢" : "🔴";
  const direction = isCall ? "Bullish" : "Bearish";
  const pnlRisk = alert.entry > 0 ? Math.abs((alert.entry - alert.sl) / alert.entry * 100).toFixed(1) : "—";
  const pnlReward = alert.entry > 0 ? Math.abs((alert.tp1 - alert.entry) / alert.entry * 100).toFixed(1) : "—";

  // Greeks section
  const g = alert.greeks;
  const greeksLine = g && (g.delta || g.gamma || g.theta || g.vega)
    ? `\nΔ ${g.delta?.toFixed(2) || "—"} · Γ ${g.gamma?.toFixed(4) || "—"} · Θ ${g.theta?.toFixed(2) || "—"} · ν ${g.vega?.toFixed(2) || "—"} · IV ${g.iv?.toFixed(1) || "—"}%`
    : "";

  return `⚡ SDM Signal — ${alert.symbol}

${emoji} ${alert.side} ${alert.instrument}
${direction} | Confidence: ${alert.confidence}%

Strike: ${fmtStrike(alert.strike)} ${alert.optionType} ${alert.expiry ? `| ${alert.expiry}` : ""}
Entry: ₹${tickPx(alert.entry)}
Stop: ₹${tickPx(alert.sl)} (${pnlRisk}% risk)
Target 1: ₹${tickPx(alert.tp1)} (${pnlReward}% gain)
${alert.tp2 ? `Target 2: ₹${tickPx(alert.tp2)}` : ''}
${alert.tp3 ? `Target 3: ₹${tickPx(alert.tp3)}` : ''}
R:R 1:${alert.rr}${greeksLine}

${alert.rationale}
📡 Data: SDM V2 · ${alert.dataSource || "unknown"}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
`;
}

/** Age of a chain in minutes (null when unknown). */
export function chainAgeMinutes(chainAsOf?: string): number | null {
  if (!chainAsOf) return null;
  const t = Date.parse(chainAsOf);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 60000;
}

/** A plan built on a chain older than this is not a trade (fail closed). */
export function isChainFresh(chainAsOf?: string, maxMinutes = 15): boolean {
  const age = chainAgeMinutes(chainAsOf);
  if (age == null) return true;         // unknown age → not provably stale
  return age <= maxMinutes;
}

/** Single-flight lock: only one scan at a time. */
let scanInFlight = false;

/** Watchdog fires at most once per trading day. Resets on IST date change. */
let watchdogSentToday = false;
let watchdogDateKey = "";

function watchdogShouldSend(key: string): boolean {
  if (watchdogDateKey !== key) {
    watchdogDateKey = key;
    watchdogSentToday = false;
  }
  return !watchdogSentToday;
}

function markWatchdogSent(): void {
  watchdogSentToday = true;
}

/** Run up to `concurrency` async tasks concurrently. Each item is processed
 * exactly once; results are returned in the same order as items. */
async function boundedConcurrency<T>(items: any[], concurrency: number, fn: (item: any) => Promise<T>, checkDeadline?: () => boolean): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let i = 0;
  
  async function worker() {
    while (i < items.length) {
      if (checkDeadline && checkDeadline()) {
        console.log("[scan] deadline reached in worker, stopping");
        return;
      }
      const idx = i++;
      try {
        results[idx] = await fn(items[idx]);
      } catch (e) {
        results[idx] = e as any;
      }
    }
  }
  
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  
  return results;
}

export async function sendIntradayAlerts(): Promise<{ ran: boolean; newAlerts: number }> {
  if (!isAlertsOwner()) {
    console.log('[alerts-owner] sendIntradayAlerts suppressed — ALERTS_OWNER is not "true"');
    return { ran: false, newAlerts: 0 };
  }
  if (scanInFlight) {
    console.log("[scan] already in flight, skipping");
    return { ran: false, newAlerts: 0 };
  }
  scanInFlight = true;
  try {
    return await sendIntradayAlertsInner();
  } finally {
    scanInFlight = false;
  }
}

async function sendIntradayAlertsInner(): Promise<{ ran: boolean; newAlerts: number }> {
  const scanStartMs = Date.now();
  const startTime = new Date(scanStartMs).toISOString();
  const SCAN_DEADLINE_MS = 100000; // 100 seconds

  const checkDeadline = (): boolean => {
    if (Date.now() - scanStartMs > SCAN_DEADLINE_MS) {
      console.log("[scan] deadline reached (" + SCAN_DEADLINE_MS + "ms), stopping");
      return true;
    }
    return false;
  };

  // Milliseconds left of the single scan budget. Every sub-step that can block
  // on the network (the stock scanner, the watchdog) draws from this, so the
  // whole request stays inside SCAN_DEADLINE_MS instead of each step carrying
  // its own independent timeout.
  const remainingBudgetMs = (): number =>
    Math.max(0, SCAN_DEADLINE_MS - (Date.now() - scanStartMs));

  if (!isTelegramSendWindow()) {
      console.error("[sendIntradayAlerts] outside 09:10-15:30 IST window — skipping");
    return { ran: false, newAlerts: 0 };
  }
  if (DIGEST_CHAT_IDS.length === 0) {
    console.error("[sendIntradayAlerts] TELEGRAM_DIGEST_CHAT_IDS not set — nowhere to send");
    return { ran: false, newAlerts: 0 };
  }

  const symbolList = ALL_SYMBOLS.filter(sym => !hasActiveTrade(sym));
  console.log("[scan] start ts=" + startTime + " symbols=" + symbolList.length);

  // Scan statistics for structured logging
  const scanStats = {
    symbolsScanned: symbolList.length,
    candidates: 0,
    deduped: 0,
    sent: 0,
    errors: 0,
    perSymbolMs: [] as number[],
    rejected: [] as { symbol: string; strike: number; type: string; expiry: string | null; source: string; oi: number | null; volume: number | null; reason: string }[],
  };

  // 1. Check active trades for SL/TP hits. The event is claimed/sent BEFORE
  // the status update; a failed send leaves the trade monitored for retry.
  let newAlerts = 0;
  await checkSLTP(
    (sym, strike, type, expiry) => getCurrentOptionPrice(sym, strike, type, expiry),
    async (trade, hit, fill) => {
      const result = await sendTradeEvent({
        tradeId: trade.id,
        eventType: hit,
        targetLevel: fill,
        symbol: trade.symbol,
        action: trade.side,
        strike: trade.strike,
        optionType: trade.optionType,
        entry: trade.entry,
        stopLoss: trade.sl,
        target1: trade.tp1,
        target2: trade.tp2,
        target3: trade.tp3,
        confidence: trade.confidence,
        source: trade.source,
        expiry: trade.expiry,
      });
      if (result.sent && !result.alreadySent) newAlerts++;
      return result.sent;
    }
  );

  // 2. Filter symbols — skip those with active trades
  const symbolsToScan = symbolList;
  if (symbolsToScan.length === 0) {
    console.log("[scan] end ts=" + new Date(Date.now()).toISOString() + " ran=true newAlerts=" + newAlerts + " skipped=noSymbols");
    scanInFlight = false;
    // Log scan summary for no-symbols case
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      event: "scan_summary",
      marketOpen: isTradingDay(new Date()),
      symbolsScanned: scanStats.symbolsScanned,
      perSymbolMs: scanStats.perSymbolMs,
      candidates: scanStats.candidates,
      deduped: scanStats.deduped,
      sent: newAlerts,
      errors: scanStats.errors,
      rejected: scanStats.rejected,
    }));
    scanInFlight = false;
    return { ran: true, newAlerts };
  }

  // 3. Fetch SDM V2 recommendations for each symbol (both CE and PE, weekly + monthly)
  const candidates: { symbol: string; alert: any }[] = [];

  // Collect all scan tasks (symbol × direction × expiry) then run with bounded concurrency
  const scanTasks: { symbol: string; direction: string; expiry?: string }[] = [];
  for (const sym of symbolsToScan) {
    const monthlyExpiry = getNextMonthlyExpiry(sym);
    for (const direction of ['CALL', 'PUT'] as const) {
      for (const expiryOpt of [null, monthlyExpiry?.date]) {
        scanTasks.push({ symbol: sym, direction, expiry: expiryOpt ?? undefined });
      }
    }
  }

  // Run fetchAndPushSignal with bounded concurrency (5 at a time), deadline enforced
  await boundedConcurrency(scanTasks, 5, async (task) => {
    if (checkDeadline()) {
      console.log("[scan] deadline reached, stopping scan");
      return;
    }
    const taskStartMs = Date.now();
    await fetchAndPushSignal(task.symbol, task.direction, candidates, task.expiry);
    scanStats.perSymbolMs.push(Date.now() - taskStartMs);
  });

  // Sort by confidence descending
  candidates.sort((a, b) => (b.alert.confidence || 0) - (a.alert.confidence || 0));
  scanStats.candidates = candidates.length;
  const topCandidates = candidates.slice(0, 12);

  // Log per-strike rejection reasons before sending
  for (const c of candidates) {
    const rec = c.alert;
    if (!rec.entry || rec.entry <= 0) {
      const strike = c.alert.strike || 0;
      const type = c.alert.optionType || '?';
      const expiry = c.alert.expiry || null;
      scanStats.rejected.push({ symbol: c.symbol, strike, type, expiry, source: 'sdm-signal', oi: null, volume: null, reason: 'entry missing/zero' });
      console.log("[reject] " + c.symbol + " " + strike + " " + type + " expiry=" + (c.alert.expiry || '?') + " source=sdm-signal reason=\"entry missing/zero\" OI=? volume=?");
      continue;
    }
    if (!rec.stopLoss || rec.stopLoss <= 0) {
      const strike = c.alert.strike || 0;
      const type = c.alert.optionType || '?';
      const expiry = c.alert.expiry || null;
      scanStats.rejected.push({ symbol: c.symbol, strike, type, expiry, source: 'sdm-signal', oi: null, volume: null, reason: 'missing stop' });
      console.log("[reject] " + c.symbol + " " + strike + " " + type + " expiry=" + (c.alert.expiry || '?') + " source=sdm-signal reason=\"missing stop\" OI=? volume=?");
      continue;
    }
    if (!rec.tp1 || rec.tp1 <= 0) {
      const strike = c.alert.strike || 0;
      const type = c.alert.optionType || '?';
      const expiry = c.alert.expiry || null;
      scanStats.rejected.push({ symbol: c.symbol, strike, type, expiry, source: 'sdm-signal', oi: null, volume: null, reason: 'missing TP1' });
      console.log("[reject] " + c.symbol + " " + strike + " " + type + " expiry=" + (c.alert.expiry || '?') + " source=sdm-signal reason=\"missing TP1\" OI=? volume=?");
      continue;
    }
    if (rec.sl >= rec.entry) {
      const strike = c.alert.strike || 0;
      const type = c.alert.optionType || '?';
      const expiry = c.alert.expiry || null;
      scanStats.rejected.push({ symbol: c.symbol, strike, type, expiry, source: 'sdm-signal', oi: null, volume: null, reason: 'stop not below entry' });
      console.log("[reject] " + c.symbol + " " + strike + " " + type + " expiry=" + (c.alert.expiry || '?') + " source=sdm-signal reason=\"stop not below entry\" OI=? volume=?");
      continue;
    }
  }

  // 4. Send index-level SDM alerts
  let alertsSent = 0;
  for (const c of topCandidates) {
    const signature = buildSignature(c.symbol, c.alert);
    if (alreadySentToday(signature)) continue;

    const text = formatSDMMessage(c.alert);
    const sent = await sendTradeAlert({
      symbol: c.symbol,
      action: c.alert.side || "BUY",
      strike: c.alert.strike || 0,
      type: c.alert.optionType || "CE",
      confidence: c.alert.confidence,
      entry: c.alert.entry,
      stopLoss: c.alert.sl,
      target1: c.alert.tp1,
      target2: c.alert.tp2,
      source: "sdm-v2-engine",
      instrument: c.alert.optionType === "PE" ? "PUT" : "CALL",
      expiry: c.alert.expiryDate,
      spot: c.alert.spot,
      requireExpiry: true,
      strategy: "sdm-v2-engine",
      expectsTrade: true,
      message: text,
      register: async () => addTrade({
        id: c.alert.id,
        symbol: c.symbol,
        side: c.alert.side,
        instrument: c.alert.instrument,
        strike: c.alert.strike || 0,
        optionType: c.alert.optionType || "",
        entry: c.alert.entry,
        sl: c.alert.sl,
        tp1: c.alert.tp1,
        tp2: c.alert.tp2,
        status: "ACTIVE",
        sentAt: new Date().toISOString(),
        source: "sdm-v2-engine",
        confidence: c.alert.confidence,
        expiry: c.alert.expiryDate || undefined,
        spotPrice: c.alert.spot || undefined,
      }, true),
    });

    if (sent) {
        markSentToday(signature);
        // Migration: also record executed intraday trades to Trade Audit sidecar.
        await recordIntradayTrade({
          id: c.alert.id,
          symbol: c.symbol,
          optionType: (c.alert.optionType as "CE" | "PE") || "CE",
          strike: c.alert.strike || 0,
          entry: c.alert.entry,
          stopLoss: c.alert.sl,
          tp1: c.alert.tp1,
          tp2: c.alert.tp2,
          confidence: c.alert.confidence,
          reason: c.alert.rationale,
          source: "sdm-v2-engine",
        });

        // Record in Agent Signal Lifecycle
        try {
          let sdmAgent = getAgentByName('SDM_ENGINE');
          if (!sdmAgent) {
            sdmAgent = registerAgent({
              name: 'SDM_ENGINE',
              type: 'SMDAPP_ENGINE',
              version: '2.0',
              description: 'SDM V2 Scoring Engine',
            });
          }
          const optionType = (c.alert.optionType as 'CE' | 'PE') || 'CE';
          const signal = createSignal({
            agentId: sdmAgent.id,
            market: 'INDIA',
            exchange: 'NFO',
            underlying: c.symbol,
            signalType: 'FINAL',
            direction: optionType === 'CE' ? 'BUY_CE' : 'BUY_PE',
            optionType,
            strike: c.alert.strike || undefined,
            entryPrice: c.alert.entry,
            stopLoss: c.alert.sl,
            target1: c.alert.tp1,
            target2: c.alert.tp2,
            confidence: (c.alert.confidence || 0) / 100,
            thesis: c.alert.rationale || 'SDM V2 signal',
            evidence: {},
            dataSource: 'SDM_V2',
            dataFreshness: 'LIVE',
          });
          transitionSignal(signal.id, 'CANDIDATE');
          transitionSignal(signal.id, 'VALIDATING');
          transitionSignal(signal.id, 'VALIDATED');
          transitionSignal(signal.id, 'FINAL');
          transitionSignal(signal.id, 'ACTIVE');
        } catch {
          // Non-critical
        }

        newAlerts++;
        alertsSent++;
      }
  }

  // 5. Stock scanner alerts — monthly expiry, confidence ≥ 80%
  // Shares the single scan budget: it gets whatever is LEFT of the 100s
  // deadline instead of its own 120s timeout. Worst case stays ≈100s, so the
  // request can never approach the 15-minute cron's service timeout.
  try {
    const stockBudgetMs = remainingBudgetMs();
    if (stockBudgetMs < 5000) {
      console.log("[scan] stock scanner skipped — only " + stockBudgetMs + "ms left of the scan budget");
    } else {
    const scannerRes = await fetch(
      `${BASE}/api/scanner?symbol=NIFTY`,
      { cache: "no-store", signal: AbortSignal.timeout(stockBudgetMs) }
    );
    if (scannerRes.ok) {
      const scannerJson = await scannerRes.json();
      const scanData = scannerJson?.data;
      if (scanData?.candidates) {
        // A tradeable scanner alert needs: a real option plan, a strong score,
        // a sane plan, AND the unified gate to pass (TRADE decision or gates passed).
        // The old gate was totalScore ≥ 60 with no R:R or unified check.
        const dataQualityOk = scanData.dataQuality === "LIVE";
        const highConfStocks = scanData.candidates.filter((s: any) => {
          const opt = s.monthlyOptionTrade;
          if (!opt || !(opt.premium > 0)) return false;
          if ((s.totalScore ?? 0) < 60) return false;
          if (!dataQualityOk) return false;
          // Unified gate: only alert when the unified scorer approves.
          const unifiedOk = s.unifiedDecision === "TRADE" || s.hardGatesPassed === true;
          if (!unifiedOk) return false;
          // SIGNED R:R (R1): risk = premium − stop (>0 for valid long plans),
          // reward = target1 − premium (>0 for valid long plans). A wrong-side
          // stop or target yields rr 0 instead of being Math.abs'd into a
          // plausible value that passes the gate.
          const risk = opt.premium - opt.stopLoss;
          const reward = (opt.targets?.[0] ?? 0) - opt.premium;
          const rr = risk > 0 && reward > 0 ? reward / risk : 0;
          return rr >= 1.5;
        });

        for (const stock of highConfStocks) {
          const opt = stock.monthlyOptionTrade;
          // Fail closed on a stale chain: a plan built on an old premium is not a
          // trade. (The chain age is what "which data?" means in practice.)
          const chainAgeMin = chainAgeMinutes((opt as any)?.chainAsOf);
          if (!isChainFresh((opt as any)?.chainAsOf)) {
            console.warn(`[sendIntradayAlerts] skip ${stock.symbol} — chain ${chainAgeMin!.toFixed(0)}m old`);
            continue;
          }
          // Fail closed on an implausible plan: the premium must be a real
          // option premium (never the underlying's price) and the stop must sit
          // on the correct side of the entry.
          if (!isPlausibleOptionPlan(stock, opt)) {
            console.warn(`[sendIntradayAlerts] skip ${stock.symbol} — implausible option plan (premium ₹${opt?.premium} / stop ₹${opt?.stopLoss})`);
            continue;
          }
          const sig = `${stock.symbol}|${opt.strike}|${opt.optionType}|BUY|stock-scanner`;
          if (alreadySentToday(sig)) continue;

          const chainSrc = (opt as any)?.chainSource || scanData?.dataSources?.chain;
          const chainAge = (opt as any)?.chainAsOf
            ? ` (${Math.max(0, Math.round((Date.now() - Date.parse((opt as any).chainAsOf)) / 60000))}m ago)`
            : "";
          const text = formatStockOptionAlert(stock, opt, {
            ...(scanData?.dataSources || {}),
            chain: chainSrc ? `${chainSrc}${chainAge}` : undefined,
          });
          const ymd = new Date().toLocaleDateString('en-CA').replace(/-/g, '');
          const tradeId = `SCAN-INTRA-${stock.symbol}-${opt.strike}-${opt.optionType}-${opt.expiry ?? 'NOEXP'}-${ymd}`;
          const sent = await sendTradeAlert({
            symbol: stock.symbol,
            action: "BUY",
            strike: opt.strike,
            type: opt.optionType,
            confidence: stock.totalScore ?? 0,
            entry: opt.premium,
            stopLoss: opt.stopLoss,
            target1: opt.targets[0] || opt.premium,
            target2: opt.targets[1] || opt.targets[0] || opt.premium,
            source: "stock-scanner",
            instrument: opt.optionType === "PE" ? "PUT" : "CALL",
            expiry: expiryKey(opt.expiry) || undefined,
            spot: Number(stock.spot || stock.ltp || 0) || undefined,
            requireExpiry: true,
            strategy: "stock-scanner",
            expectsTrade: true,
            message: text,
            register: async () => addTrade({
              id: tradeId,
              symbol: stock.symbol,
              side: "BUY",
              instrument: `${stock.symbol} ${opt.strike} ${opt.optionType}`,
              strike: opt.strike,
              optionType: opt.optionType,
              entry: opt.premium,
              sl: opt.stopLoss,
              tp1: opt.targets[0] || opt.premium,
              tp2: opt.targets[1] || opt.targets[0] || opt.premium,
              tp3: opt.tp3 ?? opt.targets[2],
              status: "ACTIVE",
              sentAt: new Date().toISOString(),
              source: "stock-scanner",
              expiry: expiryKey(opt.expiry) || undefined,
              confidence: stock.totalScore,
              spotPrice: Number(stock.spot || stock.ltp || 0) || undefined,
            }, true),
          });

          if (sent) {
            markSentToday(sig);
            // Migration: also record executed intraday trades to Trade Audit sidecar.
            await recordIntradayTrade({
              id: tradeId,
              symbol: stock.symbol,
              optionType: (opt.optionType as "CE" | "PE") || "CE",
              strike: opt.strike,
              entry: opt.premium,
              stopLoss: opt.stopLoss,
              tp1: opt.targets[0] || opt.premium,
              tp2: opt.targets[1] || opt.targets[0] || opt.premium,
              tp3: opt.tp3 ?? opt.targets[2],
              confidence: stock.totalScore,
              reason: (stock.reasons || []).slice(0, 3).join(" · "),
              source: "stock-scanner",
            });
            newAlerts++;
          }
        }
      }
    }
    }
  } catch {
    // Non-blocking — stock scanner may time out
  }

  const scanEndMs = Date.now();
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event: "scan_summary",
    marketOpen: isTradingDay(new Date()),
    symbolsScanned: scanStats.symbolsScanned,
    candidates: scanStats.candidates,
    deduped: scanStats.deduped,
    sent: newAlerts,
    errors: scanStats.errors,
    rejected: scanStats.rejected,
    perSymbolMs: scanStats.perSymbolMs,
  }));

  // ── Watchdog: if no alert was sent by 11:30 IST on a trading day, alert via Telegram
  const watchdogHour = 11;
  const watchdogMinute = 30;
  const watchdogMins = watchdogHour * 60 + watchdogMinute;
  const nowIST = new Date(Date.now() + 5.5 * 3600 * 1000);
  const nowMins = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();
  const todayIst = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().split("T")[0];
  const todayIsHoliday = NSE_HOLIDAYS.has(todayIst);
  const isWeekend = nowIST.getUTCDay() === 0 || nowIST.getUTCDay() === 6;
  const isTradingDayToday = !isWeekend && !todayIsHoliday;

  if (newAlerts === 0 && isTradingDayToday && nowMins >= watchdogMins && watchdogShouldSend(todayIst)) {
    markWatchdogSent();
    console.warn("[sendIntradayAlerts] WATCHDOG: No alerts sent by 11:30 IST on trading day " + todayIst);
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChatId = process.env.TELEGRAM_CHAT_ID;
    if (tgToken && tgChatId) {
      try {
        const diag = `scanned ${scanStats.symbolsScanned} symbols · ${scanStats.candidates} candidates · ${scanStats.sent} sent · ${scanStats.errors} errors · ${scanStats.rejected.length} rejected`;
        const watchdogMsg = "🚨 <b>SDM Alert Watchdog</b>\n\nNo trade alerts sent by 11:30 IST on " + todayIst + " (trading day).\n\n" + diag + ".\n\nNo qualifying setups: SDM index signals are below the confidence floor and stock-scanner plans are below the unified gate / per-trade deployment cap. Provider and signal health: check /api/health and /api/sdm-signal logs. This watchdog fires once per trading day.";
        await fetch("https://api.telegram.org/bot" + tgToken + "/sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: tgChatId, text: watchdogMsg, parse_mode: "HTML" }),
          // Draw from the scan budget (floor 3s so the watchdog still fires
          // when the budget is exhausted) — never an extra independent 10s.
          signal: AbortSignal.timeout(Math.min(10000, Math.max(3000, remainingBudgetMs()))),
        });
      } catch (e) {
        console.error("[sendIntradayAlerts] Watchdog alert failed: " + String(e));
      }
    }
  }

  scanInFlight = false;
  return { ran: true, newAlerts };
}

/** One line that says exactly where the numbers came from. */
function describeSources(sources?: { daily?: string; intraday?: string; quotes?: string; chain?: string }): string {
  if (!sources) return "scanner (source label unavailable)";
  const parts: string[] = [];
  if (sources.quotes) parts.push(`quotes ${sources.quotes}`);
  if (sources.daily) parts.push(`daily ${sources.daily}`);
  if (sources.intraday && sources.intraday !== "none") parts.push(`5m ${sources.intraday}`);
  if (sources.intraday === "none") parts.push("5m UNAVAILABLE (no intraday feed)");
  if (sources.chain) parts.push(`chain ${sources.chain}`);
  else parts.push("chain UNKNOWN");
  return parts.join(" · ") || "scanner";
}

/**
 * Fail closed on a plan that is not a trade:
 *   • the premium must be a real option premium — an option can never be worth
 *     more than its underlying, so a premium ≥ the underlying's price is the
 *     underlying leaking into the option price (the live "BHARTIARTL — PE /
 *     Strike 1875.2 / Entry ₹1875.20" contract that never existed),
 *   • the stop must sit on the opposite side of the entry from the target,
 *   • every level must be present.
 */
export function isPlausibleOptionPlan(stock: any, opt: any): boolean {
  const premium = Number(opt?.premium);
  const sl = Number(opt?.stopLoss);
  const tp1 = Number(opt?.targets?.[0]);
  if (!(premium > 0) || !(sl > 0) || !(tp1 > 0)) return false;
  if (tp1 === premium) return false;

  // The underlying's price, when the scanner knows it.
  const underlying = Number(stock?.currentPrice);
  if (underlying > 0 && premium >= underlying) return false;

  // The stop must be on the opposite side of the entry from the target.
  const long = tp1 > premium;
  if (long ? !(sl < premium) : !(sl > premium)) return false;
  return true;
}

export function formatStockOptionAlert(stock: any, opt: any, sources?: { daily?: string; intraday?: string; quotes?: string; chain?: string }): string {
  const isCall = opt.optionType === "CE";
  const emoji = isCall ? "🟢" : "🔴";
  // R:R must come from the OPTION's own plan (entry / stop / TP1) — the
  // underlying stock's riskReward is a different instrument's number and
  // produced values like "1:39.4" and "1:0.8" for the same 1:2 option plan.
  // The side comes from the plan GEOMETRY — the option letter lies. Since R1
  // every generated plan is long-geometry for BOTH letters (a bought PE has
  // its stop BELOW the entry); the SHORT branch stays for LEGACY mirrored
  // rows so their signed risk is still measured correctly.
  const premium = Number(opt.premium);
  const stopLoss = Number(opt.stopLoss);
  const tp1 = Number(opt.targets?.[0] ?? premium);
  const long = tp1 > premium;
  const risk = long ? premium - stopLoss : stopLoss - premium;
  const reward = long ? tp1 - premium : premium - tp1;
  const rr = risk > 0 ? `1:${(reward / risk).toFixed(1)}` : "—";
  const reasons = (stock.reasons || []).slice(0, 3).join(" · ") || "Scanner pick";
  const direction = isCall ? "Bullish" : "Bearish";
  const targets = (opt.targets || []).map((t: number, i: number) => `T${i + 1} ₹${tickPx(t)}`).join(" | ");

  return `📊 STOCK OPTION — ${stock.symbol}

${emoji} BUY ${opt.optionType} | ${stock.symbol} ${fmtStrike(opt.strike)}

📅 Monthly Expiry: ${opt.expiryLabel}
💰 Premium: ₹${tickPx(premium)}
🛑 Stop Loss: ₹${tickPx(stopLoss)}
🎯 ${targets}
📐 R:R ${rr}
⭐ Confidence: ${stock.totalScore}%
📈 ${direction} | ${reasons}
📡 Data: ${describeSources(sources)}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
`.trim();
}
