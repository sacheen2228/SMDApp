/// <reference types="bun-types" />
// Voice service — event → format → queue → TTS → Telegram.
// Verifies: disabled/off switches, dedup, TTS failure isolation, SELL safety,
// startup dedup (hot reload), test voice, missing-data honesty.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";

import {
  handleVoiceEvent,
  speakSystemStart,
  speakTest,
  mapHermesEventToVoice,
  __setVoiceProviderForTests,
  __setVoiceSenderForTests,
  __setVoiceWindowForTests,
  __resetVoiceServiceForTests,
  __resetVoiceQueueForTests,
  VOICE_TOGGLE,
} from "@/lib/voice/voiceService";
import type { TTSProvider, SynthResult } from "@/lib/voice/voiceProvider";
import type { VoiceEvent } from "@/lib/voice/voiceFormatter";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "voice-svc-"));
const AUDIO = path.join(TMP, "audio");
const STATE = path.join(TMP, "voice-state.json");
const CFG = path.join(TMP, "voice-config.json");

let spoken: string[] = [];
let delivered: string[] = [];

function fakeProvider(): TTSProvider {
  return {
    name: "fake",
    isAvailable: async () => true,
    synthesize: async (text): Promise<SynthResult> => {
      spoken.push(text);
      const p = path.join(AUDIO, `t${spoken.length}.ogg`);
      fs.writeFileSync(p, "FAKE");
      return { audioPath: p, format: "ogg" };
    },
  };
}

function failingProvider(): TTSProvider {
  return {
    name: "broken",
    isAvailable: async () => true,
    synthesize: async () => { throw new Error("tts exploded"); },
  };
}

function writeCfg(patch: Record<string, unknown>): void {
  fs.writeFileSync(CFG, JSON.stringify(patch));
}

const ev = (over: Partial<VoiceEvent>): VoiceEvent => ({
  eventType: "TRADE_SIGNAL",
  timestamp: Date.now(),
  symbol: "NIFTY",
  strike: 24500,
  optionType: "CE",
  ...over,
});

