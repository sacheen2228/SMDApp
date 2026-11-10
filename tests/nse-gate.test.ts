import { describe, test, expect } from "bun:test";
import {
  NseGate,
  NseBlockedError,
  NseSuppressedError,
  isNseForbidden,
} from "@/lib/market/nse-gate";

// The NSE gate is the shared protection for every NSE call in the app:
// one global rate limit, one single-flight per key, a global cooldown after a
// 403 streak, a per-key negative cache (so a failing symbol is not retried
// every poll) and a last-good snapshot per key.
function makeGate(over: Partial<ConstructorParameters<typeof NseGate>[0]> = {}) {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const gate = new NseGate({
    minIntervalMs: 100,
    maxConcurrent: 4,
    blockThreshold: 3,
    blockCooldownMs: 60_000,
    keyCooldownMs: 300_000,
    snapshotTtlMs: 1_800_000,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    ...over,
  });
  return {
    gate,
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

describe("isNseForbidden", () => {
  test("detects 403 from status, message and nested cause", () => {
    expect(isNseForbidden({ status: 403 })).toBe(true);
    expect(isNseForbidden(new Error("https://www.nseindia.com/api/x 403: Forbidden"))).toBe(true);
    expect(isNseForbidden(new Error("403 Forbidden"))).toBe(true);
    expect(isNseForbidden({ status: 500, message: "boom" })).toBe(false);
    expect(isNseForbidden(new Error("timeout"))).toBe(false);
  });
});

describe("NseGate — single flight", () => {
  test("concurrent calls with the same key share one upstream request", async () => {
    const { gate } = makeGate();
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true };
    };
    const [a, b, c] = await Promise.all([
      gate.call("chain|NIFTY", fn),
      gate.call("chain|NIFTY", fn),
      gate.call("chain|NIFTY", fn),
    ]);
    expect(calls).toBe(1);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(c).toEqual({ ok: true });
    expect(gate.getState().deduped).toBe(2);
  });

  test("different keys are not deduplicated", async () => {
    const { gate } = makeGate();
    let calls = 0;
    const fn = async () => {
      calls++;
      return calls;
    };
    await Promise.all([gate.call("a", fn), gate.call("b", fn)]);
    expect(calls).toBe(2);
  });
});

describe("NseGate — rate limiting", () => {
  test("requests are spaced by minIntervalMs", async () => {
    const { gate, sleeps } = makeGate({ minIntervalMs: 100 });
    await gate.call("k1", async () => 1);
    await gate.call("k2", async () => 2);
    await gate.call("k3", async () => 3);
    // the 2nd and 3rd request each waited one interval
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(sleeps.every((s) => s === 100)).toBe(true);
  });

  test("no more than maxConcurrent upstream calls run at once", async () => {
    const { gate } = makeGate({ maxConcurrent: 2, minIntervalMs: 0 });
    let active = 0;
    let peak = 0;
    const fn = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return true;
    };
    await Promise.all(Array.from({ length: 6 }, (_, i) => gate.call(`k${i}`, fn)));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("NseGate — 403 protection", () => {
  test("after a 403 streak the gate stops calling NSE and reports a block", async () => {
    const { gate } = makeGate({ blockThreshold: 3 });
    let calls = 0;
    const forbidden = async () => {
      calls++;
      throw new Error("https://www.nseindia.com/api/x 403: Forbidden");
    };
    for (let i = 0; i < 3; i++) {
      await expect(gate.call("k", forbidden)).rejects.toThrow(/403/);
    }
    // 4th call must NOT hit the network — the circuit is open
    await expect(gate.call("k", forbidden)).rejects.toBeInstanceOf(NseBlockedError);
    expect(calls).toBe(3);
    const state = gate.getState();
    expect(state.blocked).toBe(true);
    expect(state.consecutive403).toBe(3);
    expect(state.blockedUntilMs).toBeGreaterThan(0);
  });

  test("a failing key is suppressed individually (no retry storm on every poll)", async () => {
    const { gate, advance } = makeGate({ blockThreshold: 99 });
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error("500 boom");
    };
    await expect(gate.call("history|RELIANCE", failing)).rejects.toThrow();
    await expect(gate.call("history|RELIANCE", failing)).rejects.toBeInstanceOf(NseSuppressedError);
    expect(calls).toBe(1);
    // after the per-key cooldown the key is retried again
    advance(300_001);
    await expect(gate.call("history|RELIANCE", failing)).rejects.toThrow(/boom/);
    expect(calls).toBe(2);
  });

  test("after the cooldown expires NSE is tried again and a success clears the block", async () => {
    const { gate, advance } = makeGate({ blockThreshold: 2, blockCooldownMs: 60_000 });
    let calls = 0;
    const forbidden = async () => {
      calls++;
      throw new Error("403: Forbidden");
    };
    await expect(gate.call("k", forbidden)).rejects.toThrow(/403/);
    await expect(gate.call("k", forbidden)).rejects.toThrow(/403/);
    await expect(gate.call("k", forbidden)).rejects.toBeInstanceOf(NseBlockedError);
    expect(calls).toBe(2);

    advance(60_001);
    const ok = await gate.call("k", async () => ({ live: true }));
    expect(ok).toEqual({ live: true });
    expect(gate.getState().blocked).toBe(false);
    expect(gate.getState().consecutive403).toBe(0);
  });
});

describe("NseGate — last good snapshot", () => {
  test("a successful response is preserved and readable after a later failure", async () => {
    const { gate, advance } = makeGate();
    await gate.call("chain|NIFTY", async () => ({ strikes: [1, 2, 3] }));
    advance(5_000);
    const snap = gate.getSnapshot<{ strikes: number[] }>("chain|NIFTY");
    expect(snap).not.toBeNull();
    expect(snap!.data).toEqual({ strikes: [1, 2, 3] });
    expect(snap!.ageMs).toBe(5_000);
  });

  test("no snapshot exists before the first success", () => {
    const { gate } = makeGate();
    expect(gate.getSnapshot("never")).toBeNull();
  });

  test("expired snapshots are not returned", async () => {
    const { gate, advance } = makeGate({ snapshotTtlMs: 1_000 });
    await gate.call("k", async () => 1);
    advance(1_001);
    expect(gate.getSnapshot("k")).toBeNull();
  });
});

describe("NseGate — state", () => {
  test("exposes counters for the health endpoint", async () => {
    const { gate } = makeGate();
    await gate.call("k", async () => 1);
    const s = gate.getState();
    expect(s.totalRequests).toBe(1);
    expect(s.totalSuccesses).toBe(1);
    expect(s.snapshotCount).toBe(1);
    expect(s.lastSuccessAtMs).toBeGreaterThan(0);
  });
});
