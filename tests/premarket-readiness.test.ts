/// <reference types="bun-types" />
// Premarket readiness — the 09:10 IST pre-flight that says whether the stack
// is fit to trade: feed gate, data health, session health (breeze/mo/nse),
// provider circuits and the morning brief, aggregated into ONE verdict.
// Pure logic is tested with injected probes — no network, no clock reading.

import { describe, it, expect } from "bun:test";
import {
  evaluatePremarketReadiness,
  formatReadinessMessage,
  type PremarketReadinessReport,
} from "@/lib/premarket-readiness";

const TRADING_DAY_MORNING = new Date("2026-10-12T03:40:00Z"); // Mon 09:10 IST
const SATURDAY_MORNING = new Date("2026-10-10T03:40:00Z");     // Sat 09:10 IST
const GANDHI_JAYANTI = new Date("2026-10-02T03:40:00Z");       // Fri holiday 09:10 IST

function okDeps() {
  return {
    now: TRADING_DAY_MORNING,
    feedProbe: async () => ({ reachable: true, overall: "LIVE", allLive: true, latencyMs: 12 }),
    chainProbe: async () => ({ ok: true, source: "NSE", strikes: 108, greeks: true, latencyMs: 300 }),
    sessionReport: async () => ({ probes: { breeze: { live: true, detail: "ok" }, mo: { live: true, detail: "ok" }, nse: { live: true, detail: "ok" } }, summary: { anySessionExpired: false, expiredSources: [] } }),
    brief: () => ({ timestamp: new Date("2026-10-12T03:35:00Z").toISOString() }),
    providerCircuits: () => ({ open: [] as string[] }),
    telegramConfigured: () => true,
  };
}

function statuses(r: PremarketReadinessReport): Record<string, string> {
  return Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
}

describe("evaluatePremarketReadiness — gate selection", () => {
  it("non-trading day (weekend) → NON_TRADING_DAY, readiness checks skipped", async () => {
    const r = await evaluatePremarketReadiness({ ...okDeps(), now: SATURDAY_MORNING });
    expect(r.tradingDay).toBe(false);
    expect(r.gate).toBe("NON_TRADING_DAY");
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.id === "trading_day")?.status).toBe("FAIL");
    // dependent checks must be SKIP, never silently PASS
    expect(statuses(r).feed_gate).toBe("SKIP");
    expect(statuses(r).data_health).toBe("SKIP");
    expect(statuses(r).session_health).toBe("SKIP");
  });

  it("exchange holiday → NON_TRADING_DAY", async () => {
    const r = await evaluatePremarketReadiness({ ...okDeps(), now: GANDHI_JAYANTI });
    expect(r.tradingDay).toBe(false);
    expect(r.gate).toBe("NON_TRADING_DAY");
  });

  it("all probes healthy → READY with zero blockers", async () => {
    const r = await evaluatePremarketReadiness(okDeps());
    expect(r.tradingDay).toBe(true);
    expect(r.gate).toBe("READY");
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.checks.every((c) => c.status === "PASS")).toBe(true);
    expect(r.minutesToOpen).toBeGreaterThanOrEqual(0);
  });
});

describe("evaluatePremarketReadiness — blockers (FAIL → NOT_READY)", () => {
  it("live data service unreachable → feed_gate FAIL and NOT_READY", async () => {
    const r = await evaluatePremarketReadiness({
      ...okDeps(),
      feedProbe: async () => ({ reachable: false, allLive: false, latencyMs: 1500, failNote: "timeout after 1500ms" }),
    });
    expect(statuses(r).feed_gate).toBe("FAIL");
    expect(r.gate).toBe("NOT_READY");
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => /feed/i.test(b))).toBe(true);
  });

  it("live service reports all_live=false → feed_gate FAIL", async () => {
    const r = await evaluatePremarketReadiness({
      ...okDeps(),
      feedProbe: async () => ({ reachable: true, overall: "DEGRADED", allLive: false, latencyMs: 30 }),
    });
    expect(statuses(r).feed_gate).toBe("FAIL");
    expect(r.gate).toBe("NOT_READY");
  });

  it("option chain probe fails → data_health FAIL", async () => {
    const r = await evaluatePremarketReadiness({
      ...okDeps(),
      chainProbe: async () => ({ ok: false, latencyMs: 3000, detail: "NSE + MOAPI unavailable" }),
    });
    expect(statuses(r).data_health).toBe("FAIL");
    expect(r.gate).toBe("NOT_READY");
  });

  it("session expired on a source → session_health FAIL with source named", async () => {
    const r = await evaluatePremarketReadiness({
      ...okDeps(),
      sessionReport: async () => ({
        probes: { breeze: { live: false, detail: "session expired" }, mo: { live: true, detail: "ok" }, nse: { live: true, detail: "ok" } },
        summary: { anySessionExpired: true, expiredSources: ["breeze"] },
      }),
    });
    expect(statuses(r).session_health).toBe("FAIL");
    expect(r.gate).toBe("NOT_READY");
    expect(r.blockers.join(" ")).toMatch(/breeze/i);
  });
});

