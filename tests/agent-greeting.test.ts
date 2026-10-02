/// <reference types="bun-types" />
// Casual / smalltalk early-exit for /api/agent.
// Bug: at 12:50 am, "hi" hit hermesPro → RESEARCH_ONLY panel
// (RESEARCH ONLY — delayed data / UNAVAILABLE) instead of an SDM chat reply.
// Fix: deterministic greeting handler BEFORE the data-fetch + Hermes block.

import { describe, it, expect } from "bun:test";
import { isCasualQuery, casualKind, respondCasual } from "@/lib/agent-engine";

const closedSession = {
  session: "closed",
  label: "Market Closed",
  description: "After hours",
  isMarketOpen: false,
  confidenceMultiplier: 0,
  allowedActions: [],
  notes: [],
} as any;

const openSession = {
  session: "trend_form",
  label: "Trend Session",
  description: "Primary trading session",
  isMarketOpen: true,
  confidenceMultiplier: 1,
  allowedActions: [],
  notes: [],
} as any;

describe("isCasualQuery", () => {
  it("matches pure greetings, thanks, farewells, identity", () => {
    const casual = [
      "hi", "Hi!", "HELLO", "hey there", "hiiii", "yo", "namaste",
      "how are you", "kaise ho", "kya haal hain",
      "who are you", "what can you do",
      "thank you", "thanks!", "shukriya",
      "bye", "goodbye", "good morning", "good night",
      "okay", "cool", "accha",
      "hi 👋", "hello sdm",
    ];
    for (const q of casual) expect(isCasualQuery(q), `should match: ${q}`).toBe(true);
  });

  it("does NOT match trade/market questions (even starting with hi)", () => {
    const notCasual = [
      "mujhe ek trade do",
      "nifty kaisa hai",
      "hi nifty kaise ho",
      "what is pcr",
      "gift nifty gap",
      "What's the market news and sentiment right now?",
      "NIFTY option trade now",
      "hi/bye nifty trade",
      "Jarvis signal",
      "",
      "   ",
    ];
    for (const q of notCasual) expect(isCasualQuery(q), `should NOT match: ${q}`).toBe(false);
  });

  it("classifies the casual kind", () => {
    expect(casualKind("hi")).toBe("greeting");
    expect(casualKind("who are you")).toBe("identity");
    expect(casualKind("thanks")).toBe("thanks");
    expect(casualKind("bye")).toBe("bye");
    expect(casualKind("mujhe ek trade do")).toBeNull();
  });
});

describe("respondCasual", () => {
  it("greets with status + last price when market closed", () => {
    const r = respondCasual("hi", { symbol: "NIFTY", spotPrice: 22421.95, session: closedSession });
    expect(r).toContain("SDM");
    expect(r).toMatch(/22,421\.95|22421\.95/);
    expect(r).toMatch(/closed/i);
    expect(r).toMatch(/trade|news|gap/i); // suggests next actions, stays conversational
    expect(r).not.toMatch(/RESEARCH ONLY|UNAVAILABLE|Validation/); // never the hermes panel
  });

  it("says market open when open", () => {
    const r = respondCasual("hi", { symbol: "NIFTY", spotPrice: 22421.95, session: openSession });
    expect(r).toMatch(/open/i);
    expect(r).toContain("Trend Session");
  });

  it("omits fake price when spot unavailable", () => {
    const r = respondCasual("hi", { symbol: "NIFTY", spotPrice: 0, session: closedSession });
    expect(r).not.toContain("₹0");
    expect(r).toContain("SDM");
  });

  it("answers identity question with capabilities", () => {
    const r = respondCasual("who are you", { symbol: "NIFTY", spotPrice: 0, session: closedSession });
    expect(r).toContain("SDM");
    expect(r).toMatch(/trade|chain|OI/i);
  });

  it("keeps thanks/bye branches friendly", () => {
    expect(respondCasual("thank you", { symbol: "NIFTY", spotPrice: 0, session: closedSession })).toMatch(/anytime|pleasure|welcome/i);
    expect(respondCasual("bye", { symbol: "NIFTY", spotPrice: 0, session: closedSession })).toMatch(/bye|see you/i);
  });
});
