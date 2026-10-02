/// <reference types="bun-types" />
// Voice queue — priority, dedup, concurrency 1, timeout, cancellation, recovery.

import { describe, it, expect } from "bun:test";
import { VoiceQueue, voicePriority, buildDedupKey, type VoiceJob } from "@/lib/voice/voiceQueue";
import type { VoiceEvent } from "@/lib/voice/voiceFormatter";

const ev = (over: Partial<VoiceEvent>): VoiceEvent => ({ eventType: "TRADE_SIGNAL", timestamp: Date.now(), ...over });
const job = (key: string, priority: 1 | 2 | 3, text = "hello"): VoiceJob => ({ key, priority, text, eventType: "TRADE_SIGNAL", createdAt: Date.now() });

describe("voicePriority (spec §16)", () => {
  it("maps HIGH events to 1, MEDIUM 2, LOW 3", () => {
    expect(voicePriority("SL_HIT")).toBe(1);
    expect(voicePriority("TRADE_CONFIRMED")).toBe(1);
    expect(voicePriority("ENTRY")).toBe(1);
    expect(voicePriority("TP_HIT")).toBe(1);
    expect(voicePriority("TRADE_SIGNAL")).toBe(1);
    expect(voicePriority("NEWS_ALERT")).toBe(2);
    expect(voicePriority("MARKET_BRIEFING")).toBe(2);
    expect(voicePriority("NO_TRADE")).toBe(3);
    expect(voicePriority("SYSTEM_READY")).toBe(3);
  });
});

describe("buildDedupKey (spec §17)", () => {
  it("TP keyed by tradeId + target number", () => {
    expect(buildDedupKey(ev({ eventType: "TP_HIT", tradeId: "t1", targetNumber: 2 }))).toBe("TP_HIT:t1:2");
  });
  it("SL keyed by tradeId", () => {
    expect(buildDedupKey(ev({ eventType: "SL_HIT", tradeId: "t1" }))).toBe("SL_HIT:t1");
  });
  it("TRADE_SIGNAL keyed by symbol+strike+type+minute bucket (stable across re-emits)", () => {
    const ts = 1_760_000_000_000;
    const a = buildDedupKey(ev({ eventType: "TRADE_SIGNAL", symbol: "NIFTY", strike: 24500, optionType: "CE", timestamp: ts }));
    const b = buildDedupKey(ev({ eventType: "TRADE_SIGNAL", symbol: "NIFTY", strike: 24500, optionType: "CE", timestamp: ts + 30_000 }));
    expect(a).toBe(b); // same 5-min bucket → duplicate suppressed
    const c = buildDedupKey(ev({ eventType: "TRADE_SIGNAL", symbol: "NIFTY", strike: 24500, optionType: "PE", timestamp: ts }));
    expect(c).not.toBe(a); // different strike type → distinct
  });
  it("system events bucketed globally", () => {
    const a = buildDedupKey(ev({ eventType: "SYSTEM_START", timestamp: 1000 }));
    const b = buildDedupKey(ev({ eventType: "SYSTEM_START", timestamp: 2000 }));
    expect(a).toBe(b);
    expect(a.startsWith("SYSTEM_START")).toBe(true);
  });
});

describe("VoiceQueue", () => {
  it("dedups same key — only one synthesis", async () => {
    let calls = 0;
    const q = new VoiceQueue({ synthesize: async () => { calls++; } });
    expect(q.enqueue(job("k1", 1))).toBe("queued");
    expect(q.enqueue(job("k1", 1))).toBe("deduped");
    await q.drain();
    expect(calls).toBe(1);
    expect(q.status().deduped).toBe(1);
  });

  it("runs 10 events with concurrency 1, in priority order", async () => {
    const order: number[] = [];
    let active = 0;
    let maxActive = 0;
    const q = new VoiceQueue({
      synthesize: async (j) => {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        order.push(j.priority);
        active--;
      },
    });
    // enqueue LOW, MEDIUM, HIGH interleaved
    const prios: Array<1 | 2 | 3> = [3, 2, 1, 3, 2, 1, 3, 2, 1, 3];
    prios.forEach((p, i) => q.enqueue(job(`k${i}`, p)));
    await q.drain();
    expect(q.status().completed).toBe(10);
    expect(maxActive).toBe(1);           // never 10 simultaneous processes (spec §16)
    expect(order[0]).toBe(1);            // HIGH first
    expect(order[order.length - 1]).toBe(3); // LOW last
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("recovers from TTS failure — later jobs still run", async () => {
    let calls = 0;
    const q = new VoiceQueue({
      synthesize: async (j) => {
        calls++;
        if (j.key === "bad") throw new Error("tts exploded");
      },
    });
    q.enqueue(job("bad", 1));
    q.enqueue(job("good", 1));
    await q.drain();
    expect(calls).toBe(2);
    expect(q.status().failed).toBe(1);
    expect(q.status().completed).toBe(1);
  });

  it("times out a hanging synthesis and continues", async () => {
    let done = false;
    const q = new VoiceQueue({
      timeoutMs: 40,
      synthesize: async (j) => {
        if (j.key === "hang") await new Promise((r) => setTimeout(r, 500));
        else done = true;
      },
    });
    q.enqueue(job("hang", 1));
    q.enqueue(job("after", 1));
    await q.drain();
    expect(done).toBe(true);
    expect(q.status().failed).toBeGreaterThanOrEqual(1);
  }, 5000);

  it("drops incoming when queue is full", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const q = new VoiceQueue({
      maxPending: 2,
      synthesize: async () => { await gate; },
    });
    q.enqueue(job("a", 1));
    await new Promise((r) => setTimeout(r, 5));
    q.enqueue(job("b", 2));
    q.enqueue(job("c", 3));
    expect(q.enqueue(job("d", 3))).toBe("dropped");
    release();
    await q.drain();
    expect(q.status().dropped).toBe(1);
  });

  it("cancelPending clears queued jobs", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const q = new VoiceQueue({ synthesize: async () => { calls++; await gate; } });
    q.enqueue(job("running", 1));
    await new Promise((r) => setTimeout(r, 5));
    q.enqueue(job("p1", 1));
    q.enqueue(job("p2", 2));
    const cancelled = q.cancelPending();
    expect(cancelled).toBe(2);
    release();
    await q.drain();
    expect(calls).toBe(1); // only the running one
  });
});
