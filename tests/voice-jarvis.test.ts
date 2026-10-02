/// <reference types="bun-types" />
// Jarvis signal → voice layer: structured mapper + interactive (user-requested)
// delivery that bypasses the telegram send window (clicking "Jarvis signal"
// in chat is explicit — like Test Voice), while push events stay window-gated.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";

import {
  handleVoiceEvent,
  mapJarvisSignalToVoiceEvent,
  emitJarvisSignalVoice,
  __setVoiceProviderForTests,
  __setVoiceSenderForTests,
  __setVoiceWindowForTests,
  __resetVoiceServiceForTests,
  __resetVoiceQueueForTests,
} from "@/lib/voice/voiceService";
import type { TTSProvider, SynthResult } from "@/lib/voice/voiceProvider";
import type { JarvisSignal } from "@/lib/jarvis/types";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "voice-jarvis-"));
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

function writeCfg(patch: Record<string, unknown>): void {
  fs.writeFileSync(CFG, JSON.stringify(patch));
}

function baseSignal(over: Partial<JarvisSignal> = {}): JarvisSignal {
  return {
    agentId: "jarvis",
    timestampIso: new Date().toISOString(),
    instrument: "NIFTY",
    spot: 22421.95,
    biasScore: 62,
    componentScores: {} as any,
    groupsAgreeing: 6,
    strategy: "PB_01" as any,
    strategyName: "Pullback buy",
    levelsUsed: [],
    confluenceZone: null,
    action: "BUY_CE",
    confidence: "Moderate",
    trade: {
      expiry: "2026-10-08",
      strike: 22400,
      optionType: "CE",
      entryZone: [101.7, 104],
      stopLossPremium: 85,
      tp1Premium: 125,
      tp2Premium: 140,
      underlyingInvalidation: 22340,
      underlyingTargets: [22500, 22560],
      riskRewardTp1: 1.4,
      timeStopIso: "2026-10-02T14:30:00+05:30",
    },
    keyLevels: {},
    greeks: null,
    newsHeadlinesUsed: [],
    reasons: ["pullback held VWAP"],
    gatesFailed: [],
    dataFreshnessMinutes: 0,
    disclaimer: "Educational analysis, not investment advice.",
    ...over,
  };
}

async function drainQueue(): Promise<void> {
  const { getVoiceStatus } = await import("@/lib/voice/voiceService");
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
  writeCfg({ enabled: true, telegramVoice: true, tradeAlerts: true, noTrade: true });
  __resetVoiceServiceForTests();
  __resetVoiceQueueForTests();
  __setVoiceProviderForTests(fakeProvider());
  __setVoiceSenderForTests(async (p) => { delivered.push(p); return true; });
  __setVoiceWindowForTests(() => true);
});

afterEach(() => {
  __resetVoiceServiceForTests();
  delete process.env.VOICE_CONFIG_FILE;
  delete process.env.VOICE_AUDIO_DIR;
  delete process.env.VOICE_STATE_FILE;
});