async function drainQueue(): Promise<void> {
  const { getVoiceStatus } = await import("@/lib/voice/voiceService");
  // queue instance is private — wait for status idle
  for (let i = 0; i < 200; i++) {
    const st = getVoiceStatus();
    if (!st.queue.running && st.queue.pending === 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  spoken = [];
  delivered = [];
  fs.mkdirSync(AUDIO, { recursive: true });
  process.env.VOICE_CONFIG_FILE = CFG;
  process.env.VOICE_AUDIO_DIR = AUDIO;
  process.env.VOICE_STATE_FILE = STATE;
  try { fs.unlinkSync(CFG); } catch {}
  try { fs.unlinkSync(STATE); } catch {}
  writeCfg({ enabled: true, telegramVoice: true, provider: "piper" });
  __resetVoiceServiceForTests();
  __setVoiceProviderForTests(fakeProvider());
  __setVoiceSenderForTests(async (p) => { delivered.push(p); return true; });
  __setVoiceWindowForTests(() => true); // pretend market hours for trade events
});

afterEach(() => {
  __resetVoiceServiceForTests();
  delete process.env.VOICE_CONFIG_FILE;
  delete process.env.VOICE_AUDIO_DIR;
  delete process.env.VOICE_STATE_FILE;
});

describe("handleVoiceEvent", () => {
  it("speaks a trade signal end-to-end (format → synth → deliver)", async () => {
    const r = handleVoiceEvent(ev({ eventType: "TRADE_SIGNAL", confidence: 82, entryPrice: 125, stopLoss: 92, target: 178 }));
    expect(r).toBe("queued");
    await drainQueue();
    expect(spoken.length).toBe(1);
    expect(spoken[0]).toContain("Alert.");
    expect(spoken[0]).toContain("NIFTY 24500 Call");
    expect(delivered.length).toBe(1);
  });

  it("returns disabled when VOICE_ENABLED=false — no synthesis", async () => {
    writeCfg({ enabled: false });
    expect(handleVoiceEvent(ev({}))).toBe("disabled");
    await drainQueue();
    expect(spoken.length).toBe(0);
  });

  it("respects per-event toggles (TP off → ignored)", async () => {
    writeCfg({ enabled: true, tpAlerts: false });
    expect(handleVoiceEvent(ev({ eventType: "TP_HIT", targetNumber: 1, tradeId: "t1" }))).toBe("off");
    await drainQueue();
    expect(spoken.length).toBe(0);
  });

  it("dedups duplicate trade signals — one synthesis", async () => {
    const ts = Date.now();
    const a = handleVoiceEvent(ev({ eventType: "TRADE_SIGNAL", timestamp: ts }));
    const b = handleVoiceEvent(ev({ eventType: "TRADE_SIGNAL", timestamp: ts + 1000 }));
    expect(a).toBe("queued");
    expect(b).toBe("deduped");
    await drainQueue();
    expect(spoken.length).toBe(1);
  });

  it("skips events outside the telegram send window (market events)", async () => {
    __setVoiceWindowForTests(() => false);
    expect(handleVoiceEvent(ev({ eventType: "SL_HIT", tradeId: "x" }))).toBe("off");
    await drainQueue();
    expect(spoken.length).toBe(0);
  });

  it("TTS failure never propagates to caller (trading continues)", async () => {
    __setVoiceProviderForTests(failingProvider());
    const r = handleVoiceEvent(ev({ eventType: "TRADE_SIGNAL" }));
    expect(r).toBe("queued"); // no throw
    await drainQueue();
    const { getVoiceStatus } = await import("@/lib/voice/voiceService");
    expect(getVoiceStatus().queue.failed).toBeGreaterThanOrEqual(1);
  });

  it("missing data → no_text, no fabrication", () => {
    expect(handleVoiceEvent({ eventType: "TRADE_SIGNAL", timestamp: Date.now() })).toBe("no_text");
  });

  it("SELL signal never spoken as confirmed/approved", async () => {
    handleVoiceEvent(ev({ eventType: "ENTRY", side: "SELL PE", optionType: "PE", entryPrice: 100 }));
    await drainQueue();
    expect(spoken.length).toBe(1);
    expect(spoken[0].toLowerCase()).not.toContain("confirmed");
    expect(spoken[0].toLowerCase()).not.toContain("approved");
    expect(spoken[0]).toContain("Alert.");
  });
});

describe("startup dedup (spec §11)", () => {
  it("speaks once, dedups hot-reload within 4h, speaks after window", async () => {
    expect(await speakSystemStart()).toBe("queued");
    await drainQueue();
    expect(spoken.length).toBe(1);
    expect(spoken[0]).toContain("SMDApp systems online.");

    // simulate hot reload / restart within 4h
    expect(await speakSystemStart()).toBe("deduped");
    await drainQueue();
    expect(spoken.length).toBe(1);

    // stale state + fresh process (new queue) → speaks again
    fs.writeFileSync(STATE, JSON.stringify({ lastSystemStart: Date.now() - 5 * 3_600_000 }));
    __resetVoiceQueueForTests();
    __setVoiceProviderForTests(fakeProvider());
    __setVoiceSenderForTests(async (p) => { delivered.push(p); return true; });
    expect(await speakSystemStart()).toBe("queued");
    await drainQueue();
    expect(spoken.length).toBe(2);
  });
});

describe("test voice (spec §15)", () => {
  it("works even when voice disabled (explicit user action) and returns url", async () => {
    writeCfg({ enabled: false });
    const r = await speakTest();
    expect(r.status).toBe("ok");
    expect(r.url).toMatch(/^\/api\/voice\/audio\/.+\.ogg$/);
    expect(r.text).toBe("SMDApp voice systems are online. All monitoring systems are operational.");
    expect(fs.existsSync(path.join(TMP, "audio", path.basename(r.url!)))).toBe(true);
  });
});

describe("mapHermesEventToVoice", () => {
  const he = (eventType: string, symbol: string, payload: any) =>
    ({ eventId: "e1", eventType, symbol, payload, timestamp: 1000 }) as any;

  it("maps TP2 hit with target number and premium", () => {
    const v = mapHermesEventToVoice(he("TP2_HIT", "NIFTY", { direction: "BUY CE", entry: 100, tp2: 160, current: 162 }));
    expect(v?.eventType).toBe("TP_HIT");
    expect(v?.targetNumber).toBe(2);
    expect(v?.premium).toBe(162);
    expect(v?.optionType).toBe("CE");
    expect(v?.side).toBe("BUY CE");
  });

  it("maps SL hit", () => {
    const v = mapHermesEventToVoice(he("SL_HIT", "BANKNIFTY", { direction: "BUY PE", entry: 200, sl: 150, exit: 150 }));
    expect(v?.eventType).toBe("SL_HIT");
    expect(v?.stopLoss).toBe(150);
    expect(v?.optionType).toBe("PE");
  });

  it("maps NO_TRADE_OBSERVED with engine reason only", () => {
    const v = mapHermesEventToVoice(he("NO_TRADE_OBSERVED", "NIFTY", { blockingConditions: ["low volume", "conflicting OI"] }));
    expect(v?.eventType).toBe("NO_TRADE");
    expect(v?.reason).toBe("low volume; conflicting OI");
  });

  it("returns null for unmapped events (voice never over-speaks)", () => {
    expect(mapHermesEventToVoice(he("SCHEDULER_TICK", "NIFTY", {}))).toBeNull();
    expect(mapHermesEventToVoice(he("TELEGRAM_SENT", "NIFTY", {}))).toBeNull();
  });
});

describe("toggle map completeness (spec §14/§15)", () => {
  it("every VoiceEventType has a toggle", async () => {
    const { formatVoiceEvent } = await import("@/lib/voice/voiceFormatter");
    const types = [
      "SYSTEM_START", "SYSTEM_READY", "MARKET_OPEN", "MARKET_CLOSE", "MARKET_BRIEFING",
      "TRADE_SIGNAL", "TRADE_CONFIRMED", "ENTRY", "TP_HIT", "SL_HIT", "NO_TRADE", "WAIT",
      "STRONG_BULLISH", "STRONG_BEARISH", "NEWS_ALERT", "VOLATILITY_ALERT",
      "SYSTEM_WARNING", "SYSTEM_ERROR",
    ] as const;
    for (const t of types) expect(VOICE_TOGGLE[t], `missing toggle for ${t}`).toBeTruthy();
    expect(formatVoiceEvent).toBeTypeOf("function");
  });
});
