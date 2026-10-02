/// <reference types="bun-types" />
// strike_selector tool — chat-bot execution of the option-buying playbook's
// strike calculator (skills/option-buying-playbook/scripts/strike_selector.py).
// The bot must (a) rank a strike when gates pass, (b) answer honestly with
// SKIP when no strike passes the gates, (c) ask for missing inputs instead of
// fabricating them.

import { describe, it, expect } from "bun:test";
import { executeTool, selectToolsForQuery, AGENT_TOOLS } from "@/lib/agent-brain";

const ctx = {
  symbol: "NIFTY",
  spotPrice: 22400,
  analysis: {},
  summary: { indiaVIX: 14.4 },
};

const baseArgs = {
  direction: "call",
  days: 5,
  target: 22550,
  stop: 22350,
  capital: 200000,
  lotSize: 75,
  holdDays: 0.25,
};

describe("strike_selector tool", () => {
  it("returns a concrete strike recommendation when gates pass", async () => {
    const out = await executeTool("strike_selector", { ...baseArgs }, ctx);
    expect(out).toContain("Recommended strike");
    expect(out).toMatch(/Entry premium/);
    expect(out).toMatch(/Option R:R/);
    expect(out).toMatch(/Lots/);
    expect(out).not.toContain("Unknown tool");
  }, 30000);

  it("answers SKIP honestly when no strike passes the gates", async () => {
    // stop 60 pts under risk budget of ₹2000 → size gate fails on every strike
    const out = await executeTool("strike_selector", { ...baseArgs, stop: 22340 }, ctx);
    expect(out).toMatch(/SKIP/i);
    expect(out).not.toContain("Recommended strike");
  }, 30000);

  it("defaults spot and VIX from live context", async () => {
    const out = await executeTool("strike_selector", {
      direction: "call",
      days: 5,
      target: 22550,
      stop: 22350,
      lotSize: 75,
    }, ctx);
    // no spot/vix args — must still run using ctx values (22400 / 14.4)
    expect(out).not.toContain("required");
    expect(out).toMatch(/spot=22400|Spot: ₹22,400|22400/i);
  }, 30000);

  it("asks for missing inputs instead of guessing", async () => {
    const out = await executeTool("strike_selector", { direction: "call" }, { ...ctx, spotPrice: 0, summary: {} });
    expect(out).toMatch(/--days|--target|--stop|missing/i);
  }, 30000);

  it("rejects an invalid direction", async () => {
    const out = await executeTool("strike_selector", { ...baseArgs, direction: "long" }, ctx);
    expect(out).toMatch(/direction/i);
  }, 30000);
});

describe("strike_selector registration", () => {
  it("is registered in AGENT_TOOLS with a callable schema", () => {
    const def: any = AGENT_TOOLS.find((t: any) => t.function?.name === "strike_selector");
    expect(def).toBeTruthy();
    expect(def.function.parameters.required).toEqual(["direction", "target", "stop", "days"]);
    expect(def.function.parameters.properties.direction.enum).toEqual(["call", "put"]);
  });

  it("router selects it for strike questions", () => {
    const picks = selectToolsForQuery("which strike should I buy for NIFTY call?").map((t: any) => t.function.name);
    expect(picks).toContain("strike_selector");
  });

  it("router selects it for ATM/ITM/OTM and lot questions", () => {
    expect(selectToolsForQuery("ATM or ITM or OTM?").map((t: any) => t.function.name)).toContain("strike_selector");
    expect(selectToolsForQuery("how many lots of RELIANCE options?").map((t: any) => t.function.name)).toContain("strike_selector");
  });
});
