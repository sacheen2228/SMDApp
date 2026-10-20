/// <reference types="bun-types" />
// DATA HONESTY — the option chain's legs must not claim to be live when the
// chain is stale.
//
// THE DEFECT (2026-10-20): option-chain-normalizer.ts stamped EVERY leg with
// `timestamp: new Date().toISOString()`, `freshness: "REALTIME"` and
// `dataStatus: "LIVE"` — the build time of the response, not the time the
// exchange priced the chain. On a 29-hour-old chain the top level correctly
// said STALE while every leg said REALTIME, so any consumer reading a leg's
// freshness (dashboard, option-chain-reader, the GEX engine) believed a stale
// chain was live — a "fires wrong signals" defect.

import { describe, test, expect } from "bun:test";
import {
  buildOptionChain,
  resolveChainProvenance,
  type NormalizedStrike,
} from "@/lib/option-chain-normalizer";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const STALE_TS = "2026-10-19T07:00:00.000Z"; // 29 hours before NOW
const FRESH_TS = "2026-10-20T11:59:30.000Z"; // 30 seconds before NOW

function strikes(n = 5): NormalizedStrike[] {
  const out: NormalizedStrike[] = [];
  for (let i = 0; i < n; i++) {
    const ltp = 100 + i;
    out.push({
      strike: 22000 + i * 50,
      ce: {
        ltp, bid: ltp - 0.05, ask: ltp + 0.05, spread: 0.1, quoteQuality: "COMPLETE",
        oi: 100000, oiChange: 1000, volume: 50000, iv: 14, delta: 0.5, gamma: 0.001,
        theta: -10, vega: 50, hasData: true,
      },
      pe: {
        ltp, bid: ltp - 0.05, ask: ltp + 0.05, spread: 0.1, quoteQuality: "COMPLETE",
        oi: 90000, oiChange: -500, volume: 45000, iv: 15, delta: 0.45, gamma: 0.001,
        theta: -9, vega: 48, hasData: true,
      },
    });
  }
  return out;
}

describe("leg freshness — a stale chain's legs are NOT live", () => {
  test("the legs of a 29-hour-old chain are STALE, not REALTIME", () => {
    const chain = buildOptionChain(strikes(), 22100, "NIFTY", "NSE", undefined, {
      timestamp: STALE_TS,
      freshness: "STALE",
    })!;
    expect(chain).not.toBeNull();

    // the chain level
    expect(chain.freshness).toBe("STALE");
    expect(chain.timestamp).toBe(STALE_TS);
    expect(chain.providerTimestamp).toBe(STALE_TS);

    // every leg carries the PROVIDER's stamp — never the build time
    for (const s of chain.strikes) {
      for (const leg of [s.ce, s.pe]) {
        if (!leg) continue;
        expect(leg.freshness).toBe("STALE");
        expect(leg.dataStatus).not.toBe("LIVE");
        expect(leg.timestamp).toBe(STALE_TS);
        expect(leg.timestamp).not.toBe(new Date().toISOString());
      }
    }
  });

  test("no leg ever says REALTIME / LIVE unless the provider says so", () => {
    const chain = buildOptionChain(strikes(), 22100, "NIFTY", "NSE", undefined, {
      timestamp: STALE_TS,
    })!;
    const freshnesses = new Set<string>();
    const statuses = new Set<string>();
    for (const s of chain.strikes) {
      for (const leg of [s.ce, s.pe]) {
        if (!leg) continue;
        freshnesses.add(leg.freshness);
        statuses.add(leg.dataStatus);
      }
    }
    expect(freshnesses.has("REALTIME")).toBe(false);
    expect(statuses.has("LIVE")).toBe(false);
    expect([...freshnesses]).toEqual(["STALE"]);
  });

  test("a FRESH provider stamp keeps the legs live (the honest case)", () => {
    const chain = buildOptionChain(strikes(), 22100, "NIFTY", "NSE", undefined, {
      timestamp: FRESH_TS,
      freshness: "LIVE",
    })!;
    expect(chain.freshness).toBe("LIVE");
    for (const s of chain.strikes) {
      expect(s.ce?.freshness).toBe("LIVE");
      expect(s.ce?.dataStatus).toBe("AVAILABLE");
      expect(s.ce?.timestamp).toBe(FRESH_TS);
    }
  });
});

describe("leg freshness — no provider stamp means UNAVAILABLE, never a fresh lie", () => {
  test("without a provider timestamp the chain is not live", () => {
    const chain = buildOptionChain(strikes(), 22100, "NIFTY", "NSE")!;
    expect(chain.freshness).not.toBe("LIVE");
    expect(chain.freshness).not.toBe("REALTIME");
    for (const s of chain.strikes) {
      expect(s.ce?.freshness).not.toBe("LIVE");
      expect(s.ce?.timestamp).toBe("");
    }
  });

  test("resolveChainProvenance derives the freshness from the provider's age", () => {
    const stale = resolveChainProvenance({ timestamp: STALE_TS }, NOW);
    expect(stale.freshness).toBe("STALE");
    expect(stale.dataStatus).toBe("STALE");
    expect(stale.timestamp).toBe(STALE_TS);

    const fresh = resolveChainProvenance({ timestamp: FRESH_TS }, NOW);
    expect(["LIVE", "FRESH"]).toContain(fresh.freshness);
    expect(fresh.dataStatus).toBe("AVAILABLE");

    const none = resolveChainProvenance({}, NOW);
    expect(none.freshness).toBe("UNAVAILABLE");
    expect(none.timestamp).toBe("");
  });
});
