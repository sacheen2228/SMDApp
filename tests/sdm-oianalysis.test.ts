/// <reference types="bun-types" />
// TDD for sdm-oianalysis: OI pattern classification must use PREMIUM CHANGE
// (not absolute ltp > 0), and fresh writing must not require ltp <= 0.

import { describe, test, expect } from "bun:test";
import {
  classifyOIPattern,
  detectFreshWriting,
  analyzeOptionChain,
} from "@/lib/sdm-oianalysis";
import type { SDMOptionStrike } from "@/types/sdm";

function leg(overrides: Partial<NonNullable<SDMOptionStrike["ce"]>> = {}) {
  return {
    ltp: 100,
    oi: 10000,
    oiChg: 0,
    volume: 500,
    iv: 14,
    delta: 0.5,
    theta: -0.05,
    gamma: 0.01,
    vega: 0.1,
    ...overrides,
  };
}

function strike(
  s: number,
  ce: Partial<NonNullable<SDMOptionStrike["ce"]>> | null,
  pe: Partial<NonNullable<SDMOptionStrike["pe"]>> | null,
): SDMOptionStrike {
  return {
    strike: s,
    ce: ce === null ? null : leg(ce),
    pe: pe === null ? null : leg(pe),
  };
}

describe("classifyOIPattern — uses premium CHANGE, not absolute ltp", () => {
  test("CE OI up + premium DOWN → SHORT_BUILDUP (was wrongly LONG_BUILDUP)", () => {
    const prev = strike(25150, { ltp: 120, oi: 10000, oiChg: 0 }, null);
    const curr = strike(25150, { ltp: 110, oi: 15000, oiChg: 5000 }, null);
    const out = classifyOIPattern(curr, prev);
    expect(out.callPattern).toBe("SHORT_BUILDUP");
  });

  test("CE OI up + premium UP → LONG_BUILDUP", () => {
    const prev = strike(25150, { ltp: 110, oi: 10000, oiChg: 0 }, null);
    const curr = strike(25150, { ltp: 120, oi: 15000, oiChg: 5000 }, null);
    const out = classifyOIPattern(curr, prev);
    expect(out.callPattern).toBe("LONG_BUILDUP");
  });

  test("CE OI down + premium UP → SHORT_COVERING", () => {
    const prev = strike(25150, { ltp: 110, oi: 15000, oiChg: 0 }, null);
    const curr = strike(25150, { ltp: 120, oi: 10000, oiChg: -5000 }, null);
    const out = classifyOIPattern(curr, prev);
    expect(out.callPattern).toBe("SHORT_COVERING");
  });

  test("CE OI down + premium DOWN → LONG_UNWINDING", () => {
    const prev = strike(25150, { ltp: 120, oi: 15000, oiChg: 0 }, null);
    const curr = strike(25150, { ltp: 110, oi: 10000, oiChg: -5000 }, null);
    const out = classifyOIPattern(curr, prev);
    expect(out.callPattern).toBe("LONG_UNWINDING");
  });

  test("PE OI up + premium DOWN → SHORT_BUILDUP", () => {
    const prev = strike(25150, null, { ltp: 120, oi: 10000, oiChg: 0 });
    const curr = strike(25150, null, { ltp: 110, oi: 15000, oiChg: 5000 });
    const out = classifyOIPattern(curr, prev);
    expect(out.putPattern).toBe("SHORT_BUILDUP");
  });

  test("no prev leg → null pattern (unknown, never fabricated)", () => {
    const curr = strike(25150, { ltp: 120, oi: 15000, oiChg: 5000 }, null);
    const out = classifyOIPattern(curr);
    expect(out.callPattern).toBeNull();
  });

  test("OI unchanged → null pattern", () => {
    const prev = strike(25150, { ltp: 110, oi: 10000, oiChg: 0 }, null);
    const curr = strike(25150, { ltp: 120, oi: 10000, oiChg: 0 }, null);
    const out = classifyOIPattern(curr, prev);
    expect(out.callPattern).toBeNull();
  });
});

describe("detectFreshWriting — fires on live premiums (ltp > 0)", () => {
  test("CE OI ↑ >20% with premium flat/down above spot → FRESH_CALL_WRITING", () => {
    const spot = 25100;
    const prev = [strike(25200, { ltp: 80, oi: 10000, oiChg: 0 }, null)];
    const curr = [strike(25200, { ltp: 78, oi: 14000, oiChg: 4000 }, null)];
    const out = detectFreshWriting(curr, spot, prev);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("FRESH_CALL_WRITING");
    expect(out[0].side).toBe("CE");
    expect(out[0].ltpDirection).toBe("DOWN");
    expect(out[0].oiPercentChange).toBeGreaterThan(20);
  });

  test("PE OI ↑ >20% with premium flat/down below spot → FRESH_PUT_WRITING", () => {
    const spot = 25200;
    const prev = [strike(25000, null, { ltp: 80, oi: 10000, oiChg: 0 })];
    const curr = [strike(25000, null, { ltp: 80, oi: 13000, oiChg: 3000 })];
    const out = detectFreshWriting(curr, spot, prev);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("FRESH_PUT_WRITING");
    expect(out[0].ltpDirection).toBe("FLAT");
  });

  test("OI ↑ but premium rising → NOT fresh writing (that is long buildup)", () => {
    const spot = 25100;
    const prev = [strike(25200, { ltp: 70, oi: 10000, oiChg: 0 }, null)];
    const curr = [strike(25200, { ltp: 90, oi: 14000, oiChg: 4000 }, null)];
    const out = detectFreshWriting(curr, spot, prev);
    expect(out).toHaveLength(0);
  });

  test("no prev chain → no fresh writing (unknown premium direction)", () => {
    const spot = 25100;
    const curr = [strike(25200, { ltp: 80, oi: 14000, oiChg: 4000 }, null)];
    const out = detectFreshWriting(curr, spot);
    expect(out).toHaveLength(0);
  });

  test("OI change below 20% → no signal", () => {
    const spot = 25100;
    const prev = [strike(25200, { ltp: 80, oi: 10000, oiChg: 0 }, null)];
    const curr = [strike(25200, { ltp: 78, oi: 11000, oiChg: 1000 }, null)];
    const out = detectFreshWriting(curr, spot, prev);
    expect(out).toHaveLength(0);
  });
});

describe("analyzeOptionChain passes prevChain into classification", () => {
  test("with prevChain, classifications use premium change", () => {
    const spot = 25100;
    const prev = [strike(25150, { ltp: 120, oi: 10000, oiChg: 0 }, { ltp: 90, oi: 10000, oiChg: 0 })];
    const curr = [strike(25150, { ltp: 110, oi: 15000, oiChg: 5000 }, { ltp: 95, oi: 12000, oiChg: 2000 })];
    const out = analyzeOptionChain(curr, spot, prev);
    expect(out.classifications[0].callPattern).toBe("SHORT_BUILDUP");
    expect(out.classifications[0].putPattern).toBe("LONG_BUILDUP");
    expect(out.status).toBe("DEGRADED"); // <5 strikes
  });

  test("without prevChain, classifications are null (not fabricated)", () => {
    const spot = 25100;
    const curr = [strike(25150, { ltp: 110, oi: 15000, oiChg: 5000 }, null)];
    const out = analyzeOptionChain(curr, spot);
    expect(out.classifications[0].callPattern).toBeNull();
  });
});
