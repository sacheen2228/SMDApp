import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  fetchCandlesWithFallback,
  __setCandleSourcesForTests,
  __setMOTOTPRecoveryForTests,
  type CandleSourceFns,
} from "@/lib/market/candle-chain";
import {
  __setSessionAlertSenderForTests,
  __resetSessionHealthForTests,
  getSessionHealth,
} from "@/lib/session-health";

const TODAY = new Date().toISOString().slice(0, 10);
const MIN1 = [{ time: "2026-09-28T09:15:00.000Z", open: 25000, high: 25010, low: 24990, close: 25005, volume: 100 }];
const MO_DAY = [{ time: "2026-09-25T10:00:00.000Z", open: 25000, high: 25100, low: 24900, close: 25050, volume: 1000 }];

type Spies = {
  breeze: ReturnType<typeof spyFn>;
  mo: ReturnType<typeof spyFn>;
  nse: ReturnType<typeof spyFn>;
  calls: Record<"breeze" | "mo" | "nse", number>;
  recovery: { calls: number; result: boolean };
};

function spyFn(impl: (...args: any[]) => any, key: "breeze" | "mo" | "nse", s: Spies) {
  return async (...args: any[]) => {
    s.calls[key]++;
    return impl(...args);
  };
}

function makeSpies(impls: Partial<Record<"breeze" | "mo" | "nse", (...args: any[]) => any>>): Spies {
  const s: Spies = {
    calls: { breeze: 0, mo: 0, nse: 0 },
    recovery: { calls: 0, result: false },
    breeze: null as any, mo: null as any, nse: null as any,
  };
  s.breeze = spyFn(impls.breeze ?? (async () => ({ candles: MIN1 })), "breeze", s);
  s.mo = spyFn(impls.mo ?? (async () => MO_DAY), "mo", s);
  s.nse = spyFn(impls.nse ?? (async () => [{ time: "2026-09-28T09:15:00.000Z", close: 25000 }]), "nse", s);
  const fns: CandleSourceFns = { breeze: s.breeze as any, mo: s.mo as any, nse: s.nse as any };
  __setCandleSourcesForTests(fns);
  return s;
}

