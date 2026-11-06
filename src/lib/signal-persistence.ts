const TELEGRAM_API = "https://api.telegram.org/bot";

import { isTelegramSendWindow } from "./marketHours";
import {
  buildSignalSignature,
  isSignalAlreadySent,
  markSignalSent,
  isSignalDuplicateOrLowerQuality,
} from "./signalTracker";
import { evaluateSignalVeto } from "./signal-veto";
import { logCandidate, calibrationBandFor } from "./candidate-log";
import { cachedLayers } from "./tech-cache";
import { structureLayer, triggerLayer } from "./tech-read";
import { BRAIN_FLAGS } from "./brain-flags";
import { checkSignalRiskLimits } from "./risk-state.server";

/** Option R:R from the alert's own levels (never from a ledger field). */
function rrOf(entry?: number, sl?: number, tp?: number, action?: string): number | null {
  if (entry == null || sl == null || tp == null) return null;
  const buy = String(action || "").toUpperCase().includes("BUY");
  const rr = buy ? (tp - entry) / (entry - sl) : (entry - tp) / (sl - entry);
  return Number.isFinite(rr) ? rr : null;
}

// Short-term throttle: prevent sending same signal within 5 minutes
const recentAlerts = new Map<string, number>();
const SHORT_COOLDOWN_MS = 5 * 60 * 1000;

/** Read-only: true when `key` is within the short-term cooldown window. */
export function isThrottled(key: string): boolean {
  const last = recentAlerts.get(key);
  return Boolean(last && Date.now() - last < SHORT_COOLDOWN_MS);
}

/** Sets the throttle timestamp for `key` and prunes stale entries. Call only
 *  after a successful send. */
export function markThrottle(key: string): void {
  recentAlerts.set(key, Date.now());
  if (recentAlerts.size > 200) {
    const cutoff = Date.now() - 3600000;
    for (const [k, v] of recentAlerts) { if (v < cutoff) recentAlerts.delete(k); }
  }
}

function getBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN || "";
}

function getChatId(): string {
  return process.env.TELEGRAM_CHAT_ID || "";
}

export async function verifyTelegramBot(): Promise<{ ok: boolean; username?: string; description?: string }> {
  const token = getBotToken();
  if (!token) {
    return { ok: false, description: "TELEGRAM_BOT_TOKEN not configured" };
  }
  try {
    const res = await fetch(`${TELEGRAM_API}${token}/getMe`);
    const data = await res.json();
    if (!data.ok) {
      return { ok: false, description: data.description || "getMe failed" };
    }
    return { ok: true, username: data.result?.username };
  } catch (err: any) {
    return { ok: false, description: err?.message || "network error" };
  }
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export { escapeHtml };

/** Strip Telegram HTML tags and unescape entities for a plain-text retry. */
function stripHtmlTags(text: string): string {
  return text
    .replace(/<\/?(b|i|u|s|code|pre|a|strong|em)\b[^>]*>/gi, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const PARSE_ERROR_HINTS = ["can't parse entities", "parse error", "bad message", "invalid", "telegram"];
function isParseError(description: string | undefined): boolean {
  const d = (description || "").toLowerCase();
  return PARSE_ERROR_HINTS.some((h) => d.includes(h));
}

export async function sendTelegramMessage(text: string, chatId?: string): Promise<boolean> {
  // Hard gate: no Telegram output outside 09:10-15:30 IST (Mon-Fri).
  // Override for tests with TELEGRAM_ALLOW_OFFHOURS=1.
  if (!isTelegramSendWindow()) {
    console.warn("[Telegram] outside 09:10-15:30 IST window — suppressed send");
    return false;
  }
  const token = getBotToken();
  const cid = chatId || getChatId();
  const missing: string[] = [];
  if (!token) missing.push("TELEGRAM_BOT_TOKEN");
  if (!cid) missing.push("TELEGRAM_CHAT_ID");
  if (missing.length > 0) {
    console.warn(`[Telegram] Not configured — missing: ${missing.join(", ")}`);
    return false;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  const sendOnce = async (payloadText: string): Promise<boolean> => {
    try {
      const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: cid,
          text: payloadText,
          parse_mode: "HTML",
        }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!data.ok) {
        const desc = data.description || "";
        const error_code = data.error_code;
        if (error_code === 429) {
          console.error(`[Telegram] Rate limited (429), retry_after=${data.parameters?.retry_after ?? "unknown"}`);
        } else if (isParseError(desc)) {
          console.warn("[Telegram] HTML parse error — retrying as plain text");
          // Retry once as plain text
          const plain = stripHtmlTags(payloadText);
          const res2 = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: cid,
              text: plain,
            }),
            signal: controller.signal,
          });
          const data2 = await res2.json();
          if (!data2.ok) {
            console.error("[Telegram] Send failed:", data2.description);
            return false;
          }
          return true;
        } else {
          console.error("[Telegram] Send failed:", desc);
        }
        return false;
      }
      return true;
    } catch (err: any) {
      if (err.name === "AbortError") {
        console.error("[Telegram] Send timed out after 15s");
      } else {
        console.error("[Telegram] Error:", err.message);
      }
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  try {
    return await sendOnce(text);
  } finally {
    clearTimeout(timeoutId);
  }
}

