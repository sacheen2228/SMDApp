/// <reference types="bun-types" />
// hedge_calculator tool — chatbot wiring for the new hedge_calculator.py from
// the updated option-buying-playbook skill (v3 update: hedging section + new
// hedging-strategies.md reference + hedge script).

import { describe, it, expect } from "bun:test";
import { executeTool, selectToolsForQuery, AGENT_TOOLS } from "@/lib/agent-brain";

const ctx = { symbol: "NIFTY", spotPrice: 25100, analysis: {}, summary: { indiaVIX: 22 } };

describe("hedge_calculator tool", () => {
  it("is registered in AGENT_TOOLS with mode + scenario params", () => {
    const def: any = AGENT_TOOLS.find((t: any) => t.function?.name === "hedge_calculator");
    expect(def).toBeTruthy();
    expect(def.function.parameters.properties.mode).toBeTruthy();
    expect(def.function.parameters.properties.longStrike || def.function.parameters.properties.spot).toBeTruthy();
  });

  it("spread mode: compares naked vs debit spreads with real BS numbers", async () => {
    const out = await executeTool("hedge_calculator", {
      mode: "spread", spot: 25100, vix: 22, days: 4, direction: "call",
      longStrike: 25100, target: 25250, stop: 25040, holdDays: 1,
      capital: 300000, lotSize: 75,
    }, ctx);
    expect(out.toLowerCase()).toContain("naked");
    expect(out.toLowerCase()).toMatch(/net debit|debit ₹/);
    expect(out.toLowerCase()).toContain("max loss");
    expect(out.toLowerCase()).toMatch(/r:r/);
    expect(out.toLowerCase()).toMatch(/never leave a short leg naked|exit both legs/);
  }, 30000);

  it("spread mode: missing required args → asks for them, never guesses", async () => {
    const out = await executeTool("hedge_calculator", { mode: "spread", spot: 25100 }, ctx);
    expect(out).toMatch(/needs:|Ask Sachin/);
    expect(out).toContain("--direction");
    expect(out).toContain("--long-strike");
  });

  it("portfolio mode: sizes an index-put hedge for a portfolio value", async () => {
    const out = await executeTool("hedge_calculator", {
      mode: "portfolio", value: 2500000, beta: 1.1, index: 25100,
      lotSize: 75, hedgeRatio: 0.5, vix: 14, days: 25, putPremium: 210,
    }, ctx);
    expect(out.toLowerCase()).toMatch(/hedge|notional/);
    expect(out).toMatch(/lot/i);
    expect(out).toContain("15750"); // est cost from script --json output
  }, 30000);

  it("router selects it for hedging questions", () => {
    const picks = (q: string) => selectToolsForQuery(q).map((t: any) => t.function.name);
    expect(picks("how do I hedge my NIFTY 25100 call, reduce my loss?")).toContain("hedge_calculator");
    expect(picks("protect profit on this PE with a debit spread")).toContain("hedge_calculator");
    expect(picks("portfolio hedge with index puts")).toContain("hedge_calculator");
  });
});

describe("updated skill files readable via read_playbook", () => {
  it("lists and reads the new hedging-strategies reference", async () => {
    const list = await executeTool("read_playbook", {}, ctx);
    expect(list).toContain("references/hedging-strategies.md");
    const doc = await executeTool("read_playbook", { file: "references/hedging-strategies.md" }, ctx);
    expect(doc).not.toContain("No such file");
    expect(doc.length).toBeGreaterThan(500);
  });
});
