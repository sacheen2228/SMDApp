// Voice Notification Service — the ONLY place voice events become speech.
// Architecture (spec §26):  All systems → Event Bus / Alert Event → Voice Service → TTS.
// Voice NEVER feeds anything back into the decision pipeline (spec §12).
// Voice NEVER blocks trading (spec §19): synthesis is async in the queue.

import fs from "fs";
import path from "path";
import { loadVoiceSettings, type VoiceSettings } from "./voiceConfig";
import { formatVoiceEvent, type VoiceEvent, type VoiceEventType } from "./voiceFormatter";
import { VoiceQueue, buildDedupKey, voicePriority, type VoiceJob } from "./voiceQueue";
import { createProvider, type TTSProvider } from "./voiceProvider";
import { isTelegramSendWindow } from "@/lib/marketHours";
import type { HermesEvent } from "@/lib/hermes/event-bus";

// ─── Toggle map (spec §14) ────────────────────────────────────────
export const VOICE_TOGGLE: Record<VoiceEventType, keyof VoiceSettings> = {
  TRADE_SIGNAL: "tradeAlerts",
  TRADE_CONFIRMED: "entryAlerts",
  ENTRY: "entryAlerts",
  TP_HIT: "tpAlerts",
  SL_HIT: "slAlerts",
  NO_TRADE: "noTrade",
  WAIT: "noTrade",
  MARKET_BRIEFING: "marketBriefing",
  SYSTEM_START: "systemAlerts",
  SYSTEM_READY: "systemAlerts",
  MARKET_OPEN: "systemAlerts",
  MARKET_CLOSE: "systemAlerts",
  STRONG_BULLISH: "systemAlerts",
  STRONG_BEARISH: "systemAlerts",
  NEWS_ALERT: "systemAlerts",
  VOLATILITY_ALERT: "systemAlerts",
  SYSTEM_WARNING: "systemAlerts",
  SYSTEM_ERROR: "systemAlerts",
};

/** Events tied to market hours — telegram delivery respects the existing send window. */
export const MARKET_VOICE_EVENTS = new Set<VoiceEventType>([
  "TRADE_SIGNAL", "TRADE_CONFIRMED", "ENTRY", "TP_HIT", "SL_HIT", "NO_TRADE", "WAIT", "NEWS_ALERT",
]);

export type HandleResult = "disabled" | "off" | "no_text" | "queued" | "deduped" | "dropped";

// ─── Test seams (repo convention) ─────────────────────────────────
let providerOverride: TTSProvider | null = null;
let senderOverride: ((audioPath: string, text: string) => Promise<boolean>) | null = null;
let windowOverride: (() => boolean) | null = null;

export function __setVoiceProviderForTests(p: TTSProvider | null): void { providerOverride = p; }
export function __setVoiceSenderForTests(fn: ((audioPath: string, text: string) => Promise<boolean>) | null): void { senderOverride = fn; }
export function __setVoiceWindowForTests(fn: (() => boolean) | null): void { windowOverride = fn; }
export function __resetVoiceServiceForTests(): void {
  queue?.cancelPending();
  queue = null;
  started = false;
  providerOverride = null;
  senderOverride = null;
  windowOverride = null;
  directResolvers.clear();
}

/** Fresh queue = fresh dedup keys (simulates a new process / restart). */
export function __resetVoiceQueueForTests(): void {
  queue?.cancelPending();
  queue = null;
  directResolvers.clear();
}

// ─── Module state ─────────────────────────────────────────────────
let queue: VoiceQueue | null = null;
let started = false;
let unsubs: Array<() => void> = [];
// one-shot per-job resolvers for direct synthesis (test voice / briefing)
const directResolvers = new Map<string, (r: { audioPath?: string; error?: string }) => void>();

function settings(): VoiceSettings {
  return loadVoiceSettings();
}

function inSendWindow(): boolean {
  if (windowOverride) return windowOverride();
  try {
    return isTelegramSendWindow();
  } catch {
    return true;
  }
}

function deliverable(type: VoiceEventType, s: VoiceSettings): boolean {
  if (!s.telegramVoice) return false;
  if (MARKET_VOICE_EVENTS.has(type)) return inSendWindow();
  return true; // system / briefing voices allowed anytime
}

function getProvider(s: VoiceSettings): TTSProvider | null {
  if (providerOverride) return providerOverride;
  try {
    return createProvider(s.provider, {
      piperUrl: s.piperUrl,
      modelDir: s.modelDir,
      audioDir: s.audioDir,
      retentionMin: s.retentionMin,
    });
  } catch {
    return null;
  }
}

