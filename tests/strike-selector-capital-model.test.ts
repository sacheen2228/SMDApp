/// <reference types="bun-types" />
// The per-trade capital model reached the Hermes tools.
//
// THE P0 BUG: the strike selector was called with `--capital 200000 --risk-pct 1`
// (a Rs 2,000 risk budget) against a NIFTY lot that risks Rs 3,000+ -> 0 lots on
// EVERY strike -> "no strike passes the gates" for every NIFTY setup.
//
// THE MODEL (user-defined): Rs 20,000-30,000 per trade, risk = 20% of the amount
// DEPLOYED, max Rs 20,000 deployed per trade, and the position must be AFFORDABLE.

import { describe, it, expect } from "bun:test";
import { executeTool, AGENT_TOOLS } from "@/lib/agent-brain";
import { GATE_CONFIG } from "@/lib/agent-brain-gate";

const ctx = { symbol: "NIFTY", spotPrice: 25100, analysis: {}, summary: { indiaVIX: 14 } };

const setup = {
  direction: "call",
  days: 5,
  target: 25300,
  stop: 25000,
  lotSize: 65,
  holdDays: 0.25,
};

describe("per-trade capital model in the agent tools", () => {
  it("GATE_CONFIG carries the user's per-trade rule", () => {
    expect(GATE_CONFIG.capital).toBe(25_000);
    expect(GATE_CONFIG.tradeBudget).toBe(20_000);
    expect(GATE_CONFIG.riskPctOfTrade).toBe(20);
  });

  it("strike_selector returns a strike with lots (the P0 regression)", async () => {
    const out = await executeTool("strike_selector", { ...setup }, ctx);
    expect(out).toContain("Recommended strike");
    expect(out).toMatch(/Lots: 1/);
    expect(out).not.toContain("NO strike passes the gates");
    expect(out).toMatch(/Position model: deployed .*20,?000.*risk 20%/);
  }, 30000);

  it("strike_selector ignores the stale Rs 2,00,000 capital the LLM may pass", async () => {
    const out = await executeTool("strike_selector", { ...setup, capital: 200000, riskPct: 1 }, ctx);
    expect(out).toContain("Recommended strike");
    expect(out).not.toContain("NO strike passes the gates");
  }, 30000);

  it("strike_selector reports why nothing passes (size reason, never 'risk more')", async () => {
    // lot 200 => Rs 40,504 premium per lot does not fit the Rs 20,000 deployment cap
    const out = await executeTool("strike_selector", { ...setup, lotSize: 200 }, ctx);
    expect(out).toContain("NO strike passes the gates");
    expect(out).not.toContain("Recommended strike");
    expect(out).toMatch(/Size reason:/);
    expect(out).toMatch(/SKIP/i);
  }, 30000);

  it("calculate_position_size uses 20% of the deployed amount, not 1% of a big account", async () => {
    const out = await executeTool("calculate_position_size", {
      entry: 202.52, sl: 145.38, lotSize: 65, riskPct: 1, capital: 200000,
    }, ctx);
    expect(out).toMatch(/risk 20% of the amount deployed/);
    expect(out).toMatch(/1 lot\(s\)/);
    expect(out).not.toMatch(/0 lots/);
  }, 30000);
});

describe("tool schemas tell the LLM the real numbers", () => {
  const schema = (name: string) => {
    const def: any = AGENT_TOOLS.find((t: any) => t.function?.name === name);
    return def?.function;
  };

  it("strike_selector advertises the per-trade model, not Rs 2L / 1%", () => {
    const fn = schema("strike_selector");
    const p = fn.parameters.properties;
    expect(fn.description).toMatch(/20,000-30,000 per trade/);
    expect(fn.description).toMatch(/risk = 20% of the amount DEPLOYED/);
    expect(fn.description).toMatch(/max Rs 20,000 deployed per trade/);
    expect(p.capital.description).toMatch(/25000/);
    expect(p.capital.description).not.toMatch(/200000/);
    expect(p.riskPct.description).toMatch(/default 20/);
    expect(p.riskPct.description).not.toMatch(/default 1\b/);
  });

  it("hedge_calculator advertises the per-trade model, not Rs 2L / 1%", () => {
    const fn = schema("hedge_calculator");
    const p = fn.parameters.properties;
    expect(fn.description).toMatch(/20,000-30,000 per trade/);
    expect(fn.description).toMatch(/risk = 20% of the amount DEPLOYED/);
    expect(p.capital.description).toMatch(/25000/);
    expect(p.capital.description).not.toMatch(/200000/);
    expect(p.riskPct.description).toMatch(/default 20/);
    expect(p.riskPct.description).not.toMatch(/default 1\b/);
  });

  it("calculate_position_size advertises the per-trade model, not Rs 2L / 1%", () => {
    const fn = schema("calculate_position_size");
    const p = fn.parameters.properties;
    expect(fn.description).toMatch(/20,000-30,000 per trade/);
    expect(fn.description).toMatch(/risk = 20% of the amount DEPLOYED/);
    expect(p.capital.description).toMatch(/25000/);
    expect(p.riskPct.description).toMatch(/default 20/);
    expect(p.riskPct.description).not.toMatch(/default 1\b/);
  });
});
