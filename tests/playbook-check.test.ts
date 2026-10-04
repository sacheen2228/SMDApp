/// <reference types="bun-types" />
// PLAYBOOK_CHECK — the playbook's 8-item pre-trade checklist as a post-engine
// gate (Phase 4.5). Reads existing agent evidence + the engine candidate;
// NEVER re-scores factors (dedup: cross-confluence owns aggregation, agents
// own their factors). Any failed item → decision forced to NO_TRADE.
// Risk threshold: playbook rules (R:R >= 1:2, risk <= 1% capital).

import { describe, it, expect } from "bun:test";
import { evaluatePlaybookCheck, playbookNoTrade } from "@/lib/agents/playbook-check";

function agent(id: string, bias = "NEUTRAL", confidence = 50, riskFlags: string[] = []) {
  return {
    agentId: id, bias, confidence, riskFlags, evidence: [],
    dataFreshness: "FRESH", recommendationContext: "RESEARCH_ONLY",
  } as any;
}

function candidate(over: Record<string, unknown> = {}) {
  return {
    symbol: "NIFTY", exchange: "NFO", instrument: "CALL", optionType: "CE",
    strike: 22400, entry: 100, stopLoss: 90, target1: 130, target2: 140,
    direction: "BUY_CE", strategy: "AGENT_SYSTEM", score: 70,
    spot: 22400, premium: 100, maxLoss: 650, daysToExpiry: 5,
    ...over,
  } as any;
}

const FRESH8 = [
  agent("FII_DII"), agent("CAS"), agent("MTF_CONFIRMATION"), agent("MARKET_STRUCTURE"),
  agent("SUPPORT_RESISTANCE"), agent("OI_CLASSIFICATION"), agent("BREAKOUT"),
  agent("MOMENTUM"), agent("EVENT_RISK"),
];

