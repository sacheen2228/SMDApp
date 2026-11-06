/// <reference types="bun-types" />
// TDD for the expiry-liquidity chain source with real fallbacks.
//
// GET /api/expiry-liquidity gathered its chain from NSE/BSE ONLY. When NSE
// rate-limits (403 flapping) the endpoint answers 503 "Real option chain data
// unavailable for NIFTY" even though two real sources remain:
//   1. Breeze getOptionChain(symbol, '') — live, session-authenticated
//   2. market-data-manager fetchOptionChainWithFallback — the canonical
//      exchange-aware tree (NSE → MO → BHAVCOPY) used by /api/option-chain
// Order mirrors the main option-chain route: exchange primary → Breeze live →
// canonical tree (EOD bhavcopy last, honestly labelled) → null → 503.
//
// Contract locked here:
//   - a source only wins with rows AND spot > 0 (a chain without spot can't
//     drive the engine — the route would 503 on it anyway);
//   - short-circuit: never touch later sources once one wins; never let a
//     throwing source abort the chain;
//   - breezeChainToRows groups Breeze's flat calls/puts into the exact
//     {strike, ce, pe} (+CE/PE aliases) row shape normalizeSnapshot reads,
//     null for a missing side (normalizeLeg(null) zeroes it).

import { describe, test, expect } from "bun:test";
import {
  gatherChainWithFallback,
  breezeChainToRows,
  type ChainDeps,
  type ChainSource,
} from "@/lib/expiry-liquidity/chain-source";
import { getOptionChainFlowEngine } from "@/lib/expiry-liquidity/option-chain-flow-engine";
import type { OptionChainData, OptionQuote } from "@/types";

function fakeQuote(strike: number, type: "call" | "put", ltp: number): OptionQuote {
  return {
    symbol: "NIFTY",
    strikePrice: strike,
    expiryDate: "09-Nov-2026",
    optionType: type,
    ltp,
    bid: ltp - 1,
    ask: ltp + 1,
    volume: 1000,
    openInterest: 5000,
    oiChange: 250,
    iv: 13.2,
    delta: type === "call" ? 0.5 : -0.5,
    gamma: 0.02,
    theta: -12,
    vega: 8,
  };
}

function makeDeps(behaviors: {
  primary?: ChainSource | null;
  breeze?: ChainSource | null;
  tree?: ChainSource | null;
  throwPrimary?: boolean;
}) {
  const calls: string[] = [];
  const deps: ChainDeps = {
    primary: async () => {
      calls.push("primary");
      if (behaviors.throwPrimary) throw new Error("NSE down");
      return behaviors.primary ?? null;
    },
    breeze: async () => {
      calls.push("breeze");
      return behaviors.breeze ?? null;
    },
    tree: async () => {
      calls.push("tree");
      return behaviors.tree ?? null;
    },
  };
  return { calls, deps };
}

const NSE_OK: ChainSource = {
  rows: [{ strike: 24800, CE: { ltp: 120 }, PE: { ltp: 130 } }],
  spot: 24810,
  source: "nse-api",
};