describe("mapJarvisSignalToVoiceEvent", () => {
  it("BUY_CE → structured TRADE_SIGNAL (strike/entry/SL/TP from trade idea)", () => {
    const ev = mapJarvisSignalToVoiceEvent(baseSignal())!;
    expect(ev).toBeTruthy();
    expect(ev.eventType).toBe("TRADE_SIGNAL");
    expect(ev.symbol).toBe("NIFTY");
    expect(ev.strike).toBe(22400);
    expect(ev.optionType).toBe("CE");
    expect(ev.side).toBe("BUY CE");
    expect(ev.entryPrice).toBe(101.7);
    expect(ev.stopLoss).toBe(85);
    expect(ev.target).toBe(125);
    expect(ev.spotPrice).toBe(22421.95);
    expect(ev.source).toBe("JARVIS");
  });

  it("BUY_PE → optionType PE", () => {
    const ev = mapJarvisSignalToVoiceEvent(
      baseSignal({ action: "BUY_PE", trade: { ...(baseSignal().trade as any), optionType: "PE" } })
    )!;
    expect(ev.eventType).toBe("TRADE_SIGNAL");
    expect(ev.optionType).toBe("PE");
    expect(ev.side).toBe("BUY PE");
  });

  it("NO_TRADE → NO_TRADE with structured gate reasons (first 3)", () => {
    const ev = mapJarvisSignalToVoiceEvent(
      baseSignal({
        action: "NO_TRADE",
        trade: null,
        biasScore: -24,
        gatesFailed: ["outside market hours", "after 14:45 IST: no fresh entry", "|score| -24 below 40", "only 3/9 groups agree"],
      })
    )!;
    expect(ev.eventType).toBe("NO_TRADE");
    expect(ev.symbol).toBe("NIFTY");
    expect(ev.reason).toContain("outside market hours");
    expect(ev.reason).toContain("|score| -24 below 40");
    expect(ev.reason).not.toContain("groups agree"); // capped at 3
  });

  it("BUY signal with no trade idea still maps (symbol-only signal)", () => {
    const ev = mapJarvisSignalToVoiceEvent(baseSignal({ trade: null }))!;
    expect(ev.eventType).toBe("TRADE_SIGNAL");
    expect(ev.symbol).toBe("NIFTY");
    expect(ev.strike).toBeUndefined();
  });

  it("garbage input → null (never throws)", () => {
    expect(mapJarvisSignalToVoiceEvent(null as any)).toBeNull();
    expect(mapJarvisSignalToVoiceEvent({} as any)).toBeNull();
  });
});

describe("handleVoiceEvent — interactive (user-requested) delivery", () => {
  it("interactive events speak OUTSIDE the telegram send window", async () => {
    __setVoiceWindowForTests(() => false); // market closed
    const ev = mapJarvisSignalToVoiceEvent(baseSignal())!;
    expect(handleVoiceEvent(ev, { interactive: true })).toBe("queued");
    await drainQueue();
    expect(spoken.length).toBe(1);
    expect(spoken[0]).toContain("Alert.");
    expect(delivered.length).toBe(1);
  });

  it("push (non-interactive) events still gated by the window", () => {
    __setVoiceWindowForTests(() => false);
    const ev = mapJarvisSignalToVoiceEvent(baseSignal())!;
    expect(handleVoiceEvent(ev)).toBe("off");
  });

  it("interactive events respect enabled/telegramVoice switches", async () => {
    __setVoiceWindowForTests(() => false);
    writeCfg({ enabled: false });
    expect(handleVoiceEvent(mapJarvisSignalToVoiceEvent(baseSignal())!, { interactive: true })).toBe("disabled");
    writeCfg({ enabled: true, telegramVoice: false });
    expect(handleVoiceEvent(mapJarvisSignalToVoiceEvent(baseSignal())!, { interactive: true })).toBe("off");
    await drainQueue();
    expect(spoken.length).toBe(0);
  });

  it("interactive re-requests are not deduped — each click re-speaks", async () => {
    __setVoiceWindowForTests(() => false);
    const ts = Date.now();
    const a = handleVoiceEvent(mapJarvisSignalToVoiceEvent(baseSignal({ timestampIso: new Date(ts).toISOString() }))!, { interactive: true });
    const b = handleVoiceEvent(mapJarvisSignalToVoiceEvent(baseSignal({ timestampIso: new Date(ts + 1000).toISOString() }))!, { interactive: true });
    expect(a).toBe("queued");
    expect(b).toBe("queued");
    await drainQueue();
    expect(spoken.length).toBe(2);
  });
});

describe("emitJarvisSignalVoice (agent route tap)", () => {
  it("speaks a NO_TRADE decision end-to-end", async () => {
    __setVoiceWindowForTests(() => false);
    emitJarvisSignalVoice(
      baseSignal({ action: "NO_TRADE", trade: null, gatesFailed: ["|score| -24 below 40", "only 3/9 groups agree"] })
    );
    await drainQueue();
    expect(spoken.length).toBe(1);
    expect(spoken[0]).toContain("No trade.");
    expect(spoken[0]).toContain("below 40");
    expect(spoken[0]).not.toContain("|"); // pipes stripped for TTS
    expect(delivered.length).toBe(1);
  });

  it("never throws on malformed signal", () => {
    expect(() => emitJarvisSignalVoice(null as any)).not.toThrow();
    expect(() => emitJarvisSignalVoice({} as any)).not.toThrow();
  });
});