// Full-day dedup: check if same signal was sent today (read-only — no side
// effects; the throttle timestamp is recorded only after a successful send).
export function checkTradeDedup(symbol: string, action: string, strike: number, type: string): boolean {
  const sig = buildSignalSignature({ symbol, strike, optionType: type, direction: action });
  if (isSignalAlreadySent(sig)) return true;
  // Read-only throttle check — does not record a timestamp.
  return isThrottled(sig);
}

// In-flight guard: prevents concurrent sends of the same signal signature.
const inFlight = new Set<string>();

export async function sendTradeAlert(params: Parameters<typeof sendTradeAlertInner>[0]): Promise<boolean> {
  const sig = buildSignalSignature({
    symbol: params.symbol,
    strike: params.strike,
    optionType: params.type,
    direction: params.action,
  });
  if (inFlight.has(sig)) {
    console.log(`[Telegram] sendTradeAlert in-flight — skipping duplicate ${sig}`);
    return false;
  }
  inFlight.add(sig);
  try {
    return await sendTradeAlertInner(params);
  } catch (err: any) {
    console.log(`[Telegram] sendTradeAlert THREW ${sig}: ${err?.message || String(err)}`);
    return false;
  } finally {
    inFlight.delete(sig);
  }
}

/**
 * Inner implementation of sendTradeAlert — runs the full veto/risk/dedup
 * pipeline and sends the message. Called by the public sendTradeAlert
 * wrapper which adds the in-flight guard.
 */
