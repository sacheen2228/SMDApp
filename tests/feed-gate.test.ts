/// <reference types="bun-types" />
// Feed gate (playbook skill: "levels only when meta.all_live").
// Market-hours pipeline runs must NOT produce trade levels when the
// Live Option Data Service says spot/VIX/chains are not all fresh —
// and must not even consult the service when the market is closed
// (after-hours behaviour stays exactly as before).

import { describe, it, expect } from "bun:test";
import { evaluateFeedGate, feedGateNoTrade, type FeedGateResult } from "@/lib/agents/feed-gate";

function resp(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe("evaluateFeedGate", () => {
  it("market CLOSED → never blocked, even if service unreachable", async () => {
    const gate = await evaluateFeedGate({
      isMarketOpen: () => false,
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    expect(gate.marketOpen).toBe(false);
    expect(gate.blocked).toBe(false);
    expect(gate.checked).toBe(false);
    expect(gate.allLive).toBe(false);
  });

  it("market open + all_live true → passes with overall", async () => {
    const gate = await evaluateFeedGate({
      isMarketOpen: () => true,
      fetchImpl: async () => resp({ overall: "LIVE", all_live: true }),
    });
    expect(gate).toMatchObject({ marketOpen: true, checked: true, allLive: true, blocked: false });
    expect(gate.overall).toBe("LIVE");
    expect(gate.reason).toBeUndefined();
  });

  it("market open + all_live false → BLOCKED, reason names the overall status", async () => {
    const gate = await evaluateFeedGate({
      isMarketOpen: () => true,
      fetchImpl: async () => resp({ overall: "DEGRADED", all_live: false }),
    });
    expect(gate.blocked).toBe(true);
    expect(gate.checked).toBe(true);
    expect(gate.allLive).toBe(false);
    expect(gate.reason).toContain("DEGRADED");
    expect(gate.reason).toContain("all_live");
  });

  it("market open + service unreachable → BLOCKED, checked false, reason says unreachable", async () => {
    const gate = await evaluateFeedGate({
      isMarketOpen: () => true,
      fetchImpl: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8765"); },
    });
    expect(gate.blocked).toBe(true);
    expect(gate.checked).toBe(false);
    expect(gate.reason).toMatch(/unreachable|not running|refused/i);
    expect(gate.reason).toContain("127.0.0.1:8765");
  });

  it("market open + non-JSON/failed response → BLOCKED", async () => {
    const gate = await evaluateFeedGate({
      isMarketOpen: () => true,
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => { throw new Error("no body"); } }) as unknown as Response,
    });
    expect(gate.blocked).toBe(true);
    expect(gate.checked).toBe(false);
  });

  it("market open + missing all_live field → BLOCKED (fail closed)", async () => {
    const gate = await evaluateFeedGate({
      isMarketOpen: () => true,
      fetchImpl: async () => resp({ overall: "LIVE" }),
    });
    expect(gate.blocked).toBe(true);
    expect(gate.allLive).toBe(false);
  });
});

describe("feedGateNoTrade", () => {
  it("produces an engine-decision-shaped NO_TRADE carrying the gate reason", () => {
    const gate: FeedGateResult = {
      marketOpen: true, checked: false, allLive: false, blocked: true,
      reason: "Live data service unreachable at 127.0.0.1:8765 (service not running?)",
    };
    const d = feedGateNoTrade(gate);
    expect(d.action).toBe("NO_TRADE");
    expect(d.confidence).toBe(0);
    expect(d.grade).toBe("F");
    expect(d.reasons[0]).toContain("Feed gate");
    expect(d.reasons.join(" ")).toContain("127.0.0.1:8765");
    expect(d.risks.join(" ")).toMatch(/all_live|playbook/i);
  });
});