describe("evaluatePlaybookCheck — scope", () => {
  it("no candidate → checked=false, pass=true (research is never gated)", () => {
    const r = evaluatePlaybookCheck(undefined, FRESH8, {} as any);
    expect(r.checked).toBe(false);
    expect(r.pass).toBe(true);
    expect(r.items).toHaveLength(0);
  });

  it("clean inputs → all 8 items pass, checked=true", () => {
    const r = evaluatePlaybookCheck(candidate(), FRESH8, {} as any);
    expect(r.checked).toBe(true);
    expect(r.pass).toBe(true);
    expect(r.failedItems).toEqual([]);
    expect(r.items.map(i => i.item)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("item 1 — flow aligned (FII_DII)", () => {
  it("BEARISH conf 70 vs BUY_CE → item 1 fails, overall fail", () => {
    const outs = [agent("FII_DII", "BEARISH", 70), ...FRESH8.slice(1)];
    const r = evaluatePlaybookCheck(candidate(), outs, {} as any);
    expect(r.pass).toBe(false);
    expect(r.failedItems).toContain(1);
    expect(r.items.find(i => i.item === 1)!.note).toMatch(/BEARISH.*70|70.*BEARISH/);
  });

  it("opposing bias but conf 50 (<60) → weak voice cannot veto", () => {
    const outs = [agent("FII_DII", "BEARISH", 50), ...FRESH8.slice(1)];
    const r = evaluatePlaybookCheck(candidate(), outs, {} as any);
    expect(r.pass).toBe(true);
  });

  it("NO_DATA flow → pass with honest note", () => {
    const outs = [agent("FII_DII", "NO_DATA", 0), ...FRESH8.slice(1)];
    const r = evaluatePlaybookCheck(candidate(), outs, {} as any);
    expect(r.pass).toBe(true);
    expect(r.items.find(i => i.item === 1)!.note).toMatch(/no data|neutral/i);
  });
});

describe("item 2 — positioning not crowded (participant OI)", () => {
  const poi = (client: { indexLong: number; indexShort: number }) =>
    ({ client: { indexLong: client.indexLong, indexShort: client.indexShort } } as any);

  it("client crowded LONG (indexLong 70) vs BUY_CE → item 2 fails", () => {
    const r = evaluatePlaybookCheck(candidate(), FRESH8,
      { participantOI: poi({ indexLong: 70, indexShort: 30 }) } as any);
    expect(r.failedItems).toContain(2);
    expect(r.pass).toBe(false);
  });

  it("client crowded LONG vs BUY_PE → not crowded against the put, passes", () => {
    const r = evaluatePlaybookCheck(candidate({ direction: "BUY_PE", instrument: "PUT", optionType: "PE" }),
      FRESH8, { participantOI: poi({ indexLong: 70, indexShort: 30 }) } as any);
    expect(r.pass).toBe(true);
  });

  it("participant OI missing → item 2 passes with 'unavailable' note", () => {
    const r = evaluatePlaybookCheck(candidate(), FRESH8, {} as any);
    expect(r.items.find(i => i.item === 2)!.note).toMatch(/unavailable/i);
    expect(r.pass).toBe(true);
  });
});

describe("items 3-5 — structure / level+OI / candles (opposition rule)", () => {
  it("MARKET_STRUCTURE BEARISH conf 70 vs BUY_CE → item 3 fails", () => {
    const outs = FRESH8.map(a => a.agentId === "MARKET_STRUCTURE" ? agent("MARKET_STRUCTURE", "BEARISH", 70) : a);
    const r = evaluatePlaybookCheck(candidate(), outs, {} as any);
    expect(r.failedItems).toContain(3);
  });

  it("OI_CLASSIFICATION BULLISH conf 70 vs BUY_PE → opposes the put, item 4 fails", () => {
    const outs = FRESH8.map(a => a.agentId === "OI_CLASSIFICATION" ? agent("OI_CLASSIFICATION", "BULLISH", 70) : a);
    const r = evaluatePlaybookCheck(candidate({ direction: "BUY_PE", instrument: "PUT", optionType: "PE" }), outs, {} as any);
    expect(r.failedItems).toContain(4);
    expect(r.pass).toBe(false);
  });

  it("BREAKOUT BEARISH conf 70 vs BUY_CE → item 5 fails", () => {
    const outs = FRESH8.map(a => a.agentId === "BREAKOUT" ? agent("BREAKOUT", "BEARISH", 70) : a);
    const r = evaluatePlaybookCheck(candidate(), outs, {} as any);
    expect(r.failedItems).toContain(5);
  });
});

describe("item 6 — strike selector (option R:R >= 1:2, lots >= 1)", () => {
  it("R:R below 2 → item 6 fails", () => {
    const r = evaluatePlaybookCheck(candidate({ target1: 110 }), FRESH8, {} as any);
    // rr = (110-100)/(100-90) = 1.0
    expect(r.failedItems).toContain(6);
    expect(r.items.find(i => i.item === 6)!.note).toMatch(/R:R/i);
  });

  it("one lot exceeds the 1% risk budget → lots < 1, item 6 fails", () => {
    // per-lot risk = (2000-1900) * lot(NIFTY >= 65) = >= 6500 > budget 1000
    const r = evaluatePlaybookCheck(
      candidate({ entry: 2000, stopLoss: 1900, target1: 2300, maxLoss: 6500 }),
      FRESH8, {} as any);
    expect(r.failedItems).toContain(6);
    expect(r.items.find(i => i.item === 6)!.note).toMatch(/lot/i);
  });

  it("good R:R and affordable lot → item 6 passes (theta honestly noted as unchecked)", () => {
    const r = evaluatePlaybookCheck(candidate(), FRESH8, {} as any);
    const i6 = r.items.find(i => i.item === 6)!;
    expect(i6.pass).toBe(true);
    expect(i6.note).toMatch(/theta/i);
  });
});

describe("item 7 — stop/RR/risk limits (R:R >= 1:2, risk <= 1%)", () => {
  it("maxLoss 1500 > 1% of 100000 → item 7 fails", () => {
    const r = evaluatePlaybookCheck(candidate({ target1: 130, maxLoss: 1500 }), FRESH8, { capital: 100000 } as any);
    expect(r.failedItems).toContain(7);
    expect(r.items.find(i => i.item === 7)!.note).toMatch(/1%/);
  });

  it("maxLoss 900 <= 1% of 100000 → passes", () => {
    const r = evaluatePlaybookCheck(candidate({ maxLoss: 900 }), FRESH8, { capital: 100000 } as any);
    expect(r.pass).toBe(true);
  });

  it("maxLoss absent → passes with 'unchecked' note (item 6 already enforces lot feasibility)", () => {
    const r = evaluatePlaybookCheck(candidate({ maxLoss: undefined }), FRESH8, {} as any);
    expect(r.items.find(i => i.item === 7)!.note).toMatch(/unchecked/i);
    expect(r.pass).toBe(true);
  });
});

describe("item 8 — no event or expiry distortion", () => {
  it("EVENT_RISK has riskFlags (expiry/event) → item 8 fails with the flag in the note", () => {
    const outs = FRESH8.map(a => a.agentId === "EVENT_RISK" ? agent("EVENT_RISK", "NEUTRAL", 45, ["Expiry week — higher volatility expected"]) : a);
    const r = evaluatePlaybookCheck(candidate(), outs, {} as any);
    expect(r.failedItems).toContain(8);
    expect(r.items.find(i => i.item === 8)!.note).toMatch(/Expiry week/);
  });
});

describe("playbookNoTrade", () => {
  it("builds an engine-shaped NO_TRADE naming failed items", () => {
    const outs = [agent("FII_DII", "BEARISH", 70), ...FRESH8.slice(1)];
    const check = evaluatePlaybookCheck(candidate(), outs, {} as any);
    const d = playbookNoTrade(check);
    expect(d.action).toBe("NO_TRADE");
    expect(d.confidence).toBe(0);
    expect(d.reasons.join(" ")).toMatch(/Playbook checklist/);
    expect(d.reasons.join(" ")).toMatch(/flow/i);
    expect(d.risks.join(" ")).toMatch(/skip/i);
  });
});