export async function evaluateTradeGate(params: {
  symbol: string;
  action: string;
  optionType?: string;
  strike: number;
  entry: number;
  stopLoss: number;
  tp1: number;
  confidence: number;
  spot?: number;
  expiry?: string;
  requireExpiry?: boolean;
  requireSpot?: boolean;
  nowMs?: number;
  lots?: number;
  lotSize?: number;
  deployedAmount?: number;
  riskAmount?: number;
}): Promise<{ blocked: boolean; reasons: string[] }> {
  const reasons: string[] = [];

  // SAFETY: Option selling blocked — instrument-aware (options only)
  // SELL is valid for EQUITY and FUTURES
  const isOption = params.instrument === 'CALL' || params.instrument === 'PUT';
  if (isOption && params.action && (params.action.includes('SELL') || params.action.includes('SHORT'))) {
    reasons.push('option selling not allowed (' + params.action + ' on ' + params.instrument + ')');
    return { blocked: true, reasons };
  }

  // Calibration band for the stated confidence (cached, DB-free on the hot path).
  const calibrationBand = await calibrationBandFor(params.confidence);
  // Cached technical read — O(1), no network. Cold cache → warning, never a block.
  const optType = params.type === 'CE' || params.type === 'PE' ? params.type : undefined;
  const dir = optType === 'CE' ? 'call' : optType === 'PE' ? 'put' : undefined;
  const tech = dir
    ? cachedLayers(params.symbol, '15m', dir, structureLayer, triggerLayer)
    : undefined;
  // HYBRID veto: old brain (scanners / SDM / Zero Hero) generates candidates;
  // this layer only blocks or warns — it never creates signals.
  const veto = evaluateSignalVeto({
    symbol: params.symbol,
    action: params.action,
    optionType: optType,
    strike: params.strike,
    entry: params.entry,
    stopLoss: params.stopLoss,
    tp1: params.target1,
    confidence: params.confidence,
    spot: params.spot,
    expiry: params.expiry,
    source: params.source,
    requireExpiry: params.requireExpiry,
    requireSpot: params.requireSpot,
    nowMs: params.nowMs,
    calibrationBand,
    tech: tech
      ? { structure: tech.structure?.state, trigger: tech.trigger?.state, stale: tech.stale }
      : undefined,
  });
  if (veto.suppress) {
    reasons.push(...veto.reasons);
    return { blocked: true, reasons };
  }

  const riskCheck = await checkSignalRiskLimits({
    symbol: params.symbol,
    entry: params.entry ?? null,
    stopLoss: params.stopLoss ?? null,
    lots: params.lots ?? null,
    lotSize: params.lotSize ?? null,
    deployedAmount: params.deployedAmount ?? null,
    riskAmount: params.riskAmount ?? null,
    nowMs: params.nowMs,
  });
  if (riskCheck.blocked) {
    reasons.push(...riskCheck.reasons);
    return { blocked: true, reasons };
  }

  return { blocked: false, reasons: [] };
}