describe("evaluatePremarketReadiness — warnings (WARN → DEGRADED)", () => {
  it("missing morning brief → WARN, still ready", async () => {
    const r = await evaluatePremarketReadiness({ ...okDeps(), brief: () => null });
    expect(statuses(r).morning_brief).toBe("WARN");
    expect(r.gate).toBe("DEGRADED");
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("stale morning brief (yesterday) → WARN", async () => {
    const r = await evaluatePremarketReadiness({
      ...okDeps(),
      brief: () => ({ timestamp: "2026-10-11T03:35:00Z" }),
    });
    expect(statuses(r).morning_brief).toBe("WARN");
    expect(r.gate).toBe("DEGRADED");
  });

  it("provider circuit open → WARN (degraded, not blocked)", async () => {
    const r = await evaluatePremarketReadiness({
      ...okDeps(),
      providerCircuits: () => ({ open: ["nse"] }),
    });
    expect(statuses(r).provider_circuits).toBe("WARN");
    expect(r.gate).toBe("DEGRADED");
    expect(r.ready).toBe(true);
  });

  it("telegram not configured → WARN", async () => {
    const r = await evaluatePremarketReadiness({ ...okDeps(), telegramConfigured: () => false });
    expect(statuses(r).telegram).toBe("WARN");
    expect(r.gate).toBe("DEGRADED");
  });

  it("FAIL always outranks WARN", async () => {
    const r = await evaluatePremarketReadiness({
      ...okDeps(),
      brief: () => null,
      providerCircuits: () => ({ open: ["nse"] }),
      feedProbe: async () => ({ reachable: false, allLive: false, latencyMs: 1, failNote: "down" }),
    });
    expect(r.gate).toBe("NOT_READY");
    expect(r.ready).toBe(false);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("evaluatePremarketReadiness — honest reporting", () => {
  it("a thrown probe becomes FAIL, never a crash or a silent PASS", async () => {
    const r = await evaluatePremarketReadiness({
      ...okDeps(),
      sessionReport: async () => { throw new Error("boom"); },
    });
    expect(statuses(r).session_health).toBe("FAIL");
    expect(r.gate).toBe("NOT_READY");
  });

  it("every check carries a non-empty detail", async () => {
    const r = await evaluatePremarketReadiness(okDeps());
    for (const c of r.checks) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.detail.length).toBeGreaterThan(0);
    }
  });

  it("fixed check set is present exactly once each", async () => {
    const r = await evaluatePremarketReadiness(okDeps());
    const ids = r.checks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      "trading_day", "session_clock", "feed_gate", "data_health",
      "session_health", "provider_circuits", "morning_brief", "telegram",
    ]));
  });

  it("summary is a one-line verdict naming the gate", async () => {
    const r = await evaluatePremarketReadiness(okDeps());
    expect(r.summary.length).toBeGreaterThan(0);
    expect(r.summary).toContain("READY");
  });
});

describe("formatReadinessMessage", () => {
  it("renders every check with its status and the verdict line", async () => {
    const r = await evaluatePremarketReadiness(okDeps());
    const msg = formatReadinessMessage(r);
    expect(msg).toContain("PRE-MARKET READINESS");
    expect(msg).toContain("READY");
    expect(msg).toMatch(/feed_gate/);
    expect(msg).toMatch(/session_health/);
  });

  it("surfaces blockers as actionable lines when NOT_READY", async () => {
    const r = await evaluatePremarketReadiness({
      ...okDeps(),
      feedProbe: async () => ({ reachable: false, allLive: false, latencyMs: 1, failNote: "ECONNREFUSED" }),
    });
    const msg = formatReadinessMessage(r);
    expect(msg).toContain("NOT_READY");
    expect(msg).toContain("ECONNREFUSED");
  });
});