describe("gatherChainWithFallback ordering", () => {
  test("exchange primary wins → breeze/tree never touched", async () => {
    const { calls, deps } = makeDeps({ primary: NSE_OK });
    const out = await gatherChainWithFallback("NIFTY", deps);

    expect(out?.source).toBe("nse-api");
    expect(out?.spot).toBe(24810);
    expect(calls).toEqual(["primary"]);
  });

  test("primary null → Breeze live wins, tree untouched", async () => {
    const { calls, deps } = makeDeps({
      primary: null,
      breeze: { rows: [{ strike: 24800, ce: fakeQuote(24800, "call", 118) }], spot: 24805, source: "icici-breeze" },
    });
    const out = await gatherChainWithFallback("NIFTY", deps);

    expect(out?.source).toBe("icici-breeze");
    expect(calls).toEqual(["primary", "breeze"]);
  });

  test("primary + breeze null → canonical tree (BHAVCOPY label survives)", async () => {
    const { calls, deps } = makeDeps({
      primary: null,
      breeze: null,
      tree: { rows: [{ strike: 24800, CE: { ltp: 121 }, PE: { ltp: 131 } }], spot: 24811, source: "BHAVCOPY" },
    });
    const out = await gatherChainWithFallback("NIFTY", deps);

    expect(out?.source).toBe("BHAVCOPY");
    expect(calls).toEqual(["primary", "breeze", "tree"]);
  });

  test("all sources dead → null (route turns this into 503, never rows)", async () => {
    const { calls, deps } = makeDeps({ primary: null, breeze: null, tree: null });
    const out = await gatherChainWithFallback("NIFTY", deps);

    expect(out).toBeNull();
    expect(calls).toEqual(["primary", "breeze", "tree"]);
  });

  test("throwing primary does not abort the chain", async () => {
    const { calls, deps } = makeDeps({
      throwPrimary: true,
      breeze: { rows: [{ strike: 24800, ce: fakeQuote(24800, "call", 118) }], spot: 24805, source: "icici-breeze" },
    });
    const out = await gatherChainWithFallback("SENSEX", deps);

    expect(out?.source).toBe("icici-breeze");
    expect(calls).toEqual(["primary", "breeze"]);
  });

  test("rows without spot > 0 are not a win — falls through", async () => {
    const { calls, deps } = makeDeps({
      primary: { rows: NSE_OK.rows, spot: 0, source: "nse-api" },
      breeze: { rows: [{ strike: 24800, ce: fakeQuote(24800, "call", 118) }], spot: 24805, source: "icici-breeze" },
    });
    const out = await gatherChainWithFallback("NIFTY", deps);

    expect(out?.source).toBe("icici-breeze");
    expect(calls).toEqual(["primary", "breeze"]);
  });
});

describe("breezeChainToRows", () => {
  const chain: OptionChainData = {
    symbol: "NIFTY",
    expiryDate: "09-Nov-2026",
    spotPrice: 24800.5,
    strikes: [24700, 24800],
    calls: [fakeQuote(24700, "call", 150), fakeQuote(24800, "call", 120)],
    puts: [fakeQuote(24800, "put", 130)],
    atmStrike: 24800,
    timestamp: "2026-11-06T09:30:00.000Z",
  };

  test("groups flat calls/puts by strike, null side for a missing leg", () => {
    const out = breezeChainToRows(chain);

    expect(out).not.toBeNull();
    expect(out!.spot).toBe(24800.5);
    expect(out!.rows).toHaveLength(2);

    expect(out!.rows[0].strike).toBe(24700);
    expect(out!.rows[0].ce?.ltp).toBe(150);
    expect(out!.rows[0].pe).toBeNull();

    expect(out!.rows[1].strike).toBe(24800);
    expect(out!.rows[1].pe?.ltp).toBe(130);
    // Aliases: every consumer of rows (normalizeSnapshot, legacy readers)
    // must find the leg under either key.
    expect(out!.rows[1].CE).toBe(out!.rows[1].ce);
    expect(out!.rows[1].PE).toBe(out!.rows[1].pe);
    expect(out!.rows[0].strikePrice).toBe(24700);
  });

  test("quotes pass through field-untouched (ltp/OI/IV/greeks survive)", () => {
    const out = breezeChainToRows(chain);
    const leg = out!.rows[1].ce;

    expect(leg).toMatchObject({
      ltp: 120,
      openInterest: 5000,
      oiChange: 250,
      iv: 13.2,
      delta: 0.5,
      gamma: 0.02,
      theta: -12,
      vega: 8,
      volume: 1000,
      bid: 119,
      ask: 121,
    });
  });

  test("null / empty chains → null (never empty rows with a spot)", () => {
    expect(breezeChainToRows(null as any)).toBeNull();
    expect(breezeChainToRows({ ...chain, strikes: [], calls: [], puts: [] } as any)).toBeNull();
  });

  test("rows feed the live flow engine exactly like NSE rows do", () => {
    const out = breezeChainToRows(chain)!;
    const flow = getOptionChainFlowEngine();

    expect(() => flow.processOptionChain(out.rows)).not.toThrow();
    // Second pass: strikes get processed against the baseline snapshot.
    const moved = out.rows.map((r: any) => ({
      ...r,
      ce: r.ce ? { ...r.ce, ltp: r.ce.ltp + 5, openInterest: r.ce.openInterest + 100 } : r.ce,
      pe: r.pe ? { ...r.pe, ltp: r.pe.ltp - 5 } : r.pe,
      CE: null,
      PE: null,
    }));
    expect(() => flow.processOptionChain(moved)).not.toThrow();

    const agg = flow.getAggregateFlow();
    expect(agg).toBeTypeOf("object");
  });
});