async function defaultSender(audioPath: string): Promise<boolean> {
  try {
    const { sendTelegramVoice } = await import("@/lib/telegram");
    return await sendTelegramVoice(audioPath);
  } catch (err: any) {
    console.warn(`[Voice] telegram voice send failed: ${err.message}`);
    return false;
  }
}

function ensureAudioDir(s: VoiceSettings): void {
  try { fs.mkdirSync(s.audioDir, { recursive: true }); } catch {}
}

// ─── Queue ────────────────────────────────────────────────────────
// NOTE: touchpoints read settings at call time so UI toggles apply without restart.
function getQueue(): VoiceQueue {
  if (queue) return queue;
  queue = new VoiceQueue({
    synthesize: async (job: VoiceJob) => {
      const s = settings();
      ensureAudioDir(s);
      const provider = getProvider(s);
      if (!provider) throw new Error("no local TTS provider available");
      const res = await provider.synthesize(job.text, { model: s.model, speed: s.speed, volume: s.volume });
      // deliver (never throws upward — trading system continues, spec §19)
      if (job.deliver) {
        const send = senderOverride ?? ((p: string) => defaultSender(p));
        try { await send(res.audioPath, job.text); } catch (err: any) { console.warn(`[Voice] deliver failed: ${err.message}`); }
      }
      return { audioPath: res.audioPath };
    },
    onSynthesized: (job, result) => {
      const fn = directResolvers.get(job.key);
      if (fn) { directResolvers.delete(job.key); fn({ audioPath: result.audioPath }); }
    },
    onFailed: (job, error) => {
      const fn = directResolvers.get(job.key);
      if (fn) { directResolvers.delete(job.key); fn({ error: error.message }); }
    },
  });
  return queue;
}

// ─── Public entry — fire-and-forget from any notification path ────
export function handleVoiceEvent(ev: VoiceEvent): HandleResult {
  try {
    const s = settings();
    if (!s.enabled) return "disabled";
    const toggle = VOICE_TOGGLE[ev.eventType];
    if (toggle && !s[toggle]) return "off";
    if (!deliverable(ev.eventType, s)) return "off"; // no consumer / outside send window
    const text = formatVoiceEvent(ev);
    if (!text) return "no_text";
    const job: VoiceJob = {
      key: buildDedupKey(ev),
      priority: voicePriority(ev.eventType),
      text,
      eventType: ev.eventType,
      createdAt: Date.now(),
      deliver: true,
    };
    return getQueue().enqueue(job);
  } catch (err: any) {
    console.warn(`[Voice] handleVoiceEvent failed: ${err.message}`);
    return "off"; // voice failure must never propagate into callers
  }
}

