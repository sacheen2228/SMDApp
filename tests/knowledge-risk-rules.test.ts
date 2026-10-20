/// <reference types="bun-types" />
// THE RULE THE APP TEACHES.
//
// THE DEFECT (2026-10-20): the knowledge base injected into the agent prompt
// still taught "NEVER risk more than 2% of capital" / "Risk only 2% of capital
// per trade", the Risk-Management agent tool printed "₹1,00,000 × 2% = ₹2,000"
// and sized on it, the admin sliders said "% of capital" (1% / 3%) and the CAS
// straddle strategy carried a ₹1,00,000 capital with a 1.5% risk.
//
// The knowledge base is INJECTED into the prompt — if it teaches the replaced
// rule, the agent teaches it back. These tests pin the replacement.

import { describe, test, expect } from "bun:test";
import TRADING_KNOWLEDGE from "@/lib/trading-knowledge";
import { DEFAULT_STRATEGY_CONFIG } from "@/lib/strategy-config";
import { DEFAULT_CONFIG as CAS_DEFAULT_CONFIG } from "@/lib/cas-straddle-strategy-v2";
import { DEFAULT_PAPER_CONFIG } from "@/lib/hermes/paper-engine";
import { GATE_CONFIG } from "@/lib/agent-brain-gate";

describe("the injected knowledge base", () => {
  test("it never teaches the replaced '2% of capital' rule", () => {
    const banned = [
      /2%\s*of\s*capital/i,
      /1-2%\s*of\s*capital/i,
      /risk only 2%/i,
      /never risk more than 2%/i,
      /risk\s+max\s+2%/i,
      /2%\s*per\s+trade/i,
      /₹1,00,000/,
      /₹5,00,000/,
      /1L\s+capital/i,
    ];
    for (const re of banned) {
      expect(TRADING_KNOWLEDGE.match(re)).toBeNull();
    }
  });

  test("it states the per-trade model (20% of the amount deployed, ≤ ₹20,000)", () => {
    expect(TRADING_KNOWLEDGE).toMatch(/20%\s*of the amount DEPLOYED/i);
    expect(TRADING_KNOWLEDGE).toMatch(/₹20,000/);
    expect(TRADING_KNOWLEDGE).toMatch(/Risk × 2/);
    expect(TRADING_KNOWLEDGE).toMatch(/R:R 1:2 \/ 1:3 \/ 1:4/);
    expect(TRADING_KNOWLEDGE).toMatch(/₹25,000/);
  });

  test("the daily rules use the new caps", () => {
    expect(TRADING_KNOWLEDGE).toMatch(/Two losing trades in a row/i);
    expect(TRADING_KNOWLEDGE).toMatch(/₹8,000 daily loss cap/);
  });
});

describe("the strategy config (the admin sliders)", () => {
  test("the risk sliders are the per-trade model, not '% of capital'", () => {
    expect(DEFAULT_STRATEGY_CONFIG.risk.maxRiskPerTrade).toBe(20);   // % of the deployed amount
    expect(DEFAULT_STRATEGY_CONFIG.risk.maxDailyLoss).toBe(32);      // % of the ₹25,000 account
    expect(DEFAULT_STRATEGY_CONFIG.risk.slPercent).toBe(20);         // the rupee-risk stop
    expect(DEFAULT_STRATEGY_CONFIG.risk.tp1Multiplier).toBe(2);
    expect(DEFAULT_STRATEGY_CONFIG.risk.tp2Multiplier).toBe(3);
    expect(DEFAULT_STRATEGY_CONFIG.risk.tp3Multiplier).toBe(4);
  });
});

describe("the CAS straddle strategy", () => {
  test("it runs on the real account with the per-trade risk", () => {
    expect(CAS_DEFAULT_CONFIG.initialCapital).toBe(GATE_CONFIG.capital);
    expect(CAS_DEFAULT_CONFIG.initialCapital).toBe(25_000);
    expect(CAS_DEFAULT_CONFIG.maxRiskPct).toBe(GATE_CONFIG.riskPctOfTrade);
    expect(CAS_DEFAULT_CONFIG.maxRiskPct).toBe(20);
  });
});

describe("the paper account", () => {
  test("it mirrors the real ₹25,000 account", () => {
    expect(DEFAULT_PAPER_CONFIG.startingCapital).toBe(GATE_CONFIG.capital);
    expect(DEFAULT_PAPER_CONFIG.startingCapital).toBe(25_000);
  });
});

describe("the agent's Risk-Management tool output", () => {
  test("it never prints the old '₹1,00,000 × 2%' sizing", async () => {
    const { agentRespond } = await import("@/lib/agent-engine");
    const out = agentRespond({
      symbol: "NIFTY",
      spotPrice: 22900,
      analysis: { recommendation: { entryPrice: 100, stopLoss: 80 } },
      trades: [],
      session: null,
      summary: null,
      gammaBlast: null,
      expiryDate: "2026-10-30",
    }, "what is my position size?");
    expect(out).toBeTruthy();
    expect(out).not.toMatch(/2%/);
    expect(out).not.toMatch(/₹1,00,000/);
    expect(out).toMatch(/20%/);
    expect(out).toMatch(/₹20,000/);
  });
});