describe("candle chain — first success wins", () => {
  let sent: string[];
  let spies: Spies;

  beforeEach(() => {
    sent = [];
    __resetSessionHealthForTests();
    __setSessionAlertSenderForTests((m) => { sent.push(m); });
    __setMOTOTPRecoveryForTests(async () => false);
  });
  afterEach(() => {
    __setCandleSourcesForTests(null);
    __setMOTOTPRecoveryForTests(null);
    __resetSessionHealthForTests();
    __setSessionAlertSenderForTests(null);
  });

  test("breeze success → mo/nse never called, no failures", async () => {
    spies = makeSpies({});
    const r = await fetchCandlesWithFallback("NIFTY", TODAY, "1minute");
    expect(r.source).toBe("breeze");
    expect(r.candles.length).toBe(1);
    expect(r.failures).toEqual([]);
    expect(r.intervalLabel).toBe("1minute");
    expect(spies.calls.mo).toBe(0);
    expect(spies.calls.nse).toBe(0);
    expect(sent.length).toBe(0);
  });

  test("breeze session expiry (1m, index) → ONE alert, MO capability-skip recorded, NSE keeps continuity", async () => {
    spies = makeSpies({
      breeze: async () => { throw new Error("Breeze session expired and re-init failed. Update .env BREEZE_SESSION_TOKEN."); },
    });
    const r = await fetchCandlesWithFallback("NIFTY", TODAY, "1minute");

    // alert: single owner, once
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("[SYSTEM][SESSION_EXPIRED]");
    expect(sent[0]).toContain("source=breeze");

    // MO: intraday is a capability skip — recorded SOURCE_UNAVAILABLE, spy not called
    expect(spies.calls.mo).toBe(0);
    expect(r.failures).toContainEqual({ source: "mo", kind: "SOURCE_UNAVAILABLE", detail: expect.stringContaining("no intraday candle endpoint") });

    // continuity maintained via NSE (index)
    expect(spies.calls.nse).toBe(1);
    expect(r.source).toBe("nse");
    expect(r.candles.length).toBe(1);
    expect(r.failures[0]).toEqual({ source: "breeze", kind: "SESSION_EXPIRED", detail: expect.any(String) });
    expect(getSessionHealth().breeze.kind).toBe("SESSION_EXPIRED");
  });

  test("breeze session expiry (daily, stock) → MO still tried as fallback and serves data", async () => {
    spies = makeSpies({
      breeze: async () => ({ candles: [], warning: "Breeze error: Unauthorized User (401)" }),
    });
    const r = await fetchCandlesWithFallback("RELIANCE", TODAY, "1day");
    expect(spies.calls.mo).toBe(1); // MO tried
    expect(r.source).toBe("mo");
    expect(r.candles.length).toBe(1);
    expect(r.intervalLabel).toBe("1day");
    expect(sent.length).toBe(1); // breeze expiry alerted once
    expect(r.failures[0].source).toBe("breeze");
  });

  test("MO endpoint unavailable (network) → SOURCE_UNAVAILABLE, no fake expiry alert", async () => {
    spies = makeSpies({
      breeze: async () => ({ candles: [], warning: "Breeze error: timeout" }),
      mo: async () => { throw new Error("fetch failed: connect timeout"); },
    });
    const r = await fetchCandlesWithFallback("RELIANCE", TODAY, "1day");
    expect(spies.calls.mo).toBe(1);
    expect(r.failures).toContainEqual({ source: "mo", kind: "SOURCE_UNAVAILABLE", detail: "fetch failed: connect timeout" });
    expect(r.source).toBe("none");
    expect(sent.length).toBe(0);
  });

  test("stock symbol → NSE source NEVER called (index-only enforced in code)", async () => {
    spies = makeSpies({
      breeze: async () => ({ candles: [], warning: "Breeze error: timeout" }),
    });
    const r = await fetchCandlesWithFallback("RELIANCE", TODAY, "1minute");
    expect(spies.calls.nse).toBe(0);
    expect(r.failures).toContainEqual({ source: "nse", kind: "SOURCE_UNAVAILABLE", detail: expect.stringContaining("index-only") });
    expect(r.source).toBe("none");
  });

  test("SENSEX → NSE never called, clear BSE detail", async () => {
    spies = makeSpies({ breeze: async () => ({ candles: [], warning: "Breeze error: timeout" }) });
    const r = await fetchCandlesWithFallback("SENSEX", TODAY, "1minute");
    expect(spies.calls.nse).toBe(0);
    expect(r.failures.find((f) => f.source === "nse")?.detail).toContain("BSE index");
  });

  test("MO session expiry + TOTP recovery SUCCEEDS → no alert, candles from MO", async () => {
    spies = makeSpies({
      breeze: async () => ({ candles: [], warning: "Breeze error: timeout" }),
      mo: async () => { throw new Error("Invalid Token"); },
    });
    __setMOTOTPRecoveryForTests(async () => {
      spies.recovery.calls++;
      spies.recovery.result = true;
      return true;
    });
    // after recovery the retry must succeed:
    let firstCall = true;
    spies.mo = (async () => {
      spies.calls.mo++;
      if (firstCall) { firstCall = false; throw new Error("Invalid Token"); }
      return MO_DAY;
    }) as any;
    __setCandleSourcesForTests({ breeze: spies.breeze as any, mo: spies.mo as any, nse: spies.nse as any });

    const r = await fetchCandlesWithFallback("RELIANCE", TODAY, "1day");
    expect(spies.recovery.calls).toBe(1);
    expect(r.source).toBe("mo");
    expect(r.candles.length).toBe(1);
    expect(sent.length).toBe(0); // self-healed → no page
    expect(getSessionHealth().mo.kind).toBeNull();
  });

  test("MO session expiry + recovery FAILS → SESSION_EXPIRED alert once with remedy", async () => {
    spies = makeSpies({
      breeze: async () => ({ candles: [], warning: "Breeze error: timeout" }),
      mo: async () => { throw new Error("Invalid Token"); },
    });
    __setMOTOTPRecoveryForTests(async () => false);

    const r = await fetchCandlesWithFallback("RELIANCE", TODAY, "1day");
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("source=mo");
    expect(sent[0]).toContain("MOTILAL_TOTP_KEY");
    expect(r.failures.find((f) => f.source === "mo")?.detail).toContain("recovery attempted and failed");
    expect(r.source).toBe("none"); // stock → no NSE leg
  });

  test("NSE failure is never SESSION_EXPIRED and never alerts (403 block)", async () => {
    spies = makeSpies({
      breeze: async () => ({ candles: [], warning: "Breeze error: timeout" }),
      nse: async () => { throw new Error("403 Forbidden"); },
    });
    const r = await fetchCandlesWithFallback("NIFTY", TODAY, "1minute");
    const nseF = r.failures.find((f) => f.source === "nse");
    expect(nseF?.kind).toBe("SOURCE_UNAVAILABLE");
    expect(getSessionHealth().nse.kind).toBe("SOURCE_UNAVAILABLE");
    expect(sent.length).toBe(0); // nse never alerts
    expect(r.source).toBe("none");
  });

  test("empty NSE grapthData (Sunday) → NO_DATA, no alert", async () => {
    spies = makeSpies({
      breeze: async () => ({ candles: [], warning: "Breeze error: timeout" }),
      nse: async () => [],
    });
    const r = await fetchCandlesWithFallback("NIFTY", TODAY, "1minute");
    expect(r.failures).toContainEqual({ source: "nse", kind: "NO_DATA", detail: expect.stringContaining("grapthData is empty") });
    expect(sent.length).toBe(0);
  });

  test("NSE close-only 5-min points → degraded label + interval derived from spacing (never mislabeled 1m)", async () => {
    const points = [
      { time: "2026-09-28T09:15:00.000Z", close: 25000 },
      { time: "2026-09-28T09:20:00.000Z", close: 25010 },
      { time: "2026-09-28T09:25:00.000Z", close: 25020 },
    ];
    spies = makeSpies({
      breeze: async () => ({ candles: [], warning: "Breeze error: timeout" }),
      nse: async () => points,
    });
    const r = await fetchCandlesWithFallback("NIFTY", TODAY, "1minute");
    expect(r.source).toBe("nse");
    expect(r.intervalLabel).toBe("5minute"); // real spacing, not the requested 1m
    expect(r.degraded).toContain("close-only");
    expect(r.candles[0]).toEqual({ timestamp: points[0].time, open: 25000, high: 25000, low: 25000, close: 25000, volume: 0 });
  });

  test("NSE historical date → SOURCE_UNAVAILABLE (current session only), source not called", async () => {
    spies = makeSpies({
      breeze: async () => ({ candles: [], warning: "Breeze error: timeout" }),
    });
    const r = await fetchCandlesWithFallback("NIFTY", "2026-09-25", "1minute");
    expect(spies.calls.nse).toBe(0);
    expect(r.failures.find((f) => f.source === "nse")?.kind).toBe("SOURCE_UNAVAILABLE");
  });

  test("repeated breeze expiry reports → exactly one alert (episode dedup via session-health)", async () => {
    spies = makeSpies({
      breeze: async () => { throw new Error("session expired"); },
      nse: async () => [],
    });
    await fetchCandlesWithFallback("NIFTY", TODAY, "1minute");
    await fetchCandlesWithFallback("NIFTY", TODAY, "1minute");
    expect(sent.length).toBe(1);
  });
});

describe("backtest isolation (live-capture only)", () => {
  test("no backtest/evaluation module imports the candle chain", async () => {
    const { readdirSync, readFileSync, statSync } = await import("fs");
    const { join } = await import("path");
    const root = process.cwd();
    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", ".git", "downloads"].includes(name)) continue;
        const p = join(dir, name);
        try {
          if (statSync(p).isDirectory()) { scan(p); continue; }
          if (!/\.(ts|tsx)$/.test(name)) continue;
          const self = p.includes("candle-chain");
          if (self) continue;
          const src = readFileSync(p, "utf8");
          if (/from\s+["'].*candle-chain["']/.test(src) || /import\(["'].*candle-chain["']\)/.test(src)) {
            offenders.push(p.replace(root + "/", ""));
          }
        } catch {}
      }
    };
    for (const d of ["src", "scripts", "trade-audit"]) {
      try { scan(join(root, d)); } catch {}
    }
    // Only the live recorder glue may import the chain.
    expect(offenders.filter((f) => f !== "src/lib/market/capture.ts")).toEqual([]);
  });
});