// ─── Direct synthesis (test voice / briefing — returns audio URL) ─
async function speakDirect(text: string, eventType: VoiceEventType, deliver: boolean): Promise<{ audioPath?: string; status: string }> {
  const s = settings();
  ensureAudioDir(s);
  const key = `DIRECT:${eventType}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const result = new Promise<{ audioPath?: string; status: string }>((resolve) => {
    const timeout = setTimeout(() => {
      directResolvers.delete(key);
      resolve({ status: "timeout" });
    }, 45_000);
    directResolvers.set(key, (r) => {
      clearTimeout(timeout);
      resolve(r.audioPath ? { audioPath: r.audioPath, status: "ok" } : { status: "error" });
    });
  });
  const status = getQueue().enqueue({
    key,
    priority: 1,
    text,
    eventType,
    createdAt: Date.now(),
    deliver,
  });
  if (status !== "queued") {
    const fn = directResolvers.get(key);
    if (fn) directResolvers.delete(key);
    return { status };
  }
  return result;
}

/** Spec §15 Test Voice — forced (bypasses enabled/toggles; explicit user action). */
export async function speakTest(): Promise<{ audioPath?: string; url?: string; text: string; status: string }> {
  const text = "SMDApp voice systems are online. All monitoring systems are operational.";
  const s = settings();
  const r = await speakDirect(text, "SYSTEM_READY", s.telegramVoice);
  return { ...r, text, url: r.audioPath ? `/api/voice/audio/${path.basename(r.audioPath)}` : undefined };
}

/** Spec §11 — startup greeting, deduplicated (no hot-reload spam). */
export function systemStatePath(): string {
  return process.env.VOICE_STATE_FILE || path.join(process.cwd(), "data", "voice-state.json");
}

export async function speakSystemStart(): Promise<HandleResult> {
  try {
    const s = settings();
    if (!s.enabled || !s.systemAlerts) return "off";
    if (!deliverable("SYSTEM_START", s)) return "off";
    let last = 0;
    try { last = JSON.parse(fs.readFileSync(systemStatePath(), "utf8")).lastSystemStart || 0; } catch {}
    if (Date.now() - last < 4 * 3_600_000) return "deduped";
    try {
      fs.mkdirSync(path.dirname(systemStatePath()), { recursive: true });
      fs.writeFileSync(systemStatePath(), JSON.stringify({ lastSystemStart: Date.now() }));
    } catch {}
    return handleVoiceEvent({ eventType: "SYSTEM_START", timestamp: Date.now() });
  } catch {
    return "off";
  }
}

/** Spec §10 — market briefing from REAL SMDApp data only. */
export async function speakBriefing(symbol = "NIFTY"): Promise<{ audioPath?: string; url?: string; text: string; status: string; skipped?: string }> {
  const s = settings();
  if (!s.enabled || !s.marketBriefing) return { text: "", status: "off", skipped: "marketBriefing disabled" };
  const ev: VoiceEvent = { eventType: "MARKET_BRIEFING", symbol, timestamp: Date.now() };

  // real data only — sdm-signal first (marketContext: spot/vix/pcr/trend), SMDContext fallback
  try {
    const base = process.env.API_BASE_URL || "http://localhost:3000";
    const res = await fetch(`${base}/api/sdm-signal?symbol=${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(20_000) });
    if (res.ok) {
      const j = await res.json();
      const mc = j?.signal?.marketContext || j?.marketContext;
      if (mc) {
        ev.spotPrice = Number(mc.spot) || undefined;
        ev.vix = Number(mc.vix) || undefined;
        ev.pcr = Number(mc.pcr) || undefined;
        ev.trend = typeof mc.trend === "string" ? mc.trend : undefined;
        ev.chainStatus = ev.pcr ? "confirmed" : "incomplete";
      }
    }
  } catch {}
  if (ev.spotPrice === undefined && ev.vix === undefined) {
    try {
      const { buildSMDContext } = await import("@/lib/smd-context");
      const base = process.env.API_BASE_URL || "http://localhost:3000";
      const ctx = await buildSMDContext(symbol, base);
      ev.spotPrice = ctx?.spot?.price || undefined;
      ev.vix = ctx?.options?.vix || undefined;
      ev.pcr = ctx?.options?.pcr || undefined;
      if (ev.pcr) ev.chainStatus = "confirmed";
    } catch {}
  }

  const text = formatVoiceEvent(ev);
  if (!text) return { text: "", status: "no_text" };
  const deliver = deliverable("MARKET_BRIEFING", s);
  const r = await speakDirect(text, "MARKET_BRIEFING", deliver);
  return { ...r, text, url: r.audioPath ? `/api/voice/audio/${path.basename(r.audioPath)}` : undefined };
}

// ─── Hermes bus mapping (read-only tap — never feeds decisions back) ─
function parseOptionType(direction?: string): { optionType?: "CE" | "PE"; side?: string } {
  if (!direction) return {};
  const m = /\b(CE|PE)\b/i.exec(direction);
  return { optionType: m ? (m[1].toUpperCase() as "CE" | "PE") : undefined, side: direction };
}

export function mapHermesEventToVoice(event: HermesEvent): VoiceEvent | null {
  const p = (event.payload || {}) as Record<string, any>;
  const ts = typeof event.timestamp === "number" ? event.timestamp : Date.parse(event.timestamp || "") || Date.now();
  const opt = parseOptionType(p.direction);
  const tradeId = p.signalId || p.tradeId || event.tradeId;

  switch (event.eventType) {
    case "TRADE_CREATED":
      return {
        eventType: "TRADE_CONFIRMED",
        symbol: event.symbol || p.symbol,
        strike: Number(p.strike) || undefined,
        optionType: opt.optionType,
        side: p.direction,
        entryPrice: Number(p.entry) || undefined,
        stopLoss: Number(p.sl) || undefined,
        target: Number(p.tp1) || undefined,
        confidence: Number(p.confidence ?? p.score) || undefined,
        tradeId,
        timestamp: ts,
      };
    case "TP1_HIT":
    case "TP2_HIT":
    case "TP3_HIT": {
      const n = event.eventType === "TP1_HIT" ? 1 : event.eventType === "TP2_HIT" ? 2 : 3;
      const target = Number(p[`tp${n}`]) || undefined;
      return {
        eventType: "TP_HIT",
        symbol: event.symbol || p.symbol,
        strike: Number(p.strike) || undefined,
        optionType: opt.optionType,
        side: p.direction,
        targetNumber: n,
        target,
        premium: Number(p.current) || undefined,
        tradeId,
        timestamp: ts,
      };
    }
    case "SL_HIT":
      return {
        eventType: "SL_HIT",
        symbol: event.symbol || p.symbol,
        strike: Number(p.strike) || undefined,
        optionType: opt.optionType,
        side: p.direction,
        entryPrice: Number(p.entry) || undefined,
        stopLoss: Number(p.sl ?? p.exit) || undefined,
        tradeId,
        timestamp: ts,
      };
    case "NO_TRADE_OBSERVED": {
      const conds = Array.isArray(p.blockingConditions) ? p.blockingConditions.join("; ") : "";
      const reason = typeof p.reason === "string" ? p.reason : conds;
      return reason
        ? { eventType: "NO_TRADE", symbol: event.symbol || p.underlying, reason, timestamp: ts }
        : { eventType: "NO_TRADE", symbol: event.symbol || p.underlying, timestamp: ts };
    }
    case "PROVIDER_FAILURE":
      return {
        eventType: "SYSTEM_WARNING",
        reason: `${p.provider || "provider"} unavailable${p.error ? `: ${p.error}` : ""}`,
        timestamp: ts,
      };
    case "HEALTH_DEGRADED":
      return {
        eventType: "SYSTEM_WARNING",
        reason: `${p.component || "component"} degraded${p.reason ? `: ${p.reason}` : ""}`,
        timestamp: ts,
      };
    default:
      return null;
  }
}

