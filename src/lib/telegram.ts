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

function shortTermThrottle(key: string): boolean {
  const last = recentAlerts.get(key);
  if (last && Date.now() - last < SHORT_COOLDOWN_MS) return true;
  recentAlerts.set(key, Date.now());
  if (recentAlerts.size > 200) {
    const cutoff = Date.now() - 3600000;
    for (const [k, v] of recentAlerts) { if (v < cutoff) recentAlerts.delete(k); }
  }
  return false;
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

export async function sendTelegramMessage(text: string, chatId?: string): Promise<boolean> {
  // Hard gate: no Telegram output outside 09:10-15:30 IST (Mon-Fri).
  // Override for tests with TELEGRAM_ALLOW_OFFHOURS=1.
  if (!isTelegramSendWindow()) {
    console.warn("[Telegram] outside 09:10-15:30 IST window — suppressed send");
    return false;
  }
  const token = getBotToken();
  const cid = chatId || getChatId();
  if (!token || !cid) {
    console.warn("[Telegram] Bot token or chat ID not configured");
    return false;
  }
  try {
    const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cid,
        text,
        parse_mode: "HTML",
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("[Telegram] Send failed:", data.description);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error("[Telegram] Error:", err.message);
    return false;
  }
}

// Full-day dedup: check if same signal was sent today
export function checkTradeDedup(symbol: string, action: string, strike: number, type: string): boolean {
  const sig = buildSignalSignature({ symbol, strike, optionType: type, direction: action });
  if (isSignalAlreadySent(sig)) return true;
  // Also check short-term throttle
  return shortTermThrottle(sig);
}

export async function sendTradeAlert(params: {
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
    vetoWarn = BRAIN_FLAGS.tiering
      ? `\n🏷 Tier ${veto.tier}: ${veto.reasons.join("; ")}`
      : `\n⚠ ${veto.reasons.join("; ")} — halve size`;
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

  // Short-term throttle: also skip if sent within 5 minutes
  if (shortTermThrottle(sig)) {
    console.log(`[Telegram] Dedup (short-term): skipped ${sig} (sent <5min ago)`);
    return false;
  }

  const emoji = params.action.includes("BUY") ? "🟢" : "🔴";
  const sourceLabel = params.source || "SDM Engine";
  const mtfLine = (params.mtf
    ? `\n📐 MTF: ${params.mtf.direction} (${params.mtf.trendDirection} trend, score ${params.mtf.compositeScore})`
    : '') + vetoWarn;
  const msg = `
${emoji} <b>${sourceLabel}</b>

📊 <b>${params.symbol}</b> — ${params.type}
⚡ Action: <b>${params.action}</b>
🎯 Strike: <b>${params.strike.toLocaleString("en-IN")}</b>
💪 Confidence: <b>${params.confidence}%</b>${mtfLine}
${params.entry ? `💰 Entry: ₹${params.entry}` : ""}
${params.stopLoss ? `🛑 Stop Loss: ₹${params.stopLoss}` : ""}
${params.target1 ? `🎯 Target 1: ₹${params.target1}` : ""}
${params.target2 ? `🎯 Target 2: ₹${params.target2}` : ""}

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
  const msg = `
${emoji} <b>ML Signal — ${params.direction}</b>

📊 Symbol: <b>${params.symbol}</b>
💪 Confidence: <b>${params.confidence}%</b>
📝 Reasons:
${params.reasons.map((r, i) => `  ${i + 1}. ${r}`).join("\n")}

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