export async function sendTradeAlertInner(params: {
  symbol: string;
  action: string;
  strike: number;
  type: string;
  confidence: number;
  entry?: number;
  stopLoss?: number;
  target1?: number;
  target2?: number;
  source?: string;
  instrument?: string;  // 'CALL' | 'PUT' | 'FUTURES' | 'EQUITY' — for SELL safety
  spot?: number;        // UNDERLYING level (never the option premium) — enables delta/OTM checks
  expiry?: string;      // YYYY-MM-DD — enables the expiry-day check
  requireExpiry?: boolean; // caller can supply expiry → absence fails closed
  requireSpot?: boolean;   // caller can supply spot → absence fails closed
  underlyingStop?: number;
  underlyingTarget?: number;
  /** Cash-equity entry ZONE (weekly scanner) — shown instead of a single price. */
  entryZone?: { low: number; high: number };
  /**
   * The caller's REAL exposure. Cash-equity producers state their share
   * count (lotSize 1 = one share, lots = shares) so the risk check prices the
   * candidate as cash — without it the check falls back to the symbol master's
   * F&O lot size and sizes a ₹2,700 share as a ₹27,000 futures lot.
   */
  lots?: number;
  lotSize?: number;
  deployedAmount?: number;
  riskAmount?: number;
  nowMs?: number;            // clock seam for session rules (replay/tests pin it)
  mtf?: {
    direction: string;
    compositeScore: number;
    confidence: number;
    trendDirection: string;
    reasons: string[];
  } | null;
}): Promise<boolean> {
  // SAFETY: Option selling blocked — instrument-aware (options only)
  // SELL is valid for EQUITY and FUTURES
  const isOption = params.instrument === 'CALL' || params.instrument === 'PUT';
  if (isOption && params.action && (params.action.includes('SELL') || params.action.includes('SHORT'))) {
    console.log(`[Telegram] BLOCKED: ${params.symbol} — option selling not allowed (${params.action} on ${params.instrument})`);
    return false;
  }

  // Calibration band for the stated confidence (cached, DB-free on the hot path).
  const calibrationBand = await calibrationBandFor(params.confidence);
  // Cached technical read — O(1), no network. Cold cache → warning, never a block.
  const optType = params.type === "CE" || params.type === "PE" ? params.type : undefined;
  const dir = optType === "CE" ? "call" : optType === "PE" ? "put" : undefined;
  const tech = dir
    ? cachedLayers(params.symbol, "15m", dir, structureLayer, triggerLayer)
    : undefined;
  // HYBRID veto: old brain (scanners / SDM / Zero Hero) generates candidates;
  // this layer only blocks or warns — it never creates signals.
  const veto = evaluateSignalVeto({
    symbol: params.symbol,
    action: params.action,
    optionType: optType,
    strike: params.strike,
    entry: params.entry,
    stopLoss: params.stopLoss,
    tp1: params.target1,
    confidence: params.confidence,
    spot: params.spot,
    expiry: params.expiry,
    source: params.source,
    requireExpiry: params.requireExpiry,
    requireSpot: params.requireSpot,
    nowMs: params.nowMs,
    calibrationBand,
    tech: tech
      ? { structure: tech.structure?.state, trigger: tech.trigger?.state, stale: tech.stale }
      : undefined,
  });
  let vetoWarn = "";
  if (veto.suppress) {
    console.log(`[Telegram] VETO BLOCK ${params.symbol}: ${veto.reasons.join("; ")}`);
    // log the blocked candidate too (every candidate is logged, sent or not)
    void logCandidate({
      source: params.source || "unknown",
      symbol: params.symbol,
      direction: params.action,
      strike: params.strike,
      expiry: params.expiry ?? null,
      underlyingSpot: params.spot ?? null,
      entryPremium: params.entry ?? null,
      stopPremium: params.stopLoss ?? null,
      targetPremium: params.target1 ?? null,
      underlyingStop: params.underlyingStop ?? null,
      underlyingTarget: params.underlyingTarget ?? null,
      confidence: params.confidence,
      calibratedConfidence: veto.calibratedConfidence,
      rr: rrOf(params.entry, params.stopLoss, params.target1, params.action),
      gateVerdict: veto.verdict,
      tier: veto.tier,
      warnings: veto.warnings,
      fails: veto.fails,
      sent: false,
      wouldBlock: true,
    });
    return false;
  }
  if (veto.verdict === "WARN") {
    const safeReasons = veto.reasons.map((r) => escapeHtml(r)).join("; ");
    vetoWarn = BRAIN_FLAGS.tiering
      ? `\n🏷 Tier ${veto.tier}: ${safeReasons}`
      : `\n⚠ ${safeReasons} — halve size`;
  }

  // DAY-LOSS + CONCURRENT-EXPOSURE GATE (2026-10-20).
  // The scanner / Zero-Hero / master-bot / SDM paths all reach Telegram through
  // this funnel, so this is where the loss caps and the consecutive-loss rule
  // are enforced for EVERY producer — the same caps the agent's trade gate uses.
  // FAIL CLOSED: an unreadable risk state blocks the signal.
  const riskCheck = await checkSignalRiskLimits({
    symbol: params.symbol,
    entry: params.entry ?? null,
    stopLoss: params.stopLoss ?? null,
    lots: params.lots ?? null,
    lotSize: params.lotSize ?? null,
    deployedAmount: params.deployedAmount ?? null,
    riskAmount: params.riskAmount ?? null,
    nowMs: params.nowMs,
  });
  if (riskCheck.blocked) {
    console.log(`[Telegram] RISK BLOCK ${params.symbol}: ${riskCheck.reasons.join("; ")}`);
    void logCandidate({
      source: params.source || "unknown",
      symbol: params.symbol,
      direction: params.action,
      strike: params.strike,
      expiry: params.expiry ?? null,
      underlyingSpot: params.spot ?? null,
      entryPremium: params.entry ?? null,
      stopPremium: params.stopLoss ?? null,
      targetPremium: params.target1 ?? null,
      underlyingStop: params.underlyingStop ?? null,
      underlyingTarget: params.underlyingTarget ?? null,
      confidence: params.confidence,
      calibratedConfidence: params.confidence,
      rr: rrOf(params.entry, params.stopLoss, params.target1, params.action),
      gateVerdict: "SKIP",
      tier: "NONE",
      warnings: riskCheck.reasons,
      fails: riskCheck.reasons,
      sent: false,
      wouldBlock: true,
    });
    return false;
  }

  const sig = buildSignalSignature({
    symbol: params.symbol,
    strike: params.strike,
    optionType: params.type,
    direction: params.action,
  });

  // FULL-DAY dedup: skip if same signal sent today with >= confidence
  if (isSignalDuplicateOrLowerQuality(sig, params.confidence)) {
    console.log(`[Telegram] Dedup (full-day): skipped ${sig} — already sent with equal/higher confidence`);
    return false;
  }

  // Short-term throttle: also skip if sent within 5 minutes (read-only check;
  // the timestamp is recorded only after a successful send below).
  if (isThrottled(sig)) {
    console.log(`[Telegram] Dedup (short-term): skipped ${sig} (sent <5min ago)`);
    return false;
  }

  const emoji = params.action.includes("BUY") ? "🟢" : "🔴";
  const sourceLabel = escapeHtml(params.source || "SDM Engine");
  const isCashEquity = params.instrument === "EQUITY";
  // Cash prices read as rupees (₹2,709.20); option premiums keep the raw
  // premium format the option path has always used.
  const cashPx = (v?: number) =>
    v == null ? "" : `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const px = (v?: number) => (isCashEquity ? cashPx(v) : v == null ? "" : `₹${v}`);
  const mtfLine = (params.mtf
    ? `\n📐 MTF: ${escapeHtml(params.mtf.direction)} (${escapeHtml(params.mtf.trendDirection)} trend, score ${params.mtf.compositeScore})`
    : '') + vetoWarn;
  const msg = `
${emoji} <b>${sourceLabel}</b>

📊 <b>${escapeHtml(params.symbol)}</b> — ${isCashEquity ? "EQUITY" : escapeHtml(params.type)}
⚡ Action: <b>${escapeHtml(params.action)}</b>
${params.strike > 0 ? `🎯 Strike: <b>${params.strike.toLocaleString("en-IN")}</b>` : ""}
💪 Confidence: <b>${veto.calibratedConfidence}%</b>${veto.calibratedConfidence !== params.confidence ? ` <i>(stated ${params.confidence}%)</i>` : ""}${mtfLine}
${params.entryZone
  ? `💰 Entry: ${px(params.entry)} <i>(zone ₹${params.entryZone.low.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}–₹${params.entryZone.high.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</i>`
  : params.entry ? `💰 Entry: ${px(params.entry)}` : ""}
${params.stopLoss ? `🛑 Stop Loss: ${px(params.stopLoss)}` : ""}
${params.target1 ? `🎯 Target 1: ${px(params.target1)}` : ""}
${params.target2 && params.target2 !== params.target1 ? `🎯 Target 2: ${px(params.target2)}` : ""}
${isCashEquity && params.lots && params.deployedAmount
  ? `\n📦 Size: <b>${params.lots} shares</b> — ${cashPx(params.deployedAmount)} deployed, ${cashPx(params.riskAmount)} at risk`
  : ""}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
  `.trim();

  const sent = await sendTelegramMessage(msg);
  // every candidate that reached the send stage is logged (sent or not) — this is the
  // out-of-sample population the replay measures. Dedup-skipped duplicates are NOT
  // logged: they are the same signal, and would double-count the sample.
  void logCandidate({
    source: params.source || "unknown",
    symbol: params.symbol,
    direction: params.action,
    strike: params.strike,
    expiry: params.expiry ?? null,
    underlyingSpot: params.spot ?? null,
    entryPremium: params.entry ?? null,
    stopPremium: params.stopLoss ?? null,
    targetPremium: params.target1 ?? null,
    underlyingStop: params.underlyingStop ?? null,
    underlyingTarget: params.underlyingTarget ?? null,
    confidence: params.confidence,
    calibratedConfidence: veto.calibratedConfidence,
    rr: rrOf(params.entry, params.stopLoss, params.target1, params.action),
    gateVerdict: veto.verdict,
    tier: veto.tier,
    layerStates: tech
      ? { structure: tech.structure?.state ?? "unknown", trigger: tech.trigger?.state ?? "unknown", techStale: tech.stale }
      : null,
    warnings: veto.warnings,
    fails: veto.fails,
    sent,
    wouldBlock: veto.wouldBlock,
  });
  if (sent) {
    markSignalSent(sig, params.confidence, params.source || "sdm-engine");
    markThrottle(sig);
    // Voice output layer (fire-and-forget — never blocks the text alert or trading).
    // Central tap: all TRADE_SIGNAL producers flow through sendTradeAlert.
    void import("./voice/voiceService")
      .then(({ handleVoiceEvent }) =>
        handleVoiceEvent({
          eventType: "TRADE_SIGNAL",
          symbol: params.symbol,
          strike: params.strike,
          optionType: params.type === "CE" || params.type === "PE" ? params.type : undefined,
          side: params.action,
          confidence: params.confidence,
          entryPrice: params.entry,
          stopLoss: params.stopLoss,
          target: params.target1,
          source: params.source,
          timestamp: Date.now(),
        })
      )
      .catch(() => {});
  }
  return sent;
}

export async function sendSignalAlert(params: {
  direction: string;
  confidence: number;
  symbol: string;
  reasons: string[];
}): Promise<boolean> {
  const sig = buildSignalSignature({
    symbol: params.symbol,
    direction: params.direction,
  });

  // Full-day dedup for signals too
  if (isSignalDuplicateOrLowerQuality(sig, params.confidence)) {
    console.log(`[Telegram] Dedup: skipped signal ${sig}`);
    return false;
  }

  const emoji = params.direction === "BULLISH" ? "📈" : params.direction === "BEARISH" ? "📉" : "➡️";
  const safeDirection = escapeHtml(params.direction);
  const safeSymbol = escapeHtml(params.symbol);
  const safeReasons = params.reasons.map((r) => escapeHtml(r));
  const msg = `
${emoji} <b>ML Signal — ${safeDirection}</b>

📊 Symbol: <b>${safeSymbol}</b>
💪 Confidence: <b>${params.confidence}%</b>
📝 Reasons:
${safeReasons.map((r, i) => `  ${i + 1}. ${r}`).join("\n")}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
  `.trim();
  const sent = await sendTelegramMessage(msg);
  if (sent) {
    markSignalSent(sig, params.confidence, "ml-signal");
  }
  return sent;
}

export async function sendSystemAlert(message: string): Promise<boolean> {
  const msg = `🤖 <b>System Alert</b>\n\n${message}\n\n⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
  return sendTelegramMessage(msg);
}