// ─── Service lifecycle ────────────────────────────────────────────
export async function startVoiceService(): Promise<void> {
  if (started) return;
  started = true;
  ensureAudioDir(settings());

  // 1) Hermes event bus — read-only subscriptions (voice is output-only, spec §12)
  try {
    const { getEventBus } = await import("@/lib/hermes/event-bus");
    const bus = getEventBus();
    const busTypes = [
      "TRADE_CREATED", "TP1_HIT", "TP2_HIT", "TP3_HIT", "SL_HIT",
      "NO_TRADE_OBSERVED", "PROVIDER_FAILURE", "HEALTH_DEGRADED",
    ] as const;
    for (const t of busTypes) {
      const handler = (event: HermesEvent) => {
        try {
          const ev = mapHermesEventToVoice(event);
          if (ev) handleVoiceEvent(ev);
        } catch {}
      };
      bus.on(t, handler);
      unsubs.push(() => bus.off(t, handler as any));
    }

    // 2) SESSION_CHANGE → MARKET_OPEN / MARKET_CLOSE (uses real session engine)
    const sessionHandler = async (event: HermesEvent) => {
      try {
        const { getCurrentSession } = await import("@/lib/market-session");
        const open = getCurrentSession().isMarketOpen;
        if (lastSessionOpen === null) { lastSessionOpen = open; return; }
        if (open !== lastSessionOpen) {
          lastSessionOpen = open;
          handleVoiceEvent({ eventType: open ? "MARKET_OPEN" : "MARKET_CLOSE", timestamp: Date.now() });
        }
      } catch {}
    };
    bus.on("SESSION_CHANGE", sessionHandler);
    unsubs.push(() => bus.off("SESSION_CHANGE", sessionHandler as any));
  } catch (err: any) {
    console.warn(`[Voice] bus subscription failed: ${err.message}`);
  }

  // 3) AlertEngine — expiry-liquidity alerts (spec event types only)
  try {
    const { getAlertEngine } = await import("@/lib/expiry-liquidity/alert-engine");
    const engine = getAlertEngine();
    const unsub = engine.subscribe((alert: any) => {
      try {
        let type: VoiceEventType | null = null;
        if (alert?.type === "IV_SHOCK") type = "VOLATILITY_ALERT";
        else if (alert?.type === "DATA_QUALITY_DEGRADED" || alert?.type === "MARGIN_RISK_HIGH") type = "SYSTEM_WARNING";
        if (type) handleVoiceEvent({ eventType: type, symbol: alert.symbol, reason: alert.message, timestamp: alert.timestamp || Date.now() });
      } catch {}
    });
    if (typeof unsub === "function") unsubs.push(unsub);
  } catch (err: any) {
    console.warn(`[Voice] alert-engine subscription failed: ${err.message}`);
  }

  // 4) startup greeting (deduplicated — spec §11)
  speakSystemStart().catch(() => {});
}

let lastSessionOpen: boolean | null = null;

export function stopVoiceService(): void {
  for (const u of unsubs) { try { u(); } catch {} }
  unsubs = [];
  queue?.cancelPending();
  queue = null;
  started = false;
  lastSessionOpen = null;
}

export function getVoiceStatus() {
  return {
    started,
    queue: queue ? queue.status() : { pending: 0, running: false, completed: 0, failed: 0, deduped: 0, dropped: 0, cancelled: 0 },
  };
}