/**
 * Voice message to Telegram (voice output layer).
 * Format: OGG/OPUS (converted by the TTS provider). No window gating here —
 * the voice service decides deliverability per event type.
 */
export async function sendTelegramVoice(audioPath: string, chatId?: string): Promise<boolean> {
  try {
    const token = getBotToken();
    if (!token) return false;
    const chat = chatId || getChatId();
    if (!chat) return false;
    const { readFile } = await import("fs/promises");
    const { basename } = await import("path");
    const buf = await readFile(audioPath);
    const form = new FormData();
    form.append("chat_id", chat);
    form.append(
      "voice",
      new File([new Uint8Array(buf)], basename(audioPath), {
        type: audioPath.endsWith(".ogg") ? "audio/ogg" : "audio/wav",
      })
    );
    const res = await fetch(`${TELEGRAM_API}${token}/sendVoice`, { method: "POST", body: form });
    const json: any = await res.json().catch(() => ({}));
    if (!json.ok) console.warn(`[Telegram] sendVoice failed: ${json.description || res.status}`);
    else console.log(`[Telegram] voice sent → ${basename(audioPath)}`);
    return !!json.ok;
  } catch (err: any) {
    console.warn(`[Telegram] sendVoice error: ${err.message}`);
    return false;
  }
}

export const CONF_FLOOR_CALL = CONFIG.confFloorCall; // 60 (0-100 scale)
export const CONF_FLOOR_PUT = CONFIG.confFloorPut; // 70 (0-100 scale)
